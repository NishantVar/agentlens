import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:os';
import { startProxy, type CaptureProxy } from './proxy.js';
import { SessionWriter, newSessionId, storeRoot } from './store.js';
import { detectRuntime, getAdapter, type RuntimeAdapter } from './runtimes.js';
import { resolveTags } from './tags.js';
import { extractClaudeSessionIdFromRawBody } from './claudeTranscript.js';
import { Looker, nameUnclaimed, type LookClock } from './claims.js';
import { finalizeSession, prepareClaims, type Prepared } from './finalize.js';
import { identityOf } from './procinfo.js';
import type { NormalizedEvent, RawPair, Runtime, SessionMeta } from './types.js';

const LENS_VERSION = '0.1.0';
const SIGNALS = ['SIGHUP', 'SIGTERM', 'SIGINT'] as const;
type Sig = typeof SIGNALS[number];
// After a signal, wait this long before forwarding it, so a child that got the
// same signal from its process group can exit on its own first.
const FORWARD_SETTLE_MS = 200;
const graceMs = () => Number(process.env.AGENTLENS_SIGNAL_GRACE_MS) || 3000;
// Open-file lookups can be slow (ps and lsof each time out at 2 s), so after a
// signal they never hold the stop past grace + 1 s: the signal look gets until
// this long after the signal before forwarding, and looks still running at the
// grace deadline get until grace + 1 s minus the time kept for finalize and
// exit. A look still running then counts as unreadable evidence: it claims
// nothing, and stderr says so once.
const SIGNAL_LOOK_CAP_MS = 500;
const STOP_LOOK_SLACK_MS = 1000 - 200;
const until = (t: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, t - Date.now())));
const signo = (s: string) => (constants.signals as Record<string, number>)[s] ?? 0;

export interface RunOptions {
  tags: string[];
  argv: string[];
  upstreamOverride?: string;
  /** Test-only: drives the look schedule by hand (ALF-42). */
  lookClock?: LookClock;
}

let stderrGuarded = false;

export function lensRun(opts: RunOptions): Promise<number> {
  let runtime: Runtime;
  try {
    runtime = detectRuntime(opts.argv[0]);
  } catch (e) {
    console.error(`agentlens: ${(e as Error).message}`);
    return Promise.resolve(2);
  }
  // After a pane closes, writes to the hung-up TTY fail with EIO; with no
  // listener that error would kill the wrapper before it finalizes.
  if (!stderrGuarded) { stderrGuarded = true; process.stderr.on('error', () => {}); }
  const adapter: RuntimeAdapter = getAdapter(runtime);
  const startedAt = new Date();
  const root = storeRoot();
  const log = (m: string) => { try { console.error(m); } catch { /* stderr gone */ } };

  return new Promise((resolve) => {
    let writer: SessionWriter | null = null;
    let meta: SessionMeta | null = null;
    let proxy: CaptureProxy | null = null;
    let looker: Looker | null = null;
    let child: ChildProcess | null = null;
    let seq = 0;
    const nativeIds = new Set<string>();
    let requests = 0;
    let finishing = false;
    let signalled: Sig | null = null;
    let childExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let onChildExit: (() => void) | null = null;
    // Claimed rollouts read ahead while the wrapper only waits, so finalizing
    // after a stop deadline reads just what was written since.
    let prepared: Prepared | undefined;
    const prepare = () => { if (writer && meta?.capture === 'logs') prepared = prepareClaims(root, writer.id, prepared); };

    const handlers = new Map<Sig, () => void>();
    const removeHandlers = () => { for (const [s, h] of handlers) process.removeListener(s, h); handlers.clear(); };

    const recordEvent = (ev: NormalizedEvent) => {
      writer!.appendEvent(ev);
      requests++;
    };

    const setup = async (): Promise<Record<string, string>> => {
      const tags = resolveTags(opts.tags, process.env.AGENTLENS_TAGS);
      const self = identityOf(process.pid);
      if (!self?.startTime) log('agentlens: cannot read own process start time; if this session is left unsaved, recovery waits until this process id is gone');
      meta = {
        id: newSessionId(), runtime, capture: adapter.mode, tags, cwd: process.cwd(), argv: opts.argv,
        lensVersion: LENS_VERSION, startedAt: startedAt.toISOString(),
        // Always recorded: without it, recovery would take a live session for a
        // pre-change one. A null start time makes liveness 'unknown' while the
        // pid exists, so recovery waits for the pid to go.
        wrapper: { pid: process.pid, startTime: self?.startTime ?? null },
      };
      writer = new SessionWriter(root, meta);
      if (adapter.mode !== 'proxy') return {};
      const proxyAdapter = adapter;
      proxy = await startProxy({
        upstream: opts.upstreamOverride ?? process.env.AGENTLENS_UPSTREAM ?? proxyAdapter.upstream,
        onPair: (p) => {
          const pair: RawPair = { ...p, seq: ++seq };
          writer!.appendRaw(pair);
          const nid = extractClaudeSessionIdFromRawBody(pair.request.body);
          if (nid) nativeIds.add(nid);
          const call = proxyAdapter.normalize(pair);
          if (call) recordEvent({ ts: pair.ts, seq: pair.seq, kind: 'api_call', model: call.model, usage: call.usage, durationMs: pair.durationMs, status: pair.response.status });
          else requests++; // raw-only pair still counts as a request
        },
      });
      return proxyAdapter.env(proxy.origin);
    };

    const finish = async (code: number, lookBy?: number) => {
      if (finishing) return;
      finishing = true;
      try {
        if (looker) {
          const last = looker.look('exit').then(() => true);
          prepare(); // while the exit look runs
          const inTime = lookBy === undefined ? await last : await Promise.race([last, until(lookBy).then(() => false)]);
          looker.stop();
          if (!inTime) log('agentlens: open-file lookup still running at the stop deadline; no Codex rollout claimed from it');
        }
        if (writer && meta) {
          const entry = finalizeSession(root, writer.id, {
            exitCode: code, role: 'writer', meta, log, prepared,
            nativeSessionIds: nativeIds.size ? [...nativeIds] : undefined,
          });
          if (entry) {
            if (meta.capture === 'logs') nameUnclaimed(root, meta, log);
            const t = entry.totals;
            log(`agentlens: session ${entry.id} — ${meta.capture === 'proxy' ? requests : t.requests} requests, ${t.input + t.cacheRead + t.cacheWrite} in / ${t.output} out tokens`);
          }
        }
        if (proxy) await proxy.close();
      } catch (e) {
        log(`agentlens: finalize failed (fail-open): ${(e as Error).message}`);
      }
      removeHandlers();
      resolve(code);
    };

    const childStatus = (fallback: Sig | null): number => {
      if (childExit?.signal) return 128 + signo(childExit.signal);
      if (childExit && childExit.code !== null) return childExit.code;
      return fallback ? 128 + signo(fallback) : 1;
    };

    const onSignal = (s: Sig) => {
      if (signalled || finishing) return;
      signalled = s;
      const t0 = Date.now();
      const deadline = t0 + graceMs();
      const exited = new Promise<void>((r) => { onChildExit = r; });
      void (async () => {
        // Look while the agent still holds its rollouts, bounded so that a slow
        // lookup cannot delay the forward or the deadline.
        const look = looker ? looker.look('signal') : Promise.resolve();
        if (!childExit) await Promise.race([exited, until(t0 + FORWARD_SETTLE_MS)]);
        if (!childExit) await Promise.race([exited, look, until(t0 + SIGNAL_LOOK_CAP_MS)]);
        if (!childExit && child?.pid) { try { child.kill(s); } catch { /* already gone */ } }
        if (!childExit) prepare(); // while the child has until the deadline
        if (!childExit) await Promise.race([exited, until(deadline)]);
        await finish(childStatus(s), deadline + STOP_LOOK_SLACK_MS);
      })();
    };

    for (const s of SIGNALS) { const h = () => onSignal(s); handlers.set(s, h); process.on(s, h); }

    (async () => {
      let extraEnv: Record<string, string> = {};
      try {
        extraEnv = await setup();
      } catch (e) {
        log(`agentlens: capture setup failed, running unwrapped (fail-open): ${(e as Error).message}`);
        writer = null; proxy = null; meta = null;
      }
      // Marker for wrappers that sit in front of the agent binary (the cmux
      // shim, the shell functions): a nested `lens run` under an already-active
      // capture would start a second proxy and split one session in two, so
      // they exec straight through when they see this.
      const captureEnv = writer ? { AGENTLENS_CAPTURE: '1' } : {};
      if (signalled) { // stopped during setup: do not start the agent
        childExit = { code: null, signal: null };
        (onChildExit as (() => void) | null)?.(); // set by onSignal; TS narrows it to null here
        return;
      }
      child = spawn(opts.argv[0], opts.argv.slice(1), {
        stdio: 'inherit',
        env: { ...process.env, ...captureEnv, ...extraEnv },
      });
      const w = writer as SessionWriter | null; // TS narrows the closure-set binding to null here
      if (w && adapter.mode === 'logs' && child.pid) {
        looker = new Looker(root, w.id, child.pid, opts.lookClock, log);
        looker.start();
      }
      child.on('error', (e) => {
        log(`agentlens: failed to launch ${opts.argv[0]}: ${e.message}`);
        childExit = { code: 127, signal: null };
        if (onChildExit) onChildExit(); else void finish(127);
      });
      child.on('exit', (code, signal) => {
        childExit = { code, signal };
        if (signalled) { onChildExit?.(); return; }
        void finish(childStatus(null));
      });
    })();
  });
}

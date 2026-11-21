import { spawn } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { startProxy, type CaptureProxy } from './proxy.js';
import { SessionWriter, newSessionId, storeRoot } from './store.js';
import { detectRuntime, getAdapter, type RuntimeAdapter } from './runtimes.js';
import { resolveTags } from './tags.js';
import { extractClaudeSessionIdFromRawBody } from './claudeTranscript.js';
import type { NormalizedEvent, RawPair, Runtime } from './types.js';

const LENS_VERSION = '0.1.0';

export interface RunOptions { tags: string[]; argv: string[]; upstreamOverride?: string }

export function lensRun(opts: RunOptions): Promise<number> {
  let runtime: Runtime;
  try {
    runtime = detectRuntime(opts.argv[0]);
  } catch (e) {
    console.error(`agentlens: ${(e as Error).message}`);
    return Promise.resolve(2);
  }
  const adapter: RuntimeAdapter = getAdapter(runtime);
  const startedAt = new Date();
  const root = storeRoot();

  return new Promise((resolve) => {
    let writer: SessionWriter | null = null;
    let proxy: CaptureProxy | null = null;
    let seq = 0;
    const nativeIds = new Set<string>();
    let requests = 0; let tin = 0; let tout = 0;

    const recordEvent = (ev: NormalizedEvent) => {
      writer!.appendEvent(ev);
      requests++;
      tin += ev.usage.input + ev.usage.cacheRead + ev.usage.cacheWrite;
      tout += ev.usage.output;
    };

    const setup = async (): Promise<Record<string, string>> => {
      const tags = resolveTags(opts.tags, process.env.AGENTLENS_TAGS);
      writer = new SessionWriter(root, {
        id: newSessionId(), runtime, capture: adapter.mode, tags, cwd: process.cwd(), argv: opts.argv,
        lensVersion: LENS_VERSION, startedAt: startedAt.toISOString(),
      });
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

    const collectLogs = () => {
      if (adapter.mode !== 'logs' || !writer) return;
      const logsWriter = writer;
      try {
        let i = 0;
        for (const s of adapter.collect(startedAt, { cwd: process.cwd() })) {
          i++;
          if (s.nativeSessionId) nativeIds.add(s.nativeSessionId);
          for (const ev of s.events) recordEvent({ ...ev, seq: ++seq });
          try {
            copyFileSync(s.rolloutPath, join(root, 'sessions', logsWriter.id, `rollout-${i}.jsonl`));
          } catch (e) {
            console.error(`agentlens: rollout copy failed (fail-open): ${(e as Error).message}`);
          }
        }
      } catch (e) {
        console.error(`agentlens: log collection failed (fail-open): ${(e as Error).message}`);
      }
    };

    const finish = async (code: number) => {
      try {
        collectLogs();
        if (writer) {
          const entry = writer.finalize(code, { nativeSessionIds: nativeIds.size ? [...nativeIds] : undefined });
          console.error(`agentlens: session ${entry.id} — ${requests} requests, ${tin} in / ${tout} out tokens`);
        }
        if (proxy) await proxy.close();
      } catch (e) {
        console.error(`agentlens: finalize failed (fail-open): ${(e as Error).message}`);
      }
      resolve(code);
    };

    (async () => {
      let extraEnv: Record<string, string> = {};
      try {
        extraEnv = await setup();
      } catch (e) {
        console.error(`agentlens: capture setup failed, running unwrapped (fail-open): ${(e as Error).message}`);
        writer = null; proxy = null;
      }
      // Marker for wrappers that sit in front of the agent binary (the cmux
      // shim, the shell functions): a nested `lens run` under an already-active
      // capture would start a second proxy and split one session in two, so
      // they exec straight through when they see this.
      const captureEnv = writer ? { AGENTLENS_CAPTURE: '1' } : {};
      const child = spawn(opts.argv[0], opts.argv.slice(1), {
        stdio: 'inherit',
        env: { ...process.env, ...captureEnv, ...extraEnv },
      });
      child.on('error', (e) => {
        console.error(`agentlens: failed to launch ${opts.argv[0]}: ${e.message}`);
        finish(127);
      });
      child.on('exit', (code, signal) => finish(signal ? 1 : (code ?? 1)));
    })();
  });
}

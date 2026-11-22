// One agent per Codex log. A rollout is tied to a session only by open-file
// evidence: a process in the tree `lens run` launched holds it open for
// writing (lsof mode `w` or `u`). Start time and folder never decide
// ownership; they only narrow which rollouts are named as unclaimed.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { procTable, descendantsIn, type ProcIdentity } from './procinfo.js';
import { hook } from './testHooks.js';
import type { SessionMeta } from './types.js';

export interface ClaimRecord { rollout: string; session: string; holders: ProcIdentity[]; claimedAt: string }

export function codexSessionsRoot(): string {
  return process.env.AGENTLENS_CODEX_SESSIONS ?? join(homedir(), '.codex', 'sessions');
}
const realOrNull = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };

// ---- exclusive publish ---------------------------------------------------------
// Write the full content to a unique temp file, then hard-link it to its final
// name: the link either creates the name with complete content or fails EEXIST.
export function publishExclusive(path: string, content: string): boolean {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, content);
  try { linkSync(tmp, path); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e; }
  finally { try { unlinkSync(tmp); } catch { /* already gone */ } }
}

// ---- claim store ------------------------------------------------------------------
const claimsDir = (root: string) => join(root, 'claims');
export const claimFile = (root: string, rollout: string) =>
  join(claimsDir(root), createHash('sha256').update(rollout).digest('hex') + '.json');

export function readClaim(root: string, rollout: string): ClaimRecord | null {
  try { return JSON.parse(readFileSync(claimFile(root, rollout), 'utf8')); } catch { return null; }
}

export function hasClaim(root: string, rollout: string): boolean {
  const r = realOrNull(rollout) ?? rollout;
  return existsSync(claimFile(root, r));
}

export function tryClaim(root: string, rec: ClaimRecord): 'won' | 'mine' | 'lost' {
  mkdirSync(claimsDir(root), { recursive: true });
  const path = claimFile(root, rec.rollout);
  hook('claim:before-link');
  if (publishExclusive(path, JSON.stringify(rec))) return 'won';
  return readClaim(root, rec.rollout)?.session === rec.session ? 'mine' : 'lost';
}

export function listClaims(root: string): ClaimRecord[] {
  const d = claimsDir(root);
  if (!existsSync(d)) return [];
  const out: ClaimRecord[] = [];
  for (const f of readdirSync(d)) {
    if (!/^[0-9a-f]{64}\.json$/.test(f)) continue;
    try { out.push(JSON.parse(readFileSync(join(d, f), 'utf8'))); } catch { /* torn or foreign file: skip */ }
  }
  return out;
}

export const claimsOf = (all: ClaimRecord[], session: string) => all
  .filter((c) => c.session === session)
  .sort((a, b) => a.claimedAt.localeCompare(b.claimedAt) || a.rollout.localeCompare(b.rollout));

// A later look can see an extra writer for a rollout this session owns.
export function recordHolder(root: string, session: string, id: ProcIdentity): void {
  appendFileSync(join(root, 'sessions', session, 'holders.jsonl'), JSON.stringify(id) + '\n');
}
export function readHolders(root: string, session: string): ProcIdentity[] {
  const p = join(root, 'sessions', session, 'holders.jsonl');
  if (!existsSync(p)) return [];
  const out: ProcIdentity[] = [];
  for (const l of readFileSync(p, 'utf8').split('\n')) { if (l.trim()) try { out.push(JSON.parse(l)); } catch { /* skip */ } }
  return out;
}

// ---- open-file evidence -------------------------------------------------------------
export type Evidence = { ok: true; held: { pid: number; path: string }[] } | { ok: false; reason: string };

const isRollout = (p: string, rootReal: string) => p.startsWith(rootReal + sep) && /\/rollout-[^/]*\.jsonl$/.test(p);
const anyAlive = (pids: number[]) => pids.some((p) => { try { process.kill(p, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } });

export function writersOf(pids: number[], rootReal: string | null): Promise<Evidence> {
  if (!pids.length || !rootReal) return Promise.resolve({ ok: true, held: [] });
  const bin = process.env.AGENTLENS_LSOF || 'lsof';
  return new Promise((resolve) => {
    execFile(bin, ['-n', '-P', '-w', '-F', 'pan', '-p', pids.join(',')], { timeout: 2000, maxBuffer: 16 << 20 }, (err, stdout) => {
      const out = String(stdout ?? '');
      if (err) {
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (typeof e.code === 'string') return resolve({ ok: false, reason: `lsof: ${e.code}` });
        if (e.killed) return resolve({ ok: false, reason: 'lsof: timed out' });
        // lsof exits 1 when some listed pid has gone; that is not a failure
        // while it still printed something, or when none of them is alive.
        if (!out.trim() && anyAlive(pids)) return resolve({ ok: false, reason: `lsof: exit ${e.code ?? '?'}` });
      }
      const held: { pid: number; path: string }[] = [];
      let pid = 0; let mode = '';
      for (const line of out.split('\n')) {
        const t = line[0]; const v = line.slice(1);
        if (t === 'p') pid = Number(v);
        else if (t === 'f') mode = '';
        else if (t === 'a') mode = v;
        else if (t === 'n' && (mode === 'w' || mode === 'u')) {
          const real = realOrNull(v) ?? v;
          if (isRollout(real, rootReal)) held.push({ pid, path: real });
        }
      }
      resolve({ ok: true, held });
    });
  });
}

// ---- the look loop --------------------------------------------------------------------
export interface LookClock { schedule(fn: () => void, ms: number): void; now(): number }
export const LOOK_DELAY_MS = 900; // < 1 s after each look ends, by construction

export class Looker {
  private owned = new Map<string, ProcIdentity[]>();
  private lost = new Set<string>();
  private remembered = new Map<number, string>(); // pid -> start time
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private pending = false;
  private reported = false;
  private n = 0;
  private rootReal: string | null = null;
  private clock: LookClock;

  constructor(private root: string, private session: string, private rootPid: number, clock: LookClock | undefined, private log: (m: string) => void) {
    this.clock = clock ?? {
      schedule: (fn, ms) => { this.timer = setTimeout(fn, ms); this.timer.unref(); },
      now: () => Date.now(),
    };
  }

  start(): void { void this.look('start'); }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); }

  look(reason: 'start' | 'tick' | 'signal' | 'exit'): Promise<void> {
    this.chain = this.chain.then(() => this.once(reason)).catch((e) => this.log(`agentlens: rollout look failed (fail-open): ${(e as Error).message}`));
    return this.chain;
  }

  private async once(reason: string): Promise<void> {
    const n = ++this.n; const startedAt = this.clock.now();
    this.rootReal ??= realOrNull(codexSessionsRoot());
    const table = await procTable();
    const pids = new Set<number>();
    if (table) {
      const roots = [this.rootPid, ...[...this.remembered].filter(([p, s]) => table.start.get(p) === s).map(([p]) => p)];
      for (const p of [this.rootPid, ...descendantsIn(table, roots)]) {
        const s = table.start.get(p);
        if (s === undefined) continue;
        pids.add(p); this.remembered.set(p, s);
      }
      for (const [p, s] of this.remembered) if (table.start.get(p) === s) pids.add(p);
    } else {
      pids.add(this.rootPid);
    }
    const ev = await writersOf([...pids], this.rootReal);
    if (!ev.ok) {
      if (!this.reported) { this.reported = true; this.log(`agentlens: cannot read open-file evidence (${ev.reason}); no Codex rollout claimed`); }
    } else {
      const byPath = new Map<string, ProcIdentity[]>();
      for (const h of ev.held) {
        const id = { pid: h.pid, startTime: table?.start.get(h.pid) ?? null };
        const list = byPath.get(h.path) ?? [];
        if (!list.some((x) => x.pid === id.pid)) list.push(id);
        byPath.set(h.path, list);
      }
      for (const [path, holders] of byPath) {
        if (this.lost.has(path)) continue;
        const mine = this.owned.get(path);
        if (mine) {
          for (const h of holders) if (!mine.some((m) => m.pid === h.pid && m.startTime === h.startTime)) { mine.push(h); recordHolder(this.root, this.session, h); }
          continue;
        }
        const r = tryClaim(this.root, { rollout: path, session: this.session, holders, claimedAt: new Date().toISOString() });
        if (r === 'lost') this.lost.add(path); else this.owned.set(path, [...holders]);
      }
    }
    const lookLog = process.env.AGENTLENS_TEST_LOOK_LOG;
    if (lookLog) appendFileSync(lookLog, JSON.stringify({ n, reason, startedAt, endedAt: this.clock.now(), claimed: [...this.owned.keys()] }) + '\n');
    if (!this.stopped && !this.pending && reason !== 'exit') {
      this.pending = true;
      this.clock.schedule(() => { this.pending = false; if (!this.stopped) void this.look('tick'); }, LOOK_DELAY_MS);
    }
  }
}

// ---- naming what no look tied ---------------------------------------------------------
function firstLine(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const s = buf.subarray(0, n).toString('utf8');
    const i = s.indexOf('\n');
    return i < 0 ? s : s.slice(0, i);
  } finally { closeSync(fd); }
}
function rolloutsUnder(dir: string, out: string[] = []): string[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of entries) {
    const p = join(dir, d.name);
    if (d.isDirectory()) rolloutsUnder(p, out);
    else if (d.name.startsWith('rollout-') && d.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// Rollouts in the session's window and folder that carry no claim. They are
// only named, never counted.
export function unclaimedNear(root: string, meta: SessionMeta, all: ClaimRecord[] = listClaims(root)): string[] {
  const rootReal = realOrNull(codexSessionsRoot());
  if (!rootReal) return [];
  const cutoff = new Date(meta.startedAt).getTime() - 2000;
  const claimed = new Set(all.map((c) => c.rollout));
  const out: string[] = [];
  for (const p of rolloutsUnder(rootReal)) {
    try {
      const real = realOrNull(p) ?? p;
      if (claimed.has(real) || statSync(real).mtimeMs < cutoff) continue;
      const m = JSON.parse(firstLine(real));
      if (m?.type === 'session_meta' && m.payload?.cwd === meta.cwd) out.push(real);
    } catch { /* unreadable or not a rollout header: not ours to name */ }
  }
  return out;
}

export function nameUnclaimed(root: string, meta: SessionMeta, log: (m: string) => void, all?: ClaimRecord[]): void {
  try {
    for (const p of unclaimedNear(root, meta, all)) log(`agentlens: rollout not tied to any session (no look saw it open for writing), not counted: ${p}`);
  } catch (e) {
    log(`agentlens: unclaimed-rollout scan failed (fail-open): ${(e as Error).message}`);
  }
}

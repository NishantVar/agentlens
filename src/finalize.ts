// Finalize a session exactly once, shared by `lens run` and the recovery sweep.
//   1. ticket: publish sessions/<id>/final.<n>.json exclusively. `lens run`
//      takes 0 and never waits. A sweep takes n+1 only when every earlier
//      ticket's holder is gone, so a finalizer that died partway is taken
//      over, and racing takeovers collide on the same name.
//   2. index check: stop if the session already has an index entry.
//   3. logs mode: rebuild events.jsonl from every claimed rollout, read in
//      full now (temp file + rename, so a re-run gives the same result). A
//      rollout prepared earlier (prepareClaims) is read only from where that
//      left off, so the work left at a stop deadline does not grow with its size.
//   4. meta: endedAt, exitCode, recovered, nativeSessionIds.
//   5. append the index line: the commit point.
import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { scanRollout, type RolloutScan } from './codexRollout.js';
import { claimsOf, listClaims, publishExclusive, type ClaimRecord } from './claims.js';
import { identityOf, liveness, type ProcIdentity } from './procinfo.js';
import { hook } from './testHooks.js';
import { addUsage, emptyUsage } from './types.js';
import type { IndexEntry, NormalizedEvent, SessionMeta } from './types.js';

export interface FinalizeOpts {
  exitCode: number | null;
  role: 'writer' | 'sweep';
  recovered?: boolean;
  endedAt?: string;
  nativeSessionIds?: string[];
  meta?: SessionMeta;
  claims?: ClaimRecord[];
  log?: (m: string) => void;
  prepared?: Prepared;
}

// A claimed rollout read up to its last complete line ahead of finalize: the
// bytes so far are already in a temp copy and already scanned.
export interface PreparedRollout { offset: number; scan: RolloutScan; tmp: string }
export type Prepared = Map<string, PreparedRollout>;

/** Read this session's claimed rollouts so far, adding to `prepared`; fail-open. */
export function prepareClaims(root: string, id: string, prepared: Prepared = new Map()): Prepared {
  try {
    const dir = join(root, 'sessions', id);
    for (const c of claimsOf(listClaims(root), id)) {
      if (prepared.has(c.rollout)) continue;
      try {
        const buf = readFileSync(c.rollout);
        const prefix = buf.subarray(0, buf.lastIndexOf(0x0a) + 1);
        const tmp = join(dir, `rollout-prepared.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
        writeFileSync(tmp, prefix);
        prepared.set(c.rollout, { offset: prefix.length, scan: scanRollout(prefix.toString('utf8')), tmp });
      } catch { /* finalize reads it in full */ }
    }
  } catch { /* finalize reads them in full */ }
  return prepared;
}

function readFrom(path: string, offset: number): Buffer | null {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size < offset) return null; // truncated or replaced: start over
    const out = Buffer.alloc(size - offset);
    for (let got = 0; got < out.length;) { const n = readSync(fd, out, got, out.length - got, offset + got); if (!n) return out.subarray(0, got); got += n; }
    return out;
  } finally { closeSync(fd); }
}

// The claimed rollout's scan, and a step that leaves its full copy at `copy`.
function readClaimed(path: string, p: PreparedRollout | undefined): { scan: RolloutScan; commit: (copy: string) => void } {
  if (p) {
    let tail: Buffer | null | undefined;
    try { tail = readFrom(path, p.offset); } catch { tail = undefined; }
    if (tail === undefined) return { scan: p.scan, commit: (copy) => renameSync(p.tmp, copy) }; // unreadable now: count what was read
    if (tail) {
      appendFileSync(p.tmp, tail);
      const rest = scanRollout(tail.toString('utf8'), p.scan);
      return { scan: { ...rest, events: [...p.scan.events, ...rest.events] }, commit: (copy) => renameSync(p.tmp, copy) };
    }
    rmSync(p.tmp, { force: true });
  }
  const text = readFileSync(path, 'utf8');
  return { scan: scanRollout(text), commit: (copy) => writeAtomic(copy, text) };
}

let self: ProcIdentity | null | undefined;
const selfIdentity = () => (self === undefined ? (self = identityOf(process.pid)) : self) ?? { pid: process.pid, startTime: null };

export function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function readLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const l of readFileSync(path, 'utf8').split('\n')) { if (l.trim()) try { out.push(JSON.parse(l)); } catch { /* skip corrupt */ } }
  return out;
}

export function indexedIds(root: string): Set<string> {
  return new Set(readLines<IndexEntry>(join(root, 'index.jsonl')).map((e) => e.id));
}

// A short write (a full disk, or a finalizer killed mid-append) can leave the
// index ending in a partial line, and another session's writer can do so at any
// moment, so checking the tail first would race. Every entry therefore starts
// on a fresh line; readers skip the blank lines this leaves.
function appendIndexLine(path: string, line: string): void {
  hook('finalize:before-index-append');
  appendFileSync(path, '\n' + line + '\n');
}

const TICKET = /^final\.(\d+)\.json$/;

function takeTicket(dir: string, role: 'writer' | 'sweep'): boolean {
  const body = JSON.stringify({ ...selfIdentity(), role, at: new Date().toISOString() });
  if (role === 'writer') return publishExclusive(join(dir, 'final.0.json'), body);
  let max = -1;
  for (const f of readdirSync(dir)) {
    const m = TICKET.exec(f);
    if (!m) continue;
    max = Math.max(max, Number(m[1]));
    let holder: ProcIdentity | null = null;
    try { holder = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { /* unreadable: cannot tell */ }
    if (!holder || liveness(holder) !== 'gone') return false;
  }
  return publishExclusive(join(dir, `final.${max + 1}.json`), body);
}

export function finalizeSession(root: string, id: string, o: FinalizeOpts): IndexEntry | null {
  const log = o.log ?? ((m: string) => console.error(m));
  const dir = join(root, 'sessions', id);
  if (!takeTicket(dir, o.role)) {
    if (o.role === 'writer') log(`agentlens: session ${id} is already being finalized by another process; not finalized again`);
    return null;
  }
  hook('finalize:after-ticket');
  if (indexedIds(root).has(id)) return null;

  let meta: SessionMeta = o.meta ?? JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const nativeIds = new Set([...(meta.nativeSessionIds ?? []), ...(o.nativeSessionIds ?? [])]);

  const claims = meta.capture === 'logs' ? (o.claims ?? claimsOf(listClaims(root), id)) : [];
  if (claims.length) {
    const events: NormalizedEvent[] = [];
    for (const [i, c] of claims.entries()) {
      const copy = join(dir, `rollout-${i + 1}.jsonl`);
      const p = o.prepared?.get(c.rollout);
      o.prepared?.delete(c.rollout);
      let got: ReturnType<typeof readClaimed>;
      try { got = readClaimed(c.rollout, p); }
      catch (e) {
        if (!existsSync(copy)) { log(`agentlens: claimed rollout unreadable, not counted: ${c.rollout} (${(e as Error).message})`); continue; }
        const text = readFileSync(copy, 'utf8');
        got = { scan: scanRollout(text), commit: () => {} };
      }
      for (const ev of got.scan.events) events.push({ ...ev, seq: events.length + 1 });
      if (got.scan.nativeId) nativeIds.add(got.scan.nativeId);
      got.commit(copy);
      writeAtomic(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''));
      if (i === 0 && claims.length > 1) hook('finalize:after-partial-events');
    }
  }

  for (const p of o.prepared?.values() ?? []) rmSync(p.tmp, { force: true });
  o.prepared?.clear();

  const endedAt = o.endedAt ?? new Date().toISOString();
  const nativeSessionIds = nativeIds.size ? [...nativeIds] : undefined;
  meta = { ...meta, endedAt, exitCode: o.exitCode, nativeSessionIds, ...(o.recovered ? { recovered: true as const } : {}) };
  writeAtomic(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));

  const events = readLines<NormalizedEvent>(join(dir, 'events.jsonl'));
  let totals = emptyUsage();
  const models = new Set<string>();
  for (const e of events) { totals = addUsage(totals, e.usage); models.add(e.model); }
  const entry: IndexEntry = {
    id, runtime: meta.runtime, tags: meta.tags,
    models: [...models], startedAt: meta.startedAt, endedAt, exitCode: o.exitCode,
    totals: { ...totals, requests: events.length },
    nativeSessionIds,
    ...(o.recovered ? { recovered: true as const } : {}),
  };
  appendIndexLine(join(root, 'index.jsonl'), JSON.stringify(entry));
  return entry;
}

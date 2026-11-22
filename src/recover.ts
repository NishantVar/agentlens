// Recovery sweep: finalize sessions whose `lens run` died without saving.
// Runs from `lens recover`, `stats`, `sessions`, `report` and the dashboard's
// /api/data; never from `run`, `import` or `compact`. Fail-open throughout.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { claimsOf, listClaims, nameUnclaimed, readHolders, type ClaimRecord } from './claims.js';
import { finalizeSession, indexedIds } from './finalize.js';
import { liveness, type ProcIdentity } from './procinfo.js';
import { storeRoot } from './store.js';
import { hook } from './testHooks.js';
import type { SessionMeta } from './types.js';

export const LEGACY_IDLE_MS = 60 * 60 * 1000;

export interface SweepSummary { recovered: number; skipped: number; errors: number }
export interface SweepOpts { now?: number; log?: (m: string) => void }

function newestMtime(dir: string): number {
  let t = statSync(dir).mtimeMs;
  for (const f of readdirSync(dir)) t = Math.max(t, statSync(join(dir, f)).mtimeMs);
  return t;
}

export function sweepStore(root: string = storeRoot(), o: SweepOpts = {}): SweepSummary {
  const log = o.log ?? ((m: string) => { try { console.error(m); } catch { /* stderr gone */ } });
  const sum: SweepSummary = { recovered: 0, skipped: 0, errors: 0 };
  try {
    const sessions = join(root, 'sessions');
    if (!existsSync(sessions)) return sum;
    // Prefilter on the index only. A finalizer that died after writing meta
    // leaves endedAt set with no index line, so endedAt cannot narrow here.
    const indexed = indexedIds(root);
    const candidates = readdirSync(sessions).filter((id) => !indexed.has(id));
    if (!candidates.length) return sum;
    const now = o.now ?? Date.now();
    for (const id of candidates) {
      try {
        hook('recover:before-gate');
        const dir = join(sessions, id);
        const meta: SessionMeta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
        let eligible: boolean;
        let allClaims: ClaimRecord[] = [];
        let mine: ClaimRecord[] = [];
        if (meta.wrapper) {
          // Only the wrapper publishes this session's claims and holders, so
          // they are read after it is known gone: then the set is final.
          eligible = liveness(meta.wrapper) === 'gone';
          if (eligible) {
            allClaims = listClaims(root);
            mine = claimsOf(allClaims, id);
            const holders: ProcIdentity[] = [...mine.flatMap((c) => c.holders), ...readHolders(root, id)];
            eligible = holders.every((h) => liveness(h) === 'gone');
          }
        } else {
          eligible = now - newestMtime(dir) >= LEGACY_IDLE_MS; // legacy: no identity recorded
          // An import interrupted after its claim: count the claimed rollout in
          // full, as import would have, so the claim does not strand its usage.
          if (eligible && meta.source?.kind === 'import' && meta.capture === 'logs') mine = claimsOf(listClaims(root), id);
        }
        if (!eligible) { sum.skipped++; continue; }
        hook('recover:after-gate');
        const entry = finalizeSession(root, id, { exitCode: null, role: 'sweep', recovered: true, claims: mine, log });
        if (!entry) { sum.skipped++; continue; }
        sum.recovered++;
        if (meta.capture === 'logs' && meta.wrapper) nameUnclaimed(root, meta, log, allClaims);
      } catch (e) {
        sum.errors++;
        log(`agentlens: recover skipped session ${id} (unreadable): ${(e as Error).message}`);
      }
    }
  } catch (e) {
    sum.errors++;
    log(`agentlens: recover failed (fail-open): ${(e as Error).message}`);
  }
  return sum;
}

export const sweepLine = (s: SweepSummary) =>
  `recovered ${s.recovered} unsaved sessions, skipped ${s.skipped} (still running or recent)${s.errors ? `, ${s.errors} errors` : ''}`;

// The automatic sweep before a read command: one summary line, only when it did something.
export function autoSweep(root?: string): void {
  const s = sweepStore(root);
  if (s.recovered || s.errors) { try { console.error(`agentlens: ${sweepLine(s)}`); } catch { /* stderr gone */ } }
}

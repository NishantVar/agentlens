import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { forEachLine, packPair, readBlobs, storeRoot, unpackPair } from './store.js';
import type { RawPair } from './types.js';

export interface CompactSummary { compacted: number; skippedActive: number; errors: number; bytesBefore: number; bytesAfter: number }

// Rewrites a finished session's raw.jsonl with packed bodies (see blobs.ts).
// Returns null when nothing in it needed packing. The original is only
// replaced, by rename, after every line has been verified to unpack to the
// exact body it had.
function compactSession(dir: string): { before: number; after: number } | 'grew' | null {
  const rawPath = join(dir, 'raw.jsonl');
  const orig = statSync(rawPath);
  const before = orig.size;
  const tmpPath = rawPath + '.compact-tmp';
  const blobsPath = join(dir, 'blobs.jsonl');
  const blobs = readBlobs(dir);
  const seen = new Set(blobs.keys());
  let changed = false;
  const fd = openSync(tmpPath, 'w', 0o600);
  try {
    forEachLine(rawPath, (line) => {
      if (!line.trim()) return;
      let out = line;
      try {
        const p = JSON.parse(line) as RawPair & { request?: { packed?: true } };
        if (p.request && !p.request.packed && typeof p.request.body === 'string') {
          const fresh: { h: string; v: unknown }[] = [];
          const stored = packPair(p, seen, (h, v) => { fresh.push({ h, v }); blobs.set(h, v); });
          if (stored !== p && unpackPair(stored, blobs).request.body === p.request.body) {
            if (fresh.length) appendFileSync(blobsPath, fresh.map((b) => JSON.stringify(b)).join('\n') + '\n');
            out = JSON.stringify(stored);
            changed = true;
          }
        }
      } catch { /* corrupt line — keep verbatim */ }
      writeSync(fd, out + '\n');
    });
  } finally { closeSync(fd); }
  if (!changed) { rmSync(tmpPath, { force: true }); return null; }
  // A writer woke up mid-rewrite: renaming now would drop its new lines.
  if (statSync(rawPath).size !== before) { rmSync(tmpPath, { force: true }); return 'grew'; }
  renameSync(tmpPath, rawPath);
  // Keep the original mtime: it's how an unfinalized session's idleness is judged.
  utimesSync(rawPath, orig.atime, orig.mtime);
  return { before, after: statSync(rawPath).size + (existsSync(blobsPath) ? statSync(blobsPath).size : 0) };
}

// An unfinalized session idle this long is a dead run (killed before
// finalize), not a live writer.
const IDLE_MS = 60 * 60 * 1000;

export function compactStore(root: string = storeRoot(), log?: (msg: string) => void, now = Date.now()): CompactSummary {
  const sum: CompactSummary = { compacted: 0, skippedActive: 0, errors: 0, bytesBefore: 0, bytesAfter: 0 };
  const sessions = join(root, 'sessions');
  if (!existsSync(sessions)) return sum;
  for (const id of readdirSync(sessions).sort()) {
    const dir = join(sessions, id);
    if (!existsSync(join(dir, 'raw.jsonl'))) continue;
    try {
      const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
      // A live writer may still be appending; leave it alone.
      if (!meta.endedAt && now - statSync(join(dir, 'raw.jsonl')).mtimeMs < IDLE_MS) { sum.skippedActive++; continue; }
      const r = compactSession(dir);
      if (r === 'grew') { sum.skippedActive++; continue; }
      if (!r) continue;
      sum.compacted++; sum.bytesBefore += r.before; sum.bytesAfter += r.after;
      log?.(`${id}: ${mb(r.before)} -> ${mb(r.after)}`);
    } catch (e) {
      sum.errors++;
      rmSync(join(dir, 'raw.jsonl.compact-tmp'), { force: true });
      log?.(`${id}: failed, left as-is: ${(e as Error).message}`);
    }
  }
  return sum;
}

export const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

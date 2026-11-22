import { copyFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SessionWriter, StoreReader, newSessionId, storeRoot } from './store.js';
import { claudeProjectsRoot, extractClaudeSessionIdFromRawBody, findClaudeTranscripts, parseClaudeTranscript } from './claudeTranscript.js';
import { listCodexRollouts, rolloutNativeSessionId } from './codexRollout.js';
import { hasClaim } from './claims.js';
import { parseSince } from './query.js';
import { resolveTags } from './tags.js';
import type { NormalizedEvent, Runtime } from './types.js';

const LENS_VERSION = '0.1.0';

export interface ImportOptions { runtime?: Runtime; since?: string; tag: string[] }
export interface ImportSummary { imported: number; skippedExisting: number; skippedEmpty: number; errors: number }

interface Candidate { nativeSessionId?: string; cwd?: string; startedAt?: string; endedAt?: string; events: NormalizedEvent[] }

// Native ids already in the store. Legacy entries (pre-nativeSessionIds) get
// their ids recovered once from stored artifacts; unrecoverable ones are
// treated as unknown (fail-open — no silent guessing).
function knownNativeIds(reader: StoreReader, root: string): Set<string> {
  const known = new Set<string>();
  for (const e of reader.listIndex()) {
    if (e.nativeSessionIds) {
      for (const id of e.nativeSessionIds) known.add(`${e.runtime}:${id}`);
      continue;
    }
    try {
      if (e.runtime === 'claude') {
        for (const pair of reader.readRaw(e.id)) {
          const id = extractClaudeSessionIdFromRawBody(pair.request.body);
          if (id) { known.add(`claude:${id}`); break; }
        }
      } else {
        const dir = join(root, 'sessions', e.id);
        for (const f of readdirSync(dir)) {
          if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
          const id = rolloutNativeSessionId(readFileSync(join(dir, f), 'utf8'));
          if (id) known.add(`codex:${id}`);
        }
      }
    } catch { /* legacy session unreadable — treat as unknown */ }
  }
  return known;
}

export function runImport(opts: ImportOptions): ImportSummary {
  const root = storeRoot();
  const reader = new StoreReader(root);
  const since = opts.since ? parseSince(opts.since) : undefined;
  const tags = resolveTags(opts.tag, process.env.AGENTLENS_TAGS);
  const known = knownNativeIds(reader, root);
  const sum: ImportSummary = { imported: 0, skippedExisting: 0, skippedEmpty: 0, errors: 0 };

  const consider = (runtime: Runtime, sourcePath: string, copyName: string, c: Candidate) => {
    if (since && (!c.startedAt || new Date(c.startedAt) < since)) return; // out of scope, not counted
    if (c.events.length === 0) { sum.skippedEmpty++; return; }
    if (!c.nativeSessionId) {
      sum.errors++;
      console.error(`agentlens: ${sourcePath} has no session id — cannot dedup, skipped`);
      return;
    }
    if (known.has(`${runtime}:${c.nativeSessionId}`)) { sum.skippedExisting++; return; }
    const writer = new SessionWriter(root, {
      id: newSessionId(), runtime, capture: 'logs', tags, cwd: c.cwd ?? '', argv: [],
      lensVersion: LENS_VERSION, startedAt: c.startedAt ?? new Date().toISOString(),
      nativeSessionIds: [c.nativeSessionId], source: { kind: 'import', path: sourcePath },
    });
    for (const [i, ev] of c.events.entries()) writer.appendEvent({ ...ev, seq: i + 1 });
    try {
      copyFileSync(sourcePath, join(root, 'sessions', writer.id, copyName));
    } catch (e) {
      console.error(`agentlens: source copy failed (fail-open): ${(e as Error).message}`);
    }
    writer.finalize(0, { endedAt: c.endedAt });
    known.add(`${runtime}:${c.nativeSessionId}`);
    sum.imported++;
  };

  if (opts.runtime !== 'codex') {
    for (const path of findClaudeTranscripts(claudeProjectsRoot())) {
      try {
        const p = parseClaudeTranscript(readFileSync(path, 'utf8'));
        consider('claude', path, 'transcript.jsonl', { ...p, nativeSessionId: p.sessionId });
      } catch (e) {
        sum.errors++;
        console.error(`agentlens: import failed for ${path} (skipped): ${(e as Error).message}`);
      }
    }
  }
  if (opts.runtime !== 'claude') {
    for (const r of listCodexRollouts()) {
      try {
        // A claimed rollout belongs to a `lens run` session, finalized or not.
        if (hasClaim(root, r.rolloutPath)) { sum.skippedExisting++; continue; }
        consider('codex', r.rolloutPath, 'rollout-1.jsonl', r);
      } catch (e) {
        sum.errors++;
        console.error(`agentlens: import failed for ${r.rolloutPath} (skipped): ${(e as Error).message}`);
      }
    }
  }
  return sum;
}

import { copyFileSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { SessionWriter, StoreReader, newSessionId, storeRoot } from './store.js';
import { claudeProjectsRoot, extractClaudeSessionIdFromRawBody, findClaudeTranscripts, parseClaudeTranscript } from './claudeTranscript.js';
import { listCodexRollouts, rolloutNativeSessionId } from './codexRollout.js';
import { codexSessionsRoot, hasClaim, writersOf } from './claims.js';
import { descendantsIn, liveness, procTable } from './procinfo.js';
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

// Rollouts that a process in a live `lens run` Codex session's tree holds open
// for writing. That wrapper will claim them, so importing one now would count
// it twice; it is left to its session. Rollouts written outside any `lens run`
// are unaffected. Without open-file evidence nothing is held back (fail-open).
async function wrappedLiveRollouts(reader: StoreReader): Promise<Set<string>> {
  const wrappers = reader.listActive().filter((m) => m.runtime === 'codex' && m.capture === 'logs' && m.wrapper && liveness(m.wrapper) !== 'gone');
  if (!wrappers.length) return new Set();
  let rootReal: string | null = null;
  try { rootReal = realpathSync(codexSessionsRoot()); } catch { return new Set(); }
  const table = await procTable();
  const roots = wrappers.map((m) => m.wrapper!.pid);
  const pids = table ? [...roots, ...descendantsIn(table, roots)] : roots;
  const ev = await writersOf(pids, rootReal);
  if (!ev.ok) {
    console.error(`agentlens: cannot read open-file evidence (${ev.reason}); rollouts of running \`lens run\` sessions may be imported`);
    return new Set();
  }
  return new Set(ev.held.map((h) => h.path));
}

export async function runImport(opts: ImportOptions): Promise<ImportSummary> {
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
    // List first, then look: a rollout created after the look is not listed.
    const rollouts = listCodexRollouts();
    const held = await wrappedLiveRollouts(reader);
    for (const r of rollouts) {
      try {
        // A claimed rollout belongs to a `lens run` session, finalized or not;
        // so does one a running session's tree is writing but has not claimed yet.
        if (hasClaim(root, r.rolloutPath)) { sum.skippedExisting++; continue; }
        let real = r.rolloutPath;
        try { real = realpathSync(r.rolloutPath); } catch { /* compare as listed */ }
        if (held.has(real)) { sum.skippedExisting++; continue; }
        consider('codex', r.rolloutPath, 'rollout-1.jsonl', r);
      } catch (e) {
        sum.errors++;
        console.error(`agentlens: import failed for ${r.rolloutPath} (skipped): ${(e as Error).message}`);
      }
    }
  }
  return sum;
}

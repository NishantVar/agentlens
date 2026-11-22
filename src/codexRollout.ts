import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedEvent } from './types.js';

export interface CollectOpts { sessionsRoot?: string; cwd?: string }
export interface CollectedSession { rolloutPath: string; events: NormalizedEvent[]; nativeSessionId?: string }

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const n = (v: unknown): number => (typeof v === 'number' ? v : 0);

function lines(jsonlText: string): Any[] {
  const out: Any[] = [];
  for (const line of jsonlText.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

// One pass over rollout text: usage events plus the native session id (from the
// first session_meta). `from` continues a scan of the text before this chunk, so
// a rollout can be read in two parts that end and start on a line boundary.
export interface RolloutScan { events: NormalizedEvent[]; model: string; sawMeta: boolean; nativeId?: string }
export function scanRollout(jsonlText: string, from?: RolloutScan): RolloutScan {
  const events: NormalizedEvent[] = [];
  let model = from?.model ?? 'unknown';
  let sawMeta = from?.sawMeta ?? false;
  let nativeId = from?.nativeId;
  for (const d of lines(jsonlText)) {
    if (!sawMeta && d?.type === 'session_meta') { sawMeta = true; if (typeof d.payload?.id === 'string') nativeId = d.payload.id; }
    if (d?.type === 'turn_context' && d.payload?.model) model = d.payload.model;
    if (d?.type === 'event_msg' && d.payload?.type === 'token_count') {
      const u = d.payload.info?.last_token_usage;
      if (!u) continue;
      const cached = n(u.cached_input_tokens);
      events.push({
        ts: d.timestamp ?? '', seq: events.length + 1, kind: 'api_call', model,
        usage: { input: n(u.input_tokens) - cached, output: n(u.output_tokens), cacheRead: cached, cacheWrite: 0, reasoning: n(u.reasoning_output_tokens) },
        durationMs: 0, status: 200,
      });
    }
  }
  return { events, model, sawMeta, nativeId };
}

export const parseRollout = (jsonlText: string): NormalizedEvent[] => scanRollout(jsonlText).events;

export function extractMessages(jsonlText: string): { role: string; text: string }[] {
  const out: { role: string; text: string }[] = [];
  for (const d of lines(jsonlText)) {
    if (d?.type !== 'response_item' || d.payload?.type !== 'message') continue;
    const content: Any[] = Array.isArray(d.payload.content) ? d.payload.content : [];
    out.push({ role: String(d.payload.role ?? 'unknown'), text: content.map((c) => (typeof c?.text === 'string' ? c.text : `[${c?.type ?? 'unknown'}]`)).join('\n') });
  }
  return out;
}

function findRollouts(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch (e) { console.error(`agentlens: skipping unreadable dir ${dir}: ${(e as Error).message}`); return out; }
  for (const name of entries) {
    const p = join(dir, name.name);
    if (name.isDirectory()) out.push(...findRollouts(p));
    else if (name.name.startsWith('rollout-') && name.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

export function rolloutNativeSessionId(jsonlText: string): string | undefined {
  const meta = lines(jsonlText).find((d) => d?.type === 'session_meta');
  return typeof meta?.payload?.id === 'string' ? meta.payload.id : undefined;
}

export interface RolloutInfo { rolloutPath: string; nativeSessionId?: string; cwd?: string; startedAt?: string; endedAt?: string; events: NormalizedEvent[] }

export function listCodexRollouts(opts: { sessionsRoot?: string } = {}): RolloutInfo[] {
  const root = opts.sessionsRoot ?? process.env.AGENTLENS_CODEX_SESSIONS ?? join(homedir(), '.codex', 'sessions');
  if (!existsSync(root)) return [];
  const out: RolloutInfo[] = [];
  for (const path of findRollouts(root)) {
    try {
      const text = readFileSync(path, 'utf8');
      const ls = lines(text);
      const meta = ls.find((d) => d?.type === 'session_meta');
      const last = ls.at(-1);
      out.push({
        rolloutPath: path,
        nativeSessionId: typeof meta?.payload?.id === 'string' ? meta.payload.id : undefined,
        cwd: typeof meta?.payload?.cwd === 'string' ? meta.payload.cwd : undefined,
        startedAt: typeof (meta?.payload?.timestamp ?? meta?.timestamp) === 'string' ? (meta?.payload?.timestamp ?? meta?.timestamp) : undefined,
        endedAt: typeof last?.timestamp === 'string' ? last.timestamp : undefined,
        events: parseRollout(text),
      });
    } catch (e) {
      console.error(`agentlens: skipping unreadable rollout ${path}: ${(e as Error).message}`);
    }
  }
  return out;
}

export function collectCodexSessions(startedAt: Date, opts: CollectOpts = {}): CollectedSession[] {
  const root = opts.sessionsRoot ?? process.env.AGENTLENS_CODEX_SESSIONS ?? join(homedir(), '.codex', 'sessions');
  if (!existsSync(root)) return [];
  const cutoff = startedAt.getTime() - 2000;
  const out: CollectedSession[] = [];
  try {
    for (const path of findRollouts(root)) {
      if (statSync(path).mtimeMs < cutoff) continue;
      const text = readFileSync(path, 'utf8');
      const parsed = lines(text);
      const meta = parsed.find((d) => d?.type === 'session_meta');
      if (opts.cwd && meta?.payload?.cwd !== opts.cwd) continue;
      const events = parseRollout(text);
      if (events.length === 0 && extractMessages(text).length === 0) continue;
      out.push({ rolloutPath: path, events, nativeSessionId: typeof meta?.payload?.id === 'string' ? meta.payload.id : undefined });
    }
  } catch (e) {
    console.error(`agentlens: codex rollout collection failed (fail-open): ${(e as Error).message}`);
  }
  return out;
}

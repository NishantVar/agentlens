import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedEvent, Usage } from './types.js';

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

export interface ParsedTranscript { sessionId?: string; cwd?: string; startedAt?: string; endedAt?: string; events: NormalizedEvent[] }

// One API call is streamed as several assistant lines sharing a requestId, all
// repeating the same usage — count once per requestId (last line wins).
export function parseClaudeTranscript(jsonlText: string): ParsedTranscript {
  const byRequest = new Map<string, { ts: string; model: string; usage: Usage }>();
  let sessionId: string | undefined, cwd: string | undefined;
  let startedAt: string | undefined, endedAt: string | undefined;
  for (const d of lines(jsonlText)) {
    if (!sessionId && typeof d?.sessionId === 'string') sessionId = d.sessionId;
    if (!cwd && typeof d?.cwd === 'string') cwd = d.cwd;
    if (typeof d?.timestamp === 'string') { startedAt ??= d.timestamp; endedAt = d.timestamp; }
    if (d?.type !== 'assistant' || typeof d.requestId !== 'string') continue;
    const u = d.message?.usage;
    if (!u) continue;
    byRequest.set(d.requestId, {
      ts: typeof d.timestamp === 'string' ? d.timestamp : '',
      model: typeof d.message?.model === 'string' ? d.message.model : 'unknown',
      usage: { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens), reasoning: 0 },
    });
  }
  const events = [...byRequest.values()].map((e, i): NormalizedEvent => ({
    ts: e.ts, seq: i + 1, kind: 'api_call', model: e.model, usage: e.usage, durationMs: 0, status: 200,
  }));
  return { sessionId, cwd, startedAt, endedAt, events };
}

// Claude Code carries the session id in metadata.user_id on every /v1/messages
// request; recover it from a recorded raw request body. Handles both the legacy
// "_session_<uuid>" suffix form and the current JSON-encoded {"session_id":"<uuid>"}
// form (where user_id is itself a JSON string, so quotes appear backslash-escaped).
export function extractClaudeSessionIdFromRawBody(requestBody: string): string | undefined {
  const m = /_session_([0-9a-f-]{36})/.exec(requestBody)
    ?? /session_id\\?"\s*:\s*\\?"([0-9a-f-]{36})/.exec(requestBody);
  return m?.[1];
}

export function claudeProjectsRoot(): string {
  return process.env.AGENTLENS_CLAUDE_PROJECTS ?? join(homedir(), '.claude', 'projects');
}

export function findClaudeTranscripts(root: string = claudeProjectsRoot()): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root);
  return out;
}

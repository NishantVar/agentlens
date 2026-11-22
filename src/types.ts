export interface Usage {
  input: number;      // uncached input tokens
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;  // informational; subset of output for OpenAI
}
export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
export const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input, output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite,
  reasoning: a.reasoning + b.reasoning,
});

export type Runtime = 'claude' | 'codex';

export interface SessionMeta {
  id: string;
  runtime: Runtime;
  capture: 'proxy' | 'logs';   // how this session's data was captured
  tags: Record<string, string>;
  cwd: string;
  argv: string[];        // the wrapped command, e.g. ["claude","-p","hi"]
  lensVersion: string;
  startedAt: string;     // ISO 8601
  endedAt?: string;
  exitCode?: number | null;     // null: recovered, the child's status is unknown
  recovered?: true;             // finalized by a recovery sweep, not its own wrapper
  wrapper?: { pid: number; startTime: string | null };  // the `lens run` process, for liveness (null start: ps failed)
  nativeSessionIds?: string[];  // native ids of the underlying CLI session(s)
  source?: { kind: 'import'; path: string };
}

export interface RawPair {
  seq: number;
  ts: string;
  durationMs: number;
  request: { method: string; path: string; headers: Record<string, string>; body: string };
  response: { status: number; headers: Record<string, string>; body: string };
}

export interface NormalizedEvent {
  ts: string;
  seq: number;           // matches RawPair.seq
  kind: 'api_call';
  model: string;
  usage: Usage;
  durationMs: number;
  status: number;
}

export interface SessionTotals extends Usage { requests: number }

export interface IndexEntry {
  id: string;
  runtime: Runtime;
  tags: Record<string, string>;
  models: string[];
  startedAt: string;
  endedAt: string;
  exitCode: number | null;  // null only on a recovered entry
  totals: SessionTotals;
  nativeSessionIds?: string[];
  recovered?: true;
}

import { basename } from 'node:path';
import { normalizeAnthropic, type ModelCall } from './normalize.js';
import { collectCodexSessions, type CollectOpts, type CollectedSession } from './codexRollout.js';
import type { RawPair, Runtime } from './types.js';

export interface ProxyAdapter {
  name: Runtime;
  mode: 'proxy';
  upstream: string;
  env(proxyOrigin: string): Record<string, string>;
  normalize(pair: Pick<RawPair, 'request' | 'response'>): ModelCall | null;
}
export interface LogsAdapter {
  name: Runtime;
  mode: 'logs';
  collect(startedAt: Date, opts?: CollectOpts): CollectedSession[];
}
export type RuntimeAdapter = ProxyAdapter | LogsAdapter;

const claude: ProxyAdapter = {
  name: 'claude',
  mode: 'proxy',
  upstream: 'https://api.anthropic.com',
  env: (o) => ({ ANTHROPIC_BASE_URL: o }),
  normalize: (p) => normalizeAnthropic(p.response.headers['content-type'], p.response.body),
};

// codex model calls ride a hardcoded WebSocket (see spikes/FINDINGS.md) — not proxyable.
// Capture comes from codex's native session rollouts instead.
const codex: LogsAdapter = {
  name: 'codex',
  mode: 'logs',
  collect: (startedAt, opts) => collectCodexSessions(startedAt, opts),
};

const adapters: Record<Runtime, RuntimeAdapter> = { claude, codex };

export function detectRuntime(argv0: string): Runtime {
  const b = basename(argv0);
  if (b === 'claude' || b === 'codex') return b;
  throw new Error(`unsupported runtime "${b}" — supported: claude, codex`);
}

export function getAdapter(rt: Runtime): RuntimeAdapter {
  return adapters[rt];
}

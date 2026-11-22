import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { storeRoot } from './store.js';
import type { Usage } from './types.js';

// USD per million tokens. cacheWrite is the shorter-duration write rate (Anthropic
// 5m, OpenAI 30m); cacheWriteLong the longer one (Anthropic 1h, OpenAI 12h), and
// absent means every write is priced at cacheWrite. `long`, when present, replaces
// every rate for a request whose prompt (input + cache reads + cache writes)
// exceeds `threshold` tokens.
export interface Rates { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWriteLong?: number }
export interface ModelPrice extends Rates { long?: Rates & { threshold: number } }

// Standard global rates as published 2026-11-22:
// https://platform.claude.com/docs/en/about-claude/pricing
// https://developers.openai.com/api/docs/pricing
// OpenAI's 272K threshold is assumed to count cached input.
const openaiLong = (input: number, output: number, cacheRead: number, cacheWrite: number, cacheWriteLong: number) =>
  ({ threshold: 272_000, input, output, cacheRead, cacheWrite, cacheWriteLong });
const BUILTIN: Record<string, ModelPrice> = {
  'claude-opus-4':   { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4':  { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'gpt-5':           { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  'claude-fable-5-2':  { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10, cacheWriteLong: 16 },
  'claude-opus-5-5':   { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWriteLong: 8 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWriteLong: 4 },
  'claude-haiku-5-5':  { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, cacheWriteLong: 0.2,
    long: { threshold: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625, cacheWriteLong: 1 } },
  'gpt-6.2-astra': { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10, cacheWriteLong: 20, long: openaiLong(16, 60, 0.8, 20, 40) },
  'gpt-6.2-sol':   { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWriteLong: 5, long: openaiLong(4, 15, 0.2, 5, 10) },
  'gpt-6.1-sol':   { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWriteLong: 5, long: openaiLong(4, 15, 0.2, 5, 10) },
  'gpt-6-astra':   { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheWriteLong: 25, long: openaiLong(20, 75, 2, 25, 50) },
  'gpt-6-luna':    { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, cacheWriteLong: 0.25, long: openaiLong(0.2, 0.75, 0.02, 0.25, 0.5) },
};

export function loadPricing(): Record<string, ModelPrice> {
  const userPath = join(storeRoot(), 'pricing.json');
  let user: Record<string, ModelPrice> = {};
  if (existsSync(userPath)) {
    try { user = JSON.parse(readFileSync(userPath, 'utf8')); } catch (e) { console.error(`agentlens: bad pricing.json ignored: ${(e as Error).message}`); }
  }
  return { ...BUILTIN, ...user };
}

export function priceFor(model: string, table: Record<string, ModelPrice>): ModelPrice | null {
  let best: string | null = null;
  for (const key of Object.keys(table)) {
    if (model.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? table[best] : null;
}

// Each request is priced on its own: its prompt length picks the tier, and its
// longer-duration writes (if known and priced) take the longer write rate.
export function costUsd(u: Usage, p: ModelPrice): number {
  const r: Rates = p.long && u.input + u.cacheRead + u.cacheWrite > p.long.threshold ? p.long : p;
  const writeLong = Math.min(u.cacheWriteLong ?? 0, u.cacheWrite);
  const writes = (u.cacheWrite - writeLong) * r.cacheWrite + writeLong * (r.cacheWriteLong ?? r.cacheWrite);
  return (u.input * r.input + u.output * r.output + u.cacheRead * r.cacheRead + writes) / 1e6;
}

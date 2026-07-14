import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { storeRoot } from './store.js';
import type { Usage } from './types.js';

export interface ModelPrice { input: number; output: number; cacheRead: number; cacheWrite: number }

const BUILTIN: Record<string, ModelPrice> = {
  'claude-opus-4':   { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4':  { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'gpt-5':           { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
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

export function costUsd(u: Usage, p: ModelPrice): number {
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1e6;
}

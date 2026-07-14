import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { costUsd, loadPricing, priceFor } from '../src/pricing.js';

beforeEach(() => { process.env.AGENTLENS_HOME = mkdtempSync(join(tmpdir(), 'agentlens-')); });

describe('pricing', () => {
  it('matches by longest prefix', () => {
    const t = loadPricing();
    expect(priceFor('claude-opus-4-1-20250805', t)?.output).toBe(75);
    expect(priceFor('gpt-5-codex', t)?.input).toBe(1.25);
    expect(priceFor('unknown-model', t)).toBeNull();
  });
  it('user pricing.json overrides builtin and adds models', () => {
    writeFileSync(join(process.env.AGENTLENS_HOME!, 'pricing.json'),
      JSON.stringify({ 'gpt-5': { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 }, 'my-model': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }));
    const t = loadPricing();
    expect(priceFor('gpt-5-codex', t)?.input).toBe(9);
    expect(priceFor('my-model-v2', t)?.input).toBe(1);
  });
  it('computes cost per million tokens', () => {
    expect(costUsd({ input: 1_000_000, output: 0, cacheRead: 2_000_000, cacheWrite: 0, reasoning: 0 }, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })).toBeCloseTo(3.6);
  });
});

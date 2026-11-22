// ALF-14: built-in prices for today's models, priced per request the way each
// model's page prices it (prompt-length tier, cache-write duration). Expected
// costs are worked by hand from the vendor pages' published rates (USD/MTok).
import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { costUsd, loadPricing, priceFor } from '../src/pricing.js';
import { normalizeAnthropic } from '../src/normalize.js';
import { parseClaudeTranscript } from '../src/claudeTranscript.js';
import { parseRollout } from '../src/codexRollout.js';
import { statsCommand } from '../src/stats.js';
import { SessionWriter, StoreReader } from '../src/store.js';
import type { SessionMeta, Usage } from '../src/types.js';
import { tmp } from './helpers/lens.js';

let home: string;
beforeEach(() => { home = tmp('agentlens-price-'); process.env.AGENTLENS_HOME = home; });

const LISTED = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2',
  'gpt-6.1-sol', 'gpt-6.2-sol', 'gpt-6-astra', 'gpt-6.2-astra', 'gpt-6-luna'];

// Standard rates from the pages retrieved 2026-11-22.
const PAGE: Record<string, object> = {
  'claude-fable-5-2':  { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10, cacheWriteLong: 16 },
  'claude-opus-5-5':   { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWriteLong: 8 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWriteLong: 4 },
  'claude-haiku-5-5':  { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, cacheWriteLong: 0.2,
    long: { threshold: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625, cacheWriteLong: 1 } },
  'gpt-6.2-astra': { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10, cacheWriteLong: 20,
    long: { threshold: 272_000, input: 16, output: 60, cacheRead: 0.8, cacheWrite: 20, cacheWriteLong: 40 } },
  'gpt-6.2-sol':   { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWriteLong: 5,
    long: { threshold: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5, cacheWriteLong: 10 } },
  'gpt-6.1-sol':   { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWriteLong: 5,
    long: { threshold: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5, cacheWriteLong: 10 } },
  'gpt-6-astra':   { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheWriteLong: 25,
    long: { threshold: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25, cacheWriteLong: 50 } },
  'gpt-6-luna':    { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, cacheWriteLong: 0.25,
    long: { threshold: 272_000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25, cacheWriteLong: 0.5 } },
};

const u = (input: number, output: number, cacheRead: number, cacheWrite: number, cacheWriteLong?: number): Usage =>
  ({ input, output, cacheRead, cacheWrite, reasoning: 0, ...(cacheWriteLong === undefined ? {} : { cacheWriteLong }) });
const cost = (model: string, usage: Usage) => costUsd(usage, priceFor(model, loadPricing())!);

function session(id: string, model: string, usages: Usage[]) {
  const meta: SessionMeta = { id, runtime: 'claude', capture: 'proxy', tags: {}, cwd: '/', argv: ['claude'], lensVersion: '0', startedAt: new Date().toISOString() };
  const w = new SessionWriter(home, meta);
  usages.forEach((usage, i) => w.appendEvent({ ts: meta.startedAt, seq: i + 1, kind: 'api_call', model, usage, durationMs: 1, status: 200 }));
  w.finalize(0);
}
const statsCost = () => JSON.parse(statsCommand({ tag: [], json: true }, new StoreReader(home))).rows[0].costUsd as number;

describe('ALF-14 built-in entries', () => {
  it('ALF-14 [exact-id] each listed id resolves to its own entry with the page rates', () => {
    const table = loadPricing();
    for (const id of LISTED) {
      expect(Object.keys(table)).toContain(id);
      expect(priceFor(id, table), id).toEqual(PAGE[id]);
    }
  });
  it('ALF-14 [no-cross-match] no built-in key is a shorter prefix of a listed id, and no listed id prices another', () => {
    const keys = Object.keys(loadPricing());
    for (const id of LISTED) for (const k of keys) if (k !== id) expect(id.startsWith(k), `${k} prefixes ${id}`).toBe(false);
  });
  it('ALF-14 [dated-variant] a dated variant resolves to its id\'s entry', () => {
    const table = loadPricing();
    expect(priceFor('claude-opus-5-5-20261101', table)).toEqual(PAGE['claude-opus-5-5']);
    expect(priceFor('gpt-6.2-sol-2026-10-01', table)).toEqual(PAGE['gpt-6.2-sol']);
  });
  it('ALF-14 [override] a pricing.json entry for a listed id wins', () => {
    writeFileSync(`${home}/pricing.json`, JSON.stringify({ 'claude-sonnet-5-5': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }));
    expect(priceFor('claude-sonnet-5-5', loadPricing())).toEqual({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 });
  });
});

describe('ALF-14 per-request pricing', () => {
  it('ALF-14 [long-boundary] Haiku 5.5 is base at exactly 100,000 prompt tokens and long at 100,001', () => {
    // 40,000 input + 50,000 cache read + 10,000 cache write = 100,000; 1,000 output
    expect(cost('claude-haiku-5-5', u(40_000, 1_000, 50_000, 10_000))).toBeCloseTo(0.00625, 10);
    // one more input token: every field at the long rates
    expect(cost('claude-haiku-5-5', u(40_001, 1_000, 50_000, 10_000))).toBeCloseTo(0.0312505, 10);
  });
  it('ALF-14 [long-boundary] an OpenAI id is base at 272,000 tokens counting cached input, long above', () => {
    expect(cost('gpt-6.2-sol', u(72_000, 1_000, 200_000, 0))).toBeCloseTo(0.174, 10);
    expect(cost('gpt-6.2-sol', u(72_001, 1_000, 200_000, 0))).toBeCloseTo(0.343004, 10);
  });
  it('ALF-14 [long-boundary] a Codex record at 272,001 total input is priced long', () => {
    const rollout = [
      JSON.stringify({ timestamp: 't0', type: 'turn_context', payload: { model: 'gpt-6.2-sol' } }),
      JSON.stringify({ timestamp: 't1', type: 'token_usage_record', payload: { response_id: 'r1', usage: { input_tokens: 272_001, cached_input_tokens: 200_000, cache_write_input_tokens: 0, output_tokens: 1_000, reasoning_output_tokens: 0, total_tokens: 273_001 } } }),
    ].join('\n') + '\n';
    const [ev] = parseRollout(rollout);
    expect(cost(ev.model, ev.usage)).toBeCloseTo(0.343004, 10);
  });
  it('ALF-14 [per-request] one session with a short and a long request prices each at its own tier', () => {
    session('s1', 'claude-haiku-5-5', [u(40_000, 1_000, 50_000, 10_000), u(40_001, 1_000, 50_000, 10_000)]);
    expect(statsCost()).toBeCloseTo(0.00625 + 0.0312505, 10);
  });
});

describe('ALF-14 cache-write duration', () => {
  const usage5m1h = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 3_000,
    cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 2_000 } };
  // opus 5.5: 10*4 + 100*20 + 1,000*5 (5m) + 2,000*8 (1h) = 23,040 per M
  it('ALF-14 [write-duration] a proxy response with 5m and 1h writes prices each at its own rate', () => {
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { model: 'claude-opus-5-5', usage: usage5m1h } })}`,
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 100 } })}`,
    ].join('\n\n') + '\n\n';
    const call = normalizeAnthropic('text/event-stream', sse)!;
    expect(call.usage.cacheWrite).toBe(3_000);
    expect(cost(call.model, call.usage)).toBeCloseTo(0.02304, 10);
    const json = normalizeAnthropic('application/json', JSON.stringify({ model: 'claude-opus-5-5', usage: { ...usage5m1h, output_tokens: 100 } }))!;
    expect(cost(json.model, json.usage)).toBeCloseTo(0.02304, 10);
  });
  it('ALF-14 [write-duration] a transcript with 5m and 1h writes prices each at its own rate', () => {
    const line = JSON.stringify({ type: 'assistant', sessionId: 's', timestamp: 't', requestId: 'req_1', message: { model: 'claude-opus-5-5', usage: { ...usage5m1h, output_tokens: 100 } } });
    const [ev] = parseClaudeTranscript(line + '\n').events;
    expect(cost(ev.model, ev.usage)).toBeCloseTo(0.02304, 10);
  });
  it('ALF-14 [write-duration] a record with only a total write count is priced at the 5m rate', () => {
    const json = normalizeAnthropic('application/json', JSON.stringify({ model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 3_000 } }))!;
    // 10*4 + 100*20 + 3,000*5 = 17,040 per M
    expect(cost(json.model, json.usage)).toBeCloseTo(0.01704, 10);
  });
  it('ALF-14 [write-duration] a session saved before this change is priced at the 5m rate', () => {
    session('old', 'claude-opus-5-5', [u(10, 100, 0, 3_000)]);
    expect(statsCost()).toBeCloseTo(0.01704, 10);
  });
  it('ALF-14 [write-duration] a Codex record\'s cache-write count is read and priced at the 30m rate', () => {
    const rollout = [
      JSON.stringify({ timestamp: 't0', type: 'turn_context', payload: { model: 'gpt-6.2-sol' } }),
      JSON.stringify({ timestamp: 't1', type: 'token_usage_record', payload: { response_id: 'r1', usage: { input_tokens: 100_000, cached_input_tokens: 40_000, cache_write_input_tokens: 60_000, output_tokens: 10_000, reasoning_output_tokens: 0, total_tokens: 110_000 } } }),
    ].join('\n') + '\n';
    const [ev] = parseRollout(rollout);
    expect(ev.usage.cacheWrite).toBe(60_000);
    // 0 uncached + 40,000*0.1 + 60,000*2.5 + 10,000*10 = 254,000 per M
    expect(cost(ev.model, ev.usage)).toBeCloseTo(0.254, 10);
  });
});

describe('ALF-14 flat overrides', () => {
  it('ALF-14 [flat-override] an override without long rates prices every request at one rate', () => {
    writeFileSync(`${home}/pricing.json`, JSON.stringify({ 'claude-haiku-5-5': { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 3 } }));
    // 40,001*1 + 1,000*2 + 50,000*0.5 + 10,000*3 = 97,001 per M
    expect(cost('claude-haiku-5-5', u(40_001, 1_000, 50_000, 10_000))).toBeCloseTo(0.097001, 10);
  });
  it('ALF-14 [flat-override] an override with a single cache write rate prices every write at it', () => {
    writeFileSync(`${home}/pricing.json`, JSON.stringify({ 'claude-opus-5-5': { input: 1, output: 1, cacheRead: 1, cacheWrite: 3 } }));
    expect(cost('claude-opus-5-5', u(0, 0, 0, 3_000, 2_000))).toBeCloseTo(0.009, 10);
  });
});

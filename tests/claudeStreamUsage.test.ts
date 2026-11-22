// ALF-14 (review 02, round 1): a Claude stream's message_delta can carry
// cumulative input and cache totals; they replace message_start's, fields the
// delta omits keep their message_start value, and the request is priced on the
// final counts.
import { describe, it, expect, beforeEach } from 'vitest';
import { costUsd, loadPricing, priceFor } from '../src/pricing.js';
import { normalizeAnthropic } from '../src/normalize.js';
import { statsCommand } from '../src/stats.js';
import { SessionWriter, StoreReader } from '../src/store.js';
import type { SessionMeta, Usage } from '../src/types.js';
import { tmp } from './helpers/lens.js';

let home: string;
beforeEach(() => { home = tmp('agentlens-stream-'); process.env.AGENTLENS_HOME = home; });

const stream = (model: string, start: object, delta: object) => [
  `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { model, usage: start } })}`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } })}`,
  `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: delta })}`,
  `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}`,
].join('\n\n') + '\n\n';
const usageOf = (sse: string) => normalizeAnthropic('text/event-stream', sse)!;
const cost = (model: string, u: Usage) => costUsd(u, priceFor(model, loadPricing())!);

const split = { cache_creation_input_tokens: 3_000, cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 2_000 } };
// Haiku request whose opening prompt is exactly 100,000 and whose final one is 100,001.
const haikuStart = { input_tokens: 40_000, output_tokens: 1, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 10_000 };
const haikuCrossing = () => stream('claude-haiku-5-5', haikuStart, { output_tokens: 1_000, input_tokens: 40_001, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 10_000 });

describe('ALF-14 Claude stream cumulative usage', () => {
  it('ALF-14 [write-duration] cumulative input and cache totals from message_delta replace the opening counts; the reported split is kept', () => {
    // a server-tool request: opens at 2,679 input, finishes at 10,682
    const call = usageOf(stream('claude-opus-5-5', { input_tokens: 2_679, output_tokens: 3, cache_read_input_tokens: 0, ...split },
      { output_tokens: 100, input_tokens: 10_682, cache_read_input_tokens: 500, cache_creation_input_tokens: 3_000 }));
    expect(call.usage).toEqual({ input: 10_682, output: 100, cacheRead: 500, cacheWrite: 3_000, cacheWriteLong: 2_000, reasoning: 0 });
    // 10,682*4 + 100*20 + 500*0.2 + 1,000*5 + 2,000*8 = 65,828 per M
    expect(cost(call.model, call.usage)).toBeCloseTo(0.065828, 10);
  });
  it('ALF-14 [write-duration] fields the delta omits keep their message_start values', () => {
    const call = usageOf(stream('claude-opus-5-5', { input_tokens: 2_679, output_tokens: 3, cache_read_input_tokens: 400, ...split },
      { output_tokens: 100, input_tokens: 10_682 }));
    expect(call.usage).toEqual({ input: 10_682, output: 100, cacheRead: 400, cacheWrite: 3_000, cacheWriteLong: 2_000, reasoning: 0 });
  });
  it('ALF-14 [long-boundary] a stream whose final prompt crosses Haiku\'s 100,000 is priced long', () => {
    const call = usageOf(haikuCrossing());
    expect(call.usage.input).toBe(40_001);
    // 40,001*0.5 + 1,000*2.5 + 50,000*0.05 + 10,000*0.625 = 31,250.5 per M
    expect(cost(call.model, call.usage)).toBeCloseTo(0.0312505, 10);
  });
  it('ALF-14 [per-request] a session of a short stream and a crossing stream charges each at its own tier', () => {
    const short = usageOf(stream('claude-haiku-5-5', haikuStart, { output_tokens: 1_000 }));
    const long = usageOf(haikuCrossing());
    const meta: SessionMeta = { id: 's', runtime: 'claude', capture: 'proxy', tags: {}, cwd: '/', argv: ['claude'], lensVersion: '0', startedAt: new Date().toISOString() };
    const w = new SessionWriter(home, meta);
    [short, long].forEach((c, i) => w.appendEvent({ ts: meta.startedAt, seq: i + 1, kind: 'api_call', model: c.model, usage: c.usage, durationMs: 1, status: 200 }));
    w.finalize(0);
    const row = JSON.parse(statsCommand({ tag: [], json: true }, new StoreReader(home))).rows[0];
    // short: 40,000*0.1 + 1,000*0.5 + 50,000*0.01 + 10,000*0.125 = 6,250 per M
    expect(row.costUsd).toBeCloseTo(0.00625 + 0.0312505, 10);
  });
  it('ALF-14 [write-duration] an output-only delta keeps every opening count (regression)', () => {
    const call = usageOf(stream('claude-opus-5-5', { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, ...split }, { output_tokens: 100 }));
    expect(call.usage).toEqual({ input: 10, output: 100, cacheRead: 0, cacheWrite: 3_000, cacheWriteLong: 2_000, reasoning: 0 });
    expect(cost(call.model, call.usage)).toBeCloseTo(0.02304, 10);
  });
});

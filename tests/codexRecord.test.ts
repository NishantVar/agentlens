// ALF-14 [codex-record] (issue planner, 02-codex-usage-decision.md): Codex
// usage comes from token_usage_record lines when a rollout has any, otherwise
// from token_count lines; uncached input is net of cache reads and writes.
import { describe, it, expect } from 'vitest';
import { parseRollout, scanRollout } from '../src/codexRollout.js';

const L = (o: object) => JSON.stringify(o);
const usage = (input: number, cached: number, write: number | undefined, output: number) => ({
  input_tokens: input, cached_input_tokens: cached, ...(write === undefined ? {} : { cache_write_input_tokens: write }),
  output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output,
});
const meta = L({ timestamp: '2026-11-22T10:00:00.000Z', type: 'session_meta', payload: { id: 'codex-native-1' } });
const ctx = (model: string) => L({ timestamp: '2026-11-22T10:00:01.000Z', type: 'turn_context', payload: { model } });
const count = (ts: string, u: object) => L({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: u, last_token_usage: u } } });
const record = (ts: string, id: string, u: object) => L({ timestamp: ts, type: 'token_usage_record', payload: { response_id: id, turn_id: 't', usage: u, turn_token_usage: u, thread_token_usage: u } });
const ev = (ts: string, seq: number, model: string, input: number, output: number, cacheRead: number, cacheWrite: number) =>
  ({ ts, seq, kind: 'api_call', model, usage: { input, output, cacheRead, cacheWrite, reasoning: 0 }, durationMs: 0, status: 200 });

// A record-era rollout: a token_count before the first record, one repeating
// the previous request (a rate-limit emit), a model switch between records.
const recordLines = [
  meta, ctx('gpt-6.2-sol'),
  count('2026-11-22T10:00:02.000Z', usage(500, 0, 0, 5)),
  record('2026-11-22T10:00:03.000Z', 'r1', usage(100, 40, 60, 10)),
  count('2026-11-22T10:00:04.000Z', usage(100, 40, 60, 10)),
  count('2026-11-22T10:00:05.000Z', usage(100, 40, 60, 10)),
  ctx('gpt-6-luna'),
  record('2026-11-22T10:00:06.000Z', 'r2', usage(1_000, 200, 0, 50)),
  count('2026-11-22T10:00:07.000Z', usage(1_000, 200, 0, 50)),
];
const recordEvents = [
  ev('2026-11-22T10:00:03.000Z', 1, 'gpt-6.2-sol', 0, 10, 40, 60),
  ev('2026-11-22T10:00:06.000Z', 2, 'gpt-6-luna', 800, 50, 200, 0),
];
const text = (ls: string[]) => ls.join('\n') + '\n';

describe('ALF-14 [codex-record]', () => {
  it('ALF-14 [codex-record] input 100 with 40 cached and 60 written is uncached 0, read 40, write 60, prompt length 100', () => {
    const [e] = parseRollout(text([ctx('gpt-6.2-sol'), record('t', 'r1', usage(100, 40, 60, 10))]));
    expect(e.usage).toEqual({ input: 0, output: 10, cacheRead: 40, cacheWrite: 60, reasoning: 0 });
    expect(e.usage.input + e.usage.cacheRead + e.usage.cacheWrite).toBe(100);
  });
  it('ALF-14 [codex-record] the formula never goes below 0 and applies to token_count lines too', () => {
    const [a] = parseRollout(text([ctx('m'), record('t', 'r', usage(50, 40, 60, 1))]));
    expect(a.usage.input).toBe(0);
    const [b] = parseRollout(text([ctx('m'), count('t', usage(100, 40, 60, 10))]));
    expect(b.usage).toEqual({ input: 0, output: 10, cacheRead: 40, cacheWrite: 60, reasoning: 0 });
  });
  it('ALF-14 [codex-record] a rollout with records gives one event per record and ignores every token_count, even one before the first record', () => {
    expect(parseRollout(text(recordLines))).toEqual(recordEvents);
  });
  it('ALF-14 [codex-record] a rollout with only token_count lines gives today\'s events', () => {
    const ls = [meta, ctx('gpt-6.2-sol'), count('2026-11-22T10:00:02.000Z', usage(500, 100, undefined, 5)), L({ timestamp: 'x', type: 'event_msg', payload: { type: 'token_count', info: null } }), count('2026-11-22T10:00:03.000Z', usage(500, 100, undefined, 5))];
    expect(parseRollout(text(ls))).toEqual([
      ev('2026-11-22T10:00:02.000Z', 1, 'gpt-6.2-sol', 400, 5, 100, 0),
      ev('2026-11-22T10:00:03.000Z', 2, 'gpt-6.2-sol', 400, 5, 100, 0),
    ]);
  });
  it('ALF-14 [codex-record] the same result holds when the rollout is read in two parts, at every line boundary', () => {
    for (let cut = 0; cut <= recordLines.length; cut++) {
      const head = scanRollout(cut ? text(recordLines.slice(0, cut)) : '');
      const whole = scanRollout(text(recordLines.slice(cut)), head);
      expect(whole.events, `cut at line ${cut}`).toEqual(recordEvents);
      expect(whole.nativeId).toBe('codex-native-1');
    }
  });
  it('ALF-14 [codex-record] a token_count-only prefix is dropped when a record first appears in the tail', () => {
    const head = scanRollout(text(recordLines.slice(0, 3)));
    expect(head.events).toHaveLength(1); // the prefix alone is a fallback rollout
    expect(scanRollout(text(recordLines.slice(3)), head).events).toEqual(recordEvents);
  });
});

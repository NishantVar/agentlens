import { describe, it, expect } from 'vitest';
import { normalizeAnthropic, normalizeOpenAI, parseSse } from '../src/normalize.js';

const anthropicJson = JSON.stringify({
  model: 'claude-opus-4-1', usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 500, cache_creation_input_tokens: 60 },
});

const anthropicSse = [
  'event: message_start',
  `data: ${JSON.stringify({ type: 'message_start', message: { model: 'claude-opus-4-1', usage: { input_tokens: 12, cache_read_input_tokens: 500, cache_creation_input_tokens: 60, output_tokens: 1 } } })}`,
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta"}',
  '',
  'event: message_delta',
  `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 34 } })}`,
  '',
].join('\n');

const openaiResponsesJson = JSON.stringify({
  model: 'gpt-5-codex',
  usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 30 } },
});

const openaiResponsesSse = [
  'event: response.output_text.delta',
  'data: {"delta":"hi"}',
  '',
  'event: response.completed',
  `data: ${JSON.stringify({ response: { model: 'gpt-5-codex', usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 30 } } } })}`,
  '',
].join('\n');

const chatCompletionsJson = JSON.stringify({
  model: 'gpt-5', usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 30 } },
});

describe('normalizeAnthropic', () => {
  it('normalizes a JSON body', () => {
    expect(normalizeAnthropic('application/json', anthropicJson)).toEqual({
      model: 'claude-opus-4-1',
      usage: { input: 12, output: 34, cacheRead: 500, cacheWrite: 60, reasoning: 0 },
    });
  });
  it('normalizes an SSE stream (output from message_delta)', () => {
    expect(normalizeAnthropic('text/event-stream', anthropicSse)).toEqual({
      model: 'claude-opus-4-1',
      usage: { input: 12, output: 34, cacheRead: 500, cacheWrite: 60, reasoning: 0 },
    });
  });
  it('returns null for bodies without usage', () => {
    expect(normalizeAnthropic('application/json', '{"ok":true}')).toBeNull();
    expect(normalizeAnthropic('application/json', 'not json')).toBeNull();
  });
});

describe('normalizeOpenAI', () => {
  it('normalizes a Responses JSON body (input minus cached)', () => {
    expect(normalizeOpenAI('application/json', openaiResponsesJson)).toEqual({
      model: 'gpt-5-codex',
      usage: { input: 20, output: 50, cacheRead: 80, cacheWrite: 0, reasoning: 30 },
    });
  });
  it('normalizes a Responses SSE stream via response.completed', () => {
    expect(normalizeOpenAI('text/event-stream', openaiResponsesSse)).toEqual({
      model: 'gpt-5-codex',
      usage: { input: 20, output: 50, cacheRead: 80, cacheWrite: 0, reasoning: 30 },
    });
  });
  it('normalizes a chat.completions JSON body', () => {
    expect(normalizeOpenAI('application/json', chatCompletionsJson)).toEqual({
      model: 'gpt-5',
      usage: { input: 20, output: 50, cacheRead: 80, cacheWrite: 0, reasoning: 30 },
    });
  });
  it('returns null when no usage', () => {
    expect(normalizeOpenAI('application/json', '{"object":"list"}')).toBeNull();
  });
});

describe('parseSse', () => {
  it('parses events and skips junk', () => {
    const evs = parseSse('event: a\ndata: {"x":1}\n\ndata: [DONE]\n\ndata: notjson\n\n');
    expect(evs).toEqual([{ event: 'a', data: { x: 1 } }]);
  });
});

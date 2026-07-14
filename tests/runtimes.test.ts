import { describe, it, expect } from 'vitest';
import { detectRuntime, getAdapter } from '../src/runtimes.js';

describe('detectRuntime', () => {
  it('detects claude and codex from argv0 (path or bare)', () => {
    expect(detectRuntime('claude')).toBe('claude');
    expect(detectRuntime('/usr/local/bin/claude')).toBe('claude');
    expect(detectRuntime('codex')).toBe('codex');
  });
  it('throws on unknown runtimes', () => {
    expect(() => detectRuntime('hermes')).toThrow(/unsupported runtime/i);
  });
});

describe('adapters', () => {
  it('claude adapter is proxy-mode via ANTHROPIC_BASE_URL and normalizes anthropic bodies', () => {
    const a = getAdapter('claude');
    if (a.mode !== 'proxy') throw new Error('claude must be proxy mode');
    expect(a.env('http://127.0.0.1:9999')).toMatchObject({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999' });
    const call = a.normalize({
      request: { method: 'POST', path: '/v1/messages', headers: {}, body: '{}' },
      response: { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-4-1', usage: { input_tokens: 1, output_tokens: 2 } }) },
    });
    expect(call).toEqual({ model: 'claude-opus-4-1', usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 } });
  });
  it('codex adapter is logs-mode', () => {
    const a = getAdapter('codex');
    expect(a.mode).toBe('logs');
  });
});

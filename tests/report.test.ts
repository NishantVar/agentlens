import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateReport } from '../src/report.js';
import { SessionWriter, StoreReader } from '../src/store.js';
import type { SessionMeta } from '../src/types.js';
import { claudeTranscriptFixture } from './fixtures/claudeTranscript.js';

let root: string; let id: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentlens-'));
  process.env.AGENTLENS_HOME = root;
  id = 'test-session';
  const meta: SessionMeta = { id, runtime: 'claude', capture: 'proxy', tags: { agent: 'verifier' }, cwd: '/', argv: ['claude'], lensVersion: '0', startedAt: '2026-07-14T10:00:00.000Z' };
  const w = new SessionWriter(root, meta);
  w.appendRaw({
    seq: 1, ts: '2026-07-14T10:00:01.000Z', durationMs: 900,
    request: { method: 'POST', path: '/v1/messages', headers: {}, body: JSON.stringify({ model: 'claude-opus-4-1', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello world </script> injection' }] }] }) },
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-4-1', usage: { input_tokens: 5, output_tokens: 2 } }) },
  });
  w.appendEvent({ ts: '2026-07-14T10:00:01.000Z', seq: 1, kind: 'api_call', model: 'claude-opus-4-1', usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, durationMs: 900, status: 200 });
  w.finalize(0);
});

describe('generateReport', () => {
  it('produces a self-contained HTML doc embedding the session data', () => {
    const html = generateReport([id], new StoreReader(root));
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('id="lens-data"');
    expect(html).toContain('test-session');
    expect(html).toContain('agent=verifier');
    expect(html).not.toMatch(/src=|href="http/); // no external requests
  });
  it('escapes </script> inside embedded JSON', () => {
    const html = generateReport([id], new StoreReader(root));
    const jsonBlock = html.split('id="lens-data">')[1].split('</script>')[0];
    expect(jsonBlock).not.toContain('</script>');
    expect(jsonBlock).toContain('<\\/script>');
  });
  it('throws a clear error for a missing session', () => {
    expect(() => generateReport(['nope'], new StoreReader(root))).toThrow(/session "nope" not found/i);
  });

  it('embeds rollout messages for logs-captured (codex) sessions', () => {
    const cid = 'codex-session';
    const meta: SessionMeta = { id: cid, runtime: 'codex', capture: 'logs', tags: {}, cwd: '/', argv: ['codex'], lensVersion: '0', startedAt: '2026-07-14T10:00:00.000Z' };
    const w = new SessionWriter(root, meta);
    w.appendEvent({ ts: '2026-07-14T10:00:01.000Z', seq: 1, kind: 'api_call', model: 'gpt-5.3-codex', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 2 }, durationMs: 0, status: 200 });
    w.finalize(0);
    writeFileSync(join(root, 'sessions', cid, 'rollout-1.jsonl'),
      JSON.stringify({ timestamp: '2026-07-14T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello codex' }] } }) + '\n');
    const html = generateReport([cid], new StoreReader(root));
    expect(html).toContain('hello codex');
    expect(html).toContain('"role":"user"');
  });

  it('embeds transcript messages for imported claude sessions', () => {
    const cid = 'imported-claude-session';
    const meta: SessionMeta = { id: cid, runtime: 'claude', capture: 'logs', tags: {}, cwd: '/', argv: ['claude'], lensVersion: '0', startedAt: '2026-07-14T10:00:00.000Z' };
    const w = new SessionWriter(root, meta);
    w.appendEvent({ ts: '2026-07-14T10:00:01.000Z', seq: 1, kind: 'api_call', model: 'claude-opus-4-8', usage: { input: 100, output: 10, cacheRead: 200, cacheWrite: 50, reasoning: 0 }, durationMs: 0, status: 200 });
    w.finalize(0);
    writeFileSync(join(root, 'sessions', cid, 'transcript.jsonl'), claudeTranscriptFixture(cid));
    const html = generateReport([cid], new StoreReader(root));
    expect(html).toContain('Hello!');
    expect(html).toContain('conversation (');
  });
});

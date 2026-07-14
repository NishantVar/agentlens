import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filterIndex, groupBy, parseSince } from '../src/query.js';
import { SessionWriter, StoreReader } from '../src/store.js';
import type { IndexEntry, SessionMeta } from '../src/types.js';

function mkSession(root: string, id: string, tags: Record<string, string>, model: string, input: number): IndexEntry {
  const meta: SessionMeta = { id, runtime: 'claude', capture: 'proxy', tags, cwd: '/', argv: ['claude'], lensVersion: '0', startedAt: new Date().toISOString() };
  const w = new SessionWriter(root, meta);
  w.appendEvent({ ts: meta.startedAt, seq: 1, kind: 'api_call', model, usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, durationMs: 1, status: 200 });
  return w.finalize(0);
}

describe('parseSince', () => {
  it('parses d/h/m suffixes', () => {
    const now = Date.now();
    expect(now - parseSince('7d').getTime()).toBeGreaterThan(6.9 * 86400_000);
    expect(now - parseSince('30m').getTime()).toBeLessThan(31 * 60_000);
  });
  it('throws on junk', () => { expect(() => parseSince('tuesday')).toThrow(); });
});

describe('filterIndex + groupBy', () => {
  it('filters by tag and groups by tag key with (untagged) bucket', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentlens-'));
    mkSession(root, 'a1', { agent: 'verifier', run: 'r1' }, 'claude-opus-4-1', 100);
    mkSession(root, 'a2', { agent: 'builder', run: 'r1' }, 'claude-opus-4-1', 50);
    mkSession(root, 'a3', { run: 'r2' }, 'claude-haiku-4', 10);
    const reader = new StoreReader(root);
    const all = reader.listIndex();

    expect(filterIndex(all, { tags: { run: 'r1' } })).toHaveLength(2);
    expect(filterIndex(all, { runtime: 'codex' })).toHaveLength(0);

    const rows = groupBy(filterIndex(all, {}), 'agent', reader);
    expect(rows.map((r) => r.key)).toEqual(['verifier', 'builder', '(untagged)']);
    expect(rows[0].totals.input).toBe(100);

    const byModel = groupBy(all, 'model', reader);
    expect(byModel[0].key).toBe('claude-opus-4-1');
    expect(byModel[0].sessions).toBe(2);
  });
});

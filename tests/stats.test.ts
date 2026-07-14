import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statsCommand, sessionsCommand } from '../src/stats.js';
import { renderTable, fmtTokens } from '../src/table.js';
import { SessionWriter, StoreReader } from '../src/store.js';
import type { SessionMeta } from '../src/types.js';

let root: string;
function seed(id: string, agent: string, model: string, input: number) {
  const meta: SessionMeta = { id, runtime: 'claude', capture: 'proxy', tags: { agent, run: 'r1' }, cwd: '/', argv: ['claude'], lensVersion: '0', startedAt: new Date().toISOString() };
  const w = new SessionWriter(root, meta);
  w.appendEvent({ ts: meta.startedAt, seq: 1, kind: 'api_call', model, usage: { input, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, durationMs: 1, status: 200 });
  w.finalize(0);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentlens-'));
  process.env.AGENTLENS_HOME = root;
  seed('s1', 'verifier', 'claude-opus-4-1', 1_000_000);
  seed('s2', 'builder', 'claude-opus-4-1', 500);
});

describe('statsCommand', () => {
  it('renders per-agent rows sorted by volume with cost', () => {
    const out = statsCommand({ by: 'agent', tag: ['run=r1'] }, new StoreReader(root));
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/KEY\s+SESSIONS\s+REQUESTS\s+INPUT/);
    expect(lines[1]).toMatch(/^verifier/);
    expect(lines[1]).toContain('1,000,000');
    expect(lines[1]).toMatch(/15\.\d+/); // ~$15 for 1M opus input tokens
  });
  it('renders a single (all) totals row with cost when no --by is given', () => {
    const out = statsCommand({ tag: [] }, new StoreReader(root));
    const lines = out.split('\n');
    expect(lines).toHaveLength(2); // header + single (all) row
    expect(lines[1]).toMatch(/^\(all\)/);
    expect(lines[1]).toMatch(/15\.\d+/); // ~$15 for 1M opus input tokens
  });
  it('emits machine-readable json', () => {
    const parsed = JSON.parse(statsCommand({ by: 'agent', tag: [], json: true }, new StoreReader(root)));
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].key).toBe('verifier');
    expect(parsed.rows[0].costUsd).toBeGreaterThan(14);
  });
});

describe('sessionsCommand', () => {
  it('lists sessions newest first with tags', () => {
    const out = sessionsCommand({ tag: [] }, new StoreReader(root));
    expect(out).toContain('agent=verifier');
    expect(out.split('\n').length).toBeGreaterThanOrEqual(3); // header + 2 rows
  });
});

describe('table', () => {
  it('aligns columns', () => {
    // col0 left-aligned to width 2, col1 right-aligned to width 2, two-space gutter, trailing ws trimmed
    expect(renderTable(['A', 'B'], [['x', '1'], ['yy', '22']])).toBe('A    B\nx    1\nyy  22');
  });
  it('formats token counts', () => { expect(fmtTokens(1234567)).toBe('1,234,567'); });
});

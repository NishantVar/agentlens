import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDashboard, type DashboardHandle } from '../src/dashboard.js';
import { SessionWriter, StoreReader } from '../src/store.js';
import type { SessionMeta } from '../src/types.js';

let root: string; let dash: DashboardHandle;
const mk = (id: string, tags: Record<string, string>, finalize: boolean, opts: { model?: string; startedAt?: string } = {}) => {
  const startedAt = opts.startedAt ?? new Date().toISOString();
  const meta: SessionMeta = { id, runtime: 'claude', capture: 'proxy', tags, cwd: '/', argv: ['claude'], lensVersion: '0', startedAt };
  const w = new SessionWriter(root, meta);
  w.appendEvent({ ts: startedAt, seq: 1, kind: 'api_call', model: opts.model ?? 'claude-opus-4-1', usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, durationMs: 1, status: 200 });
  if (finalize) w.finalize(0);
};
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentlens-'));
  process.env.AGENTLENS_HOME = root;
  mk('done-1', { agent: 'verifier', run: 'r1' }, true);
  mk('done-2', { agent: 'builder', run: 'r2' }, true);
  mk('live-1', { agent: 'builder', run: 'r1' }, false);
  dash = await startDashboard(0, new StoreReader(root));
});
afterEach(async () => { await dash.close(); delete process.env.AGENTLENS_HOME; });

describe('dashboard', () => {
  it('serves the html shell', async () => {
    const res = await fetch(dash.origin + '/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('agentlens');
  });
  it('serves live data with active sessions and per-agent rows', async () => {
    const data = await (await fetch(dash.origin + '/api/data')).json();
    expect(data.active.map((m: { id: string }) => m.id)).toEqual(['live-1']);
    expect(data.byAgent.map((r: { key: string }) => r.key).sort()).toEqual(['builder', 'verifier']);
    expect(data.recent).toHaveLength(2);
  });
  it('filters by run', async () => {
    const data = await (await fetch(dash.origin + '/api/data?run=r1')).json();
    expect(data.recent).toHaveLength(1);
    expect(data.byAgent.map((r: { key: string }) => r.key)).toEqual(['verifier']);
  });
  it('serves summary totals with estimated cost', async () => {
    const data = await (await fetch(dash.origin + '/api/data')).json();
    expect(data.summary.sessions).toBe(2);
    expect(data.summary.active).toBe(1);
    expect(data.summary.totals.input).toBe(10);
    expect(data.summary.totals.output).toBe(10);
    // claude-opus-4 pricing: (5*15 + 5*75)/1e6 per session, two sessions
    expect(data.summary.costUsd).toBeCloseTo(0.0009, 6);
    expect(data.summary.unpricedEvents).toBe(0);
  });
  it('counts unpriced events instead of guessing their cost', async () => {
    mk('done-3', { agent: 'builder' }, true, { model: 'mystery-9000' });
    const data = await (await fetch(dash.origin + '/api/data')).json();
    expect(data.summary.sessions).toBe(3);
    expect(data.summary.unpricedEvents).toBe(1);
    expect(data.summary.costUsd).toBeCloseTo(0.0009, 6);
  });
  it('serves per-model rows with cost', async () => {
    const data = await (await fetch(dash.origin + '/api/data')).json();
    expect(data.byModel).toHaveLength(1);
    expect(data.byModel[0].key).toBe('claude-opus-4-1');
    expect(data.byModel[0].sessions).toBe(2);
    expect(data.byModel[0].totals.input).toBe(10);
    expect(data.byModel[0].costUsd).toBeCloseTo(0.0009, 6);
  });
  it('attaches cost to recent sessions and agent rows', async () => {
    const data = await (await fetch(dash.origin + '/api/data')).json();
    expect(data.recent[0].costUsd).toBeCloseTo(0.00045, 6);
    expect(data.byAgent[0].costUsd).toBeCloseTo(0.00045, 6);
  });
  it('filters by since window', async () => {
    mk('old-1', { agent: 'builder' }, true, { startedAt: new Date(Date.now() - 3 * 86400_000).toISOString() });
    const all = await (await fetch(dash.origin + '/api/data')).json();
    expect(all.recent).toHaveLength(3);
    const recent = await (await fetch(dash.origin + '/api/data?since=24h')).json();
    expect(recent.recent.map((e: { id: string }) => e.id).sort()).toEqual(['done-1', 'done-2']);
    // invalid since is ignored, never a 500 — the dashboard fails open
    const bad = await fetch(dash.origin + '/api/data?since=banana');
    expect(bad.status).toBe(200);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDashboard, type DashboardHandle } from '../src/dashboard.js';
import { SessionWriter, StoreReader } from '../src/store.js';
import type { SessionMeta } from '../src/types.js';

let root: string; let dash: DashboardHandle;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentlens-'));
  const mk = (id: string, tags: Record<string, string>, finalize: boolean) => {
    const meta: SessionMeta = { id, runtime: 'claude', capture: 'proxy', tags, cwd: '/', argv: ['claude'], lensVersion: '0', startedAt: new Date().toISOString() };
    const w = new SessionWriter(root, meta);
    w.appendEvent({ ts: meta.startedAt, seq: 1, kind: 'api_call', model: 'claude-opus-4-1', usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, durationMs: 1, status: 200 });
    if (finalize) w.finalize(0);
  };
  mk('done-1', { agent: 'verifier', run: 'r1' }, true);
  mk('done-2', { agent: 'builder', run: 'r2' }, true);
  mk('live-1', { agent: 'builder', run: 'r1' }, false);
  dash = await startDashboard(0, new StoreReader(root));
});
afterEach(async () => { await dash.close(); });

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
});

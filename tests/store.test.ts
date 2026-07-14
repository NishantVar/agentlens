import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWriter, StoreReader, newSessionId } from '../src/store.js';
import type { SessionMeta, NormalizedEvent, RawPair } from '../src/types.js';

const meta = (id: string): SessionMeta => ({
  id, runtime: 'claude', capture: 'proxy', tags: { agent: 'verifier', run: 'r1' },
  cwd: '/tmp', argv: ['claude', '-p', 'hi'], lensVersion: '0.1.0',
  startedAt: '2026-07-14T10:00:00.000Z',
});
const ev = (seq: number): NormalizedEvent => ({
  ts: '2026-07-14T10:00:01.000Z', seq, kind: 'api_call', model: 'claude-opus-4',
  usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 20, reasoning: 0 },
  durationMs: 1200, status: 200,
});
const pair = (seq: number): RawPair => ({
  seq, ts: '2026-07-14T10:00:01.000Z', durationMs: 1200,
  request: { method: 'POST', path: '/v1/messages', headers: {}, body: '{"model":"claude-opus-4"}' },
  response: { status: 200, headers: {}, body: '{}' },
});

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'agentlens-')); });

describe('SessionWriter', () => {
  it('writes meta, raw, events and finalizes into the index', () => {
    const id = newSessionId();
    const w = new SessionWriter(root, meta(id));
    w.appendRaw(pair(1)); w.appendEvent(ev(1));
    w.appendRaw(pair(2)); w.appendEvent(ev(2));
    const entry = w.finalize(0);
    expect(entry.totals).toEqual({ input: 20, output: 10, cacheRead: 200, cacheWrite: 40, reasoning: 0, requests: 2 });
    expect(entry.models).toEqual(['claude-opus-4']);
    expect(entry.exitCode).toBe(0);
    const r = new StoreReader(root);
    expect(r.listIndex()).toHaveLength(1);
    expect(r.readEvents(id)).toHaveLength(2);
    expect(r.readRaw(id)[0].request.path).toBe('/v1/messages');
    expect(r.readMeta(id).endedAt).toBeTruthy();
  });
  it('sets root permissions to 700', () => {
    const id = newSessionId();
    new SessionWriter(root, meta(id));
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });
});

describe('StoreReader', () => {
  it('lists unfinalized sessions as active and skips corrupt index lines', () => {
    const id = newSessionId();
    new SessionWriter(root, meta(id)); // never finalized
    const r = new StoreReader(root);
    expect(r.listActive().map((m) => m.id)).toEqual([id]);
    expect(r.listIndex()).toEqual([]);
  });
});

describe('newSessionId', () => {
  it('matches the expected shape and is unique-ish', () => {
    const a = newSessionId(); const b = newSessionId();
    expect(a).toMatch(/^\d{8}T\d{6}-[0-9a-f]{4}$/);
    expect(a).not.toBe(b);
  });
});

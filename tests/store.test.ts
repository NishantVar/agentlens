import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  it('recreates its session dir if it is removed mid-session (e.g. archived out from under it)', () => {
    const id = newSessionId();
    const w = new SessionWriter(root, meta(id));
    w.appendRaw(pair(1));
    rmSync(join(root, 'sessions', id), { recursive: true, force: true });
    w.appendRaw(pair(2));
    w.appendEvent(ev(2));
    const entry = w.finalize(0);
    expect(entry.totals.requests).toBe(1);
    const dir = join(root, 'sessions', id);
    expect(readFileSync(join(dir, 'raw.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')).id).toBe(id);
  });

  it('stores repeated request content once per session and reads it back exactly', () => {
    const id = newSessionId();
    const w = new SessionWriter(root, meta(id));
    const tools = [{ name: 'Bash', description: 'd'.repeat(5000) }];
    const msgs: unknown[] = [];
    const bodies: string[] = [];
    for (let i = 1; i <= 20; i++) {
      msgs.push({ role: i % 2 ? 'user' : 'assistant', content: `turn ${i} `.repeat(50) });
      const body = JSON.stringify({ model: 'claude-opus-4', tools, system: 's'.repeat(2000), messages: msgs });
      bodies.push(body);
      w.appendRaw({ ...pair(i), request: { ...pair(i).request, body } });
    }
    const dir = join(root, 'sessions', id);
    const onDisk = statSync(join(dir, 'raw.jsonl')).size + statSync(join(dir, 'blobs.jsonl')).size;
    const naive = bodies.reduce((n, b) => n + b.length, 0);
    expect(onDisk).toBeLessThan(naive / 5);
    expect(new StoreReader(root).readRaw(id).map((p) => p.request.body)).toEqual(bodies);
  });

  it('still reads legacy raw lines with plain bodies', () => {
    const id = newSessionId();
    new SessionWriter(root, meta(id));
    const legacy = { ...pair(1), request: { ...pair(1).request, body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(500) }] }) } };
    writeFileSync(join(root, 'sessions', id, 'raw.jsonl'), JSON.stringify(legacy) + '\n');
    expect(new StoreReader(root).readRaw(id)).toEqual([legacy]);
  });

  it('rewrites blobs after its dir is recreated so later records still resolve', () => {
    const id = newSessionId();
    const w = new SessionWriter(root, meta(id));
    const body = JSON.stringify({ model: 'm', system: 's'.repeat(2000), messages: [{ role: 'user', content: 'u'.repeat(500) }] });
    w.appendRaw({ ...pair(1), request: { ...pair(1).request, body } });
    rmSync(join(root, 'sessions', id), { recursive: true, force: true });
    w.appendRaw({ ...pair(2), request: { ...pair(2).request, body } });
    expect(new StoreReader(root).readRaw(id).map((p) => p.request.body)).toEqual([body]);
  });

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

describe('SessionWriter.finalize with extra fields', () => {
  it('finalize honors extra endedAt and nativeSessionIds and indexes them', () => {
    const meta: SessionMeta = {
      id: 'imp-1', runtime: 'claude', capture: 'logs', tags: {}, cwd: '/repo', argv: [],
      lensVersion: '0.1.0', startedAt: '2026-07-01T10:00:00.000Z',
      source: { kind: 'import', path: '/src/t.jsonl' },
    };
    const w = new SessionWriter(root, meta);
    w.appendEvent({ ts: '2026-07-01T10:00:05.000Z', seq: 1, kind: 'api_call', model: 'm', usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, durationMs: 0, status: 200 });
    const entry = w.finalize(0, { endedAt: '2026-07-01T10:01:00.000Z', nativeSessionIds: ['native-a'] });
    expect(entry.endedAt).toBe('2026-07-01T10:01:00.000Z');
    expect(entry.nativeSessionIds).toEqual(['native-a']);
    const reader = new StoreReader(root);
    expect(reader.listIndex().at(-1)?.nativeSessionIds).toEqual(['native-a']);
    expect(reader.readMeta('imp-1').source).toEqual({ kind: 'import', path: '/src/t.jsonl' });
    expect(reader.readMeta('imp-1').endedAt).toBe('2026-07-01T10:01:00.000Z');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactStore } from '../src/compact.js';
import { StoreReader } from '../src/store.js';
import type { RawPair } from '../src/types.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'agentlens-compact-')); });

function legacySession(id: string, ended: boolean, extraLines: string[] = []): string[] {
  const dir = join(root, 'sessions', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id, runtime: 'claude', startedAt: '2026-07-14T10:00:00.000Z', ...(ended ? { endedAt: '2026-07-14T11:00:00.000Z' } : {}) }));
  const msgs: unknown[] = [];
  const lines: string[] = [];
  const bodies: string[] = [];
  for (let i = 1; i <= 10; i++) {
    msgs.push({ role: i % 2 ? 'user' : 'assistant', content: `turn ${i} `.repeat(50) });
    const body = JSON.stringify({ model: 'm', tools: [{ name: 'Bash', description: 'd'.repeat(5000) }], system: 's'.repeat(1000), messages: msgs });
    bodies.push(body);
    const p: RawPair = { seq: i, ts: 't', durationMs: 1, request: { method: 'POST', path: '/v1/messages', headers: {}, body }, response: { status: 200, headers: {}, body: '{}' } };
    lines.push(JSON.stringify(p));
  }
  writeFileSync(join(dir, 'raw.jsonl'), [...lines, ...extraLines].join('\n') + '\n');
  return bodies;
}

describe('compactStore', () => {
  it('shrinks finished legacy sessions without changing what readRaw returns', () => {
    const bodies = legacySession('s1', true);
    const reader = new StoreReader(root);
    const before = reader.readRaw('s1');
    const sizeBefore = statSync(join(root, 'sessions', 's1', 'raw.jsonl')).size;
    const sum = compactStore(root);
    expect(sum.compacted).toBe(1);
    expect(sum.bytesAfter).toBeLessThan(sizeBefore / 3);
    expect(reader.readRaw('s1')).toEqual(before);
    expect(reader.readRaw('s1').map((p) => p.request.body)).toEqual(bodies);
  });

  it('is idempotent', () => {
    legacySession('s1', true);
    compactStore(root);
    const raw = readFileSync(join(root, 'sessions', 's1', 'raw.jsonl'), 'utf8');
    const blobs = readFileSync(join(root, 'sessions', 's1', 'blobs.jsonl'), 'utf8');
    const sum = compactStore(root);
    expect(sum.compacted).toBe(0);
    expect(readFileSync(join(root, 'sessions', 's1', 'raw.jsonl'), 'utf8')).toBe(raw);
    expect(readFileSync(join(root, 'sessions', 's1', 'blobs.jsonl'), 'utf8')).toBe(blobs);
  });

  it('compacts an unfinalized session once it has been idle (a killed run)', () => {
    const bodies = legacySession('dead', false);
    const sum = compactStore(root, undefined, Date.now() + 2 * 60 * 60 * 1000);
    expect(sum.compacted).toBe(1);
    expect(new StoreReader(root).readRaw('dead').map((p) => p.request.body)).toEqual(bodies);
  });

  it('skips sessions still being written', () => {
    legacySession('live', false);
    const raw = readFileSync(join(root, 'sessions', 'live', 'raw.jsonl'), 'utf8');
    const sum = compactStore(root);
    expect(sum.skippedActive).toBe(1);
    expect(readFileSync(join(root, 'sessions', 'live', 'raw.jsonl'), 'utf8')).toBe(raw);
    expect(existsSync(join(root, 'sessions', 'live', 'blobs.jsonl'))).toBe(false);
  });

  it('handles sessions whose bodies pack without any blob (all values tiny)', () => {
    const dir = join(root, 'sessions', 'tiny');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id: 'tiny', endedAt: 'x' }));
    const p: RawPair = { seq: 1, ts: 't', durationMs: 1, request: { method: 'POST', path: '/', headers: {}, body: '{"messages":[{"role":"user","content":"hi"}]}' }, response: { status: 200, headers: {}, body: '' } };
    writeFileSync(join(dir, 'raw.jsonl'), JSON.stringify(p) + '\n');
    const sum = compactStore(root);
    expect(sum.errors).toBe(0);
    expect(new StoreReader(root).readRaw('tiny')).toEqual([p]);
  });

  it('keeps corrupt lines verbatim', () => {
    legacySession('s1', true, ['{not json']);
    compactStore(root);
    expect(readFileSync(join(root, 'sessions', 's1', 'raw.jsonl'), 'utf8')).toContain('{not json\n');
  });
});

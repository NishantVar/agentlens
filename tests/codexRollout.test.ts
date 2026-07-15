import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectCodexSessions, extractMessages, parseRollout, listCodexRollouts, rolloutNativeSessionId } from '../src/codexRollout.js';
import { rolloutFixture } from './fixtures/codexRollout.js';

describe('parseRollout', () => {
  it('emits one event per token_count with model from turn_context and cache mapping', () => {
    const events = parseRollout(rolloutFixture('/repo'));
    expect(events).toHaveLength(1); // the info:null token_count is skipped
    expect(events[0]).toEqual({
      ts: '2026-07-14T18:07:30.000Z', seq: 1, kind: 'api_call', model: 'gpt-5.3-codex',
      usage: { input: 4812, output: 256, cacheRead: 17152, cacheWrite: 0, reasoning: 85 },
      durationMs: 0, status: 200,
    });
  });
  it('tolerates junk lines', () => {
    expect(parseRollout('not json\n' + rolloutFixture('/repo'))).toHaveLength(1);
  });
});

describe('extractMessages', () => {
  it('extracts role/text pairs from message response_items', () => {
    expect(extractMessages(rolloutFixture('/repo'))).toEqual([
      { role: 'user', text: 'Reply with exactly: PROXY-OK' },
      { role: 'assistant', text: 'PROXY-OK' },
    ]);
  });
});

describe('collectCodexSessions', () => {
  it('finds new rollouts recursively, filters by cwd, ignores old files', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-sessions-'));
    const day = join(root, '2026', '07', '14');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, 'rollout-a.jsonl'), rolloutFixture('/repo'));
    writeFileSync(join(day, 'rollout-b.jsonl'), rolloutFixture('/other'));
    const startedAt = new Date(Date.now() - 60_000);
    const all = collectCodexSessions(startedAt, { sessionsRoot: root });
    expect(all).toHaveLength(2);
    const mine = collectCodexSessions(startedAt, { sessionsRoot: root, cwd: '/repo' });
    expect(mine).toHaveLength(1);
    expect(mine[0].events).toHaveLength(1);
    // files older than startedAt are ignored
    const future = collectCodexSessions(new Date(Date.now() + 60_000), { sessionsRoot: root });
    expect(future).toHaveLength(0);
  });
  it('returns [] for a missing root (fail-open)', () => {
    expect(collectCodexSessions(new Date(), { sessionsRoot: '/nope/nothing' })).toEqual([]);
  });
});

describe('listCodexRollouts / rolloutNativeSessionId', () => {
  it('lists all rollouts with native id, cwd and time bounds (no window filter)', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-sessions-'));
    mkdirSync(join(root, '2026', '07'), { recursive: true });
    writeFileSync(join(root, '2026', '07', 'rollout-old.jsonl'), rolloutFixture('/repo'));
    const [r] = listCodexRollouts({ sessionsRoot: root });
    expect(r.nativeSessionId).toBe('019f-test');
    expect(r.cwd).toBe('/repo');
    expect(r.startedAt).toBe('2026-07-14T18:07:23.308Z');
    expect(r.endedAt).toBe('2026-07-14T18:07:32.000Z');
    expect(r.events).toHaveLength(1);
    expect(listCodexRollouts({ sessionsRoot: join(root, 'nope') })).toEqual([]);
  });
  it('rolloutNativeSessionId reads session_meta payload id', () => {
    expect(rolloutNativeSessionId(rolloutFixture('/repo'))).toBe('019f-test');
    expect(rolloutNativeSessionId('not json\n')).toBeUndefined();
  });
});

describe('collectCodexSessions native id', () => {
  it('includes nativeSessionId on collected sessions', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-sessions-'));
    mkdirSync(join(root, 'd'), { recursive: true });
    writeFileSync(join(root, 'd', 'rollout-x.jsonl'), rolloutFixture('/repo'));
    const [s] = collectCodexSessions(new Date(Date.now() - 60_000), { sessionsRoot: root });
    expect(s.nativeSessionId).toBe('019f-test');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runImport } from '../src/import.js';
import { SessionWriter, StoreReader } from '../src/store.js';
import { claudeNoiseFixture, claudeTranscriptFixture, CLAUDE_RAW_BODY } from './fixtures/claudeTranscript.js';
import { rolloutFixture } from './fixtures/codexRollout.js';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
let home: string, projects: string, codexRoot: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agentlens-home-'));
  projects = mkdtempSync(join(tmpdir(), 'claude-projects-'));
  codexRoot = mkdtempSync(join(tmpdir(), 'codex-sessions-'));
  process.env.AGENTLENS_HOME = home;
  process.env.AGENTLENS_CLAUDE_PROJECTS = projects;
  process.env.AGENTLENS_CODEX_SESSIONS = codexRoot;
  delete process.env.AGENTLENS_TAGS;
});

const seedClaude = (sid = SID) => {
  mkdirSync(join(projects, '-repo'), { recursive: true });
  writeFileSync(join(projects, '-repo', `${sid}.jsonl`), claudeTranscriptFixture(sid));
};
const seedCodex = () => {
  mkdirSync(join(codexRoot, '2026'), { recursive: true });
  writeFileSync(join(codexRoot, '2026', 'rollout-a.jsonl'), rolloutFixture('/repo'));
};

describe('runImport', () => {
  it('imports claude + codex logs with metadata from the logs themselves', async () => {
    seedClaude(); seedCodex();
    const sum = await runImport({ tag: ['origin=backfill'] });
    expect(sum).toEqual({ imported: 2, skippedExisting: 0, skippedEmpty: 0, errors: 0 });
    const r = new StoreReader(home);
    const entries = r.listIndex();
    const claude = entries.find((e) => e.runtime === 'claude')!;
    const codex = entries.find((e) => e.runtime === 'codex')!;
    expect(claude.nativeSessionIds).toEqual([SID]);
    expect(claude.startedAt).toBe('2026-07-01T10:00:00.000Z');
    expect(claude.endedAt).toBe('2026-07-01T10:01:00.000Z');
    expect(claude.totals).toMatchObject({ input: 105, output: 17, cacheRead: 200, cacheWrite: 50, requests: 2 });
    expect(claude.tags).toEqual({ origin: 'backfill' });
    const meta = r.readMeta(claude.id);
    expect(meta.capture).toBe('logs');
    expect(meta.cwd).toBe('/repo');
    expect(meta.argv).toEqual([]);
    expect(meta.source?.kind).toBe('import');
    expect(existsSync(join(home, 'sessions', claude.id, 'transcript.jsonl'))).toBe(true);
    expect(codex.nativeSessionIds).toEqual(['019f-test']);
    expect(existsSync(join(home, 'sessions', codex.id, 'rollout-1.jsonl'))).toBe(true);
  });

  it('is idempotent — second run skips everything', async () => {
    seedClaude(); seedCodex();
    await runImport({ tag: [] });
    expect(await runImport({ tag: [] })).toEqual({ imported: 0, skippedExisting: 2, skippedEmpty: 0, errors: 0 });
  });

  it('dedups against a legacy lens-run claude session via raw.jsonl metadata', async () => {
    // legacy proxy-captured session: no nativeSessionIds, but raw body carries _session_<uuid>
    const w = new SessionWriter(home, {
      id: 'legacy-1', runtime: 'claude', capture: 'proxy', tags: {}, cwd: '/repo', argv: ['claude'],
      lensVersion: '0.1.0', startedAt: '2026-07-01T09:59:00.000Z',
    });
    w.appendRaw({ seq: 1, ts: '2026-07-01T10:00:01.000Z', durationMs: 5,
      request: { method: 'POST', path: '/v1/messages', headers: {}, body: CLAUDE_RAW_BODY.replace('11111111-1111-1111-1111-111111111111', SID) },
      response: { status: 200, headers: {}, body: '{}' } });
    w.finalize(0);
    seedClaude(); // same SID
    expect(await runImport({ tag: [] })).toEqual({ imported: 0, skippedExisting: 1, skippedEmpty: 0, errors: 0 });
  });

  it('dedups against a legacy lens-run codex session via its copied rollout', async () => {
    const w = new SessionWriter(home, {
      id: 'legacy-2', runtime: 'codex', capture: 'logs', tags: {}, cwd: '/repo', argv: ['codex'],
      lensVersion: '0.1.0', startedAt: '2026-07-14T18:07:00.000Z',
    });
    writeFileSync(join(home, 'sessions', 'legacy-2', 'rollout-1.jsonl'), rolloutFixture('/repo'));
    w.finalize(0);
    seedCodex(); // same native id 019f-test
    expect(await runImport({ tag: [] })).toEqual({ imported: 0, skippedExisting: 1, skippedEmpty: 0, errors: 0 });
  });

  it('skips empty transcripts, honors --runtime and --since', async () => {
    mkdirSync(join(projects, '-repo'), { recursive: true });
    writeFileSync(join(projects, '-repo', 'noise.jsonl'), claudeNoiseFixture());
    seedCodex();
    expect(await runImport({ runtime: 'claude', tag: [] })).toEqual({ imported: 0, skippedExisting: 0, skippedEmpty: 1, errors: 0 });
    // codex rollout started 2026-07-14 — far outside a 1-minute window, silently out of scope
    expect(await runImport({ runtime: 'codex', since: '1m', tag: [] })).toEqual({ imported: 0, skippedExisting: 0, skippedEmpty: 0, errors: 0 });
    expect((await runImport({ runtime: 'codex', tag: [] })).imported).toBe(1);
  });

  it('counts an unidentifiable log (no session id) as an error and does not import it', async () => {
    mkdirSync(join(codexRoot, 'x'), { recursive: true });
    // token_count but no session_meta line
    writeFileSync(join(codexRoot, 'x', 'rollout-noid.jsonl'),
      rolloutFixture('/repo').split('\n').filter((l) => !l.includes('session_meta')).join('\n'));
    const sum = await runImport({ runtime: 'codex', tag: [] });
    expect(sum.errors).toBe(1);
    expect(sum.imported).toBe(0);
  });

  it('AGENTLENS_TAGS overrides --tag on collision', async () => {
    process.env.AGENTLENS_TAGS = 'origin=env';
    seedClaude();
    await runImport({ runtime: 'claude', tag: ['origin=flag', 'extra=1'] });
    delete process.env.AGENTLENS_TAGS;
    const [e] = new StoreReader(home).listIndex();
    expect(e.tags).toEqual({ origin: 'env', extra: '1' });
  });
});

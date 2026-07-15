import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractClaudeSessionIdFromRawBody, findClaudeTranscripts, parseClaudeTranscript } from '../src/claudeTranscript.js';
import { claudeNoiseFixture, claudeTranscriptFixture, CLAUDE_RAW_BODY, CLAUDE_RAW_BODY_JSON_UID } from './fixtures/claudeTranscript.js';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('parseClaudeTranscript', () => {
  it('dedups usage by requestId, includes sidechains, extracts session meta', () => {
    const p = parseClaudeTranscript(claudeTranscriptFixture(SID));
    expect(p.sessionId).toBe(SID);
    expect(p.cwd).toBe('/repo');
    expect(p.startedAt).toBe('2026-07-01T10:00:00.000Z');
    expect(p.endedAt).toBe('2026-07-01T10:01:00.000Z');
    expect(p.events).toEqual([
      { ts: '2026-07-01T10:00:06.000Z', seq: 1, kind: 'api_call', model: 'claude-opus-4-8',
        usage: { input: 100, output: 10, cacheRead: 200, cacheWrite: 50, reasoning: 0 }, durationMs: 0, status: 200 },
      { ts: '2026-07-01T10:01:00.000Z', seq: 2, kind: 'api_call', model: 'claude-haiku-4-5',
        usage: { input: 5, output: 7, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, durationMs: 0, status: 200 },
    ]);
  });
  it('yields zero events for noise/title-only transcripts', () => {
    expect(parseClaudeTranscript(claudeNoiseFixture()).events).toHaveLength(0);
  });
});

describe('extractClaudeSessionIdFromRawBody', () => {
  it('pulls the session uuid out of metadata.user_id', () => {
    expect(extractClaudeSessionIdFromRawBody(CLAUDE_RAW_BODY)).toBe('11111111-1111-1111-1111-111111111111');
  });
  it('pulls the session uuid out of the current JSON-encoded user_id format', () => {
    expect(extractClaudeSessionIdFromRawBody(CLAUDE_RAW_BODY_JSON_UID)).toBe('33333333-3333-3333-3333-333333333333');
  });
  it('returns undefined when absent', () => {
    expect(extractClaudeSessionIdFromRawBody('{"model":"m"}')).toBeUndefined();
    expect(extractClaudeSessionIdFromRawBody('not json at all')).toBeUndefined();
  });
});

describe('findClaudeTranscripts', () => {
  it('walks project subdirs for .jsonl files and tolerates a missing root', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-projects-'));
    mkdirSync(join(root, '-Users-x-repo'));
    writeFileSync(join(root, '-Users-x-repo', `${SID}.jsonl`), claudeTranscriptFixture(SID));
    expect(findClaudeTranscripts(root)).toEqual([join(root, '-Users-x-repo', `${SID}.jsonl`)]);
    expect(findClaudeTranscripts(join(root, 'does-not-exist'))).toEqual([]);
  });
});

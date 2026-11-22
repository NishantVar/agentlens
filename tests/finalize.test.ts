import { describe, it, expect, afterEach } from 'vitest';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { finalizeSession, prepareClaims } from '../src/finalize.js';
import { scanRollout } from '../src/codexRollout.js';
import { listClaims, tryClaim } from '../src/claims.js';
import type { SessionMeta } from '../src/types.js';
import { index, metaLines, tmp, usageLine } from './helpers/lens.js';

// ALF-2 / ALF-4 [large-claimed] support: a rollout read ahead of finalize
// (prepareClaims) must give the same entry and copy as reading it in full.
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function setup() {
  const root = tmp('agentlens-home-'); const codex = tmp('codex-sessions-'); dirs.push(root, codex);
  const id = 's1'; const dir = join(root, 'sessions', id); mkdirSync(dir, { recursive: true });
  const meta: SessionMeta = { id, runtime: 'codex', capture: 'logs', tags: {}, cwd: '/fixture', argv: ['codex'], lensVersion: '0.1.0', startedAt: new Date().toISOString() };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  const rollout = join(codex, 'rollout-a.jsonl');
  writeFileSync(rollout, [...metaLines('native-a', '/fixture'), usageLine({ input: 100, cached: 0, output: 10 })].map((l) => l + '\n').join(''));
  tryClaim(root, { rollout, session: id, holders: [], claimedAt: new Date().toISOString() });
  return { root, id, dir, meta, rollout };
}
const turn = (model: string) => JSON.stringify({ timestamp: new Date().toISOString(), type: 'turn_context', payload: { turn_id: 't2', cwd: '/fixture', model } });

describe('finalize with claimed rollouts read ahead', () => {
  it('counts what was appended after the read-ahead, keeps the model and native id, and copies the whole rollout', () => {
    const { root, id, dir, meta, rollout } = setup();
    appendFileSync(rollout, usageLine({ input: 200, cached: 0, output: 20 }).slice(0, 40)); // partial line at read-ahead
    const prepared = prepareClaims(root, id);
    appendFileSync(rollout, usageLine({ input: 200, cached: 0, output: 20 }).slice(40) + '\n' + turn('gpt-later') + '\n' + usageLine({ input: 300, cached: 0, output: 30 }) + '\n');
    const entry = finalizeSession(root, id, { exitCode: 0, role: 'writer', meta, prepared, log: () => {} })!;
    expect(entry.totals).toMatchObject({ input: 600, output: 60, requests: 3 });
    expect(entry.models.sort()).toEqual(['gpt-5.3-codex', 'gpt-later']);
    expect(entry.nativeSessionIds).toEqual(['native-a']);
    expect(readFileSync(join(dir, 'rollout-1.jsonl'), 'utf8')).toBe(readFileSync(rollout, 'utf8'));
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('reads a rollout in full when it was truncated after the read-ahead', () => {
    const { root, id, dir, meta, rollout } = setup();
    const prepared = prepareClaims(root, id);
    writeFileSync(rollout, metaLines('native-b', '/fixture').map((l) => l + '\n').join('') + usageLine({ input: 5, cached: 0, output: 1 }) + '\n');
    const entry = finalizeSession(root, id, { exitCode: 0, role: 'writer', meta, prepared, log: () => {} })!;
    expect(entry.totals).toMatchObject({ input: 5, output: 1, requests: 1 });
    expect(entry.nativeSessionIds).toEqual(['native-b']);
    expect(readFileSync(join(dir, 'rollout-1.jsonl'), 'utf8')).toBe(readFileSync(rollout, 'utf8'));
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('counts what was read ahead when the rollout cannot be read at finalize', () => {
    const { root, id, dir, meta, rollout } = setup();
    const before = readFileSync(rollout, 'utf8');
    const prepared = prepareClaims(root, id);
    chmodSync(rollout, 0o000);
    try {
      const entry = finalizeSession(root, id, { exitCode: 0, role: 'writer', meta, prepared, log: () => {} })!;
      expect(entry.totals).toMatchObject({ input: 100, output: 10, requests: 1 });
      expect(readFileSync(join(dir, 'rollout-1.jsonl'), 'utf8')).toBe(before);
    } finally { chmodSync(rollout, 0o644); }
  });

  it('ALF-4 [prepare-fails] a temp copy that cannot be removed at finalize does not stop the entry being saved with full usage', () => {
    const { root, id, dir, meta, rollout } = setup();
    const other = rollout.replace('rollout-a', 'rollout-b');
    writeFileSync(other, [...metaLines('native-b', '/fixture'), usageLine({ input: 7, cached: 0, output: 1 })].map((l) => l + '\n').join(''));
    tryClaim(root, { rollout: other, session: id, holders: [], claimedAt: new Date().toISOString() });
    const prepared = prepareClaims(root, id);
    const claims = listClaims(root).filter((c) => c.rollout === rollout); // b's read-ahead is left for cleanup
    process.env.AGENTLENS_TEST_HOOKS = 'finalize:before-temp-rm=throw';
    let entry;
    try { entry = finalizeSession(root, id, { exitCode: 0, role: 'writer', meta, prepared, claims, log: () => {} }); }
    finally { delete process.env.AGENTLENS_TEST_HOOKS; }
    expect(entry?.totals).toMatchObject({ input: 100, output: 10, requests: 1 });
    expect(index(root).map((x) => x.id)).toEqual([id]);
    expect(readFileSync(join(dir, 'rollout-1.jsonl'), 'utf8')).toBe(readFileSync(rollout, 'utf8'));
  });

  it('ALF-2 [rewritten-rollout] a rollout replaced or rewritten after the read-ahead, at least as long, is counted and copied from its current version only', () => {
    for (const how of ['replaced', 'rewritten in place'] as const) {
      const { root, id, dir, meta, rollout } = setup();
      const prepared = prepareClaims(root, id);
      const offset = readFileSync(rollout).length;
      const pad = JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'y'.repeat(offset) }] } });
      const next = [...metaLines('newer', '/fixture'), turn('gpt-newer'), pad, usageLine({ input: 12, cached: 0, output: 0 })].map((l) => l + '\n').join('');
      expect(next.length).toBeGreaterThanOrEqual(offset);
      if (how === 'replaced') { writeFileSync(rollout + '.new', next); renameSync(rollout + '.new', rollout); }
      else writeFileSync(rollout, next);
      const want = scanRollout(next);
      const entry = finalizeSession(root, id, { exitCode: 0, role: 'writer', meta, prepared, log: () => {} })!;
      const totals = want.events.reduce((a, e) => ({ input: a.input + e.usage.input, output: a.output + e.usage.output }), { input: 0, output: 0 });
      expect(entry.totals, how).toMatchObject({ ...totals, requests: want.events.length });
      expect(entry.totals.input, how).toBe(12);
      expect(entry.models.sort(), how).toEqual([...new Set(want.events.map((e) => e.model))].sort());
      expect(entry.nativeSessionIds, how).toEqual(['newer']);
      expect(readFileSync(join(dir, 'rollout-1.jsonl'), 'utf8'), how).toBe(next);
      expect(readdirSync(dir).filter((f) => f.endsWith('.tmp')), how).toEqual([]);
    }
  });
});

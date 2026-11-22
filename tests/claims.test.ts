import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import {
  claims, freshEnv, index, killQuiet, lensRunFake, looks, metaLines, rolloutPath, spawnWriter, touch, usageLine, waitFor,
  type Env,
} from './helpers/lens.js';

const T = 30000;
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

// A fake codex that opens its rollout for writing, writes session_meta and the
// given usage, signals ready, waits for `gate`, writes `after` usage, signals
// `done`, then waits for `exit` and leaves.
function codexScript(e: Env, name: string, id: string, before: { input: number; cached: number; output: number }[], s: { gate?: string; after?: typeof before; done?: string; exit: string; ready: string }) {
  const p = rolloutPath(e, name);
  return [
    { open: p }, { write: p, lines: [...metaLines(id, e.cwd), ...before.map(usageLine)] }, { touch: s.ready },
    ...(s.gate ? [{ wait: s.gate }, { write: p, lines: (s.after ?? []).map(usageLine) }, { touch: s.done! }] : []),
    { wait: s.exit },
  ];
}

describe('one agent per Codex log', () => {
  it('ALF-10 [two-sessions] two concurrent sessions in one folder each carry only their own usage', async () => {
    const e = freshEnv();
    const sy = (f: string) => join(e.sync, f);
    const a = lensRunFake(e, 'codex', codexScript(e, 'a', 'sess-a', [{ input: 1000, cached: 200, output: 50 }],
      { ready: sy('a.ready'), gate: sy('both'), after: [{ input: 300, cached: 0, output: 30 }], done: sy('a.done'), exit: sy('a.exit') }));
    const b = lensRunFake(e, 'codex', codexScript(e, 'b', 'sess-b', [{ input: 5000, cached: 1000, output: 400 }],
      { ready: sy('b.ready'), gate: sy('both'), after: [{ input: 70, cached: 10, output: 7 }], done: sy('b.done'), exit: sy('b.exit') }));
    cleanup.push(() => { killQuiet(a.child.pid); killQuiet(b.child.pid); });
    await waitFor(() => claims(e.home).length === 2, T, 'two claims');
    touch(sy('both'));                             // each writes again while the other runs
    await waitFor(() => readdirSync(e.sync).includes('a.done') && readdirSync(e.sync).includes('b.done'), T, 'second writes');
    touch(sy('a.exit')); touch(sy('b.exit'));
    expect((await a.done).code).toBe(0); expect((await b.done).code).toBe(0);
    const entries = index(e.home);
    expect(entries).toHaveLength(2);
    const byNative = Object.fromEntries(entries.map((x) => [x.nativeSessionIds?.[0], x.totals]));
    expect(byNative['sess-a']).toMatchObject({ input: 1100, cacheRead: 200, output: 80, requests: 2 });
    expect(byNative['sess-b']).toMatchObject({ input: 4060, cacheRead: 1010, output: 407, requests: 2 });
    const sum = entries.reduce((t, x) => t + x.totals.input + x.totals.cacheRead + x.totals.output, 0);
    expect(sum).toBe(1100 + 200 + 80 + 4060 + 1010 + 407);
  }, T);

  it('ALF-11 [unlaunched] a writer no lens run launched is not claimed and is named on stderr', async () => {
    const e = freshEnv();
    const sy = (f: string) => join(e.sync, f);
    const stray = rolloutPath(e, 'stray');
    const w = spawnWriter(e, [{ open: stray }, { write: stray, lines: [...metaLines('stray', e.cwd), usageLine({ input: 900, cached: 0, output: 90 })] }, { touch: sy('w.ready') }, { forever: true }]);
    cleanup.push(() => killQuiet(w.pid));
    await waitFor(() => readdirSync(e.sync).includes('w.ready'), T, 'stray writer');
    const lookLog = sy('looks.jsonl');
    const s = lensRunFake(e, 'codex', codexScript(e, 'own', 'own', [{ input: 10, cached: 0, output: 1 }], { ready: sy('s.ready'), exit: sy('s.exit') }),
      { AGENTLENS_TEST_LOOK_LOG: lookLog });
    cleanup.push(() => killQuiet(s.child.pid));
    await waitFor(() => claims(e.home).length === 1 && looks(lookLog).length >= 2, T, 'own claim and two looks');
    touch(sy('s.exit'));
    expect((await s.done).code).toBe(0);
    expect(claims(e.home).map((c) => c.rollout)).toEqual([rolloutPath(e, 'own')]);
    expect(index(e.home)[0].totals).toMatchObject({ input: 10, output: 1, requests: 1 });
    expect(s.err()).toContain(stray);
  }, T);

  it('ALF-11 [read-only] a read-only holder does not claim; the writing session does', async () => {
    const e = freshEnv();
    const sy = (f: string) => join(e.sync, f);
    const bLog = rolloutPath(e, 'b');
    const b = lensRunFake(e, 'codex', codexScript(e, 'b', 'sess-b', [{ input: 400, cached: 0, output: 40 }], { ready: sy('b.ready'), exit: sy('b.exit') }));
    cleanup.push(() => killQuiet(b.child.pid));
    await waitFor(() => readdirSync(e.sync).includes('b.ready'), T, 'b ready');
    const aLooks = sy('a-looks.jsonl');
    const a = lensRunFake(e, 'codex', [{ open: bLog, mode: 'r' }, { touch: sy('a.ready') }, { wait: sy('a.exit') }], { AGENTLENS_TEST_LOOK_LOG: aLooks });
    cleanup.push(() => killQuiet(a.child.pid));
    await waitFor(() => readdirSync(e.sync).includes('a.ready'), T, 'a ready');
    const n0 = looks(aLooks).length;
    await waitFor(() => looks(aLooks).length >= n0 + 2 && claims(e.home).length === 1, T, 'a looks while holding read-only');
    touch(sy('a.exit')); touch(sy('b.exit'));
    expect((await a.done).code).toBe(0); expect((await b.done).code).toBe(0);
    const cs = claims(e.home);
    expect(cs).toHaveLength(1);
    const entries = index(e.home);
    const bEntry = entries.find((x) => x.nativeSessionIds?.includes('sess-b'))!;
    const aEntry = entries.find((x) => x !== bEntry)!;
    expect(cs[0].session).toBe(bEntry.id);
    expect(bEntry.totals).toMatchObject({ input: 400, output: 40, requests: 1 });
    expect(aEntry.totals).toMatchObject({ input: 0, output: 0, requests: 0 });
  }, T);

  it('ALF-38 [same-rollout] two writers claim one rollout at once; exactly one claim is recorded', async () => {
    const e = freshEnv();
    const sy = (f: string) => join(e.sync, f);
    const shared = rolloutPath(e, 'shared');
    const hooks = { AGENTLENS_TEST_HOOKS: `claim:before-link=pause:${e.sync}` };
    const mk = (n: string) => lensRunFake(e, 'codex', [
      { open: shared }, ...(n === '1' ? [{ write: shared, lines: [...metaLines('shared', e.cwd), usageLine({ input: 600, cached: 100, output: 60 })] }] : []),
      { touch: sy(`${n}.ready`) }, { wait: sy('exit') },
    ], hooks);
    const w1 = mk('1'); const w2 = mk('2');
    cleanup.push(() => { killQuiet(w1.child.pid); killQuiet(w2.child.pid); });
    await waitFor(() => readdirSync(e.sync).filter((f) => f.startsWith('claim:before-link.') && f.endsWith('.reached')).length === 2, T, 'both writers at the link');
    touch(join(e.sync, 'claim:before-link.release'));
    await waitFor(() => claims(e.home).length === 1, T, 'claim');
    touch(sy('exit'));
    await w1.done; await w2.done;
    const cs = claims(e.home);
    expect(cs).toHaveLength(1);
    const entries = index(e.home);
    expect(entries).toHaveLength(2);
    const winner = entries.find((x) => x.id === cs[0].session)!;
    const loser = entries.find((x) => x.id !== cs[0].session)!;
    expect(winner.totals).toMatchObject({ input: 500, cacheRead: 100, output: 60, requests: 1 });
    expect(loser.totals).toMatchObject({ input: 0, cacheRead: 0, output: 0, requests: 0 });
  }, T);

  it('ALF-39 [evidence-unreadable] entry still written, no claim, stderr says why', async () => {
    const e = freshEnv({ AGENTLENS_LSOF: '/nonexistent/lsof' });
    const sy = (f: string) => join(e.sync, f);
    const lookLog = sy('looks.jsonl');
    const s = lensRunFake(e, 'codex', codexScript(e, 'x', 'x', [{ input: 10, cached: 0, output: 1 }], { ready: sy('ready'), exit: sy('exit') }), { AGENTLENS_TEST_LOOK_LOG: lookLog });
    cleanup.push(() => killQuiet(s.child.pid));
    await waitFor(() => readdirSync(e.sync).includes('ready') && looks(lookLog).length >= 3, T, 'looks');
    touch(sy('exit'));
    expect((await s.done).code).toBe(0);
    expect(index(e.home)).toHaveLength(1);
    expect(claims(e.home)).toEqual([]);
    const reasons = s.err().split('\n').filter((l) => l.includes('cannot read open-file evidence'));
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/no Codex rollout claimed/);
  }, T);
});

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { StoreReader } from '../src/store.js';
import { startDashboard } from '../src/dashboard.js';
import type { ProcIdentity } from '../src/procinfo.js';
import {
  FAKE_BIN, claims, deadIdentity, eventLines, freshEnv, index, killQuiet, lensRunFake, liveSleeper, looks, metaLines, mockUpstream,
  pidAlive, pidOf, rolloutPath, runLens, sessionIds, spawnLens, spawnWriter, tmp, touch, usageLine, waitFor, type Env,
} from './helpers/lens.js';

const T = 60000;
let up: { origin: string; close: () => void };
beforeAll(async () => { up = await mockUpstream(); });
afterAll(() => up.close());
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

// ---- store fixtures -------------------------------------------------------------
interface Fx { id: string; runtime?: 'claude' | 'codex'; wrapper?: ProcIdentity | null; tags?: Record<string, string>; cwd?: string; usages?: { input: number; output: number; cacheRead?: number }[]; startedAt?: string }
function writeSession(home: string, f: Fx): string {
  const dir = join(home, 'sessions', f.id);
  mkdirSync(dir, { recursive: true });
  const runtime = f.runtime ?? 'claude';
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({
    id: f.id, runtime, capture: runtime === 'claude' ? 'proxy' : 'logs', tags: f.tags ?? {}, cwd: f.cwd ?? '/fixture', argv: [runtime],
    lensVersion: '0.1.0', startedAt: f.startedAt ?? new Date(Date.now() - 60_000).toISOString(),
    ...(f.wrapper ? { wrapper: f.wrapper } : {}),
  }, null, 2));
  const evs = (f.usages ?? []).map((u, i) => JSON.stringify({
    ts: new Date().toISOString(), seq: i + 1, kind: 'api_call', model: 'claude-opus-4-1',
    usage: { input: u.input, output: u.output, cacheRead: u.cacheRead ?? 0, cacheWrite: 0 }, durationMs: 5, status: 200,
  }) + '\n');
  if (evs.length) writeFileSync(join(dir, 'events.jsonl'), evs.join(''));
  return dir;
}
function finalizedSession(home: string, id: string, usage: { input: number; output: number }) {
  writeSession(home, { id, usages: [usage] });
  const meta = JSON.parse(readFileSync(join(home, 'sessions', id, 'meta.json'), 'utf8'));
  const endedAt = new Date().toISOString();
  writeFileSync(join(home, 'sessions', id, 'meta.json'), JSON.stringify({ ...meta, endedAt, exitCode: 0 }));
  writeFileSync(join(home, 'index.jsonl'), JSON.stringify({
    id, runtime: 'claude', tags: {}, models: ['claude-opus-4-1'], startedAt: meta.startedAt, endedAt, exitCode: 0,
    totals: { input: usage.input, output: usage.output, cacheRead: 0, cacheWrite: 0, requests: 1 },
  }) + '\n', { flag: 'a' });
}
const recover = (e: Env, extra: NodeJS.ProcessEnv = {}) => runLens(['recover'], { ...e.env, ...extra });
const statsJson = async (e: Env) => { const r = await runLens(['stats', '--json'], e.env); expect(r.code).toBe(0); return JSON.parse(r.out).rows as { key: string; sessions: number; totals: Record<string, number> }[]; };
const ageTree = (dir: string, ms: number) => {
  const t = new Date(Date.now() - ms);
  for (const f of readdirSync(dir)) utimesSync(join(dir, f), t, t);
  utimesSync(dir, t, t);
};
const ppidOf = (pid: number): number => { try { return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()); } catch { return -1; } };
const claimHash = (p: string) => createHash('sha256').update(p).digest('hex');

describe('recovery sweep', () => {
  it('ALF-5 [recover] a SIGKILLed wrapper leaves a session that recover finalizes once with exit unknown', async () => {
    const e = freshEnv({ AGENTLENS_UPSTREAM: up.origin });
    const gate = join(e.sync, 'gate');
    const r = lensRunFake(e, 'claude', [{ post: true }, { post: true }, { wait: gate }]);
    cleanup.push(() => { touch(gate); killQuiet(r.child.pid); });
    const id = await waitFor(() => sessionIds(e.home)[0], T, 'session dir');
    await waitFor(() => eventLines(e.home, id).length === 2, T, 'two events');
    r.child.kill('SIGKILL');
    await r.done;
    touch(gate); // the orphaned child now exits normally
    expect(index(e.home)).toHaveLength(0);
    const out = await recover(e);
    expect(out.code).toBe(0);
    expect(out.out).toMatch(/recovered 1/);
    const entries = index(e.home);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id, recovered: true, exitCode: null });
    expect(entries[0].totals).toMatchObject({ input: 14, output: 6, cacheRead: 22, requests: 2 });
    const js = await runLens(['sessions', '--json'], e.env);
    expect(JSON.parse(js.out)[0].exitCode).toBeNull();
    const table = await runLens(['sessions'], e.env);
    expect(table.out.split('\n').find((l) => l.startsWith(id))).toMatch(/\bunknown\s*$/);
    expect((await recover(e)).code).toBe(0);
    expect(index(e.home)).toHaveLength(1);
  }, T);

  it('ALF-6 [includes] stats includes a dead-wrapper session', async () => {
    const e = freshEnv();
    writeSession(e.home, { id: 's-dead', wrapper: await deadIdentity(), usages: [{ input: 40, output: 4 }] });
    const s = await statsJson(e);
    expect(s).toMatchObject([{ key: '(all)', sessions: 1 }]);
    expect(index(e.home)).toMatchObject([{ id: 's-dead', recovered: true, exitCode: null }]);
  }, T);

  it('ALF-6 [unreadable] an unreadable session does not break stats or change the other rows', async () => {
    const dead = await deadIdentity();
    const build = (withBad: boolean) => {
      const e = freshEnv();
      finalizedSession(e.home, 's-ok', { input: 10, output: 1 });
      writeSession(e.home, { id: 's-dead', wrapper: dead, usages: [{ input: 40, output: 4 }] });
      if (withBad) mkdirSync(join(e.home, 'sessions', 's-bad', 'meta.json'), { recursive: true }); // a dir in place of meta.json
      return e;
    };
    const withBad = build(true); const without = build(false);
    const a = await statsJson(withBad);
    const b = await statsJson(without);
    expect(a).toEqual(b);
    expect(a).toMatchObject([{ sessions: 2 }]);
  }, T);

  it('ALF-7 [live] a session whose wrapper is alive is left alone', async () => {
    const e = freshEnv();
    const s = await liveSleeper(); cleanup.push(s.stop);
    writeSession(e.home, { id: 's-live', wrapper: s.id, usages: [{ input: 1, output: 1 }] });
    expect((await recover(e)).code).toBe(0);
    expect(index(e.home)).toHaveLength(0);
  }, T);

  it('ALF-7 [reused-pid] a live pid with a different start time is a gone wrapper', async () => {
    const e = freshEnv();
    const s = await liveSleeper(); cleanup.push(s.stop);
    writeSession(e.home, { id: 's-reused', wrapper: { pid: s.id.pid, startTime: 'Mon Jan 1 00:00:00 2001' }, usages: [{ input: 1, output: 1 }] });
    expect((await recover(e)).code).toBe(0);
    expect(index(e.home)).toMatchObject([{ id: 's-reused', recovered: true }]);
  }, T);

  it('ALF-8 [idle] a legacy session idle two hours is recovered; a nearby rollout is not counted or claimed', async () => {
    const e = freshEnv();
    const startedAt = new Date(Date.now() - 3 * 3600_000).toISOString();
    const dir = writeSession(e.home, { id: 's-legacy', runtime: 'codex', cwd: e.cwd, startedAt });
    const p = rolloutPath(e, 'legacy-near');
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, [...metaLines('legacy-near', e.cwd), usageLine({ input: 500, cached: 0, output: 50 })].join('\n') + '\n');
    ageTree(dir, 2 * 3600_000);
    expect((await recover(e)).code).toBe(0);
    const entries = index(e.home);
    expect(entries).toMatchObject([{ id: 's-legacy', recovered: true, exitCode: null }]);
    expect(entries[0].totals).toMatchObject({ input: 0, output: 0, requests: 0 });
    expect(claims(e.home)).toHaveLength(0);
  }, T);

  it('ALF-8 [recent] a legacy session touched ten minutes ago is left alone', async () => {
    const e = freshEnv();
    const dir = writeSession(e.home, { id: 's-recent', usages: [{ input: 1, output: 1 }] });
    ageTree(dir, 10 * 60_000);
    expect((await recover(e)).code).toBe(0);
    expect(index(e.home)).toHaveLength(0);
  }, T);

  it('ALF-9 [no-sweep] lens run does not recover old sessions', async () => {
    const e = freshEnv({ AGENTLENS_UPSTREAM: up.origin });
    writeSession(e.home, { id: 's-old', wrapper: await deadIdentity(), usages: [{ input: 1, output: 1 }] });
    const r = lensRunFake(e, 'claude', [{ post: true }]);
    expect((await r.done).code).toBe(0);
    const entries = index(e.home);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).not.toBe('s-old');
  }, T);

  it('ALF-12 [killed-wrapper] a killed wrapper whose agent keeps writing is recovered only after the agent exits, with all its usage', async () => {
    const e = freshEnv();
    const pa = rolloutPath(e, 'a'); const pb = rolloutPath(e, 'b');
    const s = (n: string) => join(e.sync, n);
    const lookB = s('looks-b.jsonl');
    const A = lensRunFake(e, 'codex', [
      { open: pa }, { write: pa, lines: [...metaLines('a', e.cwd), usageLine({ input: 300, cached: 0, output: 30 })] },
      { touch: s('a-ready') }, { wait: s('a-gate') },
    ]);
    const B = lensRunFake(e, 'codex', [
      { open: pb }, { write: pb, lines: [...metaLines('b', e.cwd), usageLine({ input: 1000, cached: 0, output: 100 })] },
      { touch: s('b-ready') }, { wait: s('b-more') },
      { write: pb, lines: [usageLine({ input: 2000, cached: 0, output: 200 })] },
      { touch: s('b-wrote') }, { wait: s('b-exit') },
    ], { AGENTLENS_TEST_LOOK_LOG: lookB, FAKE_PIDFILE: s('b-pid') });
    cleanup.push(() => { for (const g of ['a-gate', 'b-more', 'b-exit']) touch(s(g)); killQuiet(A.child.pid); killQuiet(B.child.pid); });
    await waitFor(() => existsSync(s('a-ready')) && existsSync(s('b-ready')), T, 'both fakes ready');
    await waitFor(() => looks(lookB).some((l) => l.claimed.length > 0), T, "B's first claim");
    B.child.kill('SIGKILL');
    await B.done;
    touch(s('b-more'));
    await waitFor(() => existsSync(s('b-wrote')), T, 'B wrote after the kill');
    touch(s('a-gate'));
    expect((await A.done).code).toBe(0);
    expect(index(e.home)).toHaveLength(1);
    expect((await recover(e)).code).toBe(0);
    expect(index(e.home)).toHaveLength(1); // B's agent still alive
    touch(s('b-exit'));
    await waitFor(() => { try { process.kill(Number(readFileSync(s('b-pid'), 'utf8')), 0); return false; } catch { return true; } }, T, "B's agent exit");
    expect((await recover(e)).code).toBe(0);
    const entries = index(e.home);
    expect(entries).toHaveLength(2);
    const [a, b] = entries;
    expect(a.totals).toMatchObject({ input: 300, output: 30, requests: 1 });
    expect(b).toMatchObject({ recovered: true, exitCode: null });
    expect(b.totals).toMatchObject({ input: 3000, output: 300, requests: 2 });
    const cs = claims(e.home);
    expect(cs).toHaveLength(2);
    expect(readdirSync(join(e.home, 'claims')).filter((f) => f.endsWith('.json')).sort())
      .toEqual([claimHash(cs[0].rollout) + '.json', claimHash(cs[1].rollout) + '.json'].sort());
  }, T);

  it('ALF-36 [report] lens report runs the sweep and includes the recovered session', async () => {
    const e = freshEnv();
    writeSession(e.home, { id: 's-r1', wrapper: await deadIdentity(), tags: { run: 'r1' }, usages: [{ input: 5, output: 2 }] });
    const out = join(tmp('agentlens-report-'), 'r.html');
    const r = await runLens(['report', '--tag', 'run=r1', '--out', out], e.env);
    expect(r.code).toBe(0);
    expect(index(e.home)).toMatchObject([{ id: 's-r1', recovered: true }]);
    expect(readFileSync(out, 'utf8')).toContain('s-r1');
  }, T);

  it('ALF-36 [dashboard] /api/data runs the sweep and serves exitCode null, recovered true', async () => {
    const e = freshEnv();
    writeSession(e.home, { id: 's-dash', wrapper: await deadIdentity(), tags: { run: 'r1' }, usages: [{ input: 5, output: 2 }] });
    const copy = tmp('agentlens-home-copy-');
    cpSync(e.home, copy, { recursive: true });
    const d = await startDashboard(0, new StoreReader(copy));
    try {
      const data = await (await fetch(`${d.origin}/api/data`)).json();
      expect(index(copy)).toMatchObject([{ id: 's-dash', recovered: true }]);
      expect(data.recent).toMatchObject([{ id: 's-dash', exitCode: null, recovered: true }]);
    } finally { await d.close(); }
  }, T);
});

describe('finalize exactly once', () => {
  // A logs-mode session with a dead wrapper and two claimed rollouts.
  async function claimedFixture(e: Env) {
    const dead = await deadIdentity();
    writeSession(e.home, { id: 's-two', runtime: 'codex', wrapper: dead, cwd: e.cwd });
    mkdirSync(join(e.home, 'claims'), { recursive: true });
    for (const [n, u] of [['one', { input: 100, cached: 0, output: 10 }], ['two', { input: 200, cached: 0, output: 20 }]] as const) {
      const p = rolloutPath(e, n);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, [...metaLines(n, e.cwd), usageLine(u)].join('\n') + '\n');
      writeFileSync(join(e.home, 'claims', claimHash(p) + '.json'), JSON.stringify({ rollout: p, session: 's-two', holders: [dead], claimedAt: new Date().toISOString() }));
    }
  }
  const expectTwoOnce = async (e: Env, id: string) => {
    const entries = index(e.home);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id, recovered: true, exitCode: null });
    expect(entries[0].totals).toMatchObject({ input: 300, output: 30, requests: 2 });
    expect(eventLines(e.home, id)).toHaveLength(2);
    const s = await statsJson(e);
    expect(s).toMatchObject([{ key: '(all)', sessions: 1 }]);
  };

  it('ALF-37 [concurrent-recover] two recovers released together finalize once', async () => {
    const e = freshEnv();
    await claimedFixture(e);
    const hooks = { AGENTLENS_TEST_HOOKS: `recover:after-gate=pause:${e.sync}` };
    const r1 = spawnLens(['recover'], { ...e.env, ...hooks });
    const r2 = spawnLens(['recover'], { ...e.env, ...hooks });
    cleanup.push(() => { killQuiet(r1.child.pid); killQuiet(r2.child.pid); });
    await waitFor(() => readdirSync(e.sync).filter((f) => f.startsWith('recover:after-gate.') && f.endsWith('.reached')).length === 2, T, 'both at the gate');
    touch(join(e.sync, 'recover:after-gate.release'));
    expect((await r1.done).code).toBe(0);
    expect((await r2.done).code).toBe(0);
    await expectTwoOnce(e, 's-two');
  }, T);

  it('ALF-37 [sweep-during-finalize] a recover while the wrapper is finalizing adds nothing', async () => {
    const e = freshEnv({ AGENTLENS_UPSTREAM: up.origin });
    const r = lensRunFake(e, 'claude', [{ post: true }], { AGENTLENS_TEST_HOOKS: `finalize:after-ticket=pause:${e.sync}` });
    cleanup.push(() => killQuiet(r.child.pid));
    await waitFor(() => readdirSync(e.sync).some((f) => f.startsWith('finalize:after-ticket.')), T, 'wrapper at the ticket');
    expect((await recover(e)).code).toBe(0);
    expect(index(e.home)).toHaveLength(0);
    touch(join(e.sync, 'finalize:after-ticket.release'));
    expect((await r.done).code).toBe(0);
    const entries = index(e.home);
    expect(entries).toHaveLength(1);
    expect(entries[0].recovered).toBeUndefined();
    expect(entries[0].exitCode).toBe(0);
  }, T);

  it('ALF-37 [partial-finalize] a wrapper killed mid-finalize is completed by the sweep, each rollout once', async () => {
    const e = freshEnv();
    const p1 = rolloutPath(e, 'p1'); const p2 = rolloutPath(e, 'p2');
    const lookLog = join(e.sync, 'looks.jsonl');
    const r = lensRunFake(e, 'codex', [
      { open: p1 }, { write: p1, lines: [...metaLines('p1', e.cwd), usageLine({ input: 100, cached: 0, output: 10 })] },
      { open: p2 }, { write: p2, lines: [...metaLines('p2', e.cwd), usageLine({ input: 200, cached: 0, output: 20 })] },
      { wait: join(e.sync, 'gate') },
    ], { AGENTLENS_TEST_HOOKS: 'finalize:after-partial-events=kill', AGENTLENS_TEST_LOOK_LOG: lookLog });
    cleanup.push(() => { touch(join(e.sync, 'gate')); killQuiet(r.child.pid); });
    await waitFor(() => looks(lookLog).some((l) => l.claimed.length === 2), T, 'both rollouts claimed');
    touch(join(e.sync, 'gate'));
    expect((await r.done).signal).toBe('SIGKILL');
    const id = sessionIds(e.home)[0];
    expect(index(e.home)).toHaveLength(0);
    expect(eventLines(e.home, id).length).toBeGreaterThan(0); // the partial state exists
    expect((await recover(e)).code).toBe(0);
    await expectTwoOnce(e, id);
  }, T);
});

describe('lens import respects claims (plan §2.9)', () => {
  it('a claimed rollout of an unindexed session is not imported as a second session', async () => {
    const e = freshEnv();
    const s = await liveSleeper(); cleanup.push(s.stop);
    writeSession(e.home, { id: 's-open', runtime: 'codex', wrapper: s.id, cwd: e.cwd });
    const claimed = rolloutPath(e, 'claimed'); const free = rolloutPath(e, 'free');
    mkdirSync(join(claimed, '..'), { recursive: true });
    writeFileSync(claimed, [...metaLines('claimed', e.cwd), usageLine({ input: 100, cached: 0, output: 10 })].join('\n') + '\n');
    writeFileSync(free, [...metaLines('free', e.cwd), usageLine({ input: 50, cached: 0, output: 5 })].join('\n') + '\n');
    mkdirSync(join(e.home, 'claims'));
    writeFileSync(join(e.home, 'claims', claimHash(claimed) + '.json'), JSON.stringify({ rollout: claimed, session: 's-open', holders: [s.id], claimedAt: new Date().toISOString() }));
    const r = await runLens(['import', '--runtime', 'codex', '--json'], e.env);
    expect(r.code).toBe(0);
    const entries = index(e.home);
    expect(entries).toHaveLength(1);
    expect(entries[0].nativeSessionIds).toEqual(['free']);
  }, T);
});

describe('lens import before the first claim (PR #3)', () => {
  it('[import-before-claim] an import while a wrapped rollout awaits its first look leaves one entry, with the wrapped tags; unwrapped rollouts still import', async () => {
    const e = freshEnv();
    const s = (n: string) => join(e.sync, n);
    // The wrapper's lsof waits for <sync>/go, so its first look cannot
    // succeed until the import has run. The import uses the real lsof.
    const held = join(e.sync, 'lsof');
    writeFileSync(held, `#!/bin/sh\nwhile [ ! -e "${s('go')}" ]; do sleep 0.02; done\nexec lsof "$@"\n`, { mode: 0o755 });
    const wrapped = rolloutPath(e, 'wrapped'); const live = rolloutPath(e, 'live'); const done = rolloutPath(e, 'done');
    const lk = s('looks.jsonl');
    const r = lensRunFake(e, 'codex', [
      { open: wrapped }, { write: wrapped, lines: [...metaLines('wrapped', e.cwd), usageLine({ input: 120, cached: 0, output: 30 })] },
      { touch: s('ready') }, { wait: s('exit') }, { close: wrapped },
    ], { AGENTLENS_LSOF: held, AGENTLENS_TEST_LOOK_LOG: lk, AGENTLENS_TAGS: 'agent=wrapped' });
    // Independent, unwrapped rollouts: one still open by a writer outside any `lens run`, one closed.
    const w = spawnWriter(e, [
      { open: live }, { write: live, lines: [...metaLines('live', e.cwd), usageLine({ input: 70, cached: 0, output: 7 })] },
      { touch: s('live-ready') }, { forever: true },
    ]);
    cleanup.push(() => { touch(s('go')); touch(s('exit')); killQuiet(r.child.pid); killQuiet(w.pid); });
    mkdirSync(dirname(done), { recursive: true });
    writeFileSync(done, [...metaLines('done', e.cwd), usageLine({ input: 50, cached: 0, output: 5 })].join('\n') + '\n');
    await waitFor(() => existsSync(s('ready')) && existsSync(s('live-ready')), T, 'rollouts written');
    expect(looks(lk).filter((l) => l.claimed.length)).toHaveLength(0); // no successful look yet

    const imp = await runLens(['import', '--runtime', 'codex', '--json', '--tag', 'agent=imported'], e.env);
    expect(imp.code).toBe(0);

    touch(s('go'));
    await waitFor(() => looks(lk).some((l) => l.claimed.length > 0), T, 'wrapped rollout claimed');
    touch(s('exit'));
    expect((await r.done).code).toBe(0);

    const of = (id: string) => index(e.home).filter((x) => x.nativeSessionIds?.includes(id));
    expect(of('wrapped')).toHaveLength(1);
    expect(of('wrapped')[0].tags).toEqual({ agent: 'wrapped' });
    expect(of('wrapped')[0].totals).toMatchObject({ input: 120, output: 30, requests: 1 });
    expect(of('live')).toHaveLength(1);
    expect(of('live')[0].tags).toEqual({ agent: 'imported' });
    expect(of('done')).toHaveLength(1);
    expect(of('done')[0].tags).toEqual({ agent: 'imported' });
    const all = await statsJson(e);
    expect(all.find((x) => x.key === '(all)')).toMatchObject({ sessions: 3, totals: expect.objectContaining({ input: 240, output: 42 }) });
  }, T);

  it('[import-no-evidence] with a running wrapper but no open-file evidence, import holds nothing back and says so', async () => {
    const e = freshEnv({ AGENTLENS_LSOF: '/nonexistent/lsof' });
    const sl = await liveSleeper(); cleanup.push(sl.stop);
    writeSession(e.home, { id: 's-running', runtime: 'codex', wrapper: sl.id, cwd: e.cwd });
    const p = rolloutPath(e, 'free');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, [...metaLines('free', e.cwd), usageLine({ input: 50, cached: 0, output: 5 })].join('\n') + '\n');
    const r = await runLens(['import', '--runtime', 'codex', '--json'], e.env);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ imported: 1 });
    expect(r.err).toMatch(/cannot read open-file evidence/);
  }, T);
  // Route ruling §1 (option B): the first claim wins; with degraded evidence the one entry may carry the import's tags.
  it('[import-lookup-lost] import cannot read open-file evidence, then the wrapper looks: one entry, with the import\'s tags, and stderr says why', async () => {
    const e = freshEnv();
    const s = (n: string) => join(e.sync, n);
    const held = join(e.sync, 'lsof');
    writeFileSync(held, `#!/bin/sh\nwhile [ ! -e "${s('go')}" ]; do sleep 0.02; done\nexec lsof "$@"\n`, { mode: 0o755 });
    const wrapped = rolloutPath(e, 'wrapped');
    const lk = s('looks.jsonl');
    const r = lensRunFake(e, 'codex', [
      { open: wrapped }, { write: wrapped, lines: [...metaLines('wrapped', e.cwd), usageLine({ input: 120, cached: 0, output: 30 })] },
      { touch: s('ready') }, { wait: s('exit') }, { close: wrapped },
    ], { AGENTLENS_LSOF: held, AGENTLENS_TEST_LOOK_LOG: lk, AGENTLENS_TAGS: 'agent=wrapped' });
    cleanup.push(() => { touch(s('go')); touch(s('exit')); killQuiet(r.child.pid); });
    await waitFor(() => existsSync(s('ready')), T, 'rollout written');
    expect(looks(lk).filter((l) => l.claimed.length)).toHaveLength(0);

    const imp = await runLens(['import', '--runtime', 'codex', '--json', '--tag', 'agent=imported'], { ...e.env, AGENTLENS_LSOF: '/nonexistent/lsof' });
    expect(imp.code).toBe(0);
    expect(imp.err).toMatch(/cannot read open-file evidence/);

    touch(s('go'));
    const after = looks(lk).length;
    await waitFor(() => looks(lk).length >= after + 2, T, 'two wrapper looks with real lsof');
    touch(s('exit'));
    const done = await r.done;
    expect(done.code).toBe(0);
    expect(r.err()).toContain(realpathSync(wrapped));
    const of = index(e.home).filter((x) => x.nativeSessionIds?.includes('wrapped'));
    expect(of).toHaveLength(1);
    expect(of[0].tags).toEqual({ agent: 'imported' });
    expect(of[0].totals).toMatchObject({ input: 120, output: 30, requests: 1 });
  }, T);

  it('[import-reparented] a writer the wrapper remembers, since reparented out of its tree, is left to the wrapper', async () => {
    const e = freshEnv();
    const s = (n: string) => join(e.sync, n);
    // The wrapper's lsof passes through until <sync>/hold exists, then waits for <sync>/go.
    const lsof = join(e.sync, 'lsof');
    writeFileSync(lsof, `#!/bin/sh\nif [ -e "${s('hold')}" ]; then while [ ! -e "${s('go')}" ]; do sleep 0.02; done; fi\nexec lsof "$@"\n`, { mode: 0o755 });
    const ro = rolloutPath(e, 'reparented');
    const bin = join(e.sync, 'bin'); mkdirSync(bin);
    // codex -> mid -> writer. When mid exits, the writer leaves the wrapper's tree.
    writeFileSync(join(bin, 'codex'), `#!/bin/sh\n( "${join(FAKE_BIN, 'writer')}" & echo $! > "${s('wpid')}"; while [ ! -e "${s('mid-exit')}" ]; do sleep 0.02; done ) &\nwhile [ ! -e "${s('exit')}" ]; do sleep 0.02; done\n`, { mode: 0o755 });
    const script = [
      { wait: s('open') }, { open: ro }, { write: ro, lines: [...metaLines('reparented', e.cwd), usageLine({ input: 90, cached: 0, output: 9 })] },
      { touch: s('written') }, { wait: s('writer-exit') }, { close: ro },
    ];
    const lk = s('looks.jsonl');
    const r = spawnLens(['run', '--', join(bin, 'codex')], { ...e.env, FAKE_SCRIPT: JSON.stringify(script), AGENTLENS_LSOF: lsof, AGENTLENS_TEST_LOOK_LOG: lk, AGENTLENS_TAGS: 'agent=wrapped' }, { cwd: e.cwd });
    let wpid = 0;
    cleanup.push(() => { for (const f of ['go', 'open', 'mid-exit', 'writer-exit', 'exit']) touch(s(f)); killQuiet(r.child.pid); if (wpid) killQuiet(wpid); });
    wpid = await waitFor(() => existsSync(s('wpid')) && Number(readFileSync(s('wpid'), 'utf8')), T, 'writer pid');
    const seenAt = Date.now();
    await waitFor(() => looks(lk).some((l) => l.startedAt > seenAt), T, 'a look with the writer in the tree');
    touch(s('hold'));
    touch(s('mid-exit'));
    await waitFor(() => ppidOf(wpid) === 1, T, 'writer reparented');
    touch(s('open'));
    await waitFor(() => existsSync(s('written')), T, 'rollout written');
    expect(looks(lk).filter((l) => l.claimed.length)).toHaveLength(0);

    const imp = await runLens(['import', '--runtime', 'codex', '--json', '--tag', 'agent=imported'], e.env);
    expect(imp.code).toBe(0);

    touch(s('go'));
    await waitFor(() => looks(lk).some((l) => l.claimed.length > 0), T, 'remembered writer claimed');
    touch(s('writer-exit'));
    await waitFor(() => !pidAlive(wpid), T, 'writer exited');
    touch(s('exit'));
    expect((await r.done).code).toBe(0);
    const of = index(e.home).filter((x) => x.nativeSessionIds?.includes('reparented'));
    expect(of).toHaveLength(1);
    expect(of[0].tags).toEqual({ agent: 'wrapped' });
    expect(of[0].totals).toMatchObject({ input: 90, output: 9, requests: 1 });
  }, T);

  it('[import-unknown-wrapper] a stale wrapper record with unknown identity on a reused pid does not hold back an independent writer', async () => {
    const e = freshEnv();
    const s = (n: string) => join(e.sync, n);
    const live = rolloutPath(e, 'independent');
    const w = spawnWriter(e, [
      { open: live }, { write: live, lines: [...metaLines('independent', e.cwd), usageLine({ input: 40, cached: 0, output: 4 })] },
      { touch: s('ready') }, { forever: true },
    ]);
    cleanup.push(() => killQuiet(w.pid));
    await waitFor(() => existsSync(s('ready')), T, 'rollout written');
    // A wrapper whose identity lookup failed saved a null start time; its pid is now the independent writer's.
    writeSession(e.home, { id: 's-stale', runtime: 'codex', wrapper: { pid: w.pid!, startTime: null }, cwd: e.cwd });
    const r = await runLens(['import', '--runtime', 'codex', '--json', '--tag', 'agent=imported'], e.env);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ imported: 1 });
    const of = index(e.home).filter((x) => x.nativeSessionIds?.includes('independent'));
    expect(of).toHaveLength(1);
    expect(of[0].tags).toEqual({ agent: 'imported' });
  }, T);
  // Route ruling §2: a wrapped resume of an already-counted rollout counts nothing for it and names it.
  const closedRollout = (e: Env, name: string) => {
    const p = rolloutPath(e, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, [...metaLines(name, e.cwd), usageLine({ input: 50, cached: 0, output: 5 })].join('\n') + '\n');
    return p;
  };
  const resumeWrapped = (e: Env, p: string, ready: string, exit: string) => lensRunFake(e, 'codex', [
    { open: p }, { write: p, lines: [usageLine({ input: 20, cached: 0, output: 2 })] }, { touch: ready }, { wait: exit }, { close: p },
  ], { AGENTLENS_TEST_LOOK_LOG: join(e.sync, 'looks.jsonl'), AGENTLENS_TAGS: 'agent=wrapped' });
  const forgetClaim = (e: Env, p: string) => rmSync(join(e.home, 'claims', claimHash(realpathSync(p)) + '.json'), { force: true });
  const onlyEntry = (e: Env, id: string) => {
    const of = index(e.home).filter((x) => x.nativeSessionIds?.includes(id));
    expect(of).toHaveLength(1);
    expect(of[0].tags).toEqual({ agent: 'imported' });
    expect(of[0].totals).toMatchObject({ input: 50, output: 5, requests: 1 });
  };

  it('[resume-after-import] a wrapped resume of an imported rollout keeps the one imported entry and names the rollout', async () => {
    const e = freshEnv();
    const s = (n: string) => join(e.sync, n);
    const p = closedRollout(e, 'resumed');
    const imp = await runLens(['import', '--runtime', 'codex', '--json', '--tag', 'agent=imported'], e.env);
    expect(JSON.parse(imp.out)).toMatchObject({ imported: 1 });
    const r = resumeWrapped(e, p, s('ready'), s('exit'));
    cleanup.push(() => { touch(s('exit')); killQuiet(r.child.pid); });
    await waitFor(() => existsSync(s('ready')), T, 'resume wrote');
    const n = looks(s('looks.jsonl')).length;
    await waitFor(() => looks(s('looks.jsonl')).length >= n + 2, T, 'two looks after the resume wrote');
    touch(s('exit'));
    expect((await r.done).code).toBe(0);
    expect(r.err()).toContain(realpathSync(p));
    onlyEntry(e, 'resumed');
    const again = await runLens(['import', '--runtime', 'codex', '--json', '--tag', 'agent=imported'], e.env);
    expect(JSON.parse(again.out)).toMatchObject({ imported: 0 });
    onlyEntry(e, 'resumed');
  }, T);

  it('[resume-after-legacy-import] a rollout indexed by an import with no claim is not counted again by a wrapped resume', async () => {
    const e = freshEnv();
    const s = (n: string) => join(e.sync, n);
    const p = closedRollout(e, 'legacy');
    await runLens(['import', '--runtime', 'codex', '--json', '--tag', 'agent=imported'], e.env);
    forgetClaim(e, p); // as an import made before import claimed
    const r = resumeWrapped(e, p, s('ready'), s('exit'));
    cleanup.push(() => { touch(s('exit')); killQuiet(r.child.pid); });
    await waitFor(() => existsSync(s('ready')), T, 'resume wrote');
    await waitFor(() => looks(s('looks.jsonl')).some((l) => l.claimed.length), T, 'resume claimed');
    touch(s('exit'));
    expect((await r.done).code).toBe(0);
    expect(r.err()).toContain(realpathSync(p));
    onlyEntry(e, 'legacy');
  }, T);

  it('[resume-after-legacy-import-recover] the same holds when lens recover finalizes the killed resume', async () => {
    const e = freshEnv();
    const s = (n: string) => join(e.sync, n);
    const p = closedRollout(e, 'legacy-rec');
    await runLens(['import', '--runtime', 'codex', '--json', '--tag', 'agent=imported'], e.env);
    forgetClaim(e, p);
    const r = resumeWrapped(e, p, s('ready'), s('exit'));
    cleanup.push(() => { touch(s('exit')); killQuiet(r.child.pid); });
    await waitFor(() => existsSync(s('ready')), T, 'resume wrote');
    await waitFor(() => looks(s('looks.jsonl')).some((l) => l.claimed.length), T, 'resume claimed');
    const codexPid = Number(readFileSync(s('ready'), 'utf8'));
    r.child.kill('SIGKILL');
    await r.done;
    touch(s('exit'));
    await waitFor(() => !pidAlive(codexPid), T, 'resumed codex exited');
    const out = await recover(e);
    expect(out.code).toBe(0);
    expect(out.err).toContain(realpathSync(p));
    onlyEntry(e, 'legacy-rec');
  }, T);
});

describe('review 3: recovery races and damage', () => {
  it('ALF-12 [late-claim] a claim published after the sweep began, by a wrapper that then died, is not frozen out', async () => {
    const e = freshEnv();
    const W = await liveSleeper(); const H = await liveSleeper();
    cleanup.push(() => { W.stop(); H.stop(); });
    const id = 'late-claim-session';
    writeSession(e.home, { id, runtime: 'codex', wrapper: W.id, cwd: e.cwd });
    const p = rolloutPath(e, 'late');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, [...metaLines('late', e.cwd), usageLine({ input: 400, cached: 0, output: 40 })].map((l) => l + '\n').join(''));
    const rec = spawnLens(['recover'], { ...e.env, AGENTLENS_TEST_HOOKS: `recover:before-gate=pause:${e.sync}` });
    await waitFor(() => readdirSync(e.sync).some((f) => f.startsWith('recover:before-gate.') && f.endsWith('.reached')), T, 'sweep paused');
    const real = realpathSync(p);
    mkdirSync(join(e.home, 'claims'), { recursive: true });
    writeFileSync(join(e.home, 'claims', claimHash(real) + '.json'), JSON.stringify({ rollout: real, session: id, holders: [H.id], claimedAt: new Date().toISOString() }));
    W.stop();
    await waitFor(() => !pidAlive(W.id.pid), T, 'wrapper gone');
    touch(join(e.sync, 'recover:before-gate.release'));
    expect((await rec.done).code).toBe(0);
    expect(index(e.home)).toHaveLength(0); // the late claim's holder still lives
    H.stop();
    await waitFor(() => !pidAlive(H.id.pid), T, 'holder gone');
    expect((await recover(e)).code).toBe(0);
    const entries = index(e.home);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id, recovered: true, exitCode: null });
    expect(entries[0].totals).toMatchObject({ input: 400, output: 40, requests: 1 });
  }, T);

  it('ALF-37 [torn-index] a torn index tail does not swallow the next finalized session', async () => {
    const e = freshEnv();
    finalizedSession(e.home, 'older', { input: 5, output: 1 });
    writeFileSync(join(e.home, 'index.jsonl'), '{"id":"torn","runtime":"cla', { flag: 'a' });
    writeSession(e.home, { id: 'next', wrapper: await deadIdentity(), usages: [{ input: 70, output: 7 }] });
    const first = await recover(e);
    expect(first.code).toBe(0);
    expect(first.out).toContain('recovered 1');
    expect(new StoreReader(e.home).listIndex().map((r) => r.id)).toEqual(['older', 'next']); // readable at once
    expect((await recover(e)).code).toBe(0);
    const rows = new StoreReader(e.home).listIndex();
    expect(rows.map((r) => r.id)).toEqual(['older', 'next']);
    expect(rows[0].totals).toMatchObject({ input: 5, output: 1 });
    expect(rows[1].totals).toMatchObject({ input: 70, output: 7, requests: 1 });
  }, T);

  it('ALF-37 [torn-append-race] a partial append by another session between the tail check and the append does not swallow the entry', async () => {
    const e = freshEnv();
    finalizedSession(e.home, 'older', { input: 5, output: 1 });
    writeSession(e.home, { id: 'next', wrapper: await deadIdentity(), usages: [{ input: 70, output: 7 }] });
    const rec = spawnLens(['recover'], { ...e.env, AGENTLENS_TEST_HOOKS: `finalize:before-index-append=pause:${e.sync}` });
    await waitFor(() => readdirSync(e.sync).some((f) => f.startsWith('finalize:before-index-append.') && f.endsWith('.reached')), T, 'finalizer at the append');
    // Another session's finalizer dies partway through its index append.
    const dead = await deadIdentity();
    const dir = writeSession(e.home, { id: 'partial', wrapper: dead, usages: [{ input: 30, output: 3 }] });
    writeFileSync(join(dir, 'final.0.json'), JSON.stringify({ ...dead, role: 'writer', at: new Date().toISOString() }));
    writeFileSync(join(e.home, 'index.jsonl'), '{"id":"partial","runtime":"cla', { flag: 'a' });
    touch(join(e.sync, 'finalize:before-index-append.release'));
    const first = await rec.done;
    expect(first.code).toBe(0);
    expect(rec.out()).toContain('recovered 1');
    expect(new StoreReader(e.home).listIndex().map((r) => r.id)).toEqual(['older', 'next']); // readable at once
    expect((await recover(e)).code).toBe(0); // retry recovers the session whose append was torn
    expect((await recover(e)).code).toBe(0);
    const rows = new StoreReader(e.home).listIndex();
    expect(rows.map((r) => r.id).sort()).toEqual(['next', 'older', 'partial']);
    expect(rows.find((r) => r.id === 'next')!.totals).toMatchObject({ input: 70, output: 7, requests: 1 });
    expect(rows.find((r) => r.id === 'partial')!.totals).toMatchObject({ input: 30, output: 3, requests: 1 });
  }, T);

  it('ALF-7 [no-wrapper-identity] a live session whose wrapper identity could not be read is not taken for legacy', async () => {
    const e = freshEnv();
    const ps = join(e.sync, 'ps');
    writeFileSync(ps, '#!/bin/sh\ncase " $* " in *" -A "*) exec /bin/ps "$@";; esac\nexit 1\n', { mode: 0o755 });
    const s = (n: string) => join(e.sync, n);
    const p = rolloutPath(e, 'noid');
    const r = lensRunFake(e, 'codex', [
      { open: p }, { write: p, lines: [...metaLines('noid', e.cwd), usageLine({ input: 900, cached: 0, output: 90 })] },
      { touch: s('ready') }, { wait: s('exit') },
    ], { AGENTLENS_PS: ps, AGENTLENS_TEST_LOOK_LOG: s('looks.jsonl'), FAKE_PIDFILE: s('pid') });
    cleanup.push(() => { touch(s('exit')); killQuiet(r.child.pid); if (existsSync(s('pid'))) killQuiet(pidOf(s('pid'))); });
    await waitFor(() => existsSync(s('ready')), T, 'fake codex ready');
    await waitFor(() => looks(s('looks.jsonl')).some((l) => l.claimed.length > 0), T, 'rollout claimed');
    r.child.kill('SIGKILL');
    await r.done;
    const [id] = sessionIds(e.home);
    ageTree(join(e.home, 'sessions', id), 2 * 60 * 60 * 1000);
    expect((await recover(e)).code).toBe(0);
    expect(index(e.home)).toHaveLength(0); // the agent still holds its rollout
    touch(s('exit'));
    await waitFor(() => !pidAlive(pidOf(s('pid'))), T, 'agent exit');
    expect((await recover(e)).code).toBe(0);
    const entries = index(e.home);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id, recovered: true, exitCode: null });
    expect(entries[0].totals).toMatchObject({ input: 900, output: 90, requests: 1 });
  }, T);
});

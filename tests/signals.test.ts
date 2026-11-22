import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { join } from 'node:path';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { constants } from 'node:os';
import {
  freshEnv, index, killQuiet, lensRunFake, metaLines, mockUpstream, pidOf, rolloutPath, touch, usageLine, waitFor, claims, looks,
} from './helpers/lens.js';

const T = 30000;
const GRACE = 2000;
let up: { origin: string; close: () => void };
beforeAll(async () => { up = await mockUpstream(); });
afterAll(() => up.close());
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

const SIGS = ['SIGHUP', 'SIGTERM', 'SIGINT'] as const;
const status = (s: string) => 128 + (constants.signals as Record<string, number>)[s];

function claudeEnv(extra: Record<string, string> = {}) {
  return freshEnv({ AGENTLENS_UPSTREAM: up.origin, AGENTLENS_SIGNAL_GRACE_MS: String(GRACE), ...extra });
}

// Key set of a normally finished proxy-mode entry, from a real run.
async function normalKeys(): Promise<string[]> {
  const e = claudeEnv();
  const r = lensRunFake(e, 'claude', [{ post: true }]);
  expect((await r.done).code).toBe(0);
  return Object.keys(index(e.home)[0]).sort();
}

describe('save on pane close or process stop', () => {
  let keys: string[];
  beforeAll(async () => { keys = await normalKeys(); }, T);

  for (const S of SIGS) {
    it(`ALF-1 [${S}] signal to a proxy-mode lens run leaves one normal-shape entry`, async () => {
      const e = claudeEnv();
      const ready = join(e.sync, 'ready');
      const r = lensRunFake(e, 'claude', [{ post: true }, { touch: ready }, { wait: join(e.sync, 'never') }], { FAKE_PIDFILE: join(e.sync, 'pid') });
      cleanup.push(() => { killQuiet(r.child.pid); if (existsSync(join(e.sync, 'pid'))) killQuiet(pidOf(join(e.sync, 'pid'))); });
      await waitFor(() => existsSync(ready), T, 'fake claude ready');
      const sent = Date.now();
      process.kill(r.child.pid!, S);
      const done = await r.done;
      expect(done.at - sent).toBeLessThan(GRACE);
      expect(done.code).toBe(status(S)); // the child was signalled
      const entries = index(e.home);
      expect(entries).toHaveLength(1);
      expect(Object.keys(entries[0]).sort()).toEqual(keys);
      expect(entries[0].exitCode).toBe(status(S));
      expect(entries[0].totals).toMatchObject({ input: 7, output: 3, cacheRead: 11, requests: 1 });
    }, T);

    it(`ALF-2 [${S}] signal to a logs-mode lens run includes the held rollout's usage`, async () => {
      const e = claudeEnv();
      const p = rolloutPath(e, 'sig');
      const ready = join(e.sync, 'ready');
      const r = lensRunFake(e, 'codex', [
        { open: p }, { write: p, lines: [...metaLines('sig', e.cwd), usageLine({ input: 2000, cached: 500, output: 120 })] },
        { touch: ready }, { wait: join(e.sync, 'never') },
      ]);
      cleanup.push(() => killQuiet(r.child.pid));
      await waitFor(() => existsSync(ready), T, 'fake codex ready');
      await new Promise((res) => setTimeout(res, 2000)); // held open for writing at least 2 s
      const sent = Date.now();
      process.kill(r.child.pid!, S);
      const done = await r.done;
      expect(done.at - sent).toBeLessThan(GRACE);
      expect(done.code).toBe(status(S));
      const entries = index(e.home);
      expect(entries).toHaveLength(1);
      expect(entries[0].totals).toMatchObject({ input: 1500, cacheRead: 500, output: 120, requests: 1 });
      expect(claims(e.home)).toHaveLength(1);
    }, T);
  }

  it('ALF-3 [group] signal to the whole process group leaves one entry and the child gets it once', async () => {
    const e = claudeEnv();
    const ready = join(e.sync, 'ready');
    const siglog = join(e.sync, 'siglog');
    const r = lensRunFake(e, 'claude', [{ post: true }, { touch: ready }, { wait: join(e.sync, 'never') }], { FAKE_SIGLOG: siglog }, { detached: true });
    cleanup.push(() => { try { process.kill(-r.child.pid!, 'SIGKILL'); } catch { /* gone */ } });
    await waitFor(() => existsSync(ready), T, 'fake claude ready');
    const sent = Date.now();
    process.kill(-r.child.pid!, 'SIGHUP'); // as closing a pane does
    const done = await r.done;
    expect(done.at - sent).toBeLessThan(GRACE);
    expect(done.code).toBe(status('SIGHUP'));
    const entries = index(e.home);
    expect(entries).toHaveLength(1);
    expect(Object.keys(entries[0]).sort()).toEqual(keys);
    expect(readFileSync(siglog, 'utf8')).toBe('SIGHUP\n');
  }, T);

  it('ALF-4 [ignored] a child that ignores the signal still gets an entry; exit within grace + 1 s', async () => {
    const e = claudeEnv();
    const ready = join(e.sync, 'ready');
    const pidfile = join(e.sync, 'pid');
    // fetch keeps its connection alive, so a bounded proxy close is exercised.
    const r = lensRunFake(e, 'claude', [{ post: true }, { touch: ready }, { forever: true }], { FAKE_IGNORE_SIGNALS: '1', FAKE_PIDFILE: pidfile });
    cleanup.push(() => { killQuiet(r.child.pid); if (existsSync(pidfile)) killQuiet(pidOf(pidfile)); });
    await waitFor(() => existsSync(ready), T, 'fake claude ready');
    const sent = Date.now();
    process.kill(r.child.pid!, 'SIGTERM');
    const done = await r.done;
    expect(done.at - sent).toBeLessThan(GRACE + 1000);
    expect(done.code).toBe(status('SIGTERM'));
    const entries = index(e.home);
    expect(entries).toHaveLength(1);
    expect(entries[0].totals).toMatchObject({ input: 7, output: 3, cacheRead: 11, requests: 1 });
    expect(existsSync(pidfile) && (() => { try { process.kill(pidOf(pidfile), 0); return true; } catch { return false; } })()).toBe(true);
  }, T);
  it('ALF-4 [slow-evidence] slow open-file lookups do not stretch a logs-mode stop past grace + 1 s', async () => {
    const e = claudeEnv();
    const slow = join(e.sync, 'lsof');
    writeFileSync(slow, '#!/bin/sh\nsleep 1.5\nexec lsof "$@"\n', { mode: 0o755 });
    const p = rolloutPath(e, 'slow'); const ready = join(e.sync, 'ready'); const pf = join(e.sync, 'pid'); const lk = join(e.sync, 'looks.jsonl');
    const r = lensRunFake(e, 'codex', [
      { open: p }, { write: p, lines: [...metaLines('slow', e.cwd), usageLine({ input: 600, cached: 0, output: 60 })] },
      { touch: ready }, { forever: true },
    ], { AGENTLENS_LSOF: slow, AGENTLENS_TEST_LOOK_LOG: lk, FAKE_IGNORE_SIGNALS: '1', FAKE_PIDFILE: pf });
    cleanup.push(() => { killQuiet(r.child.pid); if (existsSync(pf)) killQuiet(pidOf(pf)); });
    await waitFor(() => existsSync(ready), T, 'fake codex ready');
    await waitFor(() => looks(lk).some((l) => l.claimed.length > 0), T, 'rollout claimed');
    const sent = Date.now();
    process.kill(r.child.pid!, 'SIGTERM');
    const done = await r.done;
    expect(done.at - sent).toBeLessThan(GRACE + 1000);
    expect(done.code).toBe(status('SIGTERM'));
    const entries = index(e.home);
    expect(entries).toHaveLength(1);
    expect(entries[0].totals).toMatchObject({ input: 600, output: 60, requests: 1 });
  }, T);

  // lsof is fast until <sync>/go exists; then each call marks its start and
  // sleeps before the real scan, so the scan sees what is open at its end.
  const gatedLsof = (e: { sync: string }, delay: number) => {
    const f = join(e.sync, 'lsof');
    writeFileSync(f, `#!/bin/sh\nif [ -e "${e.sync}/go" ]; then : > "${e.sync}/lsof.$$.started"; sleep ${delay}; fi\nexec lsof "$@"\n`, { mode: 0o755 });
    return f;
  };
  const lsofStarts = (e: { sync: string }) => readdirSync(e.sync).filter((f) => f.startsWith('lsof.') && f.endsWith('.started'));

  it('ALF-42 [signal-first-seen] a rollout first seen by a slow look in flight at the signal is counted, within grace + 1 s', async () => {
    const grace = 1000;
    const e = claudeEnv({ AGENTLENS_SIGNAL_GRACE_MS: String(grace) });
    const lsof = gatedLsof(e, 1.5);
    const p = rolloutPath(e, 'late'); const s = (n: string) => join(e.sync, n); const lk = s('looks.jsonl');
    const r = lensRunFake(e, 'codex', [
      { touch: s('ready') }, { wait: s('open') }, { open: p },
      { write: p, lines: [...metaLines('late', e.cwd), usageLine({ input: 500, cached: 0, output: 50 })] },
      { touch: s('opened') }, { forever: true },
    ], { AGENTLENS_LSOF: lsof, AGENTLENS_TEST_LOOK_LOG: lk, FAKE_IGNORE_SIGNALS: '1', FAKE_PIDFILE: s('pid') });
    cleanup.push(() => { killQuiet(r.child.pid); if (existsSync(s('pid'))) killQuiet(pidOf(s('pid'))); });
    await waitFor(() => existsSync(s('ready')) && looks(lk).length > 0, T, 'first look done');
    touch(s('go'));
    await waitFor(() => lsofStarts(e).length > 0, T, 'slow look in flight');
    touch(s('open'));
    await waitFor(() => existsSync(s('opened')), T, 'rollout opened');
    const sent = Date.now();
    process.kill(r.child.pid!, 'SIGTERM');
    const done = await r.done;
    expect(done.at - sent).toBeLessThan(grace + 1000);
    expect(done.code).toBe(status('SIGTERM'));
    expect(looks(lk).filter((l) => l.claimed.length > 0 && l.endedAt < sent)).toEqual([]); // no prior claim
    const entries = index(e.home);
    expect(entries).toHaveLength(1);
    expect(entries[0].totals).toMatchObject({ input: 500, output: 50, requests: 1 });
  }, T);

  it('ALF-4 [large-claimed] a large claimed rollout still saves in full within grace + 1 s when a slow look reaches the cutoff', async () => {
    const grace = 1000;
    const e = claudeEnv({ AGENTLENS_SIGNAL_GRACE_MS: String(grace) });
    cleanup.push(() => { rmSync(e.codex, { recursive: true, force: true }); rmSync(e.home, { recursive: true, force: true }); });
    const lsof = gatedLsof(e, 5); // reaches the cutoff; the 2 s lookup timeout ends it
    const p = rolloutPath(e, 'large'); const s = (n: string) => join(e.sync, n); const lk = s('looks.jsonl');
    // ~96 MiB of ordinary rollout lines with one usage line in the middle, then the agent adds one more.
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, metaLines('large', e.cwd).map((l) => l + '\n').join(''));
    const filler = JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(1000) }] } }) + '\n';
    const chunk = filler.repeat(1024);
    for (let i = 0; i < 48; i++) appendFileSync(p, chunk);
    appendFileSync(p, usageLine({ input: 700, cached: 0, output: 70 }) + '\n');
    for (let i = 0; i < 48; i++) appendFileSync(p, chunk);
    const r = lensRunFake(e, 'codex', [
      { open: p }, { write: p, lines: [usageLine({ input: 300, cached: 0, output: 30 })] },
      { touch: s('ready') }, { forever: true },
    ], { AGENTLENS_LSOF: lsof, AGENTLENS_TEST_LOOK_LOG: lk, FAKE_IGNORE_SIGNALS: '1', FAKE_PIDFILE: s('pid') });
    cleanup.push(() => { killQuiet(r.child.pid); if (existsSync(s('pid'))) killQuiet(pidOf(s('pid'))); });
    await waitFor(() => existsSync(s('ready')), T, 'fake codex ready');
    await waitFor(() => looks(lk).some((l) => l.claimed.length > 0), T, 'rollout claimed');
    touch(s('go'));
    await waitFor(() => lsofStarts(e).length > 0, T, 'slow look in flight');
    const sent = Date.now();
    process.kill(r.child.pid!, 'SIGTERM');
    const done = await r.done;
    expect(done.at - sent).toBeLessThan(grace + 1000);
    expect(done.code).toBe(status('SIGTERM'));
    const entries = index(e.home);
    expect(entries).toHaveLength(1);
    expect(entries[0].totals).toMatchObject({ input: 1000, output: 100, requests: 2 });
    expect(r.err().match(/open-file lookup still running at the stop deadline/g)).toHaveLength(1);
  }, 60000);

  it('ALF-4 [prepare-fails] a read-ahead that fails after creating its temp copy leaves none behind; the entry is saved within grace + 1 s', async () => {
    const grace = 1000;
    const e = claudeEnv({ AGENTLENS_SIGNAL_GRACE_MS: String(grace) });
    const p = rolloutPath(e, 'prep'); const s = (n: string) => join(e.sync, n); const lk = s('looks.jsonl');
    const hooks = `finalize:after-prepare-temp=pause:${e.sync},finalize:after-prepare-temp=throw`;
    const r = lensRunFake(e, 'codex', [
      { open: p }, { write: p, lines: [...metaLines('prep', e.cwd), usageLine({ input: 40, cached: 0, output: 4 })] },
      { touch: s('ready') }, { forever: true },
    ], { AGENTLENS_TEST_LOOK_LOG: lk, AGENTLENS_TEST_HOOKS: hooks, FAKE_IGNORE_SIGNALS: '1', FAKE_PIDFILE: s('pid') });
    cleanup.push(() => { try { chmodSync(p, 0o644); } catch { /* gone */ } killQuiet(r.child.pid); if (existsSync(s('pid'))) killQuiet(pidOf(s('pid'))); });
    await waitFor(() => existsSync(s('ready')) && looks(lk).some((l) => l.claimed.length > 0), T, 'rollout claimed');
    const sent = Date.now();
    process.kill(r.child.pid!, 'SIGTERM');
    // First read-ahead (after the forward): its temp copy exists, then the rollout
    // becomes unreadable and the read-ahead throws. The second (at the exit look)
    // and finalize then cannot read it either.
    await waitFor(() => readdirSync(e.sync).some((f) => f.startsWith('finalize:after-prepare-temp.') && f.endsWith('.reached')), T, 'read-ahead temp created');
    chmodSync(p, 0o000);
    touch(s('finalize:after-prepare-temp.release'));
    const done = await r.done;
    expect(done.at - sent).toBeLessThan(grace + 1000);
    expect(done.code).toBe(status('SIGTERM'));
    expect(index(e.home)).toHaveLength(1);
    expect(r.err()).toContain(`agentlens: claimed rollout unreadable, not counted: ${realpathSync(p)}`);
    const sdir = join(e.home, 'sessions', index(e.home)[0].id);
    expect(readdirSync(sdir).filter((f) => f.startsWith('rollout-prepared.'))).toEqual([]);
  }, 60000);

  it('ALF-4 [prepare-fails] a read-ahead temp whose first removal fails is removed by the later cleanup; double preparation, full usage, entry within grace + 1 s', async () => {
    const grace = 1000;
    const e = claudeEnv({ AGENTLENS_SIGNAL_GRACE_MS: String(grace) });
    const p = rolloutPath(e, 'rmfail'); const s = (n: string) => join(e.sync, n); const lk = s('looks.jsonl');
    // First read-ahead (after the forward) fails after its temp copy, and removing
    // that copy fails once. The second (at the exit look) and finalize succeed.
    const hooks = 'finalize:after-prepare-temp=throw-once,finalize:before-temp-rm=throw-once';
    const r = lensRunFake(e, 'codex', [
      { open: p }, { write: p, lines: [...metaLines('rmfail', e.cwd), usageLine({ input: 40, cached: 0, output: 4 })] },
      { touch: s('ready') }, { forever: true },
    ], { AGENTLENS_TEST_LOOK_LOG: lk, AGENTLENS_TEST_HOOKS: hooks, FAKE_IGNORE_SIGNALS: '1', FAKE_PIDFILE: s('pid') });
    cleanup.push(() => { killQuiet(r.child.pid); if (existsSync(s('pid'))) killQuiet(pidOf(s('pid'))); });
    await waitFor(() => existsSync(s('ready')) && looks(lk).some((l) => l.claimed.length > 0), T, 'rollout claimed');
    const sent = Date.now();
    process.kill(r.child.pid!, 'SIGTERM');
    const done = await r.done;
    expect(done.at - sent).toBeLessThan(grace + 1000);
    expect(done.code).toBe(status('SIGTERM'));
    const entries = index(e.home);
    expect(entries).toHaveLength(1);
    expect(entries[0].totals).toMatchObject({ input: 40, output: 4, requests: 1 });
    expect(entries[0].nativeSessionIds).toEqual(['rmfail']);
    const sdir = join(e.home, 'sessions', entries[0].id);
    expect(readFileSync(join(sdir, 'rollout-1.jsonl'), 'utf8')).toBe(readFileSync(p, 'utf8'));
    expect(readdirSync(sdir).filter((f) => f.startsWith('rollout-prepared.'))).toEqual([]);
  }, 60000);

  it('ALF-39 [late-lookup] a look result that misses the stop deadline is unreadable evidence: nothing claimed, entry saved, reason and rollout on stderr', async () => {
    const grace = 1000;
    const e = claudeEnv({ AGENTLENS_SIGNAL_GRACE_MS: String(grace) });
    const lsof = gatedLsof(e, 5); // past the deadline; the 2 s lookup timeout ends it
    const p = rolloutPath(e, 'past'); const s = (n: string) => join(e.sync, n); const lk = s('looks.jsonl');
    const r = lensRunFake(e, 'codex', [
      { touch: s('ready') }, { wait: s('open') }, { open: p },
      { write: p, lines: [...metaLines('past', e.cwd), usageLine({ input: 800, cached: 0, output: 80 })] },
      { touch: s('opened') }, { forever: true },
    ], { AGENTLENS_LSOF: lsof, AGENTLENS_TEST_LOOK_LOG: lk, FAKE_IGNORE_SIGNALS: '1', FAKE_PIDFILE: s('pid') });
    cleanup.push(() => { killQuiet(r.child.pid); if (existsSync(s('pid'))) killQuiet(pidOf(s('pid'))); });
    await waitFor(() => existsSync(s('ready')) && looks(lk).length > 0, T, 'first look done');
    touch(s('go'));
    await waitFor(() => lsofStarts(e).length > 0, T, 'slow look in flight');
    touch(s('open')); // opens after the previous look's scan
    await waitFor(() => existsSync(s('opened')), T, 'rollout opened');
    const sent = Date.now();
    process.kill(r.child.pid!, 'SIGTERM');
    const done = await r.done;
    expect(done.at - sent).toBeLessThan(grace + 1000);
    expect(done.code).toBe(status('SIGTERM'));
    const real = realpathSync(p);
    expect(claims(e.home).filter((c) => c.rollout === real)).toEqual([]);
    const entries = index(e.home);
    expect(entries).toHaveLength(1);
    expect(entries[0].totals).toMatchObject({ input: 0, output: 0 });
    expect(r.err().match(/open-file lookup still running at the stop deadline; no Codex rollout claimed from it/g)).toHaveLength(1);
    expect(r.err()).toContain(`not counted: ${real}`);
  }, T);
});

void touch;

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { constants } from 'node:os';
import {
  freshEnv, index, killQuiet, lensRunFake, metaLines, mockUpstream, pidOf, rolloutPath, touch, usageLine, waitFor, claims,
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
});

void touch;

// ALF-42: in-process lensRun with an injected look clock, so the test steps
// each scheduled look by hand and fixes what the fake does between looks.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { lensRun } from '../src/run.js';
import type { LookClock } from '../src/claims.js';
import { FAKE_BIN, claims, freshEnv, index, looks, metaLines, rolloutPath, touch, usageLine, waitFor, type Env, type Step } from './helpers/lens.js';

const T = 30000;
const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });

class StepClock implements LookClock {
  delays: number[] = [];
  private queue: (() => void)[] = [];
  schedule(fn: () => void, ms: number) { this.delays.push(ms); this.queue.push(fn); }
  now() { return Date.now(); }
  get pending() { return this.queue.length; }
  fire() { const fn = this.queue.shift(); if (!fn) throw new Error('no look scheduled'); fn(); }
}

function setup(e: Env, script: Step[]) {
  const lookLog = join(e.sync, 'looks.jsonl');
  process.env = { ...e.env, FAKE_SCRIPT: JSON.stringify(script), AGENTLENS_TEST_LOOK_LOG: lookLog };
  const stderr: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { stderr.push(a.join(' ')); });
  const clock = new StepClock();
  return { lookLog, stderr, clock };
}

// Step one scheduled look and wait until it has been logged.
async function stepLook(clock: StepClock, lookLog: string) {
  await waitFor(() => clock.pending > 0, T, 'a scheduled look');
  const before = looks(lookLog).length;
  clock.fire();
  await waitFor(() => looks(lookLog).length > before, T, 'the stepped look');
}

describe('looks at child start, at a schedule, and at exit', () => {
  it('ALF-42 [held] a rollout opened before a look is claimed and counted', async () => {
    const cwd = process.cwd();
    const e = freshEnv();
    const p = rolloutPath(e, 'held');
    const ready = join(e.sync, 'ready'); const gate = join(e.sync, 'gate');
    const { lookLog, clock } = setup(e, [
      { open: p }, { write: p, lines: [...metaLines('held', cwd), usageLine({ input: 900, cached: 100, output: 40 })] },
      { touch: ready }, { wait: gate },
    ]);
    const run = lensRun({ tags: [], argv: [join(FAKE_BIN, 'codex')], lookClock: clock });
    await waitFor(() => existsSync(ready), T, 'fake ready');
    await stepLook(clock, lookLog);
    expect(looks(lookLog).at(-1)!.claimed).toHaveLength(1);
    touch(gate);
    expect(await run).toBe(0);
    const entries = index(e.home);
    expect(entries).toHaveLength(1);
    expect(entries[0].totals).toMatchObject({ input: 800, cacheRead: 100, output: 40, requests: 1 });
    expect(claims(e.home)).toHaveLength(1);
  }, T);

  it('ALF-42 [between-looks] a rollout opened, written and closed between looks is not counted and is named', async () => {
    const cwd = process.cwd();
    const e = freshEnv();
    const p = rolloutPath(e, 'between');
    const go = join(e.sync, 'go'); const ready = join(e.sync, 'ready'); const gate = join(e.sync, 'gate');
    const { lookLog, stderr, clock } = setup(e, [
      { wait: go },
      { open: p }, { write: p, lines: [...metaLines('between', cwd), usageLine({ input: 700, cached: 0, output: 30 })] }, { close: p },
      { touch: ready }, { wait: gate },
    ]);
    const run = lensRun({ tags: [], argv: [join(FAKE_BIN, 'codex')], lookClock: clock });
    await waitFor(() => looks(lookLog).length >= 1, T, 'the start look');
    touch(go);
    await waitFor(() => existsSync(ready), T, 'fake ready');
    await stepLook(clock, lookLog); // fake alive, file closed
    touch(gate);
    expect(await run).toBe(0);
    const entries = index(e.home);
    expect(entries).toHaveLength(1);
    expect(entries[0].totals).toMatchObject({ input: 0, output: 0, requests: 0 });
    expect(claims(e.home)).toHaveLength(0);
    expect(stderr.filter((l) => l.includes(p)).length).toBe(1);
  }, T);

  it('ALF-42 [schedule] one look at child start, one at exit, every delay after a look is <= 1000 ms', async () => {
    const e = freshEnv();
    const ready = join(e.sync, 'ready'); const gate = join(e.sync, 'gate');
    const { lookLog, clock } = setup(e, [{ touch: ready }, { wait: gate }]);
    const run = lensRun({ tags: [], argv: [join(FAKE_BIN, 'codex')], lookClock: clock });
    await waitFor(() => existsSync(ready), T, 'fake ready');
    await stepLook(clock, lookLog);
    await stepLook(clock, lookLog);
    touch(gate);
    expect(await run).toBe(0);
    const log = looks(lookLog);
    expect(log[0].reason).toBe('start');
    expect(log.filter((l) => l.reason === 'start')).toHaveLength(1);
    expect(log.at(-1)!.reason).toBe('exit');
    expect(log.filter((l) => l.reason === 'exit')).toHaveLength(1);
    for (let i = 1; i < log.length; i++) expect(log[i].startedAt).toBeGreaterThanOrEqual(log[i - 1].endedAt);
    expect(clock.delays.length).toBeGreaterThanOrEqual(3);
    for (const d of clock.delays) expect(d).toBeLessThanOrEqual(1000);
  }, T);
});

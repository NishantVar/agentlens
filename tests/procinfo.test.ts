import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { identityOf, liveness, descendants } from '../src/procinfo.js';
import { deadIdentity } from './helpers/lens.js';

describe('procinfo', () => {
  it('reads this process identity with a non-empty start time', () => {
    const id = identityOf(process.pid);
    expect(id?.pid).toBe(process.pid);
    expect(id?.startTime).toMatch(/\d{4}$/);
    expect(identityOf(process.pid)).toEqual(id); // same format each read
  });

  it('reports alive for a live identity and gone for a dead or reused one', async () => {
    const live = identityOf(process.pid)!;
    expect(liveness(live)).toBe('alive');
    expect(liveness({ pid: live.pid, startTime: 'Mon Jan  1 00:00:00 2001' })).toBe('gone');
    expect(liveness(await deadIdentity())).toBe('gone');
  });

  it('lists descendants of a process tree', async () => {
    const sh = spawn('/bin/sh', ['-c', 'sleep 5 & wait'], { stdio: 'ignore' });
    try {
      let kids: number[] = [];
      for (let i = 0; i < 50 && kids.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
        kids = await descendants([sh.pid!]);
      }
      expect(kids.length).toBeGreaterThan(0);
      expect(kids).not.toContain(sh.pid);
    } finally { sh.kill('SIGKILL'); }
  });
});

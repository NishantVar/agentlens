// Test-only interleaving hooks. Inert unless AGENTLENS_TEST_HOOKS is set, e.g.
//   AGENTLENS_TEST_HOOKS='finalize:after-ticket=pause:/tmp/sync,recover:after-gate=kill'
// `pause:<dir>` writes <dir>/<point>.<pid>.reached and blocks until
// <dir>/<point>.release exists (capped at 30 s); `kill` SIGKILLs this process.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type HookPoint = 'claim:before-link' | 'finalize:after-ticket' | 'finalize:after-partial-events' | 'recover:before-gate' | 'recover:after-gate' | 'finalize:before-index-append';

const nap = new Int32Array(new SharedArrayBuffer(4));

export function hook(point: HookPoint): void {
  const spec = process.env.AGENTLENS_TEST_HOOKS;
  if (!spec) return;
  for (const part of spec.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== point) continue;
    const action = part.slice(eq + 1).trim();
    if (action === 'kill') process.kill(process.pid, 'SIGKILL');
    if (action.startsWith('pause:')) {
      const dir = action.slice('pause:'.length);
      writeFileSync(join(dir, `${point}.${process.pid}.reached`), '');
      const end = Date.now() + 30_000;
      while (!existsSync(join(dir, `${point}.release`)) && Date.now() < end) Atomics.wait(nap, 0, 0, 10);
    }
  }
}

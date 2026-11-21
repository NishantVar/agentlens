import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHIM = join(__dirname, '..', 'bin', 'cmux-claude-shim');

// Each fake just prints how it was invoked, so a run's stdout says which link
// of the exec chain actually ran and with what argv.
const echoer = (label: string) => `#!/usr/bin/env bash\necho "${label} $*"\n`;

let dirs: { real: string; cmux: string; lens: string };
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'shim-'));
  dirs = { real: join(root, 'real'), cmux: join(root, 'app', 'Resources', 'bin'), lens: join(root, 'lens') };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  writeFileSync(join(dirs.real, 'claude'), echoer('REAL'), { mode: 0o755 });
  writeFileSync(join(dirs.cmux, 'claude'), echoer('CMUX-WRAPPER'), { mode: 0o755 });
  writeFileSync(join(dirs.lens, 'lens'), echoer('LENS'), { mode: 0o755 });
});

const run = (args: string[], env: Record<string, string>, path: string[]) =>
  execFileSync(SHIM, args, {
    encoding: 'utf8',
    // /usr/bin:/bin last so `#!/usr/bin/env bash` resolves; no real claude lives there.
    env: { PATH: [...path, '/usr/bin', '/bin'].join(':'), ...env },
  }).trim();

describe('cmux-claude-shim', () => {
  it('wraps the real claude in `lens run`, skipping cmux\'s own wrapper on PATH', () => {
    // cmux's wrapper dir comes FIRST — resolving naively would exec it and loop.
    const out = run(['--session-id', 'abc', '--settings', '{"a":1}'], {}, [dirs.cmux, dirs.real, dirs.lens]);
    expect(out).toBe(`LENS run --tag surface=cmux -- ${join(dirs.real, 'claude')} --session-id abc --settings {"a":1}`);
  });

  it('execs claude directly when already inside a capture (no double proxy)', () => {
    const out = run(['-p', 'hi'], { AGENTLENS_CAPTURE: '1' }, [dirs.cmux, dirs.real, dirs.lens]);
    expect(out).toBe('REAL -p hi');
  });

  it('fails open to a bare claude when lens is not installed', () => {
    const out = run(['-p', 'hi'], {}, [dirs.cmux, dirs.real]);
    expect(out).toBe('REAL -p hi');
  });

  it('honors an override tag', () => {
    const out = run([], { AGENTLENS_CMUX_TAG: 'surface=cmux-nightly' }, [dirs.real, dirs.lens]);
    expect(out).toBe(`LENS run --tag surface=cmux-nightly -- ${join(dirs.real, 'claude')}`);
  });

  it('exits 127 with a message when no real claude exists', () => {
    expect(() => run([], {}, [dirs.cmux, dirs.lens])).toThrowError(/status 127|Command failed/);
  });
});

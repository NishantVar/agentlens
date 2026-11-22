// ALF-16: `lens --version` reports the commit its build was made from.
// Each case builds a throwaway copy of this checkout (sources, lockfile and
// build config, with node_modules linked in) in a fresh temp dir, then runs
// the built CLI the way Flux does: through a symlink, from another directory.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers/lens.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version as string;
const COPIED = ['src', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.json'];
const T = 120_000;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

// A copy of the checkout's build inputs; a git repo with one commit when `withGit`.
function checkoutCopy(withGit: boolean): { dir: string; head: string | null } {
  const dir = join(tmp('agentlens-build-'), 'agentlens');
  mkdirSync(dir);
  for (const p of COPIED) if (existsSync(join(REPO, p))) cpSync(join(REPO, p), join(dir, p), { recursive: true });
  symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'));
  if (!withGit) return { dir, head: null };
  writeFileSync(join(dir, '.gitignore'), 'node_modules\ndist\n');
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return { dir, head: git(dir, 'rev-parse', 'HEAD') };
}

const build = (dir: string) => spawnSync('npm', ['run', 'build', '--silent'], { cwd: dir, encoding: 'utf8', env: { ...process.env, AGENTLENS_HOME: tmp('agentlens-home-') } });

// `lens --version` through a symlink to the copy's CLI entry, run from `cwd`.
function versionVia(dir: string, cwd: string): string {
  const link = join(tmp('agentlens-bin-'), 'lens');
  symlinkSync(join(dir, 'dist', 'cli.js'), link);
  return execFileSync(process.execPath, [link, '--version'], { cwd, encoding: 'utf8', env: { ...process.env, AGENTLENS_HOME: tmp('agentlens-home-') } }).trim();
}

// A working directory inside another git repo, at a different commit.
function otherRepo(): string {
  const d = tmp('agentlens-other-');
  writeFileSync(join(d, 'f'), 'x');
  git(d, 'init', '-q'); git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'other');
  return d;
}

describe('ALF-16 build identity', () => {
  let other: string;
  beforeAll(() => { other = otherRepo(); });

  it('ALF-16 [symlink-other-repo] prints the package version and the build commit, not the working directory\'s', () => {
    const { dir, head } = checkoutCopy(true);
    const b = build(dir);
    expect(b.status, b.stderr).toBe(0);
    const out = versionVia(dir, other);
    expect(out).toBe(`${VERSION} ${head}`);
    expect(out).not.toContain(git(other, 'rev-parse', 'HEAD'));
  }, T);

  it('ALF-16 [head-moved] still prints the build commit after the checkout moves without a rebuild', () => {
    const { dir, head } = checkoutCopy(true);
    expect(build(dir).status).toBe(0);
    writeFileSync(join(dir, 'moved.txt'), 'later');
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'later');
    expect(git(dir, 'rev-parse', 'HEAD')).not.toBe(head);
    expect(versionVia(dir, other)).toBe(`${VERSION} ${head}`);
  }, T);

  it('ALF-16 [no-git] a build from a copy with no .git prints unknown', () => {
    const { dir } = checkoutCopy(false);
    const b = build(dir);
    expect(b.status, b.stderr).toBe(0);
    expect(versionVia(dir, other)).toBe(`${VERSION} unknown`);
  }, T);

  it('ALF-16 [no-git-inside-other-repo] a copy with no .git of its own, inside another repo, prints unknown, not that repo\'s commit', () => {
    const { dir } = checkoutCopy(false);
    git(dirname(dir), 'init', '-q');
    writeFileSync(join(dirname(dir), '.gitignore'), 'agentlens/\n');
    git(dirname(dir), 'add', '-A'); git(dirname(dir), 'commit', '-q', '-m', 'outer');
    const b = build(dir);
    expect(b.status, b.stderr).toBe(0);
    expect(versionVia(dir, other)).toBe(`${VERSION} unknown`);
  }, T);

  it('ALF-16 [failed-rebuild] a rebuild that fails at a later step prints unknown', () => {
    const { dir, head } = checkoutCopy(true);
    expect(build(dir).status).toBe(0);
    expect(versionVia(dir, other)).toBe(`${VERSION} ${head}`);
    // the compile step fails; the earlier build's output still runs
    writeFileSync(join(dir, 'src', 'broken.ts'), 'export const x: number = "not a number";\n');
    expect(build(dir).status).not.toBe(0);
    expect(versionVia(dir, other)).toBe(`${VERSION} unknown`);
  }, T);

  it('ALF-16 [killed-rebuild] a rebuild killed partway prints unknown', async () => {
    const { dir, head } = checkoutCopy(true);
    expect(build(dir).status).toBe(0);
    expect(versionVia(dir, other)).toBe(`${VERSION} ${head}`);
    const before = versionVia(dir, other);
    // Kill the whole rebuild once it is under way: its first step removes the
    // earlier record (dist/build-info.json), and the compile that follows takes
    // far longer than this poll.
    const record = join(dir, 'dist', 'build-info.json');
    expect(existsSync(record)).toBe(true);
    const p = spawn('npm', ['run', 'build', '--silent'], { cwd: dir, detached: true, stdio: 'ignore' });
    let done = false;
    const exited = new Promise<void>((r) => p.on('exit', () => { done = true; r(); }));
    const t0 = Date.now();
    while (existsSync(record) && !done && Date.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 2));
    expect(done, 'rebuild finished before it could be killed').toBe(false);
    process.kill(-p.pid!, 'SIGKILL');
    await exited;
    expect(before).toBe(`${VERSION} ${head}`);
    expect(versionVia(dir, other)).toBe(`${VERSION} unknown`);
  }, T);
  // A compiler that waits at `started` before running the real tsc and at
  // `emitted` after it, so the test can change the checkout while the build runs.
  function gatedCompiler(dir: string) {
    const gate = tmp('agentlens-gate-');
    rmSync(join(dir, 'node_modules'));
    mkdirSync(join(dir, 'node_modules'));
    for (const name of readdirSync(join(REPO, 'node_modules'))) if (name !== 'typescript') symlinkSync(join(REPO, 'node_modules', name), join(dir, 'node_modules', name));
    mkdirSync(join(dir, 'node_modules', 'typescript', 'bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'typescript', 'package.json'), JSON.stringify({ name: 'typescript', version: '0.0.0' }));
    const g = (f: string) => JSON.stringify(join(gate, f));
    writeFileSync(join(dir, 'node_modules', 'typescript', 'bin', 'tsc'), [
      "const { spawnSync } = require('node:child_process'); const fs = require('node:fs');",
      `const wait = (f) => { while (!fs.existsSync(f)) spawnSync('sleep', ['0.05']); };`,
      `fs.writeFileSync(${g('started')}, ''); wait(${g('go-compile')});`,
      `const r = spawnSync(process.execPath, [${JSON.stringify(join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'))}, ...process.argv.slice(2)], { stdio: 'inherit' });`,
      `fs.writeFileSync(${g('emitted')}, ''); wait(${g('go-exit')});`,
      'process.exit(r.status ?? 1);',
    ].join('\n'));
    const p = spawn('npm', ['run', 'build', '--silent'], { cwd: dir, stdio: 'ignore' });
    const exited = new Promise<number | null>((r) => p.on('exit', (code) => r(code)));
    const at = async (f: string) => {
      const t0 = Date.now();
      while (!existsSync(join(gate, f)) && Date.now() - t0 < 90_000) await new Promise((r) => setTimeout(r, 20));
      expect(existsSync(join(gate, f)), `compiler never reached ${f}`).toBe(true);
    };
    const open = (f: string) => writeFileSync(join(gate, f), '');
    return { exited, at, open };
  }
  // A later commit adds src/later.ts; output built from it has dist/later.js.
  const commitLater = (dir: string) => {
    writeFileSync(join(dir, 'src', 'later.ts'), 'export const later = 1;\n');
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'later');
    return git(dir, 'rev-parse', 'HEAD');
  };
  // The advertised commit supplied the compiled sources, or the commit is unknown.
  function expectHonest(dir: string, head: string, out: string) {
    const fromLater = existsSync(join(dir, 'dist', 'later.js'));
    expect([`${VERSION} ${head}`, `${VERSION} unknown`]).toContain(out);
    if (fromLater) expect(out, 'output compiled from the later commit is advertised as the first').toBe(`${VERSION} unknown`);
  }

  it('ALF-16 [head-moved-during-build] a checkout move while the build is under way never stamps the new commit', async () => {
    const { dir, head } = checkoutCopy(true);
    const c = gatedCompiler(dir);
    await c.at('started'); c.open('go-compile');
    await c.at('emitted');
    const moved = commitLater(dir); // the checkout moves after the compiler read its sources
    expect(moved).not.toBe(head);
    c.open('go-exit');
    expect(await c.exited).toBe(0);
    const out = versionVia(dir, other);
    expect(out).not.toContain(moved);
    expectHonest(dir, head!, out);
  }, T);

  it('ALF-16 [head-round-trip-during-build] sources from another commit compiled between two matching HEAD samples are never advertised as the first commit', async () => {
    const { dir, head } = checkoutCopy(true);
    const c = gatedCompiler(dir);
    await c.at('started');
    const moved = commitLater(dir); // the checkout is at B while the compiler reads
    c.open('go-compile');
    await c.at('emitted');
    git(dir, 'reset', '-q', '--hard', head!); // and back at A before the build finishes
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    c.open('go-exit');
    expect(await c.exited).toBe(0);
    const out = versionVia(dir, other);
    expect(out).not.toContain(moved);
    expectHonest(dir, head!, out);
  }, T);

  it('ALF-16 [uncommitted-source] a build of uncommitted source edits compiles them and prints unknown', () => {
    const { dir } = checkoutCopy(true);
    writeFileSync(join(dir, 'src', 'later.ts'), 'export const later = 1;\n');
    const b = build(dir);
    expect(b.status, b.stderr).toBe(0);
    expect(existsSync(join(dir, 'dist', 'later.js'))).toBe(true);
    expect(versionVia(dir, other)).toBe(`${VERSION} unknown`);
  }, T);
});

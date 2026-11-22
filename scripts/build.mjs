#!/usr/bin/env node
// `npm run build`. dist/build-info.json records the commit a build was made
// from, and only a build whose every step succeeded writes it:
//   1. remove the earlier record, so a failed or interrupted build has none;
//   2. compile with tsc. When this package root is the top of a git checkout
//      and its inputs (src/, tsconfig.json, package.json) match HEAD, tsc compiles a copy
//      of those sources read from HEAD's git objects, so the output comes from
//      that commit whatever happens to the checkout during the build.
//      Otherwise it compiles the checkout as it is;
//   3. write the record (temp file + rename): the commit compiled in step 2,
//      or "unknown" when the checkout was compiled (no git, another repo's
//      checkout, or uncommitted source changes).
// `lens --version` reads it; with no record it reports "unknown".
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const record = join(root, 'dist', 'build-info.json');
const INPUTS = ['src', 'tsconfig.json', 'package.json']; // package.json sets the module type
const git = (args, opts = {}) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], ...opts });
const gitText = (...a) => git(a, { encoding: 'utf8' }).trim();

// A copy without its own .git can sit inside another repo; that repo's HEAD
// is not this build's commit.
function commit() {
  try {
    if (realpathSync(gitText('rev-parse', '--show-toplevel')) !== realpathSync(root)) return 'unknown';
    const head = gitText('rev-parse', '--verify', 'HEAD');
    return /^[0-9a-f]{40}$/.test(head) ? head : 'unknown';
  } catch {
    return 'unknown';
  }
}

// The commit's inputs, read from git objects (which do not change) into a
// fresh directory; null when the checkout's inputs differ from the commit.
function snapshot(head) {
  try {
    const changed = spawnSync('git', ['diff', '--quiet', head, '--', ...INPUTS], { cwd: root, stdio: 'ignore' }).status !== 0;
    if (changed || gitText('ls-files', '--others', '--', ...INPUTS) !== '') return null;
    const dir = mkdtempSync(join(tmpdir(), 'agentlens-build-'));
    for (const line of gitText('ls-tree', '-r', '-z', '--full-tree', head, '--', ...INPUTS).split('\0').filter(Boolean)) {
      const [info, path] = line.split('\t');
      const [, type, oid] = info.split(' ');
      if (type !== 'blob') { rmSync(dir, { recursive: true, force: true }); return null; }
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), git(['cat-file', 'blob', oid], { maxBuffer: 1 << 30 }));
    }
    if (existsSync(join(root, 'node_modules'))) symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
    return dir;
  } catch {
    return null;
  }
}

rmSync(record, { force: true });

const head = commit();
const snap = head === 'unknown' ? null : snapshot(head);
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
// From a snapshot, emit into this checkout's dist; sourceRoot keeps source
// maps pointing at ../src (src/ has no subdirectories).
const args = snap
  ? ['-p', join(snap, 'tsconfig.json'), '--outDir', join(root, 'dist'), '--sourceRoot', '../src']
  : ['-p', join(root, 'tsconfig.json')];
const r = spawnSync(process.execPath, [tsc, ...args], { stdio: 'inherit' });
if (snap) rmSync(snap, { recursive: true, force: true });
if (r.status !== 0) process.exit(r.status ?? 1);

mkdirSync(dirname(record), { recursive: true });
const tmp = `${record}.${process.pid}.tmp`;
writeFileSync(tmp, JSON.stringify({ commit: snap ? head : 'unknown' }) + '\n');
renameSync(tmp, record);

#!/usr/bin/env node
// `npm run build`. dist/build-info.json records the commit a build was made
// from, and only a build whose every step succeeded writes it:
//   1. remove the earlier record, so a failed or interrupted build has none;
//   2. compile with tsc;
//   3. write the record (temp file + rename): the checkout's HEAD when this
//      package root is the top of a git checkout and HEAD was the same before
//      and after compiling, otherwise "unknown" (a checkout move mid-build
//      leaves output whose sources no single commit is known to have supplied).
// `lens --version` reads it; with no record it reports "unknown".
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const record = join(root, 'dist', 'build-info.json');

rmSync(record, { force: true });
const before = commit();

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const r = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')], { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);

// A copy without its own .git can sit inside another repo; that repo's HEAD
// is not this build's commit.
function commit() {
  try {
    const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (realpathSync(git('rev-parse', '--show-toplevel')) !== realpathSync(root)) return 'unknown';
    const head = git('rev-parse', '--verify', 'HEAD');
    return /^[0-9a-f]{40}$/.test(head) ? head : 'unknown';
  } catch {
    return 'unknown';
  }
}

mkdirSync(dirname(record), { recursive: true });
const tmp = `${record}.${process.pid}.tmp`;
const after = commit();
writeFileSync(tmp, JSON.stringify({ commit: before === after ? after : 'unknown' }) + '\n');
renameSync(tmp, record);

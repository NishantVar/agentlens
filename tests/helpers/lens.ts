// Shared helpers for subprocess-level capture tests: a real `lens` CLI run
// through tsx, scripted fake CLIs, synthetic rollouts and a mock upstream.
// Everything lives in fresh temp dirs; nothing touches a real store.
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { identityOf, type ProcIdentity } from '../../src/procinfo.js';
import type { IndexEntry } from '../../src/types.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO, 'src', 'cli.ts');
const TSX = join(REPO, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs');

export const tmp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

// ---- scripted fake CLI -------------------------------------------------------
// One node script, copied under the names `claude` and `codex` (lens picks the
// runtime from the basename). FAKE_SCRIPT is a JSON list of steps. A fake codex
// only ever holds its rollout open and writes ordinary rollout lines; the
// ready/gate files are test-side synchronisation that agentlens never reads.
const FAKE = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const steps = JSON.parse(process.env.FAKE_SCRIPT || '[]');
const fds = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.FAKE_PIDFILE) fs.writeFileSync(process.env.FAKE_PIDFILE, String(process.pid));
for (const s of ['SIGHUP', 'SIGTERM', 'SIGINT']) {
  process.on(s, () => {
    if (process.env.FAKE_SIGLOG) fs.appendFileSync(process.env.FAKE_SIGLOG, s + '\n');
    if (process.env.FAKE_IGNORE_SIGNALS) return;
    process.exit(128 + require('node:os').constants.signals[s]);
  });
}
(async () => {
  for (const st of steps) {
    if (st.open) {
      fs.mkdirSync(path.dirname(st.open), { recursive: true });
      if (st.mode === 'r' && !fs.existsSync(st.open)) fs.writeFileSync(st.open, '');
      fds[st.open] = fs.openSync(st.open, st.mode || 'a+');
    } else if (st.write) {
      fs.writeSync(fds[st.write], st.lines.map((l) => l + '\n').join(''));
    } else if (st.close) {
      fs.closeSync(fds[st.close]); delete fds[st.close];
    } else if (st.touch) {
      fs.writeFileSync(st.touch, String(process.pid));
    } else if (st.wait) {
      while (!fs.existsSync(st.wait)) await sleep(15);
    } else if (st.sleep) {
      await sleep(st.sleep);
    } else if (st.post) {
      const res = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-4-1', messages: [], metadata: { user_id: 'user_abc_account_def_session_44444444-4444-4444-4444-444444444444' } }) });
      await res.text();
    } else if (st.forever) {
      setInterval(() => {}, 1 << 30);
      await new Promise(() => {});
    }
  }
  process.exit(Number(process.env.FAKE_EXIT || 0));
})();
`;

export const FAKE_BIN = tmp('fakebin-');
for (const name of ['claude', 'codex', 'writer']) writeFileSync(join(FAKE_BIN, name), FAKE, { mode: 0o755 });

export type Step =
  | { open: string; mode?: 'a+' | 'r' } | { write: string; lines: string[] } | { close: string }
  | { touch: string } | { wait: string } | { sleep: number } | { post: true } | { forever: true };

// ---- synthetic rollouts -------------------------------------------------------
export interface U { input: number; cached: number; output: number }
export const metaLines = (id: string, cwd: string) => [
  JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id, timestamp: new Date().toISOString(), cwd, originator: 'codex_exec', cli_version: '0.141.0' } }),
  JSON.stringify({ timestamp: new Date().toISOString(), type: 'turn_context', payload: { turn_id: 't1', cwd, model: 'gpt-5.3-codex' } }),
];
export const usageLine = (u: U) => JSON.stringify({
  timestamp: new Date().toISOString(), type: 'event_msg',
  payload: { type: 'token_count', info: { last_token_usage: { input_tokens: u.input, cached_input_tokens: u.cached, output_tokens: u.output, reasoning_output_tokens: 0 } } },
});

// ---- environment ---------------------------------------------------------------
export interface Env { home: string; codex: string; cwd: string; sync: string; env: NodeJS.ProcessEnv }
export function freshEnv(extra: Record<string, string> = {}): Env {
  const home = tmp('agentlens-home-');
  const codex = tmp('codex-sessions-');
  const cwd = tmp('agentlens-cwd-');
  const sync = tmp('agentlens-sync-');
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTLENS_HOME: home, AGENTLENS_CODEX_SESSIONS: codex, ...extra };
  delete env.AGENTLENS_TAGS; delete env.AGENTLENS_TEST_HOOKS; delete env.AGENTLENS_CAPTURE;
  return { home, codex, cwd, sync, env };
}
export const rolloutPath = (e: Env, name: string) => join(e.codex, '2026', '11', '22', `rollout-${name}.jsonl`);

// ---- running lens ---------------------------------------------------------------
export interface Lens { child: ChildProcess; out: () => string; err: () => string; done: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }> }
export function spawnLens(args: string[], env: NodeJS.ProcessEnv, opts: { cwd?: string; detached?: boolean } = {}): Lens {
  const child = spawn(process.execPath, ['--import', TSX, CLI, ...args], { env, cwd: opts.cwd, detached: opts.detached, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout!.on('data', (d) => { out += d; });
  child.stderr!.on('data', (d) => { err += d; });
  // Resolve on exit, then give stdio up to 500 ms to drain: an orphaned child
  // that ignored a signal still holds the inherited pipes, so 'close' may never come.
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((r) => child.on('exit', (code, signal) => {
    const res = { code, signal, at: Date.now() };
    const t = setTimeout(() => r(res), 500);
    child.once('close', () => { clearTimeout(t); r(res); });
  }));
  return { child, out: () => out, err: () => err, done };
}
export async function runLens(args: string[], env: NodeJS.ProcessEnv, opts: { cwd?: string } = {}) {
  const l = spawnLens(args, env, opts);
  const r = await l.done;
  return { code: r.code, out: l.out(), err: l.err() };
}
export function lensRunFake(e: Env, runtime: 'claude' | 'codex', script: Step[], extra: Record<string, string> = {}, opts: { detached?: boolean } = {}): Lens {
  return spawnLens(['run', '--', join(FAKE_BIN, runtime)], { ...e.env, FAKE_SCRIPT: JSON.stringify(script), ...extra }, { cwd: e.cwd, detached: opts.detached });
}
export function spawnWriter(e: Env, script: Step[]): ChildProcess {
  return spawn(join(FAKE_BIN, 'writer'), [], { cwd: e.cwd, env: { ...e.env, FAKE_SCRIPT: JSON.stringify(script) }, stdio: 'ignore' });
}

// ---- waiting and reading the store ------------------------------------------------
export async function waitFor<T>(fn: () => T | undefined | null | false, ms = 15000, what = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    let v: T | undefined | null | false;
    try { v = fn(); } catch { v = undefined; }
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
export const touch = (p: string) => writeFileSync(p, '');
export const index = (home: string): IndexEntry[] => existsSync(join(home, 'index.jsonl'))
  ? readFileSync(join(home, 'index.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
export interface Claim { rollout: string; session: string; holders: ProcIdentity[] }
export const claims = (home: string): Claim[] => {
  const d = join(home, 'claims');
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith('.json') && !f.startsWith('.')).map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')));
};
export const sessionIds = (home: string): string[] => existsSync(join(home, 'sessions')) ? readdirSync(join(home, 'sessions')) : [];
export const eventLines = (home: string, id: string) => {
  const p = join(home, 'sessions', id, 'events.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
export const looks = (file: string): { n: number; reason: string; startedAt: number; endedAt: number; claimed: string[] }[] => existsSync(file)
  ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
export const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
export const pidOf = (file: string) => Number(readFileSync(file, 'utf8'));
export const killQuiet = (pid: number | undefined) => { try { if (pid) process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };

// The identity of a process that has exited: started, read, then killed.
export async function deadIdentity(): Promise<ProcIdentity> {
  const p = spawn('sleep', ['30'], { stdio: 'ignore' });
  await new Promise((r) => p.once('spawn', r));
  const id = identityOf(p.pid!)!;
  const gone = new Promise((r) => p.once('exit', r));
  p.kill('SIGKILL');
  await gone;
  return id;
}
export async function liveSleeper(): Promise<{ id: ProcIdentity; stop: () => void }> {
  const p = spawn('sleep', ['60'], { stdio: 'ignore' });
  await new Promise((r) => p.once('spawn', r));
  return { id: identityOf(p.pid!)!, stop: () => p.kill('SIGKILL') };
}

// ---- mock Anthropic upstream -------------------------------------------------------
export async function mockUpstream(): Promise<{ origin: string; close: () => void }> {
  const s = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'claude-opus-4-1', usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 11, cache_creation_input_tokens: 0 } }));
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => { s.closeAllConnections(); s.close(); } };
}

export const ensureDir = (p: string) => { mkdirSync(p, { recursive: true }); return p; };

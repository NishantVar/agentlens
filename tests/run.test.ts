import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { lensRun } from '../src/run.js';
import { StoreReader } from '../src/store.js';
import { rolloutFixture } from './fixtures/codexRollout.js';

// Mock "Anthropic API"
const upstream = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ model: 'claude-opus-4-1', usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 11, cache_creation_input_tokens: 0 } }));
});
await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
afterAll(() => upstream.close());

// Fake "claude" CLI: POSTs to $ANTHROPIC_BASE_URL/v1/messages then exits with $FAKE_EXIT
// (extensionless file = CommonJS, so no top-level await — use an async IIFE; fetch is global in Node 20)
const binDir = mkdtempSync(join(tmpdir(), 'fakebin-'));
writeFileSync(join(binDir, 'claude'), `#!/usr/bin/env node
(async () => {
  const base = process.env.ANTHROPIC_BASE_URL;
  const res = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-4-1', messages: [], metadata: { user_id: 'user_abc_account_def_session_22222222-2222-2222-2222-222222222222' } }) });
  await res.text();
  process.exit(Number(process.env.FAKE_EXIT ?? 0));
})();
`, { mode: 0o755 });

// Fake "codex" CLI: writes a rollout file into $AGENTLENS_CODEX_SESSIONS (simulating codex's native session logging)
writeFileSync(join(binDir, 'codex'), `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const day = join(process.env.AGENTLENS_CODEX_SESSIONS, '2026', '07', '14');
mkdirSync(day, { recursive: true });
writeFileSync(join(day, 'rollout-test.jsonl'), process.env.FAKE_ROLLOUT);
process.exit(0);
`, { mode: 0o755 });

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agentlens-home-'));
  process.env.AGENTLENS_HOME = home;
  delete process.env.AGENTLENS_TAGS;
});

describe('lensRun', () => {
  it('captures a session end-to-end with tags and totals', async () => {
    process.env.AGENTLENS_TAGS = 'agent=verifier';
    const code = await lensRun({ tags: ['run=r1', 'agent=flagged'], argv: [join(binDir, 'claude')], upstreamOverride: upstreamOrigin });
    expect(code).toBe(0);
    const r = new StoreReader(home);
    const [entry] = r.listIndex();
    expect(entry.tags).toEqual({ agent: 'verifier', run: 'r1' }); // env wins
    expect(entry.runtime).toBe('claude');
    expect(entry.totals).toMatchObject({ input: 7, output: 3, cacheRead: 11, requests: 1 });
    expect(entry.models).toEqual(['claude-opus-4-1']);
    const raw = r.readRaw(entry.id);
    expect(raw[0].request.path).toBe('/v1/messages');
    expect(raw[0].seq).toBe(1);
    expect(entry.nativeSessionIds).toEqual(['22222222-2222-2222-2222-222222222222']);
  });

  it('propagates the child exit code', async () => {
    process.env.FAKE_EXIT = '3';
    const code = await lensRun({ tags: [], argv: [join(binDir, 'claude')], upstreamOverride: upstreamOrigin });
    delete process.env.FAKE_EXIT;
    expect(code).toBe(3);
  });

  it('returns 2 for unsupported runtimes without spawning', async () => {
    expect(await lensRun({ tags: [], argv: ['hermes', '--flag'] })).toBe(2);
  });

  it('captures a codex session from native rollouts (logs mode)', async () => {
    const sessionsRoot = mkdtempSync(join(tmpdir(), 'codex-sessions-'));
    process.env.AGENTLENS_CODEX_SESSIONS = sessionsRoot;
    process.env.FAKE_ROLLOUT = rolloutFixture(process.cwd());
    const code = await lensRun({ tags: ['agent=codex-e2e'], argv: [join(binDir, 'codex')] });
    delete process.env.AGENTLENS_CODEX_SESSIONS;
    delete process.env.FAKE_ROLLOUT;
    expect(code).toBe(0);
    const r = new StoreReader(home);
    const [entry] = r.listIndex();
    expect(entry.runtime).toBe('codex');
    expect(entry.totals).toMatchObject({ input: 4812, output: 256, cacheRead: 17152, requests: 1 });
    expect(r.readMeta(entry.id).capture).toBe('logs');
    expect(existsSync(join(home, 'sessions', entry.id, 'rollout-1.jsonl'))).toBe(true);
    expect(entry.nativeSessionIds).toEqual(['019f-test']);
  });
});

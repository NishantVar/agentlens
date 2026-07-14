import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startProxy, type CaptureProxy } from '../src/proxy.js';
import type { RawPair } from '../src/types.js';

let upstream: http.Server;
let upstreamOrigin: string;
let proxy: CaptureProxy;
const pairs: Omit<RawPair, 'seq'>[] = [];
let foreverClosed: Promise<void>;
let resolveForeverClosed: () => void;

beforeAll(async () => {
  foreverClosed = new Promise<void>((r) => { resolveForeverClosed = r; });
  upstream = http.createServer((req, res) => {
    if (req.url === '/v1/messages') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'session=secret' });
        res.end(JSON.stringify({ echoed: JSON.parse(body), sawAcceptEncoding: req.headers['accept-encoding'] ?? null, sawAuth: req.headers.authorization ?? null }));
      });
    } else if (req.url === '/v1/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: a\ndata: {"x":1}\n\n');
      setTimeout(() => { res.write('event: b\ndata: {"x":2}\n\n'); res.end(); }, 20);
    } else if (req.url === '/v1/forever') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const timer = setInterval(() => res.write('event: tick\ndata: {}\n\n'), 5);
      res.write('event: start\ndata: {}\n\n');
      res.on('close', () => { clearInterval(timer); resolveForeverClosed(); });
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  proxy = await startProxy({ upstream: upstreamOrigin, onPair: (p) => pairs.push(p) });
});
afterAll(async () => { await proxy.close(); upstream.close(); });

describe('startProxy', () => {
  it('forwards request+auth, strips accept-encoding, records redacted pair', async () => {
    pairs.length = 0;
    const res = await fetch(`${proxy.origin}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-secret', 'accept-encoding': 'gzip' },
      body: JSON.stringify({ model: 'm1' }),
    });
    const data = await res.json();
    expect(data.echoed).toEqual({ model: 'm1' });
    expect(data.sawAuth).toBe('Bearer sk-secret');   // forwarded intact
    expect(data.sawAcceptEncoding).toBeNull();        // stripped
    expect(res.headers.get('set-cookie')).toBe('session=secret'); // forwarded intact to client
    expect(pairs).toHaveLength(1);
    expect(pairs[0].request.headers.authorization).toBe('<redacted>');
    expect(pairs[0].response.headers['set-cookie']).toBe('<redacted>'); // redacted in stored trace
    expect(pairs[0].request.body).toContain('"model":"m1"');
    expect(pairs[0].response.status).toBe(200);
    expect(pairs[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('streams SSE unbuffered and records the full stream text', async () => {
    pairs.length = 0;
    const res = await fetch(`${proxy.origin}/v1/stream`);
    const text = await res.text();
    expect(text).toContain('data: {"x":1}');
    expect(text).toContain('data: {"x":2}');
    expect(pairs[0].response.body).toBe(text);
    expect(pairs[0].response.headers['content-type']).toContain('text/event-stream');
  });

  it('fails open when onPair throws', async () => {
    const bad = await startProxy({ upstream: upstreamOrigin, onPair: () => { throw new Error('boom'); } });
    const res = await fetch(`${bad.origin}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(200);
    await bad.close();
  });

  it('aborts the upstream request when the client disconnects mid-stream', async () => {
    const controller = new AbortController();
    const res = await fetch(`${proxy.origin}/v1/forever`, { signal: controller.signal });
    const reader = res.body!.getReader();
    await reader.read();        // first chunk arrived → stream is live
    controller.abort();         // client disconnects mid-stream
    reader.cancel().catch(() => {});
    // (b) upstream saw its response closed
    await foreverClosed;
    // (a) proxy still serves a subsequent normal request
    const ok = await fetch(`${proxy.origin}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm2' }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).echoed).toEqual({ model: 'm2' });
  });

  it('responds 502 on upstream connection failure', async () => {
    const dead = await startProxy({ upstream: 'http://127.0.0.1:1', onPair: () => {} });
    const res = await fetch(`${dead.origin}/v1/messages`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(502);
    await dead.close();
  });
});

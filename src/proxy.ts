import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { RawPair } from './types.js';

export interface ProxyOptions { upstream: string; onPair(pair: Omit<RawPair, 'seq'>): void }
export interface CaptureProxy { origin: string; close(): Promise<void> }

const REDACT = new Set(['authorization', 'x-api-key', 'cookie']);

function headerMap(h: http.IncomingHttpHeaders | http.OutgoingHttpHeaders, redact: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    out[key] = redact && REDACT.has(key) ? '<redacted>' : Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

export function startProxy(opts: ProxyOptions): Promise<CaptureProxy> {
  const upstream = new URL(opts.upstream);
  const transport = upstream.protocol === 'https:' ? https : http;
  const server = http.createServer((req, res) => {
    const started = Date.now();
    const ts = new Date(started).toISOString();
    const reqChunks: Buffer[] = [];
    req.on('data', (c) => reqChunks.push(c));
    req.on('end', () => {
      const reqBody = Buffer.concat(reqChunks);
      const fwdHeaders: http.OutgoingHttpHeaders = { ...req.headers };
      delete fwdHeaders['accept-encoding'];
      fwdHeaders.host = upstream.host;
      const proxyReq = transport.request(
        {
          host: upstream.hostname,
          port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
          path: req.url,
          method: req.method,
          headers: fwdHeaders,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          const resChunks: Buffer[] = [];
          proxyRes.on('data', (c) => { resChunks.push(c); res.write(c); });
          proxyRes.on('end', () => {
            res.end();
            try {
              opts.onPair({
                ts,
                durationMs: Date.now() - started,
                request: { method: req.method ?? '', path: req.url ?? '', headers: headerMap(req.headers, true), body: reqBody.toString('utf8') },
                response: { status: proxyRes.statusCode ?? 0, headers: headerMap(proxyRes.headers, false), body: Buffer.concat(resChunks).toString('utf8') },
              });
            } catch (e) {
              console.error('agentlens: onPair failed (fail-open):', e);
            }
          });
        },
      );
      proxyReq.on('error', (e) => {
        console.error('agentlens: upstream error (fail-open):', e.message);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'agentlens proxy: upstream unreachable' }));
      });
      proxyReq.end(reqBody);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

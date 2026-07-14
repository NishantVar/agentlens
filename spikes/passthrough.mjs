// Usage: node spikes/passthrough.mjs <upstream-origin> [port]
// e.g. node spikes/passthrough.mjs https://api.anthropic.com 4141
import http from 'node:http';
import https from 'node:https';

const upstream = new URL(process.argv[2]);
const port = Number(process.argv[3] ?? 4141);

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const headers = { ...req.headers };
    delete headers['accept-encoding']; // force identity encoding upstream
    headers.host = upstream.host;
    console.log(`>>> ${req.method} ${req.url} (${body.length}B)`);
    const proxyReq = https.request(
      { host: upstream.hostname, port: 443, path: req.url, method: req.method, headers },
      (proxyRes) => {
        console.log(`<<< ${proxyRes.statusCode} ${req.url} content-type=${proxyRes.headers['content-type']} content-encoding=${proxyRes.headers['content-encoding'] ?? 'identity'}`);
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on('error', (e) => { console.error('upstream error', e); res.destroy(); });
    proxyReq.end(body);
  });
});
server.listen(port, '127.0.0.1', () => console.log(`proxying :${port} -> ${upstream.origin}`));

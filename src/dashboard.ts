import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { StoreReader } from './store.js';
import { filterIndex, groupBy } from './query.js';

export interface DashboardHandle { origin: string; close(): Promise<void> }

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>agentlens dashboard</title>
<style>
  body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:2rem;max-width:70rem}
  table{border-collapse:collapse;margin:.5rem 0 1.5rem}td,th{border:1px solid #ccc;padding:.3em .7em;text-align:right}
  td:first-child,th:first-child{text-align:left}
  .live{color:#0a0}
  @media(prefers-color-scheme:dark){body{background:#111;color:#ddd}td,th{border-color:#333}}
</style></head><body>
<h1>agentlens</h1>
<p>filter run: <input id="run" placeholder="flux run id"></p>
<h2>active sessions</h2><div id="active">–</div>
<h2>by agent</h2><div id="agents">–</div>
<h2>recent sessions</h2><div id="recent">–</div>
<script>
const fmt = (n) => Number(n ?? 0).toLocaleString();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const table = (headers, rows) => '<table><tr>' + headers.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr>' +
  rows.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</table>';
async function tick() {
  const run = document.getElementById('run').value.trim();
  const data = await (await fetch('/api/data' + (run ? '?run=' + encodeURIComponent(run) : ''))).json();
  document.getElementById('active').innerHTML = data.active.length
    ? table(['id', 'agent', 'started'], data.active.map((m) => ['<span class="live">●</span> ' + esc(m.id), esc(m.tags.agent ?? '-'), esc(m.startedAt)]))
    : '<p>none</p>';
  document.getElementById('agents').innerHTML = table(
    ['agent', 'sessions', 'requests', 'input', 'output', 'cache rd', 'cache wr'],
    data.byAgent.map((r) => [esc(r.key), r.sessions, r.totals.requests, fmt(r.totals.input), fmt(r.totals.output), fmt(r.totals.cacheRead), fmt(r.totals.cacheWrite)]));
  document.getElementById('recent').innerHTML = table(
    ['id', 'agent', 'tokens', 'exit'],
    data.recent.map((e) => [esc(e.id), esc(e.tags.agent ?? '-'), fmt(e.totals.input + e.totals.output + e.totals.cacheRead + e.totals.cacheWrite), e.exitCode]));
}
tick(); setInterval(tick, 2000);
</script></body></html>`;

export function startDashboard(port = 4040, reader: StoreReader = new StoreReader()): Promise<DashboardHandle> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/data') {
      const run = url.searchParams.get('run') ?? undefined;
      const filter = run ? { tags: { run } } : {};
      const index = filterIndex(reader.listIndex(), filter);
      const active = reader.listActive().filter((m) => !run || m.tags.run === run);
      const byAgent = groupBy(index, 'agent', reader);
      const recent = [...index].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ active, byAgent, recent }));
    } else if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
    } else {
      res.writeHead(404); res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const p = (server.address() as AddressInfo).port;
      resolve({ origin: `http://127.0.0.1:${p}`, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

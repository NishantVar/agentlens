import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { StoreReader, storeRoot } from './store.js';
import { extractMessages } from './codexRollout.js';

export function generateReport(sessionIds: string[], reader: StoreReader = new StoreReader()): string {
  const sessions = sessionIds.map((id) => {
    const dir = join(storeRoot(), 'sessions', id);
    if (!existsSync(dir)) throw new Error(`session "${id}" not found`);
    const messages = readdirSync(dir)
      .filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'))
      .sort()
      .flatMap((f) => extractMessages(readFileSync(join(dir, f), 'utf8')));
    return { meta: reader.readMeta(id), events: reader.readEvents(id), raw: reader.readRaw(id), messages };
  });
  const json = JSON.stringify({ sessions }).replaceAll('</', '<\\/');
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
  const summary = sessions
    .map((s) => `<div>${esc(s.meta.id)} — ${esc(s.meta.runtime)} ${Object.entries(s.meta.tags).map(([k, v]) => `${esc(k)}=${esc(v)}`).join(' ')}</div>`)
    .join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>agentlens report</title>
<style>
  body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:2rem;max-width:70rem}
  .session{border:1px solid #ccc;border-radius:8px;padding:1rem;margin-bottom:1.5rem}
  .tags span{background:#eee;border-radius:4px;padding:0 .4em;margin-right:.4em}
  details{margin:.5rem 0;border-left:3px solid #ddd;padding-left:.75rem}
  summary{cursor:pointer;font-family:ui-monospace,monospace}
  pre{background:#f6f6f6;padding:.75rem;border-radius:6px;overflow-x:auto;white-space:pre-wrap}
  .msg{margin:.25rem 0}.msg b{text-transform:uppercase;font-size:.8em;color:#666}
  @media(prefers-color-scheme:dark){body{background:#111;color:#ddd}.session{border-color:#333}pre{background:#1c1c1c}.tags span{background:#333}}
</style></head><body>
<h1>agentlens report</h1>
<noscript>${summary}</noscript>
<div id="app"></div>
<script type="application/json" id="lens-data">${json}</script>
<script>
${INLINE_JS}
</script></body></html>`;
}

const INLINE_JS = String.raw`
const data = JSON.parse(document.getElementById('lens-data').textContent);
const app = document.getElementById('app');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pretty = (s) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };
const fmt = (n) => Number(n ?? 0).toLocaleString();
for (const s of data.sessions) {
  const totals = s.events.reduce((t, e) => ({ input: t.input + e.usage.input, output: t.output + e.usage.output, cacheRead: t.cacheRead + e.usage.cacheRead, cacheWrite: t.cacheWrite + e.usage.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const evBySeq = Object.fromEntries(s.events.map((e) => [e.seq, e]));
  const tags = Object.entries(s.meta.tags).map(([k, v]) => '<span>' + esc(k) + '=' + esc(v) + '</span>').join('');
  let pairsHtml = '';
  for (const p of s.raw) {
    const ev = evBySeq[p.seq];
    const usage = ev ? fmt(ev.usage.input + ev.usage.cacheRead + ev.usage.cacheWrite) + ' in / ' + fmt(ev.usage.output) + ' out' : 'no usage';
    let convo = '';
    try {
      const req = JSON.parse(p.request.body);
      if (Array.isArray(req.messages)) {
        convo = '<div class="convo">' + req.messages.map((m) => {
          const content = Array.isArray(m.content)
            ? m.content.map((b) => b.type === 'text' ? esc(b.text) : '[' + esc(b.type) + (b.name ? ': ' + esc(b.name) : '') + ']').join(' ')
            : esc(m.content);
          return '<div class="msg"><b>' + esc(m.role) + '</b> ' + content + '</div>';
        }).join('') + '</div>';
      }
    } catch {}
    pairsHtml += '<details><summary>#' + p.seq + ' ' + esc(p.request.method) + ' ' + esc(p.request.path) +
      ' — ' + (ev ? esc(ev.model) + ', ' : '') + p.response.status + ', ' + p.durationMs + 'ms, ' + usage + '</summary>' +
      convo +
      '<h4>request</h4><pre>' + esc(pretty(p.request.body)) + '</pre>' +
      '<h4>response</h4><pre>' + esc(pretty(p.response.body)) + '</pre></details>';
  }
  let messagesHtml = '';
  if (s.messages && s.messages.length) {
    messagesHtml = '<details open><summary>conversation (' + s.messages.length + ' messages, from runtime session log)</summary>' +
      s.messages.map((m) => '<div class="msg"><b>' + esc(m.role) + '</b> ' + esc(m.text) + '</div>').join('') + '</details>';
  }
  app.insertAdjacentHTML('beforeend',
    '<div class="session"><h2>' + esc(s.meta.id) + '</h2>' +
    '<div class="tags">' + esc(s.meta.runtime) + ' (' + esc(s.meta.capture) + ') ' + tags + '</div>' +
    '<p>' + fmt(totals.input) + ' input, ' + fmt(totals.output) + ' output, ' + fmt(totals.cacheRead) + ' cache-read, ' + fmt(totals.cacheWrite) + ' cache-write tokens — ' + (s.raw.length || s.events.length) + ' requests</p>' +
    messagesHtml + pairsHtml + '</div>');
}
`;

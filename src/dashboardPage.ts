// The dashboard front end: one self-contained page, zero external assets
// (the dashboard must work offline and adds no runtime deps). Served at "/".
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agentlens — live capture</title>
<style>
  :root {
    --paper: #F5F4EF;
    --ink: #20272E;
    --dim: #7C7970;
    --hair: rgba(32, 39, 46, .16);
    --hair-soft: rgba(32, 39, 46, .07);
    --copper: #B4622D;
    --copper-soft: rgba(180, 98, 45, .12);
    --prussian: #33607D;
    --ember: #A33520;
    --grid-minor: rgba(32, 39, 46, .05);
    --grid-major: rgba(32, 39, 46, .1);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #0F1922;
      --ink: #D9E2E9;
      --dim: #8A96A0;
      --hair: rgba(217, 226, 233, .18);
      --hair-soft: rgba(217, 226, 233, .08);
      --copper: #DD9257;
      --copper-soft: rgba(221, 146, 87, .14);
      --prussian: #82B4D2;
      --ember: #E06A50;
      --grid-minor: rgba(217, 226, 233, .05);
      --grid-major: rgba(217, 226, 233, .1);
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { background: var(--paper); }
  body {
    font: 13px/1.6 ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
    -webkit-font-smoothing: antialiased;
  }
  code { font: inherit; color: var(--copper); }
  .page { max-width: 1060px; margin: 0 auto; padding: 28px 24px 64px; }

  /* masthead */
  .masthead { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 28px; }
  .brand { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .probe { width: .6em; height: .6em; border: 2px solid var(--copper); border-radius: 50%; display: inline-block; align-self: center; }
  .wordmark { font-size: 19px; font-weight: 700; letter-spacing: -.02em; }
  .masthead-sub { color: var(--dim); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
  .masthead-live { display: flex; align-items: baseline; gap: 10px; font-size: 12px; }
  .stamp { color: var(--dim); }
  .live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dim); display: inline-block; }
  .live-dot.hot { background: var(--copper); }

  .eyebrow { font-size: 11px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: var(--dim); }
  .rule { display: flex; align-items: center; gap: 12px; }
  .rule::after { content: ""; flex: 1; border-top: 1px solid var(--hair-soft); }

  /* trace — the chart-recorder strip */
  .trace { margin-bottom: 36px; }
  .trace-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 10px; }
  .controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .seg { display: inline-flex; border: 1px solid var(--hair); border-radius: 3px; overflow: hidden; }
  .seg button {
    font: inherit; font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
    color: var(--dim); background: none; border: none; border-right: 1px solid var(--hair);
    padding: 4px 10px; cursor: pointer;
  }
  .seg button:last-child { border-right: none; }
  .seg button.on { background: var(--ink); color: var(--paper); }
  .seg button:focus-visible, #runFilter:focus-visible { outline: 2px solid var(--copper); outline-offset: 1px; }
  #runFilter {
    font: inherit; font-size: 12px; color: var(--ink); background: none;
    border: 1px solid var(--hair); border-radius: 3px; padding: 3px 8px; width: 130px;
  }
  #runFilter::placeholder { color: var(--dim); }
  .strip {
    position: relative; height: 138px;
    border-top: 1px solid var(--hair); border-bottom: 1px solid var(--hair);
    background-image:
      repeating-linear-gradient(to right, var(--grid-major) 0 1px, transparent 1px 48px),
      repeating-linear-gradient(to bottom, var(--grid-major) 0 1px, transparent 1px 48px),
      repeating-linear-gradient(to right, var(--grid-minor) 0 1px, transparent 1px 8px),
      repeating-linear-gradient(to bottom, var(--grid-minor) 0 1px, transparent 1px 8px);
  }
  .strip svg { position: absolute; inset: 0; width: 100%; height: 100%; color: var(--ink); }
  .tr-bar { fill: currentColor; opacity: .78; }
  .tr-now { stroke: var(--copper); stroke-width: 2; }
  .strip-peak { position: absolute; top: 6px; left: 10px; font-size: 10px; color: var(--dim); letter-spacing: .08em; text-transform: uppercase; }
  .strip-now { position: absolute; top: -4px; right: -4px; }
  .pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--copper); display: inline-block; animation: pulse 1.6s ease-out infinite; }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 var(--copper-soft), 0 0 0 0 var(--copper); }
    70% { box-shadow: 0 0 0 9px rgba(0,0,0,0), 0 0 0 4px var(--copper-soft); }
    100% { box-shadow: 0 0 0 0 rgba(0,0,0,0), 0 0 0 0 rgba(0,0,0,0); }
  }
  @media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }
  .strip-empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; background: var(--paper); text-align: center; padding: 0 16px; }
  .strip-empty[hidden] { display: none; }
  .strip-empty-title { font-weight: 700; }
  .strip-empty-sub { color: var(--dim); font-size: 12px; }
  .axis { display: flex; justify-content: space-between; font-size: 10px; color: var(--dim); letter-spacing: .08em; text-transform: uppercase; margin-top: 5px; }
  .axis-now { color: var(--copper); }

  /* meters */
  .meters { display: grid; grid-template-columns: repeat(4, 1fr); margin-bottom: 44px; }
  .meter { padding: 2px 18px; border-left: 1px solid var(--hair-soft); }
  .meter:first-child { border-left: none; padding-left: 0; }
  .meter-val { font-size: 29px; font-weight: 700; letter-spacing: -.02em; line-height: 1.4; }
  .meter-sub { color: var(--dim); font-size: 11px; }

  /* panels + tables */
  .panel { margin-bottom: 40px; }
  .panel h2 { margin-bottom: 12px; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0 44px; }
  .scroll { overflow-x: auto; }
  .t { width: 100%; border-collapse: collapse; }
  .t th {
    font-size: 10px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: var(--dim);
    text-align: left; padding: 0 12px 6px 0; border-bottom: 1px solid var(--hair); white-space: nowrap;
  }
  .t td { padding: 7px 12px 7px 0; border-bottom: 1px solid var(--hair-soft); white-space: nowrap; vertical-align: baseline; }
  .t th.num, .t td.num { text-align: right; }
  .t tr:hover td { background: var(--hair-soft); }
  .tokcell { display: inline-block; min-width: 72px; }
  .bar { display: block; height: 3px; background: var(--copper); opacity: .55; margin-top: 3px; margin-left: auto; }
  .chip { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); border: 1px solid var(--hair); border-radius: 2px; padding: 1px 6px; }
  .chip-codex { border-style: dashed; }
  .dim { color: var(--dim); }
  .bad { color: var(--ember); font-weight: 600; }
  .id { color: var(--prussian); }
  .none { color: var(--dim); padding: 6px 0; }

  /* live sessions */
  .live-row { display: flex; align-items: baseline; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--hair-soft); flex-wrap: wrap; }
  .live-row .pulse { align-self: center; flex: none; }
  .live-argv { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40ch; }
  .live-when { margin-left: auto; color: var(--dim); }

  .foot { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-top: 20px; padding-top: 12px; border-top: 1px solid var(--hair-soft); color: var(--dim); font-size: 11px; }

  .offline {
    position: fixed; top: 0; left: 0; right: 0; z-index: 10;
    background: var(--ember); color: var(--paper); text-align: center;
    font-size: 12px; padding: 6px 16px;
  }
  .offline code { color: inherit; font-weight: 700; }

  @media (max-width: 720px) {
    .meters { grid-template-columns: 1fr 1fr; gap: 18px 0; }
    .meter:nth-child(3) { border-left: none; padding-left: 0; }
    .cols { grid-template-columns: 1fr; }
    .live-when { margin-left: 0; }
  }
</style>
</head>
<body>
<div class="offline" id="offline" hidden>Connection lost — is <code>lens dashboard</code> still running?</div>
<div class="page">
  <header class="masthead">
    <div class="brand">
      <span class="probe" aria-hidden="true"></span>
      <span class="wordmark">agentlens</span>
      <span class="masthead-sub">wire-level capture · local store</span>
    </div>
    <div class="masthead-live">
      <span class="live-dot" id="liveDot" aria-hidden="true"></span>
      <span id="liveCount" aria-live="polite">–</span>
      <span class="stamp" id="stamp"></span>
    </div>
  </header>

  <section class="trace" aria-label="Token trace">
    <div class="trace-head">
      <h2 class="eyebrow">Token trace</h2>
      <div class="controls">
        <div class="seg" role="group" aria-label="Time window">
          <button type="button" data-win="1h">1h</button>
          <button type="button" data-win="24h">24h</button>
          <button type="button" data-win="7d" class="on">7d</button>
          <button type="button" data-win="all">all</button>
        </div>
        <input id="runFilter" type="search" placeholder="run tag" aria-label="Filter by run tag" spellcheck="false">
      </div>
    </div>
    <div class="strip">
      <svg id="traceSvg" viewBox="0 0 1000 130" preserveAspectRatio="none" aria-hidden="true"></svg>
      <div class="strip-peak" id="tracePeak"></div>
      <div class="strip-now" id="stripNow" hidden><span class="pulse"></span></div>
      <div class="strip-empty" id="stripEmpty" hidden>
        <p class="strip-empty-title" id="emptyTitle">No sessions captured yet</p>
        <p id="emptyCmd"><code>lens run -- claude -p "hi"</code></p>
        <p class="strip-empty-sub" id="emptySub">Wrapped runs appear here live. <code>lens import</code> backfills past sessions.</p>
      </div>
    </div>
    <div class="axis"><span id="axisStart"></span><span class="axis-now">now</span></div>
  </section>

  <section class="meters" aria-label="Totals for the selected window">
    <div class="meter"><div class="eyebrow">Sessions</div><div class="meter-val" id="mSessions">–</div><div class="meter-sub" id="mSessionsSub">captured in window</div></div>
    <div class="meter"><div class="eyebrow">Tokens</div><div class="meter-val" id="mTokens">–</div><div class="meter-sub">input + output + cache</div></div>
    <div class="meter"><div class="eyebrow">Est. cost</div><div class="meter-val" id="mCost">–</div><div class="meter-sub" id="mCostSub">from model price table</div></div>
    <div class="meter"><div class="eyebrow">Live now</div><div class="meter-val" id="mLive">–</div><div class="meter-sub">sessions in flight</div></div>
  </section>

  <section class="panel">
    <h2 class="eyebrow rule">Live sessions</h2>
    <div id="active"></div>
  </section>

  <div class="cols">
    <section class="panel">
      <h2 class="eyebrow rule">By agent</h2>
      <div class="scroll" id="byAgent"></div>
    </section>
    <section class="panel">
      <h2 class="eyebrow rule">By model</h2>
      <div class="scroll" id="byModel"></div>
    </section>
  </div>

  <section class="panel">
    <h2 class="eyebrow rule">Recent sessions</h2>
    <div class="scroll" id="recent"></div>
  </section>

  <footer class="foot">
    <span>local store · polls every 2s</span>
    <span id="unpriced"></span>
  </footer>
</div>
<script>
var state = { win: '7d', run: '' };
var WIN_MS = { '1h': 3600000, '24h': 86400000, '7d': 604800000 };

function el(id) { return document.getElementById(id); }
function esc(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
function tokTotal(t) { return (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0); }
function fmtTok(n) {
  n = Number(n || 0);
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\\.0$/, '') + 'k';
  return String(n);
}
function fmtUsd(n) {
  n = Number(n || 0);
  if (n === 0) return '$0.00';
  if (n < 0.005) return '<$0.01';
  return '$' + n.toFixed(2);
}
function relTime(iso) {
  var s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function fmtDur(startIso, endIso) {
  var ms = Date.parse(endIso) - Date.parse(startIso);
  if (!(ms >= 0)) return '–';
  var s = Math.round(ms / 1000);
  if (s < 1) return '<1s';
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}
function shortModel(m) { return String(m).replace(/^claude-/, ''); }
function fmtClock(d) {
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function tagStr(tags) {
  var ks = Object.keys(tags || {});
  if (!ks.length) return 'untagged';
  return ks.map(function (k) { return k + '=' + tags[k]; }).join(' ');
}

function table(headers, rows) {
  var h = '<table class="t"><thead><tr>';
  headers.forEach(function (col) { h += '<th' + (col.num ? ' class="num"' : '') + '>' + esc(col.label) + '</th>'; });
  h += '</tr></thead><tbody>';
  rows.forEach(function (r) {
    h += '<tr>';
    r.forEach(function (cell, i) { h += '<td' + (headers[i].num ? ' class="num"' : '') + '>' + cell + '</td>'; });
    h += '</tr>';
  });
  return h + '</tbody></table>';
}
function tokCell(n, max) {
  var pct = max > 0 ? Math.max(2, Math.round(n / max * 100)) : 0;
  return '<span class="tokcell">' + fmtTok(n) + '<span class="bar" style="width:' + pct + '%"></span></span>';
}
function chip(runtime) {
  return '<span class="chip' + (runtime === 'codex' ? ' chip-codex' : '') + '">' + esc(runtime) + '</span>';
}

function renderTrace(data) {
  var svg = el('traceSvg');
  var sessions = data.recent;
  var empty = !sessions.length && !data.active.length;
  el('stripEmpty').hidden = !empty;
  if (empty) {
    var filtered = state.win !== 'all' || state.run;
    el('emptyTitle').textContent = filtered ? 'Nothing in this window' : 'No sessions captured yet';
    el('emptyCmd').hidden = filtered;
    el('emptySub').hidden = filtered;
    svg.innerHTML = '';
    el('tracePeak').textContent = '';
    el('axisStart').textContent = '';
    return;
  }
  var now = Date.now();
  var winMs = WIN_MS[state.win];
  if (!winMs) {
    var earliest = now - 3600000;
    sessions.forEach(function (s) {
      var t = Date.parse(s.startedAt);
      if (t < earliest) earliest = t;
    });
    winMs = (now - earliest) * 1.05;
  }
  var N = 120;
  var buckets = new Array(N).fill(0);
  sessions.forEach(function (s) {
    var t = Date.parse(s.startedAt);
    var i = Math.floor((t - (now - winMs)) / winMs * N);
    if (i >= N) i = N - 1;
    if (i >= 0) buckets[i] += tokTotal(s.totals);
  });
  var max = Math.max.apply(null, buckets);
  var bw = 1000 / N;
  var html = '';
  buckets.forEach(function (b, i) {
    if (!b) return;
    var h = Math.max(3, Math.sqrt(b / max) * 124);
    html += '<rect class="tr-bar" x="' + (i * bw + bw * 0.14).toFixed(1) + '" y="' + (130 - h).toFixed(1) +
      '" width="' + (bw * 0.72).toFixed(1) + '" height="' + h.toFixed(1) + '"><title>' + fmtTok(b) + ' tok</title></rect>';
  });
  html += '<line class="tr-now" x1="999" y1="0" x2="999" y2="130"></line>';
  svg.innerHTML = html;
  el('tracePeak').textContent = max > 0 ? 'peak ' + fmtTok(max) : '';
  var start = new Date(now - winMs);
  el('axisStart').textContent = winMs >= 2 * 86400000
    ? start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : fmtClock(start).slice(0, 5);
}

function render(data) {
  el('offline').hidden = true;
  el('stamp').textContent = fmtClock(new Date());
  var live = data.summary.active;
  el('liveCount').textContent = live + ' live';
  el('liveDot').className = 'live-dot' + (live ? ' hot' : '');
  el('stripNow').hidden = !live;
  document.title = (live ? '\\u25CF ' + live + ' live — ' : '') + 'agentlens — live capture';

  el('mSessions').textContent = data.summary.sessions;
  el('mSessionsSub').textContent = data.summary.totals.requests + ' model calls';
  el('mTokens').textContent = fmtTok(tokTotal(data.summary.totals));
  el('mCost').textContent = fmtUsd(data.summary.costUsd);
  el('mCostSub').textContent = data.summary.unpricedEvents
    ? data.summary.unpricedEvents + ' calls unpriced'
    : 'from model price table';
  el('mLive').textContent = live;

  el('active').innerHTML = data.active.length
    ? data.active.map(function (m) {
        return '<div class="live-row"><span class="pulse"></span>' +
          '<span class="id">' + esc(m.id) + '</span>' +
          chip(m.runtime) +
          '<span class="dim">' + esc(tagStr(m.tags)) + '</span>' +
          '<span class="live-argv" title="' + esc((m.argv || []).join(' ')) + '">' + esc((m.argv || []).join(' ')) + '</span>' +
          '<span class="live-when">started ' + esc(relTime(m.startedAt)) + '</span></div>';
      }).join('')
    : '<p class="none">None right now. Wrap a run — <code>lens run -- claude -p "…"</code> — and it appears here within 2s.</p>';

  var maxAgent = Math.max.apply(null, [0].concat(data.byAgent.map(function (r) { return tokTotal(r.totals); })));
  el('byAgent').innerHTML = data.byAgent.length
    ? table(
        [{ label: 'agent' }, { label: 'sessions', num: true }, { label: 'tokens', num: true }, { label: 'est. cost', num: true }],
        data.byAgent.map(function (r) {
          return [esc(r.key), String(r.sessions), tokCell(tokTotal(r.totals), maxAgent), fmtUsd(r.costUsd)];
        }))
    : '<p class="none">No sessions in this window.</p>';

  var maxModel = Math.max.apply(null, [0].concat(data.byModel.map(function (r) { return tokTotal(r.totals); })));
  el('byModel').innerHTML = data.byModel.length
    ? table(
        [{ label: 'model' }, { label: 'calls', num: true }, { label: 'tokens', num: true }, { label: 'est. cost', num: true }],
        data.byModel.map(function (r) {
          return ['<span title="' + esc(r.key) + '">' + esc(shortModel(r.key)) + '</span>', String(r.totals.requests), tokCell(tokTotal(r.totals), maxModel), fmtUsd(r.costUsd)];
        }))
    : '<p class="none">No sessions in this window.</p>';

  el('recent').innerHTML = data.recent.length
    ? table(
        [{ label: 'session' }, { label: 'agent' }, { label: 'runtime' }, { label: 'model' },
         { label: 'tokens', num: true }, { label: 'est. cost', num: true }, { label: 'duration', num: true },
         { label: 'started', num: true }, { label: 'exit', num: true }],
        data.recent.map(function (e) {
          var models = (e.models || []).map(shortModel);
          var modelLabel = models.length > 1 ? models[0] + ' +' + (models.length - 1) : (models[0] || '–');
          return [
            '<span class="id" title="' + esc(e.id) + '">' + esc(e.id.length > 18 ? e.id.slice(0, 17) + '…' : e.id) + '</span>',
            esc(e.tags.agent || '–'),
            chip(e.runtime),
            '<span title="' + esc((e.models || []).join(', ')) + '">' + esc(modelLabel) + '</span>',
            fmtTok(tokTotal(e.totals)),
            fmtUsd(e.costUsd),
            fmtDur(e.startedAt, e.endedAt),
            esc(relTime(e.startedAt)),
            e.exitCode === 0 ? '<span class="dim">ok</span>' : '<span class="bad">exit ' + esc(e.exitCode) + '</span>',
          ];
        }))
    : '<p class="none">No finished sessions in this window.</p>';

  el('unpriced').textContent = data.summary.unpricedEvents
    ? data.summary.unpricedEvents + ' calls excluded from cost — model not in price table (~/.agent-obs/pricing.json)'
    : '';

  renderTrace(data);
}

function tick() {
  var q = [];
  if (state.win !== 'all') q.push('since=' + state.win);
  if (state.run) q.push('run=' + encodeURIComponent(state.run));
  fetch('/api/data' + (q.length ? '?' + q.join('&') : ''))
    .then(function (r) { return r.json(); })
    .then(render)
    .catch(function () { el('offline').hidden = false; });
}

document.querySelectorAll('.seg button').forEach(function (b) {
  b.addEventListener('click', function () {
    state.win = b.dataset.win;
    document.querySelectorAll('.seg button').forEach(function (x) { x.className = x === b ? 'on' : ''; });
    tick();
  });
});
var runDebounce;
el('runFilter').addEventListener('input', function () {
  clearTimeout(runDebounce);
  runDebounce = setTimeout(function () { state.run = el('runFilter').value.trim(); tick(); }, 250);
});

tick();
setInterval(tick, 2000);
</script>
</body>
</html>
`;

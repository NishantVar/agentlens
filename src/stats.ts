import { StoreReader } from './store.js';
import { filterIndex, groupBy, parseSince, type Filter, type GroupRow } from './query.js';
import { costUsd, loadPricing, priceFor } from './pricing.js';
import { resolveTags } from './tags.js';
import { fmtTokens, renderTable } from './table.js';
import type { IndexEntry, Runtime } from './types.js';

export interface StatsOptions { by?: string; tag: string[]; since?: string; runtime?: string; json?: boolean }
export interface SessionsOptions { tag: string[]; since?: string; json?: boolean }

function buildFilter(tag: string[], since?: string, runtime?: string): Filter {
  return {
    tags: resolveTags(tag, undefined),
    since: since ? parseSince(since) : undefined,
    runtime: runtime as Runtime | undefined,
  };
}

interface CostedRow extends GroupRow { costUsd: number }

function costRows(rows: GroupRow[], by: string, entries: IndexEntry[], reader: StoreReader): { rows: CostedRow[]; unknown: number } {
  const pricing = loadPricing();
  let unknown = 0;
  // Build per-group cost from events (events carry model, the pricing unit).
  const groupCost = new Map<string, number>();
  for (const e of entries) {
    for (const ev of reader.readEvents(e.id)) {
      const key = by === '(all)' ? '(all)'
        : by === 'model' ? ev.model
        : by === 'runtime' ? e.runtime
        : (e.tags[by] ?? '(untagged)');
      const p = priceFor(ev.model, pricing);
      if (!p) { unknown++; continue; }
      groupCost.set(key, (groupCost.get(key) ?? 0) + costUsd(ev.usage, p));
    }
  }
  return { rows: rows.map((r) => ({ ...r, costUsd: groupCost.get(r.key) ?? 0 })), unknown };
}

export function statsCommand(opts: StatsOptions, reader: StoreReader = new StoreReader()): string {
  const entries = filterIndex(reader.listIndex(), buildFilter(opts.tag, opts.since, opts.runtime));
  const by = opts.by ?? 'runtime';
  const grouped = opts.by ? groupBy(entries, by, reader) : [{
    key: '(all)', sessions: entries.length,
    totals: entries.reduce((t, e) => ({
      input: t.input + e.totals.input, output: t.output + e.totals.output,
      cacheRead: t.cacheRead + e.totals.cacheRead, cacheWrite: t.cacheWrite + e.totals.cacheWrite,
      reasoning: t.reasoning + e.totals.reasoning, requests: t.requests + e.totals.requests,
    }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0 }),
  }];
  const { rows, unknown } = costRows(grouped, opts.by ?? '(all)', entries, reader);
  if (opts.json) return JSON.stringify({ rows, generatedAt: new Date().toISOString() }, null, 2);
  const table = renderTable(
    ['KEY', 'SESSIONS', 'REQUESTS', 'INPUT', 'OUTPUT', 'CACHE RD', 'CACHE WR', 'COST(USD)'],
    rows.map((r) => [r.key, String(r.sessions), String(r.totals.requests), fmtTokens(r.totals.input), fmtTokens(r.totals.output), fmtTokens(r.totals.cacheRead), fmtTokens(r.totals.cacheWrite), r.costUsd.toFixed(2)]),
  );
  return unknown > 0 ? `${table}\n* cost excludes ${unknown} events with unknown model pricing` : table;
}

export function sessionsCommand(opts: SessionsOptions, reader: StoreReader = new StoreReader()): string {
  const entries = filterIndex(reader.listIndex(), buildFilter(opts.tag, opts.since))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (opts.json) return JSON.stringify(entries, null, 2);
  return renderTable(
    ['ID', 'STARTED', 'RUNTIME', 'TAGS', 'REQUESTS', 'TOKENS', 'EXIT'],
    entries.map((e) => [
      e.id, e.startedAt, e.runtime,
      Object.entries(e.tags).map(([k, v]) => `${k}=${v}`).join(' ') || '-',
      String(e.totals.requests),
      fmtTokens(e.totals.input + e.totals.output + e.totals.cacheRead + e.totals.cacheWrite),
      String(e.exitCode),
    ]),
  );
}

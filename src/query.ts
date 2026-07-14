import { StoreReader } from './store.js';
import { addUsage, emptyUsage } from './types.js';
import type { IndexEntry, Runtime, SessionTotals } from './types.js';

export interface Filter { tags?: Record<string, string>; since?: Date; runtime?: Runtime }

export function parseSince(s: string): Date {
  const m = /^(\d+)([dhm])$/.exec(s);
  if (!m) throw new Error(`invalid --since "${s}": use e.g. 7d, 24h, 30m`);
  const mult = { d: 86400_000, h: 3600_000, m: 60_000 }[m[2] as 'd' | 'h' | 'm'];
  return new Date(Date.now() - Number(m[1]) * mult);
}

export function filterIndex(entries: IndexEntry[], f: Filter): IndexEntry[] {
  return entries.filter((e) => {
    if (f.runtime && e.runtime !== f.runtime) return false;
    if (f.since && new Date(e.startedAt) < f.since) return false;
    for (const [k, v] of Object.entries(f.tags ?? {})) if (e.tags[k] !== v) return false;
    return true;
  });
}

export type GroupKey = 'runtime' | 'model' | string;
export interface GroupRow { key: string; sessions: number; totals: SessionTotals }

const weight = (t: SessionTotals) => t.input + t.cacheRead + t.cacheWrite + t.output;

export function groupBy(entries: IndexEntry[], key: GroupKey, reader: StoreReader): GroupRow[] {
  const buckets = new Map<string, GroupRow>();
  const add = (k: string, totals: SessionTotals) => {
    const row = buckets.get(k) ?? { key: k, sessions: 0, totals: { ...emptyUsage(), requests: 0 } };
    row.sessions += 1;
    row.totals = { ...addUsage(row.totals, totals), requests: row.totals.requests + totals.requests };
    buckets.set(k, row);
  };
  for (const e of entries) {
    if (key === 'model') {
      const perModel = new Map<string, SessionTotals>();
      for (const ev of reader.readEvents(e.id)) {
        const t = perModel.get(ev.model) ?? { ...emptyUsage(), requests: 0 };
        perModel.set(ev.model, { ...addUsage(t, ev.usage), requests: t.requests + 1 });
      }
      for (const [m, t] of perModel) add(m, t);
    } else if (key === 'runtime') {
      add(e.runtime, e.totals);
    } else {
      add(e.tags[key] ?? '(untagged)', e.totals);
    }
  }
  return [...buckets.values()].sort((a, b) => weight(b.totals) - weight(a.totals));
}

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { StoreReader } from './store.js';
import { filterIndex, groupBy, parseSince } from './query.js';
import { costUsd, loadPricing, priceFor, type ModelPrice } from './pricing.js';
import { addUsage, emptyUsage } from './types.js';
import type { SessionTotals } from './types.js';
import { PAGE } from './dashboardPage.js';

export interface DashboardHandle { origin: string; close(): Promise<void> }

interface ModelSlice { totals: SessionTotals; cost: number }
interface SessionBreakdown { cost: number; unpriced: number; perModel: Map<string, ModelSlice> }

function breakdown(id: string, reader: StoreReader, pricing: Record<string, ModelPrice>): SessionBreakdown {
  const perModel = new Map<string, ModelSlice>();
  let cost = 0; let unpriced = 0;
  for (const ev of reader.readEvents(id)) {
    const slice = perModel.get(ev.model) ?? { totals: { ...emptyUsage(), requests: 0 }, cost: 0 };
    slice.totals = { ...addUsage(slice.totals, ev.usage), requests: slice.totals.requests + 1 };
    const p = priceFor(ev.model, pricing);
    if (p) { const c = costUsd(ev.usage, p); slice.cost += c; cost += c; } else { unpriced++; }
    perModel.set(ev.model, slice);
  }
  return { cost, unpriced, perModel };
}

export function startDashboard(port = 4040, reader: StoreReader = new StoreReader()): Promise<DashboardHandle> {
  const pricing = loadPricing();
  // Finalized sessions are immutable, so their cost breakdown is memoized across polls.
  const memo = new Map<string, SessionBreakdown>();
  const forSession = (id: string): SessionBreakdown => {
    let b = memo.get(id);
    if (!b) { b = breakdown(id, reader, pricing); memo.set(id, b); }
    return b;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/data') {
      try {
        const run = url.searchParams.get('run') ?? undefined;
        let since: Date | undefined;
        try { since = parseSince(url.searchParams.get('since') ?? ''); } catch { since = undefined; }
        const filter = { tags: run ? { run } : undefined, since };
        const index = filterIndex(reader.listIndex(), filter);
        const active = reader.listActive().filter((m) => !run || m.tags.run === run);

        const summaryTotals = { ...emptyUsage(), requests: 0 };
        let summaryCost = 0; let unpricedEvents = 0;
        const agentCost = new Map<string, number>();
        const modelRows = new Map<string, { sessions: number; totals: SessionTotals; costUsd: number }>();
        for (const e of index) {
          const b = forSession(e.id);
          summaryCost += b.cost; unpricedEvents += b.unpriced;
          Object.assign(summaryTotals, { ...addUsage(summaryTotals, e.totals), requests: summaryTotals.requests + e.totals.requests });
          const agentKey = e.tags.agent ?? '(untagged)';
          agentCost.set(agentKey, (agentCost.get(agentKey) ?? 0) + b.cost);
          for (const [model, slice] of b.perModel) {
            const row = modelRows.get(model) ?? { sessions: 0, totals: { ...emptyUsage(), requests: 0 }, costUsd: 0 };
            row.sessions += 1;
            row.totals = { ...addUsage(row.totals, slice.totals), requests: row.totals.requests + slice.totals.requests };
            row.costUsd += slice.cost;
            modelRows.set(model, row);
          }
        }

        const weight = (t: SessionTotals) => t.input + t.output + t.cacheRead + t.cacheWrite;
        const byAgent = groupBy(index, 'agent', reader).map((r) => ({ ...r, costUsd: agentCost.get(r.key) ?? 0 }));
        const byModel = [...modelRows.entries()]
          .map(([key, r]) => ({ key, ...r }))
          .sort((a, b) => weight(b.totals) - weight(a.totals));
        const recent = [...index]
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
          .slice(0, 50)
          .map((e) => ({ ...e, costUsd: forSession(e.id).cost }));
        const summary = {
          sessions: index.length, active: active.length,
          totals: summaryTotals, costUsd: summaryCost, unpricedEvents,
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ generatedAt: new Date().toISOString(), summary, active, byAgent, byModel, recent }));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
    } else if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
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

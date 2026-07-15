import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { addUsage, emptyUsage } from './types.js';
import type { IndexEntry, NormalizedEvent, RawPair, SessionMeta } from './types.js';

export function storeRoot(): string {
  return process.env.AGENTLENS_HOME ?? join(homedir(), '.agent-obs');
}

export function newSessionId(): string {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  return `${ts}-${randomBytes(2).toString('hex')}`;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* skip corrupt line */ }
  }
  return out;
}

export class SessionWriter {
  readonly id: string;
  private dir: string;
  private meta: SessionMeta;
  constructor(private root: string, meta: SessionMeta) {
    this.id = meta.id;
    this.meta = meta;
    mkdirSync(join(root, 'sessions'), { recursive: true });
    chmodSync(root, 0o700);
    this.dir = join(root, 'sessions', meta.id);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, 'meta.json'), JSON.stringify(meta, null, 2));
  }
  appendRaw(pair: RawPair): void {
    appendFileSync(join(this.dir, 'raw.jsonl'), JSON.stringify(pair) + '\n');
  }
  appendEvent(ev: NormalizedEvent): void {
    appendFileSync(join(this.dir, 'events.jsonl'), JSON.stringify(ev) + '\n');
  }
  finalize(exitCode: number, extra?: { endedAt?: string; nativeSessionIds?: string[] }): IndexEntry {
    const endedAt = extra?.endedAt ?? new Date().toISOString();
    const nativeSessionIds = extra?.nativeSessionIds ?? this.meta.nativeSessionIds;
    this.meta = { ...this.meta, endedAt, exitCode, nativeSessionIds };
    writeFileSync(join(this.dir, 'meta.json'), JSON.stringify(this.meta, null, 2));
    const events = readJsonl<NormalizedEvent>(join(this.dir, 'events.jsonl'));
    let totals = emptyUsage();
    const models = new Set<string>();
    for (const e of events) { totals = addUsage(totals, e.usage); models.add(e.model); }
    const entry: IndexEntry = {
      id: this.id, runtime: this.meta.runtime, tags: this.meta.tags,
      models: [...models], startedAt: this.meta.startedAt, endedAt, exitCode,
      totals: { ...totals, requests: events.length },
      nativeSessionIds,
    };
    appendFileSync(join(this.root, 'index.jsonl'), JSON.stringify(entry) + '\n');
    return entry;
  }
}

export class StoreReader {
  constructor(private root: string = storeRoot()) {}
  listIndex(): IndexEntry[] { return readJsonl<IndexEntry>(join(this.root, 'index.jsonl')); }
  readMeta(id: string): SessionMeta {
    return JSON.parse(readFileSync(join(this.root, 'sessions', id, 'meta.json'), 'utf8'));
  }
  readEvents(id: string): NormalizedEvent[] {
    return readJsonl<NormalizedEvent>(join(this.root, 'sessions', id, 'events.jsonl'));
  }
  readRaw(id: string): RawPair[] {
    return readJsonl<RawPair>(join(this.root, 'sessions', id, 'raw.jsonl'));
  }
  listActive(): SessionMeta[] {
    const dir = join(this.root, 'sessions');
    if (!existsSync(dir)) return [];
    const out: SessionMeta[] = [];
    for (const id of readdirSync(dir)) {
      try {
        const m = this.readMeta(id);
        if (!m.endedAt) out.push(m);
      } catch { /* skip */ }
    }
    return out;
  }
}

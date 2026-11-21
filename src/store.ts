import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { addUsage, emptyUsage } from './types.js';
import { packBody, unpackBody } from './blobs.js';
import type { IndexEntry, NormalizedEvent, RawPair, SessionMeta } from './types.js';

export function storeRoot(): string {
  return process.env.AGENTLENS_HOME ?? join(homedir(), '.agent-obs');
}

export function newSessionId(): string {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  return `${ts}-${randomBytes(2).toString('hex')}`;
}

// Reads in chunks: legacy raw.jsonl files can exceed V8's max string length,
// so slurping the whole file isn't an option.
export function forEachLine(path: string, fn: (line: string) => void): void {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let parts: Buffer[] = [];
    let n: number;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) {
      let start = 0;
      for (let i = buf.indexOf(10, 0); i !== -1 && i < n; i = buf.indexOf(10, start)) {
        parts.push(buf.subarray(start, i));
        fn(Buffer.concat(parts).toString('utf8'));
        parts = [];
        start = i + 1;
      }
      if (start < n) parts.push(Buffer.from(buf.subarray(start, n)));
    }
    if (parts.length) fn(Buffer.concat(parts).toString('utf8'));
  } finally { closeSync(fd); }
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  forEachLine(path, (line) => {
    if (!line.trim()) return;
    try { out.push(JSON.parse(line) as T); } catch { /* skip corrupt line */ }
  });
  return out;
}

// On disk a raw line's request may carry `packed: true`, meaning its body holds
// refs into the session's blobs.jsonl (see blobs.ts). Lines without it are
// plain — every legacy line, and any body that couldn't be packed exactly.
type StoredPair = RawPair & { request: RawPair['request'] & { packed?: true } };

export function packPair(pair: RawPair, seen: Set<string>, emit: (h: string, v: unknown) => void): StoredPair {
  const packed = packBody(pair.request.body, seen, emit);
  return packed === null ? pair : { ...pair, request: { ...pair.request, body: packed, packed: true } };
}

export function readBlobs(dir: string): Map<string, unknown> {
  const blobs = new Map<string, unknown>();
  for (const b of readJsonl<{ h: string; v: unknown }>(join(dir, 'blobs.jsonl'))) blobs.set(b.h, b.v);
  return blobs;
}

export function unpackPair(p: StoredPair, blobs: Map<string, unknown>): RawPair {
  if (!p.request?.packed) return p;
  const { packed: _, ...request } = p.request;
  try { return { ...p, request: { ...request, body: unpackBody(request.body, (h) => blobs.get(h)) } }; }
  catch { return { ...p, request }; }
}

export class SessionWriter {
  readonly id: string;
  private dir: string;
  private meta: SessionMeta;
  private seenBlobs = new Set<string>();
  constructor(private root: string, meta: SessionMeta) {
    this.id = meta.id;
    this.meta = meta;
    mkdirSync(join(root, 'sessions'), { recursive: true });
    chmodSync(root, 0o700);
    this.dir = join(root, 'sessions', meta.id);
    this.ensureDir();
  }
  // A long-lived session can have its dir removed underneath it (an archive or
  // cleanup sweep). Recreate it rather than failing every later append; the
  // earlier records are gone from here, but capture resumes.
  private ensureDir(): void {
    if (existsSync(this.dir)) return;
    this.seenBlobs.clear();  // blobs.jsonl went with the dir
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, 'meta.json'), JSON.stringify(this.meta, null, 2));
  }
  appendRaw(pair: RawPair): void {
    this.ensureDir();
    let stored: StoredPair = pair;
    try {
      const newBlobs: string[] = [];
      stored = packPair(pair, this.seenBlobs, (h, v) => { newBlobs.push(JSON.stringify({ h, v })); });
      // Blobs land before the line that refs them.
      if (newBlobs.length) appendFileSync(join(this.dir, 'blobs.jsonl'), newBlobs.join('\n') + '\n');
    } catch (e) {
      console.error(`agentlens: blob packing failed, storing body verbatim: ${(e as Error).message}`);
      stored = pair;
    }
    appendFileSync(join(this.dir, 'raw.jsonl'), JSON.stringify(stored) + '\n');
  }
  appendEvent(ev: NormalizedEvent): void {
    this.ensureDir();
    appendFileSync(join(this.dir, 'events.jsonl'), JSON.stringify(ev) + '\n');
  }
  finalize(exitCode: number, extra?: { endedAt?: string; nativeSessionIds?: string[] }): IndexEntry {
    const endedAt = extra?.endedAt ?? new Date().toISOString();
    const nativeSessionIds = extra?.nativeSessionIds ?? this.meta.nativeSessionIds;
    this.meta = { ...this.meta, endedAt, exitCode, nativeSessionIds };
    this.ensureDir();
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
    const dir = join(this.root, 'sessions', id);
    const lines = readJsonl<StoredPair>(join(dir, 'raw.jsonl'));
    if (!lines.some((p) => p.request?.packed)) return lines;
    const blobs = readBlobs(dir);
    return lines.map((p) => unpackPair(p, blobs));
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

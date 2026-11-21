import { createHash } from 'node:crypto';

// Agent request bodies are mostly repetition: every call resends the full tool
// list, the system prompt, and the whole conversation so far. Packing swaps
// those values for content-hash refs so each distinct one is stored once per
// session (in blobs.jsonl); unpacking restores the original body byte-for-byte.

const REF = '$blob';
const MIN_BLOB = 64;  // below this a ref saves nothing

type Json = unknown;

const hashOf = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

function isRef(v: Json): v is { [REF]: string } {
  return !!v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).length === 1 && typeof (v as Record<string, unknown>)[REF] === 'string';
}

// Returns the packed body, or null when the body isn't worth packing or can't
// be reproduced exactly (callers then store it verbatim). `emit` is called for
// each value not already in `seen`, before the packed body is returned.
export function packBody(body: string, seen: Set<string>, emit: (h: string, v: Json) => void): string | null {
  let obj: Record<string, Json>;
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.messages)) return null;
    obj = parsed;
  } catch { return null; }
  // Only compact JSON re-serializes to the same bytes; anything else stays verbatim.
  if (JSON.stringify(obj) !== body) return null;

  const ref = (v: Json): Json => {
    if (isRef(v)) return v;  // a literal look-alike stays inline (never a real message/tool shape)
    const s = JSON.stringify(v);
    if (s.length < MIN_BLOB) return v;
    const h = hashOf(s);
    if (!seen.has(h)) { emit(h, v); seen.add(h); }
    return { [REF]: h };
  };
  const out: Record<string, Json> = { ...obj, messages: (obj.messages as Json[]).map(ref) };
  if ('tools' in obj) out.tools = ref(obj.tools);
  if ('system' in obj) out.system = ref(obj.system);
  return JSON.stringify(out);
}

export function unpackBody(packed: string, lookup: (h: string) => Json | undefined): string {
  const obj = JSON.parse(packed) as Record<string, Json>;
  const deref = (v: Json): Json => (isRef(v) ? (lookup(v[REF]) ?? v) : v);
  const out: Record<string, Json> = { ...obj, messages: (obj.messages as Json[]).map(deref) };
  if ('tools' in obj) out.tools = deref(obj.tools);
  if ('system' in obj) out.system = deref(obj.system);
  return JSON.stringify(out);
}

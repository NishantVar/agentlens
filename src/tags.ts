export function parseTagList(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const seg of s.split(',')) {
    const t = seg.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    if (i <= 0) throw new Error(`invalid tag "${t}": expected key=value`);
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

export function resolveTags(flagTags: string[], env?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of flagTags) Object.assign(out, parseTagList(f));
  if (env) Object.assign(out, parseTagList(env));
  return out;
}

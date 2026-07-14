import type { Usage } from './types.js';

export interface ModelCall { model: string; usage: Usage }

export function parseSse(body: string): { event?: string; data: unknown }[] {
  const out: { event?: string; data: unknown }[] = [];
  for (const block of body.split(/\n\n/)) {
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) continue;
    const raw = dataLines.join('\n');
    if (raw === '[DONE]') continue;
    try { out.push({ event, data: JSON.parse(raw) }); } catch { /* skip */ }
  }
  return out;
}

const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
const isSse = (ct?: string) => !!ct && ct.includes('text/event-stream');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function anthropicUsage(u: Any): Usage {
  return { input: n(u?.input_tokens), output: n(u?.output_tokens), cacheRead: n(u?.cache_read_input_tokens), cacheWrite: n(u?.cache_creation_input_tokens), reasoning: 0 };
}

export function normalizeAnthropic(contentType: string | undefined, body: string): ModelCall | null {
  if (isSse(contentType)) {
    let model = ''; let usage: Usage | null = null;
    for (const { data } of parseSse(body)) {
      const d = data as Any;
      if (d?.type === 'message_start' && d.message?.usage) { model = d.message.model ?? ''; usage = anthropicUsage(d.message.usage); }
      if (d?.type === 'message_delta' && d.usage && usage) usage.output = n(d.usage.output_tokens);
    }
    return usage && model ? { model, usage } : null;
  }
  try {
    const d = JSON.parse(body) as Any;
    if (!d?.usage || !d?.model) return null;
    return { model: d.model, usage: anthropicUsage(d.usage) };
  } catch { return null; }
}

function openaiUsage(u: Any): Usage {
  // Responses API shape
  if (u?.input_tokens !== undefined) {
    const cached = n(u.input_tokens_details?.cached_tokens);
    return { input: n(u.input_tokens) - cached, output: n(u.output_tokens), cacheRead: cached, cacheWrite: 0, reasoning: n(u.output_tokens_details?.reasoning_tokens) };
  }
  // chat.completions shape
  const cached = n(u?.prompt_tokens_details?.cached_tokens);
  return { input: n(u?.prompt_tokens) - cached, output: n(u?.completion_tokens), cacheRead: cached, cacheWrite: 0, reasoning: n(u?.completion_tokens_details?.reasoning_tokens) };
}

export function normalizeOpenAI(contentType: string | undefined, body: string): ModelCall | null {
  if (isSse(contentType)) {
    for (const { event, data } of parseSse(body)) {
      const d = data as Any;
      if (event === 'response.completed' && d?.response?.usage) {
        return { model: d.response.model ?? '', usage: openaiUsage(d.response.usage) };
      }
      if (d?.usage && d?.object === 'chat.completion.chunk') {
        return { model: d.model ?? '', usage: openaiUsage(d.usage) };
      }
    }
    return null;
  }
  try {
    const d = JSON.parse(body) as Any;
    if (!d?.usage) return null;
    return { model: d.model ?? d.response?.model ?? '', usage: openaiUsage(d.usage) };
  } catch { return null; }
}

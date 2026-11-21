import { describe, it, expect } from 'vitest';
import { packBody, unpackBody } from '../src/blobs.js';

const TOOLS = [{ name: 'Bash', description: 'x'.repeat(500), input_schema: { type: 'object' } }];
const SYSTEM = [{ type: 'text', text: 'You are Claude Code. '.repeat(20) }];
const msg = (role: string, text: string) => ({ role, content: [{ type: 'text', text: text.repeat(10) }] });
const body = (messages: unknown[]) => JSON.stringify({ model: 'claude-opus-4', tools: TOOLS, system: SYSTEM, messages, stream: true });

function store() {
  const blobs = new Map<string, unknown>();
  return { blobs, emit: (h: string, v: unknown) => { blobs.set(h, v); } };
}

describe('packBody / unpackBody', () => {
  it('round-trips a messages body byte-for-byte', () => {
    const s = store();
    const b = body([msg('user', 'hello '), msg('assistant', 'hi ')]);
    const packed = packBody(b, new Set(), s.emit);
    expect(packed).not.toBeNull();
    expect(packed!.length).toBeLessThan(b.length);
    expect(unpackBody(packed!, (h) => s.blobs.get(h))).toBe(b);
  });

  it('emits each repeated value only once across a growing conversation', () => {
    const s = store();
    const seen = new Set<string>();
    const emitted: string[] = [];
    const emit = (h: string, v: unknown) => { emitted.push(h); s.emit(h, v); };
    const m1 = msg('user', 'first '), m2 = msg('assistant', 'second '), m3 = msg('user', 'third ');
    packBody(body([m1]), seen, emit);
    packBody(body([m1, m2]), seen, emit);
    packBody(body([m1, m2, m3]), seen, emit);
    // tools + system + 3 distinct messages
    expect(emitted).toHaveLength(5);
    expect(new Set(emitted).size).toBe(5);
  });

  it('declines bodies it cannot reproduce exactly (non-JSON, non-compact, no messages)', () => {
    const s = store();
    expect(packBody('', new Set(), s.emit)).toBeNull();
    expect(packBody('not json', new Set(), s.emit)).toBeNull();
    expect(packBody(JSON.stringify({ messages: [msg('user', 'a ')] }, null, 2), new Set(), s.emit)).toBeNull();
    expect(packBody('{"model":"x"}', new Set(), s.emit)).toBeNull();
    expect(s.blobs.size).toBe(0);
  });

  it('leaves an unresolvable ref in place rather than throwing', () => {
    const s = store();
    const packed = packBody(body([msg('user', 'hello ')]), new Set(), s.emit)!;
    expect(() => unpackBody(packed, () => undefined)).not.toThrow();
  });
});

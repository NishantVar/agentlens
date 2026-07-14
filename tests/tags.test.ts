import { describe, it, expect } from 'vitest';
import { parseTagList, resolveTags } from '../src/tags.js';

describe('parseTagList', () => {
  it('parses comma-separated pairs', () => {
    expect(parseTagList('agent=verifier, run=flux-42')).toEqual({ agent: 'verifier', run: 'flux-42' });
  });
  it('allows = in values', () => {
    expect(parseTagList('note=a=b')).toEqual({ note: 'a=b' });
  });
  it('ignores empty segments', () => {
    expect(parseTagList('a=1,,')).toEqual({ a: '1' });
  });
  it('throws on a segment without =', () => {
    expect(() => parseTagList('agent')).toThrow(/invalid tag/i);
  });
});

describe('resolveTags', () => {
  it('merges flags and env, env wins on collision', () => {
    expect(resolveTags(['agent=cli-flag', 'stage=build'], 'agent=verifier,run=r1'))
      .toEqual({ agent: 'verifier', stage: 'build', run: 'r1' });
  });
  it('works with no env', () => {
    expect(resolveTags(['a=1'], undefined)).toEqual({ a: '1' });
  });
});

import { describe, expect, it } from 'vitest';

import { packSentences } from '../../src/audio/synthesize.js';

describe('packSentences', () => {
  it('joins sentences greedily up to the limit', () => {
    expect(packSentences(['aaa', 'bbb', 'ccc', 'dd'], 7)).toEqual(['aaa bbb', 'ccc dd']);
  });

  it('keeps a sentence at the limit on its own, and measures code points', () => {
    expect(packSentences(['1234567', 'x'], 7)).toEqual(['1234567', 'x']);
    expect(packSentences(['😀😀😀', '😀😀😀'], 7)).toEqual(['😀😀😀 😀😀😀']);
    expect(packSentences([], 7)).toEqual([]);
  });
});

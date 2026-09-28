import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalise } from '../../../src/detection/normalise.js';
import {
  DIGIT_STYLES,
  INVISIBLES,
  obfuscate,
  styleDigits,
} from '../../../src/synthetic/obfuscate.js';
import { createRng } from '../../../src/synthetic/rng.js';
import { assertPropertyQuietly, seedArb } from '../../support/quiet-property.js';

describe('styleDigits', () => {
  it.each([
    ['ascii', 'a 0123456789'],
    ['fullWidth', 'a ０１２３４５６７８９'],
    ['devanagari', 'a ०१२३४५६७८९'],
    ['mathBold', 'a 𝟎𝟏𝟐𝟑𝟒𝟓𝟔𝟕𝟖𝟗'],
  ] as const)('%s', (style, expected) => {
    expect(styleDigits('a 0123456789', style)).toBe(expected);
  });
});

describe('INVISIBLES', () => {
  it('are all Default_Ignorable_Code_Point, so normalisation removes them', () => {
    for (const ch of INVISIBLES) expect(ch).toMatch(/^\p{Default_Ignorable_Code_Point}$/u);
  });
});

describe('obfuscate', () => {
  it('normalises back to the input, and never adds invisibles at either end', () => {
    assertPropertyQuietly(
      fc.property(seedArb, fc.string({ unit: 'grapheme-ascii', maxLength: 30 }), (seed, s) => {
        const out = obfuscate(s, createRng(seed), 0.5);
        const invisible = /\p{Default_Ignorable_Code_Point}/u;
        const edgesClean =
          out === '' || (!invisible.test(out.at(0)!) && !invisible.test(out.at(-1)!));
        return normalise(out).text === s && edgesClean;
      }),
      { numRuns: 1000 },
    );
  });

  it('uses every digit style and inserts invisibles over enough input', () => {
    const out = obfuscate('0123456789'.repeat(20), createRng(7));
    expect(out).toMatch(/[０-９]/u);
    expect(out).toMatch(/[०-९]/u);
    expect(out).toMatch(/[\u{1D7CE}-\u{1D7D7}]/u);
    expect(out).toMatch(/[0-9]/);
    expect(out).toMatch(/\p{Default_Ignorable_Code_Point}/u);
    expect(DIGIT_STYLES).toHaveLength(4);
  });

  it('with probability 0 inserts no invisibles', () => {
    const out = obfuscate('4111111111111111', createRng(8), 0);
    expect(out).not.toMatch(/\p{Default_Ignorable_Code_Point}/u);
  });

  it.each([1, -0.1, Number.NaN])('rejects invisibleProbability %d', (p) => {
    expect(() => obfuscate('1', createRng(9), p)).toThrow(RangeError);
  });
});

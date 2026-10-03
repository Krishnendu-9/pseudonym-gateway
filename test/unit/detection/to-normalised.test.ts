// toNormalised (ADR-037): an original-text span brought into the normalised
// text, read from the same offset map as toOriginal.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalise } from '../../../src/detection/normalise.js';
import { assertPropertyQuietly } from '../../support/quiet-property.js';

const INVISIBLE = /^\p{Default_Ignorable_Code_Point}$/u;

/** True when code unit `i` of `text` belongs to an invisible character (a surrogate pair counts whole). */
function isInvisibleAt(text: string, i: number): boolean {
  const low = i > 0 && /[\uDC00-\uDFFF]/.test(text[i]!) && /[\uD800-\uDBFF]/.test(text[i - 1]!);
  return INVISIBLE.test(String.fromCodePoint(text.codePointAt(low ? i - 1 : i)!));
}

// Pieces chosen to move offsets: expansions (½, U+FDFA), compositions
// (Hangul compatibility jamo, a letter and its accent), precomposed nukta
// letters NFKC splits in two, surrogate pairs and lone halves, full-width
// and Devanagari digits, and every kind of invisible character.
const PIECES = [
  'a',
  'Z',
  ' ',
  '-',
  '.',
  '7',
  '\r\n',
  '\u095B',
  '\u0958',
  'प्रि',
  'ा',
  'e\u0301',
  '\u0301',
  '½',
  '\uFDFA',
  'ㅎ',
  'ㅏ',
  'ㄴ',
  'Ａ',
  '１',
  '४',
  '😀',
  '𝟏',
  '\uD800',
  '\uDC00',
  '\u200B',
  '\u200C',
  '\u200D',
  '\u00AD',
  '\u2060',
  '\uFEFF',
  '\uFE0F',
  '\u202E',
];

const mixedText = fc.array(fc.constantFrom(...PIECES), { maxLength: 40 }).map((p) => p.join(''));

describe('toNormalised: examples', () => {
  it('is the identity on ASCII', () => {
    expect(normalise('Asha Rao').toNormalised({ start: 5, end: 8 })).toEqual({ start: 5, end: 8 });
  });

  it('takes everything an expansion became, from any part of it', () => {
    // "x½y" -> "x1⁄2y": the ½ is three normalised units.
    expect(normalise('x½y').toNormalised({ start: 1, end: 2 })).toEqual({ start: 1, end: 4 });
    expect(normalise('x½y').toNormalised({ start: 2, end: 3 })).toEqual({ start: 4, end: 5 });
  });

  it('takes a composed group whole when the span touches one of its parts', () => {
    // Two compatibility jamo compose into one syllable: one normalised unit.
    const n = normalise('ㅎㅏ!');
    expect(n.text).toBe('하!');
    expect(n.toNormalised({ start: 1, end: 2 })).toEqual({ start: 0, end: 1 });
    expect(n.toNormalised({ start: 2, end: 3 })).toEqual({ start: 1, end: 2 });
  });

  it('shifts past a precomposed nukta letter, which NFKC splits in two', () => {
    // U+095B, precomposed: NFKC gives U+091C U+093C.
    const n = normalise('\u095B आशा');
    expect(n.text.length).toBe('\u095B आशा'.length + 1);
    expect(n.toNormalised({ start: 2, end: 5 })).toEqual({ start: 3, end: 6 });
  });

  it('takes a whole surrogate pair from half of it', () => {
    expect(normalise('a😀b').toNormalised({ start: 2, end: 3 })).toEqual({ start: 1, end: 3 });
  });

  it('has nothing for a span of invisible characters only, between visible ones', () => {
    expect(normalise('a\u200B\u00ADb').toNormalised({ start: 1, end: 3 })).toBeUndefined();
  });

  it('leaves invisible characters at a span edge out, and keeps the inner ones for toOriginal', () => {
    const n = normalise('\u200BAs\u00ADha\u200B');
    const inner = n.toNormalised({ start: 0, end: 7 });
    expect(inner).toEqual({ start: 0, end: 4 });
    expect(n.toOriginal(inner!)).toEqual({ start: 1, end: 6 });
  });

  it('refuses a span that is not one', () => {
    const n = normalise('abc');
    for (const span of [
      { start: -1, end: 1 },
      { start: 0, end: 4 },
      { start: 2, end: 2 },
      { start: 2, end: 1 },
      { start: 0.5, end: 2 },
      { start: 0, end: Number.NaN },
    ]) {
      expect(() => n.toNormalised(span)).toThrow(RangeError);
    }
  });

  it('accepts a span to the very end of the original, past trailing invisibles', () => {
    const n = normalise('ab\u200B');
    expect(n.toNormalised({ start: 0, end: 3 })).toEqual({ start: 0, end: 2 });
    expect(n.toNormalised({ start: 2, end: 3 })).toBeUndefined();
  });
});

describe('toNormalised: properties', () => {
  it('for every offset, toOriginal(toNormalised(i)) covers i, or i is an invisible character', () => {
    assertPropertyQuietly(
      fc.property(mixedText, (text) => {
        const n = normalise(text);
        for (let i = 0; i < text.length; i++) {
          const span = n.toNormalised({ start: i, end: i + 1 });
          if (span === undefined) {
            if (!isInvisibleAt(text, i)) return false;
            continue;
          }
          const back = n.toOriginal(span);
          if (!(back.start <= i && i < back.end)) return false;
        }
        return true;
      }),
      { numRuns: 2_000 },
    );
  });

  it('for any span: every visible unit is covered on the way back, and nothing is taken that the span does not touch', () => {
    const textAndSpan = mixedText
      .filter((text) => text.length > 0)
      .chain((text) =>
        fc
          .tuple(fc.nat(text.length - 1), fc.nat(text.length - 1))
          .map(([a, b]) => ({ text, start: Math.min(a, b), end: Math.max(a, b) + 1 })),
      );
    assertPropertyQuietly(
      fc.property(textAndSpan, ({ text, start, end }) => {
        const n = normalise(text);
        const span = n.toNormalised({ start, end });
        if (span === undefined) {
          for (let i = start; i < end; i++) if (!isInvisibleAt(text, i)) return false;
          return true;
        }
        const back = n.toOriginal(span);
        for (let i = start; i < end; i++) {
          if (!isInvisibleAt(text, i) && !(back.start <= i && i < back.end)) return false;
        }
        // Each normalised unit taken has a source the span touches.
        for (let k = span.start; k < span.end; k++) {
          const source = n.toOriginal({ start: k, end: k + 1 });
          if (!(source.start < end && start < source.end)) return false;
        }
        return true;
      }),
      { numRuns: 2_000 },
    );
  });

  it('agrees with toOriginal the other way round: every normalised unit comes back to itself', () => {
    assertPropertyQuietly(
      fc.property(mixedText, (text) => {
        const n = normalise(text);
        for (let k = 0; k < n.text.length; k++) {
          const there = n.toNormalised(n.toOriginal({ start: k, end: k + 1 }));
          if (there === undefined || !(there.start <= k && k < there.end)) return false;
        }
        return true;
      }),
      { numRuns: 2_000 },
    );
  });
});

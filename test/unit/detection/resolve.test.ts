// resolve.ts as a unit: the containing span, the remainders and the size
// rule (ADR-029), on hand-made candidates over plain strings. The strings
// hold no values; only offsets are compared.

import { describe, expect, it } from 'vitest';
import type { Span } from '../../../src/detection/normalise.js';
import { resolveCandidates, significantSize } from '../../../src/detection/resolve.js';
import type { Detection, DetectionType } from '../../../src/detection/types.js';
import { growthRatio, MAX_GROWTH_RATIO } from '../../support/linear-time.js';

const d = (type: DetectionType, start: number, end: number, validated = true): Detection => ({
  type,
  start,
  end,
  validated,
  context: false,
});
const noWidening = (s: Span): Span => ({ start: s.start, end: s.end });
const spans = (found: readonly Detection[]) =>
  found.map((x) => [x.type, x.start, x.end, x.validated]);

describe('significantSize', () => {
  it('counts letters and digits, not separators or symbols', () => {
    const size = significantSize('ab-12 . @c');
    expect(size({ start: 0, end: 10 })).toBe(5);
    expect(size({ start: 2, end: 3 })).toBe(0);
  });

  it('counts a letter outside the BMP once, from either half', () => {
    const text = `a${String.fromCodePoint(0x10400)}b`; // DESERET CAPITAL LONG I
    const size = significantSize(text);
    expect(size({ start: 0, end: text.length })).toBe(3);
  });
});

describe('the containing span', () => {
  it('replaces every winner a loser wholly contains', () => {
    // "ABCDE1234F.x@example.com": a validated PAN inside an email.
    const text = 'ABCDE1234F.x@example.com';
    const found = resolveCandidates(text, [d('PAN', 0, 10), d('EMAIL', 0, 24, false)], noWidening);
    expect(spans(found)).toEqual([['EMAIL', 0, 24, false]]);
  });

  it('replaces several contained winners at once', () => {
    const text = 'aaaa bbbb cccc dddd';
    const found = resolveCandidates(
      text,
      [d('PHONE', 0, 4), d('PHONE', 5, 9), d('SECRET', 0, 14, false)],
      noWidening,
    );
    expect(spans(found)).toEqual([['SECRET', 0, 14, false]]);
  });

  it('does not replace a winner it only partly covers', () => {
    const text = 'aaaa bbbb cccc';
    const found = resolveCandidates(text, [d('PHONE', 5, 14), d('EMAIL', 0, 9, false)], noWidening);
    expect(found.map((x) => x.type)).toEqual(['EMAIL', 'PHONE']);
    expect(found.at(-1)).toEqual(d('PHONE', 5, 14));
  });

  it('counts as validated when it holds a validated value of its own type', () => {
    const text = '4111 1111 1111 1111 7';
    const found = resolveCandidates(text, [d('CARD', 0, 19), d('CARD', 0, 21, false)], noWidening);
    expect(spans(found)).toEqual([['CARD', 0, 21, true]]);
  });

  it('is never replaced in turn, and a loser touching it replaces nothing', () => {
    // Longest loser first: the EMAIL replaces the PAN. The SECRET wholly
    // contains the PHONE but also touches the EMAIL, so it replaces
    // nothing and only keeps what is left uncovered between them.
    const text = 'aaaaaaaaaaaa bbbbbbb';
    const found = resolveCandidates(
      text,
      [d('PAN', 0, 4), d('EMAIL', 0, 12, false), d('PHONE', 14, 20), d('SECRET', 10, 20, false)],
      noWidening,
    );
    expect(spans(found)).toEqual([
      ['EMAIL', 0, 12, false],
      ['SECRET', 13, 14, false],
      ['PHONE', 14, 20, true],
    ]);
  });
});

describe('remainders', () => {
  it('keeps what a loser leaves uncovered, trimmed at the cut', () => {
    // "<Aadhaar>-name@example.com": the email's local part starts inside it.
    const text = '2345 6789 0123-name@example.com';
    const found = resolveCandidates(
      text,
      [d('AADHAAR', 0, 14), d('EMAIL', 10, 31, false)],
      noWidening,
    );
    expect(spans(found)).toEqual([
      ['AADHAAR', 0, 14, true],
      ['EMAIL', 15, 31, false],
    ]);
  });

  it('keeps the edge of a loser that was not cut, even if it is not a letter or digit', () => {
    const text = '-ab12 3456';
    const found = resolveCandidates(
      text,
      [d('PHONE', 3, 10), d('SECRET', 0, 5, false)],
      noWidening,
    );
    expect(spans(found)).toEqual([
      ['SECRET', 0, 3, false],
      ['PHONE', 3, 10, true],
    ]);
  });

  it('gives each uncovered position to the best-ranked loser covering it', () => {
    const text = 'xxxxxxxxxx';
    const found = resolveCandidates(
      text,
      [d('IP', 0, 4), d('EMAIL', 2, 8, false), d('SECRET', 2, 10, false)],
      noWidening,
    );
    expect(spans(found)).toEqual([
      ['IP', 0, 4, true],
      ['SECRET', 4, 10, false],
    ]);
  });

  it('trims at a cut by whole characters: a letter outside the BMP is kept whole', () => {
    const letter = String.fromCodePoint(0x10400); // DESERET CAPITAL LONG I, two code units
    const text = `ab${letter}-${letter}-wxyz`; // offsets: a0 b1 L2-3 -4 L5-6 -7 w8…
    const found = resolveCandidates(
      text,
      [d('PHONE', 8, 12), d('SECRET', 2, 9, false)],
      noWidening,
    );
    // The SECRET is cut at 8: the "-" before the cut is trimmed, the letter
    // before that is kept, both of its code units.
    expect(spans(found)).toEqual([
      ['SECRET', 2, 7, false],
      ['PHONE', 8, 12, true],
    ]);
  });

  it('keeps the end of a loser that was not cut, even if it is not a letter or digit', () => {
    const text = '1234 ab9-';
    const found = resolveCandidates(text, [d('PHONE', 0, 4), d('SECRET', 2, 9, false)], noWidening);
    expect(spans(found)).toEqual([
      ['PHONE', 0, 4, true],
      ['SECRET', 5, 9, false],
    ]);
  });

  it('drops a remainder with no letter or digit in it', () => {
    const text = 'abcd -- efgh';
    const found = resolveCandidates(text, [d('PHONE', 0, 4), d('SECRET', 2, 8, false)], noWidening);
    expect(spans(found)).toEqual([['PHONE', 0, 4, true]]);
  });

  it('leaves digits that widening will give to a kept detection alone', () => {
    // Two overlapping Aadhaar readings of one 16-digit number: the loser's
    // last group is in the winner's digit run, so widening takes it.
    const text = '2345 6789 0123 4567';
    const widenToAll = (): Span => ({ start: 0, end: text.length });
    const found = resolveCandidates(text, [d('AADHAAR', 0, 14), d('AADHAAR', 5, 19)], widenToAll);
    expect(spans(found)).toEqual([['AADHAAR', 0, 14, true]]);
  });
});

// Linear time (test/support/linear-time.ts): many candidates, each
// containing or overlapping its neighbours.
describe('resolveCandidates: linear time', () => {
  const unit = 'aaaa bbbb ';
  const make = (n: number): string => unit.repeat(Math.ceil(n / unit.length));
  const candidatesFor = (text: string): Detection[] => {
    const out: Detection[] = [];
    for (let at = 0; at + 14 <= text.length; at += 10) {
      out.push(
        d('PHONE', at, at + 4),
        d('EMAIL', at, at + 9, false),
        d('SECRET', at + 2, at + 14, false),
      );
    }
    return out;
  };
  it('paints many losers over one long stretch in linear time', () => {
    // The worst case for the painting: the best-ranked loser paints almost
    // everything, then every other loser starts inside what it painted.
    const make = (n: number): string => 'a'.repeat(n);
    const work = (text: string): number => {
      const n = text.length;
      const losers = [d('SECRET', 0, n - 1, false)];
      for (let at = 1; at < n - 2; at += 4) losers.push(d('EMAIL', at, n - 1, false));
      return resolveCandidates(text, [d('PHONE', n - 2, n), ...losers], noWidening).length;
    };
    expect(growthRatio(make, 20_000, work)).toBeLessThan(MAX_GROWTH_RATIO);
  });

  it('resolves containing and overlapping candidates in linear time', () => {
    const work = (text: string): number =>
      resolveCandidates(text, candidatesFor(text), noWidening).length;
    expect(growthRatio(make, 20_000, work)).toBeLessThan(MAX_GROWTH_RATIO);
  });
});

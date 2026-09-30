// Aadhaar values are generated at run time and never printed (ADR-009):
// assertions compare offsets, and properties return booleans. Hand-written
// Aadhaar-shaped numbers in this file fail the Verhoeff check, so none can be
// a real Aadhaar.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isValidAadhaar } from '../../../src/detection/aadhaar.js';
import { detect } from '../../../src/detection/detect.js';
import { isVerhoeffValid, verhoeffCheckDigit } from '../../../src/detection/verhoeff.js';
import { createRng, type Rng } from '../../../src/synthetic/rng.js';
import { aadhaar, groupDigits } from '../../../src/synthetic/values.js';
import { compose } from '../../support/compose.js';
import { numberAt } from '../../support/number-at.js';
import { assertPropertyQuietly, seedArb } from '../../support/quiet-property.js';

const rng = createRng(20260928);
const valid = (): string => aadhaar(rng);
const spaced = (digits: string, separator = ' '): string =>
  groupDigits(digits, [4, 4, 4], separator);

/** Same digits with the check digit changed: Verhoeff catches every single-digit error. */
const withWrongCheckDigit = (digits: string): string =>
  digits.slice(0, 11) + String((Number(digits[11]) + 1) % 10);

/** Verhoeff-valid, but starting with 0 or 1, which no Aadhaar does. */
const startingWith01 = (r: Rng): string => {
  const payload = String(r.int(0, 1)) + r.digits(10);
  return payload + verhoeffCheckDigit(payload);
};

const aadhaarAt = (span: { start: number; end: number }, validated = true, context = false) => ({
  type: 'AADHAAR',
  ...span,
  validated,
  context,
});

describe('isValidAadhaar', () => {
  it('accepts generated Aadhaar numbers', () => {
    assertPropertyQuietly(fc.property(seedArb, (seed) => isValidAadhaar(aadhaar(createRng(seed)))));
  });

  it('rejects a wrong check digit, a first digit of 0 or 1, and the wrong length', () => {
    assertPropertyQuietly(
      fc.property(seedArb, (seed) => {
        const r = createRng(seed);
        const a = aadhaar(r);
        return (
          !isValidAadhaar(withWrongCheckDigit(a)) &&
          !isValidAadhaar(startingWith01(r)) &&
          !isValidAadhaar(a.slice(1)) &&
          !isValidAadhaar(a + '0')
        );
      }),
    );
  });
});

describe('Aadhaar detection', () => {
  it.each([
    ['spaces', ' '],
    ['hyphens', '-'],
    ['dots', '.'],
    ['no separator', ''],
    ['" - "', ' - '],
  ])('finds a valid Aadhaar written 4-4-4 with %s', (_name, separator) => {
    const { text, spans } = compose`Please verify ${spaced(valid(), separator)} today.`;
    expect(detect(text)).toEqual([aadhaarAt(spans[0]!)]);
  });

  it('finds one written in an unusual grouping, as long as it is the whole number', () => {
    const digits = valid();
    const odd = `${digits.slice(0, 2)} ${digits.slice(2, 7)} ${digits.slice(7)}`;
    const { text, spans } = compose`Ref ${odd} ok`;
    expect(detect(text)).toEqual([aadhaarAt(spans[0]!)]);
  });

  it('records context when a keyword is nearby', () => {
    const { text, spans } = compose`My Aadhaar number is ${spaced(valid())}.`;
    expect(detect(text)).toEqual([aadhaarAt(spans[0]!, true, true)]);
  });

  it('finds a valid Aadhaar at the very start and end of the text', () => {
    const value = spaced(valid());
    expect(detect(value)).toEqual([aadhaarAt({ start: 0, end: value.length })]);
  });

  it('finds an Aadhaar after a row number, and redacts the row number with it (fail closed)', () => {
    // The row number is part of the same run of digit groups, and a value is
    // widened to its whole run so no part of a longer number is left visible.
    const grouped = compose`Row ${`1 ${spaced(valid())}`}`;
    expect(detect(grouped.text)).toEqual([aadhaarAt(grouped.spans[0]!)]);
    const unbroken = compose`Row ${`2 ${valid()}`}`;
    expect(detect(unbroken.text)).toEqual([aadhaarAt(unbroken.spans[0]!)]);
  });

  it('finds two Aadhaar numbers separated only by a comma', () => {
    const { text, spans } = compose`${spaced(valid())},${spaced(valid())}`;
    expect(detect(text)).toEqual([aadhaarAt(spans[0]!), aadhaarAt(spans[1]!)]);
  });

  describe('unvalidated: accepted only with a keyword', () => {
    it('a wrong check digit (a typo) is dropped without context ...', () => {
      expect(detect(`Ref ${spaced(withWrongCheckDigit(valid()))} ok`)).toEqual([]);
    });

    it('... and kept, unvalidated, next to "Aadhaar"', () => {
      const { text, spans } = compose`Aadhaar: ${spaced(withWrongCheckDigit(valid()))}`;
      expect(detect(text)).toEqual([aadhaarAt(spans[0]!, false, true)]);
    });

    it('a first digit of 0 or 1 is dropped without context, and kept next to "UID"', () => {
      const value = spaced(startingWith01(rng));
      expect(detect(`Ref ${value} ok`)).toEqual([]);
      const { text, spans } = compose`UID ${value}`;
      expect(detect(text)).toEqual([aadhaarAt(spans[0]!, false, true)]);
    });

    it('a hand-written example that fails Verhoeff, with a Hindi keyword', () => {
      expect(isVerhoeffValid('234567890123')).toBe(false);
      const { text, spans } = compose`आधार: ${'2345 6789 0123'}`;
      expect(detect(text)).toEqual([aadhaarAt(spans[0]!, false, true)]);
    });
  });

  describe('tricky negatives', () => {
    // These are not Aadhaar numbers, but they are long numbers, so the
    // safety net (ADR-011) redacts them as NUMBER instead.
    it('is not an Aadhaar inside a longer unbroken number (the safety net takes it)', () => {
      const after = compose`Ref ${`${valid()}7`} ok`;
      expect(detect(after.text)).toEqual([numberAt(after.spans[0]!)]);
      const before = compose`Ref ${`7${valid()}`} ok`;
      expect(detect(before.text)).toEqual([numberAt(before.spans[0]!)]);
    });

    it('is not an Aadhaar glued to letters or an underscore (the safety net takes the whole token)', () => {
      const letters = compose`ref: ${`ab${valid()}cd`}`;
      expect(detect(letters.text)).toEqual([numberAt(letters.spans[0]!)]);
      const underscore = compose`${`key_${valid()}`}`;
      expect(detect(underscore.text)).toEqual([numberAt(underscore.spans[0]!)]);
    });

    it('ignores 12 digits after a plus sign (a phone number with its country code)', () => {
      const types = detect(`+${valid()}`).map((d) => d.type);
      expect(types).not.toContain('AADHAAR');
    });

    it('ignores part of a run that is not grouped 4-4-4', () => {
      // "7 NN NNNNNNNNNN": the last two groups hold 12 digits, grouped 2-10.
      const digits = valid();
      const text = `Ref 7 ${digits.slice(0, 2)} ${digits.slice(2)} ok`;
      expect(detect(text).map((d) => d.type)).not.toContain('AADHAAR');
    });

    it('redacts the whole of a 4-4-4-4 number whose 4-4-4 start is a valid Aadhaar (fail closed)', () => {
      // The number fails the card checks, but its first three groups pass the
      // Aadhaar checks. The detection is widened to the whole run, so the
      // last group is not left visible.
      const { text, spans } = compose`Ref ${`${spaced(valid())} 0000`}`;
      expect(detect(text)).toEqual([aadhaarAt(spans[0]!)]);
    });

    it('ignores a valid Aadhaar hidden in a list of two-digit numbers', () => {
      // Without the layout rule, the six pairs in the middle would be a
      // 12-digit window. The whole run (16 digits) is card-shaped but no
      // issuer starts with 1, so nothing is found at all.
      const pairs = valid().match(/../g)!.join(' ');
      expect(detect(`Scores: 11 ${pairs} 11, done`)).toEqual([]);
    });
  });

  it('finds generated Aadhaar numbers in every 4-4-4 separator style', () => {
    assertPropertyQuietly(
      fc.property(seedArb, fc.constantFrom(' ', '-', '.', '', '  '), (seed, separator) => {
        const { text, spans } =
          compose`Sent ${spaced(aadhaar(createRng(seed)), separator)} yesterday`;
        const found = detect(text);
        return (
          found.length === 1 &&
          found[0]!.type === 'AADHAAR' &&
          found[0]!.validated &&
          found[0]!.start === spans[0]!.start &&
          found[0]!.end === spans[0]!.end
        );
      }),
      { numRuns: 1000 },
    );
  });
});

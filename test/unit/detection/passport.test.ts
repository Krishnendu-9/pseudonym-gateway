// Passport numbers (ADR-031): one letter and seven digits, keyword only.
// The shape alone is never enough: model numbers, tickets and invoice codes
// are written the same way.
//
// Numbers are generated at run time and never printed (ADR-009):
// assertions compare offsets and types. Hand-written strings here are
// shapes only (the wrong length, or glued to something).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { detect } from '../../../src/detection/detect.js';
import { passportCandidates } from '../../../src/detection/passport.js';
import { passportNumber } from '../../../src/synthetic/identifiers.js';
import { obfuscate } from '../../../src/synthetic/obfuscate.js';
import { createRng } from '../../../src/synthetic/rng.js';
import { compose } from '../../support/compose.js';
import { growthRatio, MAX_GROWTH_RATIO } from '../../support/linear-time.js';
import { assertPropertyQuietly, seedArb } from '../../support/quiet-property.js';

const rng = createRng(20_261_002);

const spansOf = (text: string): [string, number, number, boolean][] =>
  detect(text).map((d) => [d.type, d.start, d.end, d.validated]);

describe('passport candidates: the shape', () => {
  it('finds one letter and seven digits, in any case, never validated', () => {
    for (const value of [passportNumber(rng), passportNumber(rng).toLowerCase()]) {
      const { text, spans } = compose`ref ${value} ok`;
      expect([...passportCandidates(text)]).toEqual([
        { type: 'PASSPORT', ...spans[0]!, validated: false },
      ]);
    }
  });

  it('takes nothing glued to a letter, digit, mark, underscore or "@" on either side', () => {
    const value = passportNumber(rng);
    for (const glue of ['x', '7', '́', '_', '@']) {
      expect([...passportCandidates(`${glue}${value}`)]).toEqual([]);
      expect([...passportCandidates(`${value}${glue}`)]).toEqual([]);
    }
  });

  it('takes no other length: six or eight digits, two letters', () => {
    for (const text of ['A123456', 'A12345678', 'AB1234567']) {
      expect([...passportCandidates(text)]).toEqual([]);
    }
  });

  it('is found after a slash, a bracket, a quote or a colon', () => {
    const value = passportNumber(rng);
    for (const before of ['/', '(', '"', ':']) {
      expect([...passportCandidates(`${before}${value}`)]).toHaveLength(1);
    }
  });
});

describe('passport numbers in text: only with a keyword', () => {
  it('is redacted next to "passport", before or after it, in any case', () => {
    assertPropertyQuietly(
      fc.property(seedArb, (seed) => {
        const value = passportNumber(createRng(seed));
        return [
          compose`My passport number is ${value}.`,
          compose`PASSPORT NO: ${value}`,
          compose`${value} is the passport I travel on.`,
          compose`मेरा पासपोर्ट नंबर ${value} है।`,
        ].every(
          ({ text, spans }) =>
            JSON.stringify(spansOf(text)) ===
            JSON.stringify([['PASSPORT', spans[0]!.start, spans[0]!.end, false]]),
        );
      }),
    );
  });

  it('records that the keyword was found', () => {
    const { text } = compose`Passport: ${passportNumber(rng)}`;
    expect(detect(text).map((d) => d.context)).toEqual([true]);
  });

  it('is not redacted with no keyword, or with the keyword more than 40 characters away', () => {
    expect(detect(`Model ${passportNumber(rng)} is back in stock.`)).toEqual([]);
    const far = `Bring your passport to the counter next week, please. Ticket ${passportNumber(rng)}`;
    expect(detect(far)).toEqual([]);
  });

  it('is redacted whole when written with other digits and invisible characters, or full-width', () => {
    const value = passportNumber(rng);
    const hidden = obfuscate(value, createRng(3), 0.5);
    const wide = value.replace(/[!-~]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0));
    for (const written of [hidden, wide]) {
      const { text, spans } = compose`Passport: ${written} ok`;
      expect(spansOf(text)).toEqual([['PASSPORT', spans[0]!.start, spans[0]!.end, false]]);
    }
  });

  // Known limit (ADR-031): a space after the letter.
  it('is a known gap when written with a space after the letter', () => {
    const value = passportNumber(rng);
    expect(detect(`Passport: ${value[0]} ${value.slice(1)}`)).toEqual([]);
  });

  // The cost (ADR-031, README): any code of the same shape within 40
  // characters of the keyword is redacted too.
  it('a ticket code of the same shape right after a passport number is redacted too (the cost)', () => {
    const { text, spans } = compose`Passport no: ${passportNumber(rng)} Ticket: ${`T${'1234567'}`}`;
    expect(spansOf(text)).toEqual([
      ['PASSPORT', spans[0]!.start, spans[0]!.end, false],
      ['PASSPORT', spans[1]!.start, spans[1]!.end, false],
    ]);
  });
});

describe('passport: linear time', () => {
  it.each([
    ['letters and digits glued together', 25_000, (n: number) => 'A1234567'.repeat(n / 8)],
    // Put together here: typed after its keyword, it would be a passport
    // number in a file (repo-hygiene.test.ts).
    [
      'passport shapes after keywords',
      25_000,
      (n: number) => ['passport A', '1234567 '].join('').repeat(n / 18),
    ],
  ])('scans %s in linear time', (_name, size, make) => {
    expect(growthRatio(make, size, detect)).toBeLessThan(MAX_GROWTH_RATIO);
  });
});

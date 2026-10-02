// Voter ID (EPIC) numbers (ADR-031): three letters and seven digits,
// keyword only. The shape alone is never enough: order, transaction and
// reference codes are written the same way.
//
// Numbers are generated at run time and never printed (ADR-009):
// assertions compare offsets and types. Hand-written strings here are
// shapes only (the wrong length, or glued to something).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { detect } from '../../../src/detection/detect.js';
import { voterCandidates } from '../../../src/detection/voter.js';
import { passportNumber, voterId } from '../../../src/synthetic/identifiers.js';
import { createRng } from '../../../src/synthetic/rng.js';
import { compose } from '../../support/compose.js';
import { growthRatio, MAX_GROWTH_RATIO } from '../../support/linear-time.js';
import { assertPropertyQuietly, seedArb } from '../../support/quiet-property.js';

const rng = createRng(20_261_003);

const spansOf = (text: string): [string, number, number, boolean][] =>
  detect(text).map((d) => [d.type, d.start, d.end, d.validated]);

describe('voter ID candidates: the shape', () => {
  it('finds three letters and seven digits, in any case, never validated', () => {
    for (const value of [voterId(rng), voterId(rng).toLowerCase()]) {
      const { text, spans } = compose`ref ${value} ok`;
      expect([...voterCandidates(text)]).toEqual([
        { type: 'VOTER', ...spans[0]!, validated: false },
      ]);
    }
  });

  it('takes nothing glued to a letter, digit, mark, underscore or "@" on either side', () => {
    const value = voterId(rng);
    for (const glue of ['x', '7', '́', '_', '@']) {
      expect([...voterCandidates(`${glue}${value}`)]).toEqual([]);
      expect([...voterCandidates(`${value}${glue}`)]).toEqual([]);
    }
  });

  it('takes no other length: six or eight digits, two or four letters', () => {
    for (const text of ['ABC123456', 'ABC12345678', 'AB1234567', 'ABCD1234567']) {
      expect([...voterCandidates(text)]).toEqual([]);
    }
  });

  it('never shares text with a passport number: the letter before the digits is glued', () => {
    const value = voterId(rng);
    expect(detect(`Voter ID and passport: ${value}`).map((d) => d.type)).toEqual(['VOTER']);
    const passport = passportNumber(rng);
    expect(detect(`Voter ID and passport: ${passport}`).map((d) => d.type)).toEqual(['PASSPORT']);
  });
});

describe('voter IDs in text: only with a keyword', () => {
  it('is redacted next to "voter", "EPIC" or मतदाता, before or after it', () => {
    assertPropertyQuietly(
      fc.property(seedArb, (seed) => {
        const value = voterId(createRng(seed));
        return [
          compose`Voter ID: ${value}`,
          compose`My EPIC number is ${value}.`,
          compose`${value} is on my voter card.`,
          compose`Mera voter card ${value.toLowerCase()} hai.`,
          compose`मतदाता पहचान पत्र ${value} है।`,
        ].every(
          ({ text, spans }) =>
            JSON.stringify(spansOf(text)) ===
            JSON.stringify([['VOTER', spans[0]!.start, spans[0]!.end, false]]),
        );
      }),
    );
  });

  it('is not redacted with no keyword, or with "ID card" alone', () => {
    expect(detect(`Order ${voterId(rng)} has shipped.`)).toEqual([]);
    expect(detect(`ID card ${voterId(rng)} is attached.`)).toEqual([]);
  });

  // The cost (ADR-031, README): any code of the same shape within 40
  // characters of the keyword is redacted too.
  it('an order code of the same shape right after a voter ID is redacted too (the cost)', () => {
    const { text, spans } = compose`Voter ID: ${voterId(rng)} Order: ${`ORD${'1234567'}`}`;
    expect(spansOf(text)).toEqual([
      ['VOTER', spans[0]!.start, spans[0]!.end, false],
      ['VOTER', spans[1]!.start, spans[1]!.end, false],
    ]);
  });
});

describe('voter ID: linear time', () => {
  it.each([
    ['letters and digits glued together', 25_000, (n: number) => 'ABC1234567'.repeat(n / 10)],
    // Put together here: typed after its keyword, it would be a voter ID in
    // a file (repo-hygiene.test.ts).
    [
      'voter ID shapes after keywords',
      25_000,
      (n: number) => ['voter ABC', '1234567 '].join('').repeat(n / 17),
    ],
  ])('scans %s in linear time', (_name, size, make) => {
    expect(growthRatio(make, size, detect)).toBeLessThan(MAX_GROWTH_RATIO);
  });
});

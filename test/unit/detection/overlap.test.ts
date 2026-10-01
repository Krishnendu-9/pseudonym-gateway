import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { resolveOverlaps } from '../../../src/detection/overlap.js';
import {
  DETECTION_TYPES,
  type Candidate,
  type DetectionType,
} from '../../../src/detection/types.js';
import { assertPropertyQuietly } from '../../support/quiet-property.js';

const c = (type: DetectionType, start: number, end: number, validated = true): Candidate => ({
  type,
  start,
  end,
  validated,
});

describe('resolveOverlaps: the three rules (ADR-003)', () => {
  it('rule 1: a validated candidate beats an unvalidated one, even a longer one', () => {
    const validated = c('PHONE', 5, 15);
    const longer = c('CARD', 0, 19, false);
    expect(resolveOverlaps([longer, validated])).toEqual([validated]);
  });

  it('rule 2: between two validated candidates, the longer span wins', () => {
    const card = c('CARD', 0, 19); // a 4-4-4-4 card ...
    const aadhaar = c('AADHAAR', 0, 14); // ... whose first 4-4-4 is also a valid Aadhaar
    expect(resolveOverlaps([aadhaar, card])).toEqual([card]);
  });

  it('rule 2: between two unvalidated candidates, the longer span wins', () => {
    const longer = c('PHONE', 3, 20, false);
    expect(resolveOverlaps([c('AADHAAR', 0, 14, false), longer])).toEqual([longer]);
  });

  // Every pair from the priority list, same span, both validated.
  const pairs = DETECTION_TYPES.flatMap((higher, i) =>
    DETECTION_TYPES.slice(i + 1).map((lower) => [higher, lower] as const),
  );
  it.each(pairs)('rule 3: on the same span, %s beats %s', (higher, lower) => {
    expect(resolveOverlaps([c(lower, 0, 12), c(higher, 0, 12)])).toEqual([c(higher, 0, 12)]);
    expect(resolveOverlaps([c(higher, 0, 12), c(lower, 0, 12)])).toEqual([c(higher, 0, 12)]);
  });

  it('the priority order is IP > Aadhaar > Card > PAN > IFSC > Phone > UPI > Email > Secret > Number (the safety net, last)', () => {
    expect(DETECTION_TYPES).toEqual([
      'IP',
      'AADHAAR',
      'CARD',
      'PAN',
      'IFSC',
      'PHONE',
      'UPI',
      'EMAIL',
      'SECRET',
      'NUMBER',
    ]);
  });

  it('rules apply in order: validation first, then length, then type', () => {
    // An unvalidated Aadhaar loses to a validated email of the same length,
    // and a longer validated phone beats a shorter validated Aadhaar.
    expect(resolveOverlaps([c('AADHAAR', 0, 10, false), c('EMAIL', 0, 10)])).toEqual([
      c('EMAIL', 0, 10),
    ]);
    expect(resolveOverlaps([c('AADHAAR', 2, 16), c('PHONE', 0, 17)])).toEqual([c('PHONE', 0, 17)]);
  });

  it('on a complete tie, the earlier span wins', () => {
    expect(resolveOverlaps([c('CARD', 5, 21), c('CARD', 0, 16)])).toEqual([c('CARD', 0, 16)]);
  });
});

describe('resolveOverlaps: structure', () => {
  it('keeps spans that only touch (half-open spans do not overlap)', () => {
    const a = c('PAN', 0, 10);
    const b = c('PHONE', 10, 20);
    expect(resolveOverlaps([b, a])).toEqual([a, b]);
  });

  it('keeps both ends of a chain when the middle one loses', () => {
    // B overlaps A and C, and loses to both; A and C do not overlap.
    const a = c('AADHAAR', 0, 12);
    const b = c('PHONE', 8, 20, false);
    const cc = c('CARD', 16, 35);
    expect(resolveOverlaps([b, cc, a])).toEqual([a, cc]);
  });

  it('drops exact duplicates to one', () => {
    expect(resolveOverlaps([c('EMAIL', 3, 9), c('EMAIL', 3, 9)])).toEqual([c('EMAIL', 3, 9)]);
  });

  it('handles no candidates', () => {
    expect(resolveOverlaps([])).toEqual([]);
  });

  const candidateArb = fc
    .record({
      type: fc.constantFrom(...DETECTION_TYPES),
      start: fc.integer({ min: 0, max: 60 }),
      length: fc.integer({ min: 1, max: 20 }),
      validated: fc.boolean(),
    })
    .map(({ type, start, length, validated }) => c(type, start, start + length, validated));

  const beats = (a: Candidate, b: Candidate): boolean =>
    a.validated !== b.validated
      ? a.validated
      : a.end - a.start !== b.end - b.start
        ? a.end - a.start > b.end - b.start
        : a.type !== b.type
          ? DETECTION_TYPES.indexOf(a.type) < DETECTION_TYPES.indexOf(b.type)
          : a.start <= b.start;
  const overlaps = (a: Candidate, b: Candidate): boolean => a.start < b.end && b.start < a.end;

  it('returns non-overlapping winners in text order, and every loser overlaps a kept winner that beats it', () => {
    assertPropertyQuietly(
      fc.property(fc.array(candidateArb, { maxLength: 25 }), (candidates) => {
        const kept = resolveOverlaps(candidates);
        for (let i = 1; i < kept.length; i++) {
          if (kept[i - 1]!.end > kept[i]!.start) return false;
        }
        return candidates.every(
          (x) => kept.includes(x) || kept.some((k) => overlaps(k, x) && beats(k, x)),
        );
      }),
      { numRuns: 2000 },
    );
  });

  it('does not depend on the order of its input', () => {
    assertPropertyQuietly(
      fc.property(
        fc
          .array(candidateArb, { maxLength: 25 })
          .chain((xs) =>
            fc.tuple(fc.constant(xs), fc.shuffledSubarray(xs, { minLength: xs.length })),
          ),
        ([xs, shuffled]) =>
          JSON.stringify(resolveOverlaps(xs)) === JSON.stringify(resolveOverlaps(shuffled)),
      ),
      { numRuns: 2000 },
    );
  });
});

// Payment card numbers: 13-19 digits. Validated (ADR-003, amended by ADR-010)
// when the Luhn check passes and the number starts with a known issuer
// prefix (IIN) at a length that issuer uses. Any other 13-19 digit number is
// an unvalidated candidate, accepted only with a keyword such as "card"
// nearby.
//
// The issuer table is written from https://en.wikipedia.org/wiki/Payment_card_number
// independently of the synthetic generator's table (src/synthetic/values.ts),
// so a mistake in one is not silently shared by the other (bug-log entry 2).
// Maestro is left out on purpose: its prefixes (50, 56-69) cover almost every
// number starting with 5 or 6, which would make the prefix check meaningless.

import { digitWindows, standsAlone } from './digit-runs.js';
import { isLuhnValid } from './luhn.js';
import type { Candidate } from './types.js';

interface Issuer {
  readonly name: string;
  /** Inclusive prefix ranges; both ends have the same number of digits. */
  readonly prefixes: readonly (readonly [string, string])[];
  readonly lengths: readonly number[];
}

const range = (min: number, max: number): number[] =>
  Array.from({ length: max - min + 1 }, (_, i) => min + i);

export const ISSUERS: readonly Issuer[] = [
  { name: 'Visa', prefixes: [['4', '4']], lengths: [13, 16, 19] },
  {
    name: 'Mastercard',
    prefixes: [
      ['51', '55'],
      ['2221', '2720'],
    ],
    lengths: [16],
  },
  {
    name: 'American Express',
    prefixes: [
      ['34', '34'],
      ['37', '37'],
    ],
    lengths: [15],
  },
  {
    name: 'Discover',
    prefixes: [
      ['6011', '6011'],
      ['644', '649'],
      ['65', '65'],
    ],
    lengths: range(16, 19),
  },
  {
    name: 'RuPay',
    prefixes: [
      ['60', '60'],
      ['65', '65'],
      ['81', '82'],
      ['508', '508'],
      ['353', '353'],
      ['356', '356'],
    ],
    lengths: [16],
  },
  {
    name: 'Diners Club',
    prefixes: [
      ['300', '305'],
      ['3095', '3095'],
      ['36', '36'],
      ['38', '39'],
    ],
    lengths: range(14, 19),
  },
  { name: 'JCB', prefixes: [['3528', '3589']], lengths: range(16, 19) },
  { name: 'UnionPay', prefixes: [['62', '62']], lengths: range(16, 19) },
];

// Usual groupings, needed when the number is only part of a longer run:
// 4-4-4-4 (most cards), 4-6-5 (Amex), 4-6-4 (14-digit Diners), 4-4-4-4-3 (19 digits).
const CARD_LAYOUTS = [
  [4, 4, 4, 4],
  [4, 6, 5],
  [4, 6, 4],
  [4, 4, 4, 4, 3],
] as const;

/**
 * Every issuer whose prefix and length fit. Ranges really do overlap: RuPay
 * shares 65 with Discover and 353/356 with JCB (co-branded cards).
 */
export function issuersOf(digits: string): string[] {
  return ISSUERS.filter(
    ({ prefixes, lengths }) =>
      lengths.includes(digits.length) &&
      prefixes.some(([low, high]) => {
        // Digit strings of equal length compare like the numbers they spell.
        const prefix = digits.slice(0, low.length);
        return prefix >= low && prefix <= high;
      }),
  ).map((issuer) => issuer.name);
}

export function isValidCard(digits: string): boolean {
  return isLuhnValid(digits) && issuersOf(digits).length > 0;
}

export function* cardCandidates(text: string): Generator<Candidate> {
  for (const w of digitWindows(text, 13, 19)) {
    if (!standsAlone(w, CARD_LAYOUTS)) continue;
    yield { type: 'CARD', start: w.start, end: w.end, validated: isValidCard(w.digits) };
  }
}

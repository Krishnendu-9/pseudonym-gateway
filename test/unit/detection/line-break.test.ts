// Numbers wrapped onto the next line (ADR-030): two whole digit runs with one
// line break between them are tried as one Aadhaar, card or phone number.
// Values are generated at run time and never printed (ADR-009): assertions
// compare offsets and types, and properties return booleans. Hand-written
// digit strings here are shapes only (too short, or failing their checks).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isValidAadhaar } from '../../../src/detection/aadhaar.js';
import { isValidCard } from '../../../src/detection/card.js';
import { detect } from '../../../src/detection/detect.js';
import {
  lineJoinedWindows,
  lineJoins,
  wrapsAlone,
  type DigitWindow,
} from '../../../src/detection/digit-runs.js';
import type { Span } from '../../../src/detection/normalise.js';
import { phoneCandidates } from '../../../src/detection/phone.js';
import { createRng } from '../../../src/synthetic/rng.js';
import {
  aadhaar,
  CARD_NETWORK_NAMES,
  cardNumber,
  groupDigits,
  indianMobile,
} from '../../../src/synthetic/values.js';
import { compose } from '../../support/compose.js';
import { growthRatio, MAX_GROWTH_RATIO, ofLength } from '../../support/linear-time.js';
import { assertPropertyQuietly, seedArb } from '../../support/quiet-property.js';

const rng = createRng(30_030);

const BREAKS = [
  ['LF', '\n'],
  ['CRLF', '\r\n'],
  ['a space and LF', ' \n'],
  ['LF and two spaces of indent', '\n  '],
] as const;

/** Is the whole of `span` inside one detection of `type`? */
const coveredBy = (text: string, span: Span, type: string): boolean =>
  detect(text).some((d) => d.type === type && d.start <= span.start && span.end <= d.end);

/** Is every digit of `span` inside some detection of `type`? */
const digitsCoveredBy = (text: string, span: Span, type: string): boolean => {
  const found = detect(text).filter((d) => d.type === type);
  for (let i = span.start; i < span.end; i++) {
    if (/[0-9]/.test(text[i]!) && !found.some((d) => d.start <= i && i < d.end)) return false;
  }
  return true;
};

/** Is any character of `span` inside some detection? */
const touched = (text: string, span: Span): boolean =>
  detect(text).some((d) => d.start < span.end && span.start < d.end);

describe('lineJoins', () => {
  const pairs = (text: string): string[][] =>
    [...lineJoins(text)].map(([a, b]) => [text.slice(a.start, a.end), text.slice(b.start, b.end)]);

  it.each(BREAKS)('pairs two runs across %s', (_name, lineBreak) => {
    expect(pairs(`x 12 34${lineBreak}56 78 y`)).toEqual([['12 34', '56 78']]);
  });

  it.each([
    ['a hyphen', '12-34-\n56-78'],
    ['a dot and a space', '12.34. \n56.78'],
  ])('pairs runs with %s before the line break', (_name, text) => {
    expect(pairs(text)).toEqual([
      [text.split('\n')[0]!.replace(/[^0-9]+$/, ''), text.split('\n')[1]],
    ]);
  });

  it('pairs each run with the next: a run can be in two pairs', () => {
    expect(pairs('12\n34\n56')).toEqual([
      ['12', '34'],
      ['34', '56'],
    ]);
  });

  it.each([
    ['a blank line', '12 34\n\n56 78'],
    ['a blank line with CRLF', '12 34\r\n\r\n56 78'],
    ['a lone CR', '12 34\r56 78'],
    ['three spaces of indent', '12 34\n   56 78'],
    ['three separators before the break', '12 34 - \n56 78'],
    ['a tab', '12 34\t\n56 78'],
    ['a word', '12 34\nand 56 78'],
    ['a bullet', '12 34\n- 56 78'],
  ])('does not pair runs across %s', (_name, text) => {
    expect(pairs(text)).toEqual([]);
  });
});

describe('lineJoinedWindows', () => {
  const windows = (text: string, min: number, max: number) =>
    [...lineJoinedWindows(text, min, max)].map((w: DigitWindow) => ({
      text: text.slice(w.start, w.end),
      digits: w.digits,
      groups: w.groups,
      wholeRun: w.wholeRun,
    }));

  it('can be the whole of both runs, with their groups in order', () => {
    expect(windows('a 12 345\n6 b', 6, 6)).toEqual([
      { text: '12 345\n6', digits: '123456', groups: [2, 3, 1], wholeRun: true },
    ]);
  });

  it('takes the last groups of the first line with the whole second run, and the reverse', () => {
    expect(windows('7 12 34\n56 b', 6, 6)).toEqual([
      { text: '12 34\n56', digits: '123456', groups: [2, 2, 2], wholeRun: false },
    ]);
    expect(windows('a 12\n34 56 7', 6, 6)).toEqual([
      { text: '12\n34 56', digits: '123456', groups: [2, 2, 2], wholeRun: false },
    ]);
  });

  it('never takes only part of both runs', () => {
    expect(windows('7 12 34\n56 8', 6, 6)).toEqual([]);
  });

  it('only yields windows with the right number of digits', () => {
    expect(windows('12 345\n6', 7, 9)).toEqual([]);
    expect(windows('12 345\n6', 1, 3)).toEqual([]);
  });

  it.each([
    ['a letter before the first run', 'ab12 34\n56'],
    ['a "+" before the first run', '+12 34\n56'],
    ['an "@" after the second run', '12 34\n56@x'],
    ['a letter after the second run', '12 34\n56cd'],
  ])('is not a whole-run window with %s (the same glue rules as digitWindows)', (_name, text) => {
    expect(windows(text, 6, 6)).toEqual([]);
  });

  it('checks the glue only where a window reaches the end of a run', () => {
    // "24x7" after the second line: the run "56 24" is glued to the x, but
    // a window of "12 34" and "56" stops before it.
    expect(windows('12 34\n56 24x7', 6, 6).map((w) => w.text)).toEqual(['12 34\n56']);
  });
});

describe('wrapsAlone', () => {
  const w = (groups: number[], wholeRun = true): DigitWindow => ({
    start: 0,
    end: 0,
    digits: '',
    groups,
    wholeRun,
  });
  const layouts = [[4, 4, 4]];

  it('accepts two unbroken groups, one on each line, when they are the whole of both runs', () => {
    expect(wrapsAlone(w([6, 6]), layouts)).toBe(true);
    expect(wrapsAlone(w([8, 4]), layouts)).toBe(true);
  });

  it('rejects two unbroken groups that are only part of a run (a table of numbers)', () => {
    expect(wrapsAlone(w([6, 6], false), layouts)).toBe(false);
  });

  it("accepts the type's usual layout split over two lines, whole or not", () => {
    expect(wrapsAlone(w([4, 4, 4]), layouts)).toBe(true);
    expect(wrapsAlone(w([4, 4, 4], false), layouts)).toBe(true);
  });

  it('rejects any other grouping (a group broken across the line, in a spaced number)', () => {
    expect(wrapsAlone(w([4, 2, 2, 4]), layouts)).toBe(false);
    expect(wrapsAlone(w([2, 2, 8]), layouts)).toBe(false);
  });
});

describe('Aadhaar wrapped onto the next line', () => {
  const WRAPS: readonly ((d: string) => [string, string])[] = [
    (d) => [groupDigits(d.slice(0, 8), [4, 4], ' '), d.slice(8)],
    (d) => [d.slice(0, 4), groupDigits(d.slice(4), [4, 4], ' ')],
    (d) => [d.slice(0, 6), d.slice(6)],
    (d) => [`${groupDigits(d.slice(0, 8), [4, 4], '-')}-`, d.slice(8)],
  ];

  it.each(BREAKS)('is found, validated, with %s and no keyword', (_name, lineBreak) => {
    assertPropertyQuietly(
      fc.property(seedArb, fc.constantFrom(...WRAPS), (seed, wrap) => {
        const [first, second] = wrap(aadhaar(createRng(seed)));
        const { text, spans } = compose`Please verify ${first}${lineBreak}${second} today.`;
        const span = { start: spans[0]!.start, end: spans[2]!.end };
        const found = detect(text);
        return (
          found.length === 1 &&
          found[0]!.type === 'AADHAAR' &&
          found[0]!.validated &&
          found[0]!.start === span.start &&
          found[0]!.end === span.end
        );
      }),
      { numRuns: 200 },
    );
  });

  it("with a wrong check digit, needs a keyword (today's rule, ADR-010)", () => {
    const digits = aadhaar(rng);
    const typo = digits.slice(0, 11) + String((Number(digits[11]) + 1) % 10);
    expect(isValidAadhaar(typo)).toBe(false);
    const wrapped = `${groupDigits(typo.slice(0, 8), [4, 4], ' ')}\n${typo.slice(8)}`;
    const bare = compose`Ref ${wrapped} ok`;
    expect(touched(bare.text, bare.spans[0]!)).toBe(false);
    const keyword = compose`Aadhaar: ${wrapped}`;
    expect(detect(keyword.text)).toEqual([
      { type: 'AADHAAR', ...keyword.spans[0]!, validated: false, context: true },
    ]);
  });

  // Unlike one whole run on one line, whole runs on two lines count only in
  // a usual layout or as two unbroken groups: rows of 3-digit codes are not
  // an Aadhaar however their digits add up (mutation A2).
  it('is not taken from whole runs in an unusual grouping (rows of 3-digit codes)', () => {
    const d = aadhaar(rng);
    const rows = `${groupDigits(d.slice(0, 6), [3, 3], ' ')}\n${groupDigits(d.slice(6), [3, 3], ' ')}`;
    const { text, spans } = compose`Codes:\n${rows}`;
    expect(touched(text, spans[0]!)).toBe(false);
  });

  it('is not found when its two halves are split by a blank line (not a wrapped number)', () => {
    const digits = aadhaar(rng);
    const { text, spans } =
      compose`Ref ${groupDigits(digits.slice(0, 8), [4, 4], ' ')}\n\n${digits.slice(8)} ok`;
    expect(touched(text, spans[0]!)).toBe(false);
  });
});

describe('card wrapped onto the next line', () => {
  const WRAPS: readonly ((d: string) => [string, string])[] = [
    (d) => [
      groupDigits(d.slice(0, 8), [4, 4], ' '),
      groupDigits(d.slice(8), [4, d.length - 12], ' '),
    ],
    (d) => [d.slice(0, 8), d.slice(8)],
  ];

  it.each(BREAKS)('is found, validated, with %s and no keyword', (_name, lineBreak) => {
    assertPropertyQuietly(
      fc.property(
        seedArb,
        fc.constantFrom(...CARD_NETWORK_NAMES.filter((n) => n !== 'amex')),
        fc.constantFrom(...WRAPS),
        (seed, network, wrap) => {
          const [first, second] = wrap(cardNumber(createRng(seed), network));
          const { text, spans } = compose`Use ${first}${lineBreak}${second} please.`;
          const found = detect(text);
          return (
            found.length === 1 &&
            found[0]!.type === 'CARD' &&
            found[0]!.validated &&
            found[0]!.start === spans[0]!.start &&
            found[0]!.end === spans[2]!.end
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  // The first line of an Amex written 4-6-5 is ten digits, which often read
  // as a valid Indian landline. The wrapped card holds that phone and wins
  // (ADR-029 C3), so the second line is never left visible.
  it('an Amex wrapped after its 4-6 is one card, even when its first line reads as a phone', () => {
    assertPropertyQuietly(
      fc.property(seedArb, (seed) => {
        const digits = cardNumber(createRng(seed), 'amex');
        const first = groupDigits(digits.slice(0, 10), [4, 6], ' ');
        const { text, spans } = compose`Card ${first}\n${digits.slice(10)} expires soon.`;
        const found = detect(text);
        return (
          found.length === 1 &&
          found[0]!.type === 'CARD' &&
          found[0]!.start === spans[0]!.start &&
          found[0]!.end === spans[1]!.end
        );
      }),
      { numRuns: 200 },
    );
  });

  it('is not taken from whole runs in an unusual grouping (mutation C2)', () => {
    const d = cardNumber(rng, 'visa');
    const rows = `${groupDigits(d.slice(0, 8), [3, 5], ' ')}\n${groupDigits(d.slice(8), [5, 3], ' ')}`;
    const { text, spans } = compose`Ref:\n${rows}`;
    expect(touched(text, spans[0]!)).toBe(false);
  });

  it('a card number on one line and a short number on the next stay covered', () => {
    const value = groupDigits(cardNumber(rng, 'visa'), [4, 4, 4, 4], ' ');
    const { text, spans } = compose`Card ${value}\n${'123'} items`;
    expect(coveredBy(text, spans[0]!, 'CARD')).toBe(true);
  });

  it('with a failing Luhn check, needs a keyword', () => {
    const digits = cardNumber(rng, 'visa');
    const typo = digits.slice(0, 15) + String((Number(digits[15]) + 1) % 10);
    expect(isValidCard(typo)).toBe(false);
    const wrapped = `${groupDigits(typo.slice(0, 8), [4, 4], ' ')}\n${groupDigits(typo.slice(8), [4, 4], ' ')}`;
    const bare = compose`Ref ${wrapped} ok`;
    expect(touched(bare.text, bare.spans[0]!)).toBe(false);
    const keyword = compose`Debit card ${wrapped}`;
    expect(coveredBy(keyword.text, keyword.spans[0]!, 'CARD')).toBe(true);
  });
});

describe('phone wrapped onto the next line: always needs a keyword', () => {
  const wrapped = (lineBreak: string): string => {
    const mobile = indianMobile(rng);
    return `${mobile.slice(0, 5)}${lineBreak}${mobile.slice(5)}`;
  };

  it.each(BREAKS)('with %s, is not a phone without a keyword ...', (_name, lineBreak) => {
    const { text, spans } = compose`Ref ${wrapped(lineBreak)} ok`;
    expect(touched(text, spans[0]!)).toBe(false);
  });

  it.each(BREAKS)('... and is one unvalidated phone next to "mobile" (%s)', (_name, lineBreak) => {
    const { text, spans } = compose`My mobile is ${wrapped(lineBreak)}.`;
    expect(detect(text)).toEqual([
      { type: 'PHONE', ...spans[0]!, validated: false, context: true },
    ]);
  });

  it('takes a "+" in front of the first line with it', () => {
    const { text, spans } = compose`Call ${`+91 ${wrapped('\n')}`} now`;
    expect(detect(text)).toEqual([
      { type: 'PHONE', ...spans[0]!, validated: false, context: true },
    ]);
  });

  // A phone found inside the window is not enough: "12" plus the mobile on
  // the next line would contain the mobile and replace it (ADR-029), taking
  // the flat number with it (mutation P5).
  it('does not take a number on the line before a whole mobile', () => {
    const { text, spans } =
      compose`Flat 12\n${groupDigits(indianMobile(rng), [5, 5], ' ')} is my mobile`;
    expect(detect(text).map((d) => [d.type, d.start, d.end])).toEqual([
      ['PHONE', spans[0]!.start, spans[0]!.end],
    ]);
  });

  // The first line alone is a possible (not valid) number: only valid ones
  // stop a wrapped window, or the last two digits would be sent.
  it('is one phone when broken inside its second group', () => {
    const m = indianMobile(rng);
    const v = `${m.slice(0, 5)} ${m.slice(5, 8)}\n${m.slice(8)}`;
    const { text, spans } = compose`My mobile: ${v} ok`;
    expect(digitsCoveredBy(text, spans[0]!, 'PHONE')).toBe(true);
  });

  it('takes a country code on the line before a whole number with it', () => {
    const { text, spans } = compose`Call ${'+1\n202-555-0143'} now`;
    expect(detect(text).map((d) => [d.type, d.start, d.end])).toEqual([
      ['PHONE', spans[0]!.start, spans[0]!.end],
    ]);
  });

  // Widening takes the whole digit run on each line (ADR-010), so the digit
  // before it goes too, as "Room 3 <mobile>" does on one line.
  it('takes a digit before a wrapped mobile with it (fail closed)', () => {
    const m = indianMobile(rng);
    const { text, spans } = compose`My mobile: room ${`7 ${m.slice(0, 5)}\n${m.slice(5)}`} ok`;
    expect(detect(text).map((d) => [d.type, d.start, d.end])).toEqual([
      ['PHONE', spans[0]!.start, spans[0]!.end],
    ]);
  });

  it('is a candidate only when the two runs make one number together', () => {
    const mobile = indianMobile(rng);
    // A mobile on each line is two whole numbers: no wrapped candidate.
    const two = `${mobile}\n${indianMobile(rng)}`;
    expect([...phoneCandidates(two)].filter((c) => c.start === 0 && c.end === two.length)).toEqual(
      [],
    );
    const glued = `x${mobile.slice(0, 5)}\n${mobile.slice(5)}`;
    expect([...phoneCandidates(glued)]).toEqual([]);
  });
});

// A wrapped value with another number in the same run on one of its lines
// (found by the no-leak test before this was committed; bug-log 40).
describe('a wrapped value with a number beside it', () => {
  const NEIGHBOURS: readonly (readonly [string, (v: string) => string])[] = [
    ['a digit before it', (v) => `Room 3 ${v} is mine.`],
    ['a digit after it', (v) => `Ref ${v} 7 ok`],
    ['a 5-digit group after it', (v) => `Ref ${v} 41100 ok`],
    ['"24x7" after it', (v) => `Ref ${v} 24x7 ok`],
    [
      'a value and " - " before it',
      (v) => `Ref ${groupDigits(indianMobile(rng), [5, 5], ' ')} - ${v} ok`,
    ],
    [
      'a value and a space after it',
      (v) => `Ref ${v} ${groupDigits(indianMobile(rng), [5, 5], ' ')} ok`,
    ],
  ];
  const at = (text: string, v: string): Span => ({
    start: text.indexOf(v),
    end: text.indexOf(v) + v.length,
  });

  it.each(NEIGHBOURS)('an Aadhaar written 4-4 / 4, with %s', (_name, frame) => {
    const d = aadhaar(rng);
    const v = `${groupDigits(d.slice(0, 8), [4, 4], ' ')}\n${d.slice(8)}`;
    const text = frame(v);
    expect(coveredBy(text, at(text, v), 'AADHAAR')).toBe(true);
  });

  it.each(NEIGHBOURS)('a card written 4-4 / 4-4, with %s', (_name, frame) => {
    const d = cardNumber(rng, 'visa');
    const v = `${groupDigits(d.slice(0, 8), [4, 4], ' ')}\n${groupDigits(d.slice(8), [4, 4], ' ')}`;
    const text = frame(v);
    expect(coveredBy(text, at(text, v), 'CARD')).toBe(true);
  });

  // When the second half and the group after it read as a valid phone on
  // their own, that phone wins (ADR-003 rule 1) and the wrapped candidate
  // keeps its first half (ADR-029): two placeholders, nothing visible.
  it.each(NEIGHBOURS)('a mobile with its keyword, with %s', (_name, frame) => {
    const m = indianMobile(rng);
    const v = `${m.slice(0, 5)}\n${m.slice(5)}`;
    const text = `Mobile: ${frame(v)}`;
    expect(digitsCoveredBy(text, at(text, v), 'PHONE')).toBe(true);
  });

  // Known gap (ADR-030): two unbroken groups are a wrapped number only as the
  // whole of both runs; inside a longer run they are as often two amounts in
  // a table row. The digit beside it is the safety net's only if 9+ long.
  it('is a known gap for an Aadhaar written 6 / 6 with a digit beside it', () => {
    const d = aadhaar(rng);
    const v = `${d.slice(0, 6)}\n${d.slice(6)}`;
    const text = `Room 3 ${v} is mine.`;
    expect(touched(text, at(text, v))).toBe(false);
  });
});

describe('what a line break does not change', () => {
  it('a value on each line keeps its own detection and type', () => {
    const aadhaarValue = groupDigits(aadhaar(rng), [4, 4, 4], ' ');
    const mobile = groupDigits(indianMobile(rng), [5, 5], ' ');
    const card = groupDigits(cardNumber(rng, 'mastercard'), [4, 4, 4, 4], ' ');
    const { text, spans } = compose`${aadhaarValue}\n${mobile}\n${card}`;
    const found = detect(text).map((d) => [d.type, d.start, d.end]);
    expect(found).toEqual([
      ['AADHAAR', spans[0]!.start, spans[0]!.end],
      ['PHONE', spans[1]!.start, spans[1]!.end],
      ['CARD', spans[2]!.start, spans[2]!.end],
    ]);
  });

  it.each([
    ['statement rows', '28-09-2026 UPI 4520.50\n29-09-2026 NEFT 12000.00\n30-09-2026 ATM 500.00'],
    ['log lines', '2026-09-28 14:30:01 done in 4520\n2026-09-28 14:31:12 done in 381'],
    ['one 5-digit amount per line', 'Totals:\n45200\n38150\n27400'],
    ['an address with a PIN code', 'Flat 1203, Tower 4\n411001 Pune'],
    ['numbered steps', '1. Wait 30\n2. Wait 45\n3. Wait 90'],
  ])('%s are not redacted', (_name, text) => {
    expect(detect(text)).toEqual([]);
  });
});

// Known costs (ADR-030, README): each a shape of ordinary text that a
// wrapped value can take. Pinned so a change to them is a decision.
describe('known costs of joining across a line', () => {
  it('two 6-digit numbers on neighbouring lines that pass the Aadhaar checks are an Aadhaar', () => {
    // About 1 pair in 11 passes (first digit 2-9, Verhoeff): found by search.
    let pair = '';
    while (!pair) {
      const digits = String(rng.int(200_000, 999_999)) + rng.digits(6);
      if (isValidAadhaar(digits)) pair = `${digits.slice(0, 6)}\n${digits.slice(6)}`;
    }
    const { text, spans } = compose`PIN codes:\n${pair}`;
    expect(coveredBy(text, spans[0]!, 'AADHAAR')).toBe(true);
  });

  it('a 4-digit code at the end of one line and two at the start of the next that pass the Aadhaar checks are an Aadhaar', () => {
    const d = aadhaar(rng);
    const codes = `${rng.int(1000, 9999)} ${d.slice(0, 4)}\n${groupDigits(d.slice(4), [4, 4], ' ')}`;
    const { text, spans } = compose`Codes:\n${codes}`;
    const span = { start: spans[0]!.start + 5, end: spans[0]!.end };
    expect(coveredBy(text, span, 'AADHAAR')).toBe(true);
  });

  it('two lines of two 4-digit codes that pass the card checks are a card', () => {
    const digits = cardNumber(rng, 'visa');
    const codes = `${groupDigits(digits.slice(0, 8), [4, 4], ' ')}\n${groupDigits(digits.slice(8), [4, 4], ' ')}`;
    const { text, spans } = compose`Codes:\n${codes}`;
    expect(coveredBy(text, spans[0]!, 'CARD')).toBe(true);
  });

  it('two lines of five digits near a phone keyword are a phone', () => {
    const { text, spans } = compose`Phone bill totals:\n${'71234\n68230'}`;
    expect(coveredBy(text, spans[0]!, 'PHONE')).toBe(true);
  });
});

// Each input grows 4 times and the time must grow about 4 times, not 16
// (test/support/linear-time.ts). Every line join costs a libphonenumber
// call, so inputs made of joins are small (bug-log 28, 30).
describe('line joins: linear time', () => {
  const m = indianMobile(rng);
  it.each([
    ['many short lines of digits', 2_000, (n: number) => ofLength('71234\n', n)],
    ['wrapped mobiles', 2_000, (n: number) => ofLength(`${m.slice(0, 5)}\n${m.slice(5)} x\n`, n)],
    [
      'two long runs on two lines',
      2_000,
      (n: number) => `${ofLength('1 ', n / 2)}\n${ofLength('2 ', n / 2)}`,
    ],
  ])('detect scans %s in linear time', (_name, size, make) => {
    expect(growthRatio(make, size, detect)).toBeLessThan(MAX_GROWTH_RATIO);
  });
});

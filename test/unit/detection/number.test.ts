// The safety net (ADR-011): long numbers that no detector claimed.
//
// Indian mobiles and bank-account-like numbers are generated at run time and
// never printed (ADR-009); checks over them count failures and print only
// the count. Everything written out here is not personal data: dates,
// amounts, versions, order references.

import { describe, expect, it } from 'vitest';
import { detect } from '../../../src/detection/detect.js';
import type { Span } from '../../../src/detection/normalise.js';
import { MIN_NUMBER_DIGITS, unclaimedNumbers } from '../../../src/detection/number.js';
import { createRng } from '../../../src/synthetic/rng.js';
import { indianMobile } from '../../../src/synthetic/values.js';
import { compose } from '../../support/compose.js';
import { growthRatio, MAX_GROWTH_RATIO } from '../../support/linear-time.js';
import { numberAt } from '../../support/number-at.js';

const spansOf = (text: string, claimed: Span[] = []): Span[] =>
  unclaimedNumbers(text, claimed).map(({ start, end }) => ({ start, end }));

// True if one detection covers the whole span.
const covers = (found: readonly Span[], span: Span): boolean =>
  found.some((d) => d.start <= span.start && d.end >= span.end);

describe('unclaimedNumbers', () => {
  it('starts at 9 digits', () => {
    expect(MIN_NUMBER_DIGITS).toBe(9);
    expect(spansOf('a 12345678 b')).toEqual([]);
    expect(spansOf('a 123456789 b')).toEqual([{ start: 2, end: 11 }]);
  });

  it.each(['.', '-', '--', '---', '–', '—', '−', '(', ')', '[', ']', '+', '-(', ')+'])(
    'counts digits across the joiner %j',
    (joiner) => {
      const text = `x 12345${joiner}6789 y`;
      expect(spansOf(text)).toEqual([{ start: 2, end: text.length - 2 }]);
    },
  );

  it.each([' ', ',', '/', ':', '_', 'x', '----', ', '])('does not join across %j', (separator) => {
    expect(spansOf(`x 12345${separator}6789 y`)).toEqual([]);
  });

  it('ignores what the digits are glued to', () => {
    expect(spansOf('UID123456789x')).toEqual([{ start: 3, end: 12 }]);
    expect(spansOf('a_123456789_b')).toEqual([{ start: 2, end: 11 }]);
  });

  it('takes only the digits a claimed span leaves, trimmed of joiners', () => {
    // "1234567890+123456789": the first 10 digits are claimed.
    expect(spansOf('1234567890+123456789', [{ start: 0, end: 10 }])).toEqual([
      { start: 11, end: 20 },
    ]);
    // A claim in the middle leaves two pieces, one long enough.
    expect(spansOf('123456789-55-1234', [{ start: 10, end: 12 }])).toEqual([{ start: 0, end: 9 }]);
    // Leftovers shorter than 9 digits are not taken.
    expect(spansOf('12345678901234', [{ start: 3, end: 10 }])).toEqual([]);
  });

  it('respects a claim that covers several runs, or starts before one', () => {
    // A card claimed across spaces covers runs a space separates.
    expect(spansOf('12345 678901234567', [{ start: 0, end: 18 }])).toEqual([]);
    expect(spansOf('12345 678901234567 ok 987654321', [{ start: 0, end: 18 }])).toEqual([
      { start: 22, end: 31 },
    ]);
    // A claim that starts before the run and ends inside it.
    expect(spansOf('ab 123456789012345', [{ start: 0, end: 8 }])).toEqual([{ start: 8, end: 18 }]);
  });

  it('runs in linear time, with or without claims', () => {
    const joined = (n: number): string => '1-'.repeat(n / 2);
    expect(growthRatio(joined, 250_000, (t) => unclaimedNumbers(t, []))).toBeLessThan(
      MAX_GROWTH_RATIO,
    );
    // One run a million characters long, with a claim every 20 characters.
    const claims = (text: string): Span[] =>
      Array.from({ length: Math.floor(text.length / 20) }, (_, i) => ({
        start: i * 20,
        end: i * 20 + 4,
      }));
    expect(growthRatio(joined, 250_000, (t) => unclaimedNumbers(t, claims(t)))).toBeLessThan(
      MAX_GROWTH_RATIO,
    );
  });
});

describe('detect: the safety net closes bug-log 8', () => {
  // Two mobiles glued with no space. Before the net, both were unredacted
  // for "-", "--", "[", "]" and ")", and one of the two for "+". "_" was
  // missed by design (ADR-010) and is now caught too.
  it.each(['-', '--', '[', ']', ')', '(', '+', '_', '.', '–', '/', ':'])(
    'redacts every digit of two mobiles glued by %j',
    (joiner) => {
      const r = createRng(800);
      let leaked = 0;
      for (let i = 0; i < 200; i++) {
        const { text, spans } = compose`Numbers ${indianMobile(r)}${joiner}${indianMobile(r)} ok`;
        const found = detect(text);
        if (!covers(found, spans[0]!) || !covers(found, spans[2]!)) leaked++;
      }
      expect(leaked).toBe(0);
    },
  );

  it('redacts bare 9- to 18-digit numbers such as bank account numbers', () => {
    const r = createRng(801);
    let leaked = 0;
    for (let length = 9; length <= 18; length++) {
      for (let i = 0; i < 50; i++) {
        const { text, spans } =
          compose`Transfer to ${`${r.int(1, 9)}${r.digits(length - 1)}`} today`;
        if (!covers(detect(text), spans[0]!)) leaked++;
      }
    }
    expect(leaked).toBe(0);
  });

  it('leaves a real detection alone and takes only what it left', () => {
    // "+" joins for the net but not for the card's digit run, so the card
    // keeps its 16 digits and the net takes the 9 after the "+".
    const { text, spans } = compose`Card ${'4111111111111111'}+${'123456789'} ok`;
    expect(detect(text)).toEqual([
      { type: 'CARD', ...spans[0]!, validated: true, context: true },
      numberAt(spans[1]!),
    ]);
  });
});

describe('detect: what the safety net does not catch (ADR-011)', () => {
  it.each([
    ['an ISO date', 'Due 2024-09-28.'],
    ['an ISO date and time', 'At 2024-09-28 14:30 IST'],
    ['an ISO timestamp', 'ts 2024-09-28T14:30:00Z'],
    ['a day-first date and time', 'On 28-09-2024 14:15'],
    ['dotted and slashed dates', 'On 28.09.2024 or 28/09/2024'],
    ['a date range with spaces', 'Stay 2024-09-28 - 2024-10-05'],
    ['a year range', 'From 1998-2024'],
    ['an amount in lakh notation', 'Pay Rs 1,25,000 now'],
    ['a large amount in crore notation', 'Total ₹12,34,56,789.50'],
    ['an amount with thousands separators', 'Revenue $1,234,567.89'],
    ['an 8-digit amount', 'Budget 12500000 INR'],
    ['a time range', 'Open 10:00-12:30'],
    ['a version', 'Version v1.12.30'],
    ['an invoice reference', 'Invoice INV/2024/00123'],
    ['a short order number', 'Order #402100 shipped'],
    ['a short IP address', 'Host 10.0.0.1 down'],
  ])('does not catch %s', (_name, text) => {
    expect(detect(text)).toEqual([]);
  });
});

describe('detect: what the safety net does catch that is not personal (the accepted cost)', () => {
  it.each([
    ['an order ID in 3-7-7 form', 'Order 403-5550143-5550199 shipped', '403-5550143-5550199'],
    ['a 12-digit tracking number', 'AWB 100000000017 in transit', '100000000017'],
    ['a Windows build number', 'Windows 10.0.19045.3693 ok', '10.0.19045.3693'],
    ['an IPv4 address with 9 or more digits', 'Host 192.168.100.200 down', '192.168.100.200'],
    ['an ISBN', 'ISBN 978-3-16-148410-0 ok', '978-3-16-148410-0'],
    ['a millisecond timestamp', 'at 1727500000000 ms', '1727500000000'],
    ['a digit stretch inside a hash', 'commit 0a1b2c3d4e5f607182934a5b', '607182934'],
  ])('catches %s', (_name, text, value) => {
    const start = text.indexOf(value);
    expect(detect(text)).toEqual([numberAt({ start, end: start + value.length })]);
  });
});

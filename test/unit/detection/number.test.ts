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

  // ADR-011 amendment (Phase 5b): nine digits cut out of a 40-character
  // token would send the other 31 characters, so the token goes whole.
  describe('takes the whole token the digits are glued into', () => {
    const whole = (text: string, token: string): void => {
      const start = text.indexOf(token);
      expect(spansOf(text)).toEqual([{ start, end: start + token.length }]);
    };

    it.each([
      ['letters before', 'see UID123456789 now', 'UID123456789'],
      ['letters after', 'see 123456789x now', '123456789x'],
      ['letters on both sides', 'UID123456789x', 'UID123456789x'],
      ['underscores', 'a_123456789_b', 'a_123456789_b'],
      ['a hexadecimal token', 'id 0a1b2c3d4e5f607182934a5b ok', '0a1b2c3d4e5f607182934a5b'],
      ['letters of another script', 'देखें नंबर123456789है अब', 'नंबर123456789है'],
      ['a combining mark right before the digits', 'x é123456789 y', 'é123456789'],
      ['a combining mark right after the digits', 'x 123456789́ y', '123456789́'],
      ['letters outside the BMP (two code units each)', 'x 𐐀𐐁123456789𐐂 y', '𐐀𐐁123456789𐐂'],
    ])('%s', (_name, text, token) => {
      whole(text, token);
    });

    it.each([' ', ',', ':', '/', '@', '=', '"', '#', '*'])(
      'stops at %j: what is beyond it is not part of the token',
      (stop) => {
        const text = `left${stop}ab123456789cd${stop}right`;
        expect(spansOf(text)).toEqual([{ start: 5, end: 18 }]);
      },
    );

    it('a joiner is not a token character: words joined to a number by a hyphen stay', () => {
      expect(spansOf('order-123456789-delivered')).toEqual([{ start: 6, end: 15 }]);
      expect(spansOf('(123456789).Then')).toEqual([{ start: 1, end: 10 }]);
    });

    it('two long stretches in one token are one detection', () => {
      expect(spansOf('x 123456789abc987654321 y')).toEqual([{ start: 2, end: 23 }]);
      // The second stretch reaches past the token the first was widened over.
      expect(spansOf('x 123456789abc12-345678901z y')).toEqual([{ start: 2, end: 27 }]);
    });

    it('a short stretch later in the same token is inside the detection already', () => {
      expect(spansOf('x 123456789abc1234 y')).toEqual([{ start: 2, end: 18 }]);
    });

    it('never widens into a claimed span, on either side', () => {
      // "ab" and "cd" are claimed (say, by a detector that found them first).
      const text = 'ab123456789cd';
      expect(
        spansOf(text, [
          { start: 0, end: 2 },
          { start: 11, end: 13 },
        ]),
      ).toEqual([{ start: 2, end: 11 }]);
      // A claim in the middle of a token: each side is widened up to it.
      expect(spansOf('xx123456789yy987654321zz', [{ start: 11, end: 13 }])).toEqual([
        { start: 0, end: 11 },
        { start: 13, end: 24 },
      ]);
    });
  });

  it('takes only the digits a claimed span leaves, trimmed of joiners', () => {
    // "1234567890+123456789": the first 10 digits are claimed.
    expect(spansOf('1234567890+123456789', [{ start: 0, end: 10 }])).toEqual([
      { start: 11, end: 20 },
    ]);
    // A claim in the middle leaves two pieces, both joined to it: taken
    // however few their digits (ADR-029).
    expect(spansOf('123456789-55-1234', [{ start: 10, end: 12 }])).toEqual([
      { start: 0, end: 9 },
      { start: 13, end: 17 },
    ]);
    // Leftovers glued to the claim are taken too; digits in a run of their
    // own (a space is not a joiner) still need 9.
    expect(spansOf('12345678901234', [{ start: 3, end: 10 }])).toEqual([
      { start: 0, end: 3 },
      { start: 10, end: 14 },
    ]);
    expect(spansOf('1234567890 1234', [{ start: 0, end: 10 }])).toEqual([]);
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

  it('runs in linear time on one long token full of long numbers', () => {
    // Every stretch would widen over the whole token if it were walked again.
    const token = (n: number): string => '123456789a'.repeat(n / 10);
    expect(growthRatio(token, 250_000, (t) => unclaimedNumbers(t, []))).toBeLessThan(
      MAX_GROWTH_RATIO,
    );
    const lettersThenNumber = (n: number): string => `${'a'.repeat(n)}123456789`;
    expect(growthRatio(lettersThenNumber, 250_000, (t) => unclaimedNumbers(t, []))).toBeLessThan(
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
    // Addresses no single host owns are kept by the IP detector (ADR-026).
    ['a netmask', 'Mask 255.255.255.0 set'],
    ['the broadcast address', 'Bcast 255.255.255.255 x'],
  ])('does not catch %s', (_name, text) => {
    expect(detect(text)).toEqual([]);
  });

  it('never sees an IP address of any length: the IP detector claims it first (ADR-026)', () => {
    for (const text of ['Host 10.0.0.1 down', 'Host 192.168.100.200 down']) {
      expect(detect(text).map((d) => d.type)).toEqual(['IP']);
    }
  });
});

describe('detect: what the safety net does catch that is not personal (the accepted cost)', () => {
  it.each([
    ['an order ID in 3-7-7 form', 'Order 403-5550143-5550199 shipped', '403-5550143-5550199'],
    ['a 12-digit tracking number', 'AWB 100000000017 in transit', '100000000017'],
    ['a Windows build number', 'Windows 10.0.19045.3693 ok', '10.0.19045.3693'],
    ['an ISBN', 'ISBN 978-3-16-148410-0 ok', '978-3-16-148410-0'],
    ['a millisecond timestamp', 'at 1727500000000 ms', '1727500000000'],
    [
      'a hash with a long digit stretch in it',
      'commit 0a1b2c3d4e5f607182934a5b',
      '0a1b2c3d4e5f607182934a5b',
    ],
  ])('catches %s', (_name, text, value) => {
    const start = text.indexOf(value);
    expect(detect(text)).toEqual([numberAt({ start, end: start + value.length })]);
  });
});

// ADR-029: digits joined to a claimed span by a joiner are taken however few,
// except next to an address no single host owns (not a detection).
describe('digits joined to a claimed span (J1)', () => {
  it('takes a few digits joined by "(", "+" or "-" to a claim', () => {
    expect(spansOf('9876543210(12345', [{ start: 0, end: 10 }])).toEqual([{ start: 11, end: 16 }]);
    expect(spansOf('9876543210+123', [{ start: 0, end: 10 }])).toEqual([{ start: 11, end: 14 }]);
    expect(spansOf('12-9876543210', [{ start: 3, end: 13 }])).toEqual([{ start: 0, end: 2 }]);
  });

  it('does not take them next to a kept address', () => {
    const kept = { start: 0, end: 9, keep: true as const };
    expect(unclaimedNumbers('127.0.0.1-12345', [kept])).toEqual([]);
    expect(unclaimedNumbers('12345-127.0.0.1', [{ start: 6, end: 15, keep: true }])).toEqual([]);
  });

  it('does not take digits in a run of their own', () => {
    expect(spansOf('9876543210 12345', [{ start: 0, end: 10 }])).toEqual([]);
  });

  it('takes bracket-joined digits after phones in linear time', () => {
    const make = (n: number): string => '98765 43210(12'.repeat(Math.ceil(n / 14));
    expect(growthRatio(make, 5_000, detect)).toBeLessThan(MAX_GROWTH_RATIO);
  });
});

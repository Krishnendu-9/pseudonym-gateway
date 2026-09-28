// Card numbers written in this file come only from published test-card lists
// (test/fixtures). Other card-shaped numbers are built in memory, and
// assertions compare offsets, so none is ever printed (rule 4, ADR-009).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ISSUERS, isValidCard, issuersOf } from '../../../src/detection/card.js';
import { detect } from '../../../src/detection/detect.js';
import { isLuhnValid, luhnCheckDigit } from '../../../src/detection/luhn.js';
import { createRng } from '../../../src/synthetic/rng.js';
import { CARD_NETWORK_NAMES, cardNumber, groupDigits } from '../../../src/synthetic/values.js';
import { PUBLISHED_TEST_CARDS } from '../../fixtures/published-test-cards.js';
import { compose } from '../../support/compose.js';
import { assertPropertyQuietly, seedArb } from '../../support/quiet-property.js';

/** A number with this prefix and length that is certainly NOT Luhn-valid. */
function notLuhn(prefix: string, length: number): string {
  const n = prefix.padEnd(length, '0');
  return isLuhnValid(n) ? n.slice(0, -1) + String((Number(n.at(-1)) + 1) % 10) : n;
}

/** A Luhn-valid number with this prefix and length, built in memory. */
function withLuhn(prefix: string, length: number): string {
  const payload = prefix.padEnd(length - 1, '0');
  return payload + luhnCheckDigit(payload);
}

const LAYOUT: Record<number, number[]> = {
  14: [4, 6, 4],
  15: [4, 6, 5],
  16: [4, 4, 4, 4],
  19: [4, 4, 4, 4, 3],
};

const cardAt = (span: { start: number; end: number }, validated = true, context = false) => ({
  type: 'CARD',
  ...span,
  validated,
  context,
});

describe('issuersOf', () => {
  it.each([
    ['Visa', '4', [13, 16, 19]],
    ['Mastercard', '51', [16]],
    ['Mastercard', '55', [16]],
    ['Mastercard', '2221', [16]],
    ['Mastercard', '2720', [16]],
    ['American Express', '34', [15]],
    ['American Express', '37', [15]],
    ['Discover', '6011', [16, 19]],
    ['Discover', '644', [16]],
    ['Discover', '649', [16]],
    ['RuPay', '508', [16]],
    ['RuPay', '81', [16]],
    ['RuPay', '82', [16]],
    ['Diners Club', '300', [14, 16]],
    ['Diners Club', '305', [14]],
    ['Diners Club', '36', [14, 19]],
    ['JCB', '3528', [16, 19]],
    ['JCB', '3589', [16]],
    ['UnionPay', '62', [16, 19]],
  ])('%s: prefix %s at lengths %j', (issuer, prefix, lengths) => {
    for (const length of lengths) expect(issuersOf(notLuhn(prefix, length))).toContain(issuer);
  });

  it.each([
    ['just below Mastercard 2-series', '2220', 16],
    ['just above Mastercard 2-series', '2721', 16],
    ['just below Mastercard 51-55', '50', 16],
    ['just above Mastercard 51-55', '56', 16],
    ['just below JCB', '3527', 16],
    ['just above JCB', '3590', 16],
    ['Discover 643', '643', 16],
    ['Diners 306', '306', 16],
    ['Maestro 57 (left out on purpose)', '57', 16],
    ['a leading 1', '1', 16],
    ['a leading 9', '9', 16],
    ['Visa at 15 digits', '4', 15],
    ['Amex at 16 digits', '37', 16],
    ['Mastercard at 19 digits', '51', 19],
  ])('no issuer for %s', (_name, prefix, length) => {
    expect(issuersOf(notLuhn(prefix, length))).toEqual([]);
  });

  it('reports every issuer when ranges overlap (co-branded RuPay)', () => {
    expect(issuersOf(notLuhn('3530', 16)).sort()).toEqual(['JCB', 'RuPay']);
    expect(issuersOf(notLuhn('65', 16)).sort()).toEqual(['Discover', 'RuPay']);
  });

  it('agrees with every published test card', () => {
    for (const card of PUBLISHED_TEST_CARDS) {
      const brand = card.brand.replace(/ \(.*\)$/, '');
      expect(issuersOf(card.number), card.brand).toContain(brand);
    }
  });

  it('has no issuer with an empty prefix range', () => {
    for (const issuer of ISSUERS) {
      for (const [low, high] of issuer.prefixes) {
        expect(low.length).toBe(high.length);
        expect(low <= high).toBe(true);
      }
    }
  });
});

describe('isValidCard', () => {
  it('needs both Luhn and an issuer', () => {
    expect(isValidCard('4111111111111111')).toBe(true);
    expect(isValidCard(notLuhn('4', 16))).toBe(false);
    expect(isValidCard(withLuhn('1', 16))).toBe(false);
  });

  it.each(CARD_NETWORK_NAMES)('accepts every generated %s number', (network) => {
    assertPropertyQuietly(
      fc.property(seedArb, (seed) => isValidCard(cardNumber(createRng(seed), network))),
      { numRuns: 500 },
    );
  });
});

describe('card detection', () => {
  it.each(PUBLISHED_TEST_CARDS.map((c) => [c.brand, c.number] as const))(
    'finds the %s test card %s unbroken, in its usual grouping, and with hyphens',
    (_brand, number) => {
      const forms = [number];
      const layout = LAYOUT[number.length];
      if (layout) forms.push(groupDigits(number, layout, ' '), groupDigits(number, layout, '-'));
      for (const form of forms) {
        const { text, spans } = compose`Paid with ${form} yesterday.`;
        expect(detect(text)).toEqual([cardAt(spans[0]!)]);
      }
    },
  );

  it('records context next to "card"', () => {
    const { text, spans } = compose`Card number: ${'4111 1111 1111 1111'}`;
    expect(detect(text)).toEqual([cardAt(spans[0]!, true, true)]);
  });

  it('finds the card after a quantity, and redacts the quantity with it (fail closed)', () => {
    // "2 4242 ..." is one run of digit groups; the card still wins the type
    // (it is found and resolved first), then covers the whole run.
    const { text, spans } = compose`Qty ${'2 4242 4242 4242 4242'}`;
    expect(detect(text)).toEqual([cardAt(spans[0]!)]);
  });

  it('prefers the whole card over a valid Aadhaar in its first 12 digits (longer wins)', () => {
    // This published Mastercard test number's first 12 digits pass the
    // Aadhaar checks; the 16-digit card is longer and wins.
    const { text, spans } = compose`Card ${'5105 1051 0510 5100'}`;
    expect(detect(text)).toEqual([cardAt(spans[0]!, true, true)]);
  });

  it('finds generated cards of every network, grouped or not', () => {
    assertPropertyQuietly(
      fc.property(seedArb, fc.boolean(), (seed, grouped) => {
        const number = cardNumber(createRng(seed));
        const form = grouped ? groupDigits(number, LAYOUT[number.length]!, ' ') : number;
        const { text, spans } = compose`Paid with ${form} yesterday.`;
        const found = detect(text);
        return (
          found.length === 1 &&
          found[0]!.type === 'CARD' &&
          found[0]!.validated &&
          found[0]!.start === spans[0]!.start &&
          found[0]!.end === spans[0]!.end
        );
      }),
      { numRuns: 1000 },
    );
  });

  describe('unvalidated: accepted only with a keyword', () => {
    it('Luhn-valid but no known issuer: dropped without context, kept next to "card"', () => {
      const number = withLuhn('1', 16);
      expect(detect(`Ref ${number} ok`)).toEqual([]);
      const { text, spans } = compose`My card ${number}`;
      expect(detect(text)).toEqual([cardAt(spans[0]!, false, true)]);
    });

    it('a known issuer but a Luhn typo: dropped without context, kept next to "debit"', () => {
      const number = groupDigits(notLuhn('4', 16), [4, 4, 4, 4], ' ');
      expect(detect(`Ref ${number} ok`)).toEqual([]);
      const { text, spans } = compose`debit ${number}`;
      expect(detect(text)).toEqual([cardAt(spans[0]!, false, true)]);
    });
  });

  describe('tricky negatives', () => {
    it('ignores a card number inside a longer unbroken number', () => {
      expect(detect('Ref 41111111111111110 ok')).toEqual([]);
      expect(detect('Ref 94111111111111111 ok')).toEqual([]);
    });

    it('ignores 20 or more digits', () => {
      expect(detect(`Ref ${withLuhn('4', 20)} ok`)).toEqual([]);
    });

    it('ignores a card number glued to letters', () => {
      expect(detect('sk_live_4111111111111111')).toEqual([]);
      expect(detect('abc4111111111111111def')).toEqual([]);
    });

    it('ignores a millisecond timestamp (13 digits, no issuer starts with 1)', () => {
      expect(detect(`at ${withLuhn('17', 13)} ms`)).toEqual([]);
    });
  });
});

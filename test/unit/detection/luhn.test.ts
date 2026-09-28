import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isLuhnValid, luhnCheckDigit } from '../../../src/detection/luhn.js';
import { PUBLISHED_TEST_CARDS } from '../../fixtures/published-test-cards.js';
import { assertPropertyQuietly } from '../../support/quiet-property.js';

const digitString = (minLength: number, maxLength: number) =>
  fc.string({ unit: fc.constantFrom(...'0123456789'), minLength, maxLength });

const withCheckDigit = (payload: string): string => payload + luhnCheckDigit(payload);

describe('Luhn: published reference vectors', () => {
  // Worked example at https://en.wikipedia.org/wiki/Luhn_algorithm
  it('1789372997 has check digit 4', () => {
    expect(luhnCheckDigit('1789372997')).toBe('4');
    expect(isLuhnValid('17893729974')).toBe(true);
    expect(isLuhnValid('17893729975')).toBe(false);
  });

  it.each(PUBLISHED_TEST_CARDS.map((c) => [c.source, c.brand, c.number] as const))(
    '%s %s test card %s is valid, and invalid with its last digit changed',
    (_source, _brand, number) => {
      expect(isLuhnValid(number)).toBe(true);
      const last = Number(number.at(-1));
      expect(isLuhnValid(number.slice(0, -1) + String((last + 1) % 10))).toBe(false);
      expect(luhnCheckDigit(number.slice(0, -1))).toBe(number.at(-1));
    },
  );
});

describe('Luhn: properties', () => {
  it('a payload followed by its check digit is valid', () => {
    assertPropertyQuietly(fc.property(digitString(1, 30), (p) => isLuhnValid(withCheckDigit(p))));
  });

  it('exactly one of the ten possible check digits is valid', () => {
    assertPropertyQuietly(
      fc.property(digitString(1, 30), (p) => {
        const valid = [...'0123456789'].filter((c) => isLuhnValid(p + c));
        return valid.length === 1;
      }),
    );
  });

  it('detects every single-digit error', () => {
    assertPropertyQuietly(
      fc.property(digitString(1, 30), fc.nat(), fc.integer({ min: 1, max: 9 }), (p, at, delta) => {
        const digits = [...withCheckDigit(p)];
        const i = at % digits.length;
        digits[i] = String((Number(digits[i]) + delta) % 10);
        return !isLuhnValid(digits.join(''));
      }),
    );
  });

  it('detects every adjacent swap except 09 <-> 90', () => {
    assertPropertyQuietly(
      fc.property(digitString(1, 30), fc.nat(), (p, at) => {
        const digits = [...withCheckDigit(p)];
        const i = at % (digits.length - 1);
        const [a, b] = [digits[i]!, digits[i + 1]!];
        if (a === b || a + b === '09' || a + b === '90') return true;
        digits[i] = b;
        digits[i + 1] = a;
        return !isLuhnValid(digits.join(''));
      }),
    );
  });

  it('misses 09 <-> 90 swaps (the known weakness; Verhoeff catches them)', () => {
    assertPropertyQuietly(
      fc.property(digitString(0, 15), digitString(0, 15), (left, right) => {
        const valid = withCheckDigit(left + '09' + right);
        const swapped = left + '90' + valid.slice(left.length + 2);
        return isLuhnValid(swapped);
      }),
    );
  });
});

describe('Luhn: input handling', () => {
  it.each([
    '',
    '0',
    'abc',
    '4242 4242 4242 4242',
    '４２４２４２４２４２４２４２４２',
    '-17893729974',
  ])('isLuhnValid(%j) is false', (input) => {
    expect(isLuhnValid(input)).toBe(false);
  });

  it.each(['', '17893x', '१७८', ' 1789'])('luhnCheckDigit(%j) throws', (input) => {
    expect(() => luhnCheckDigit(input)).toThrow(TypeError);
  });

  it('never puts the input in the error message', () => {
    expect(() => luhnCheckDigit('98765x43210')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('98765') }),
    );
  });
});

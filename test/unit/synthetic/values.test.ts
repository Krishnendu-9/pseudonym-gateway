// Generated values may coincide with real ones (ADR-009), so every check here
// runs inside assertPropertyQuietly and returns a boolean: a failure reports a
// seed, never a value.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isLuhnValid } from '../../../src/detection/luhn.js';
import { isVerhoeffValid } from '../../../src/detection/verhoeff.js';
import { createRng, type Rng } from '../../../src/synthetic/rng.js';
import {
  aadhaar,
  CARD_NETWORK_NAMES,
  cardNumber,
  email,
  groupDigits,
  indianMobile,
  pan,
  PAN_ENTITY_CODES,
  RESERVED_EMAIL_DOMAINS,
  ukDramaMobile,
  type CardNetwork,
} from '../../../src/synthetic/values.js';
import { assertPropertyQuietly, seedArb } from '../../support/quiet-property.js';

const RUNS = { numRuns: 2000 };

const holds = (check: (rng: Rng) => boolean): void => {
  assertPropertyQuietly(
    fc.property(seedArb, (seed) => check(createRng(seed))),
    RUNS,
  );
};

const between = (s: string, length: number, low: number, high: number): boolean => {
  const n = Number(s.slice(0, length));
  return n >= low && n <= high;
};

// Written independently of the generator's table, from the same source
// (https://en.wikipedia.org/wiki/Payment_card_number).
const hasIssuerPrefix: Record<CardNetwork, (n: string) => boolean> = {
  visa: (n) => n.length === 16 && n.startsWith('4'),
  mastercard: (n) => n.length === 16 && (between(n, 2, 51, 55) || between(n, 4, 2221, 2720)),
  amex: (n) => n.length === 15 && (n.startsWith('34') || n.startsWith('37')),
  discover: (n) =>
    n.length === 16 && (n.startsWith('6011') || between(n, 3, 644, 649) || n.startsWith('65')),
  rupay: (n) =>
    n.length === 16 && ['60', '65', '81', '82', '508'].some((prefix) => n.startsWith(prefix)),
};

describe('synthetic values', () => {
  it('aadhaar: 12 digits, first digit 2-9, valid Verhoeff check digit', () => {
    holds((rng) => {
      const a = aadhaar(rng);
      return /^[2-9][0-9]{11}$/.test(a) && isVerhoeffValid(a);
    });
  });

  it.each(CARD_NETWORK_NAMES)('cardNumber(%s): issuer prefix, length and Luhn', (network) => {
    holds((rng) => {
      const c = cardNumber(rng, network);
      return /^[0-9]+$/.test(c) && hasIssuerPrefix[network](c) && isLuhnValid(c);
    });
  });

  it('cardNumber with no network picks every network', () => {
    const seen = new Set<CardNetwork>();
    const rng = createRng(11);
    for (let i = 0; i < 500; i++) {
      const c = cardNumber(rng);
      for (const network of CARD_NETWORK_NAMES) if (hasIssuerPrefix[network](c)) seen.add(network);
    }
    expect([...seen].sort()).toEqual([...CARD_NETWORK_NAMES].sort());
  });

  it('pan: AAAAA9999A shape with a holder-type code in 4th place', () => {
    holds((rng) => {
      const p = pan(rng);
      return (
        /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(p) && (PAN_ENTITY_CODES as readonly string[]).includes(p[3]!)
      );
    });
  });

  it('email: one @, a non-empty local part, and a reserved domain', () => {
    holds((rng) => {
      const [local, domain, ...rest] = email(rng).split('@');
      return (
        rest.length === 0 &&
        /^[a-z0-9._+-]+$/.test(local ?? '') &&
        (RESERVED_EMAIL_DOMAINS as readonly string[]).includes(domain ?? '')
      );
    });
  });

  it('indianMobile: 10 digits starting 6-9', () => {
    holds((rng) => /^[6-9][0-9]{9}$/.test(indianMobile(rng)));
  });

  it('ukDramaMobile: inside the Ofcom drama range 447700900000-447700900999', () => {
    holds((rng) => /^447700900[0-9]{3}$/.test(ukDramaMobile(rng)));
  });

  it('is deterministic: the same seed gives the same values', () => {
    holds((rng) => {
      const seed = rng.int(0, 2 ** 32 - 1);
      const make = () => {
        const r = createRng(seed);
        return [aadhaar(r), cardNumber(r), pan(r), email(r), indianMobile(r), ukDramaMobile(r)];
      };
      return make().join('|') === make().join('|');
    });
  });
});

describe('groupDigits', () => {
  it('splits into the given group sizes', () => {
    expect(groupDigits('4111111111111111', [4, 4, 4, 4], ' ')).toBe('4111 1111 1111 1111');
    expect(groupDigits('378282246310005', [4, 6, 5], '-')).toBe('3782-822463-10005');
  });

  it('throws when the sizes do not add up', () => {
    expect(() => groupDigits('12345', [2, 2], ' ')).toThrow(RangeError);
  });
});

// Generated values may coincide with real ones (ADR-009), so every check here
// runs inside assertPropertyQuietly and returns a boolean: a failure reports a
// seed, never a value.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isValidAadhaar } from '../../../src/detection/aadhaar.js';
import { issuersOf } from '../../../src/detection/card.js';
import { isLuhnValid } from '../../../src/detection/luhn.js';
import { isValidPan } from '../../../src/detection/pan.js';
import {
  aadhaarWithTypo,
  cardWithTypo,
  ifsc,
  IFSC_BANK_CODES,
  ipAddress,
  panWithTypo,
  personName,
  secret,
  SECRET_KINDS,
  UPI_HANDLES,
  upiId,
  type SecretKind,
} from '../../../src/synthetic/identifiers.js';
import { createRng, type Rng } from '../../../src/synthetic/rng.js';
import { assertPropertyQuietly, seedArb } from '../../support/quiet-property.js';

const holds = (check: (rng: Rng) => boolean): void => {
  assertPropertyQuietly(
    fc.property(seedArb, (seed) => check(createRng(seed))),
    { numRuns: 1000 },
  );
};

describe('values with a typo: the right shape, a failed check', () => {
  it('aadhaarWithTypo: 12 digits, first digit 2-9, fails Verhoeff', () => {
    holds((rng) => {
      const a = aadhaarWithTypo(rng);
      return /^[2-9][0-9]{11}$/.test(a) && !isValidAadhaar(a);
    });
  });

  it('cardWithTypo: 16 digits with an issuer prefix, fails Luhn', () => {
    holds((rng) => {
      const c = cardWithTypo(rng);
      return /^[0-9]{16}$/.test(c) && issuersOf(c).length > 0 && !isLuhnValid(c);
    });
  });

  it('panWithTypo: PAN-shaped, but the 4th letter is not a holder type', () => {
    holds((rng) => {
      const p = panWithTypo(rng);
      return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(p) && !isValidPan(p);
    });
  });
});

describe('ifsc', () => {
  it('known: a listed bank code, a zero, six characters', () => {
    holds((rng) => {
      const code = ifsc(rng);
      return (
        /^[A-Z]{4}0[A-Z0-9]{6}$/.test(code) &&
        (IFSC_BANK_CODES as readonly string[]).includes(code.slice(0, 4))
      );
    });
  });

  it('unknown: the same shape with a bank code that is not listed', () => {
    holds((rng) => {
      const code = ifsc(rng, false);
      return (
        /^XX[A-Z]{2}0[A-Z0-9]{6}$/.test(code) &&
        !(IFSC_BANK_CODES as readonly string[]).includes(code.slice(0, 4))
      );
    });
  });

  it('writes branches both as digits and with letters', () => {
    const rng = createRng(5);
    const branches = Array.from({ length: 200 }, () => ifsc(rng).slice(5));
    expect(branches.some((b) => /^[0-9]{6}$/.test(b))).toBe(true);
    expect(branches.some((b) => /[A-Z]/.test(b))).toBe(true);
  });
});

describe('upiId', () => {
  const handleOf = (id: string): string => id.slice(id.indexOf('@') + 1);
  const known = (id: string): boolean => (UPI_HANDLES as readonly string[]).includes(handleOf(id));

  it('name: a name at a listed handle, with no dot after the @', () => {
    holds((rng) => {
      const id = upiId(rng);
      return /^[a-z]+(?:\.?[a-z]+)?[0-9]{0,2}@[a-z]+$/.test(id) && known(id);
    });
  });

  it('mobile: a 10-digit mobile at a listed handle', () => {
    holds((rng) => {
      const id = upiId(rng, 'mobile');
      return /^[6-9][0-9]{9}@[a-z]+$/.test(id) && known(id);
    });
  });

  it('unknown: a handle that is not listed', () => {
    holds((rng) => {
      const id = upiId(rng, 'unknown');
      return /^[a-z.0-9]+@zz[a-z]{4}$/.test(id) && !known(id);
    });
  });
});

describe('ipAddress', () => {
  it('v4: inside a documentation range', () => {
    holds((rng) =>
      /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.(?:[1-9][0-9]{0,2})$/.test(ipAddress(rng)),
    );
  });

  it('v6: inside 2001:db8::/32, compressed or in full', () => {
    const rng = createRng(3);
    const addresses = Array.from({ length: 200 }, () => ipAddress(rng, 'v6'));
    expect(addresses.every((a) => /^2001:db8:[0-9a-f:]+$/.test(a))).toBe(true);
    expect(addresses.some((a) => a.includes('::'))).toBe(true);
    expect(addresses.some((a) => a.split(':').length === 8)).toBe(true);
  });

  it('private: inside 10/8, 172.16/12 or 192.168/16', () => {
    holds((rng) => {
      const [a, b] = ipAddress(rng, 'private').split('.').map(Number) as [number, number];
      return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    });
  });

  it('loopback: 127.0.0.1 or ::1', () => {
    holds((rng) => ['127.0.0.1', '::1'].includes(ipAddress(rng, 'loopback')));
  });

  it('link-local: inside 169.254/16 or fe80::/10, both kinds', () => {
    const rng = createRng(4);
    const addresses = Array.from({ length: 200 }, () => ipAddress(rng, 'link-local'));
    const v4 = addresses.filter((a) => /^169\.254\.[0-9]{1,3}\.[0-9]{1,3}$/.test(a));
    const v6 = addresses.filter((a) => /^fe80::(?:[0-9a-f]{1,4}:){3}[0-9a-f]{1,4}$/.test(a));
    expect([v4.length + v6.length, v4.length > 0, v6.length > 0]).toEqual([200, true, true]);
  });
});

describe('secret', () => {
  // Shapes only: a prefix and a length. Never a whole key in this file.
  const shapes: Record<SecretKind, RegExp> = {
    openai: /^sk-[A-Za-z0-9]{48}$/,
    anthropic: /^sk-ant-api03-[A-Za-z0-9_-]{93}AA$/,
    github: /^ghp_[A-Za-z0-9]{36}$/,
    aws: /^AKIA[A-Z0-9]{16}$/,
    stripe: /^sk_live_[A-Za-z0-9]{24}$/,
    razorpay: /^rzp_live_[A-Za-z0-9]{14}$/,
    slack: /^xoxb-[0-9]{12}-[0-9]{13}-[A-Za-z0-9]{24}$/,
    google: /^AIza[A-Za-z0-9_-]{35}$/,
    jwt: /^eyJ[A-Za-z0-9]{33}\.eyJ[A-Za-z0-9]{40,90}\.[A-Za-z0-9_-]{43}$/,
    password: /^[A-Z][a-z]{4,8}[@#!$_][0-9]{2,4}$/,
    token: /^[0-9a-f]{40}$/,
  };

  it('has a shape for every kind', () => {
    expect(Object.keys(shapes).sort()).toEqual([...SECRET_KINDS].sort());
  });

  it.each(SECRET_KINDS)('%s: its prefix and length', (kind) => {
    holds((rng) => shapes[kind].test(secret(rng, kind)));
  });
});

describe('personName', () => {
  it('latin: a given name and a family name', () => {
    holds((rng) => /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(personName(rng)));
  });

  it('devanagari: two words in Devanagari', () => {
    holds((rng) =>
      /^[\p{Script=Devanagari}]+ [\p{Script=Devanagari}]+$/u.test(personName(rng, 'devanagari')),
    );
  });
});

it('is deterministic: the same seed gives the same values', () => {
  holds((rng) => {
    const seed = rng.int(0, 2 ** 32 - 1);
    const make = (): string => {
      const r = createRng(seed);
      return [
        aadhaarWithTypo(r),
        cardWithTypo(r),
        panWithTypo(r),
        ifsc(r),
        upiId(r),
        ipAddress(r, 'v6'),
        secret(r, 'jwt'),
        personName(r),
      ].join('|');
    };
    return make() === make();
  });
});

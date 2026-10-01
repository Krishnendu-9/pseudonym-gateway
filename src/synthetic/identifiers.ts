// More synthetic values: the types whose detectors arrive in Phase 5 (IFSC,
// UPI IDs, IP addresses, secrets), person names for Phase 6, and the
// "typo" variants of checksummed values (right shape, failed check).
//
// Same handling rule as values.ts (ADR-009): a generated UPI ID can coincide
// with a real one and a generated key has the shape of a real key, so these
// live in memory only and are never written to files or printed. Key-shaped
// strings in a file would also trip GitHub's secret scanning.
//
// Lists here (bank codes, UPI handles, key formats) are the generator's own;
// detectors keep theirs separately (ADR-008).

import type { Rng } from './rng.js';
import { aadhaar, cardNumber, indianMobile, pan, PAN_ENTITY_CODES } from './values.js';

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const ALNUM = UPPER + LOWER + DIGITS;

const chars = (rng: Rng, alphabet: string, count: number): string => {
  let out = '';
  for (let i = 0; i < count; i++) out += alphabet[rng.int(0, alphabet.length - 1)]!;
  return out;
};

/** `digit` replaced by a different digit. */
const otherDigit = (rng: Rng, digit: string): string =>
  String((Number(digit) + rng.int(1, 9)) % 10);

/** An Aadhaar with a wrong check digit: the right shape, fails Verhoeff. */
export function aadhaarWithTypo(rng: Rng): string {
  const valid = aadhaar(rng);
  return valid.slice(0, 11) + otherDigit(rng, valid[11]!);
}

/** A 16-digit card number with a wrong check digit: issuer prefix, fails Luhn. */
export function cardWithTypo(rng: Rng): string {
  const valid = cardNumber(rng, rng.pick(['visa', 'mastercard', 'rupay'] as const));
  return valid.slice(0, 15) + otherDigit(rng, valid[15]!);
}

/** A PAN whose 4th letter is not a holder-type code. */
export function panWithTypo(rng: Rng): string {
  const valid = pan(rng);
  const wrong = [...UPPER].filter((l) => !(PAN_ENTITY_CODES as readonly string[]).includes(l));
  return valid.slice(0, 3) + rng.pick(wrong) + valid.slice(4);
}

// Bank codes of large Indian banks (the first four letters of their IFSCs).
export const IFSC_BANK_CODES = [
  'SBIN',
  'HDFC',
  'ICIC',
  'UTIB',
  'PUNB',
  'KKBK',
  'BARB',
  'CNRB',
  'UBIN',
  'IDIB',
  'YESB',
] as const;

/**
 * IFSC: 4 letters (bank), a zero, 6 characters (branch). `known` picks a
 * real bank code; otherwise the code starts with XX, which is unlikely to be
 * any bank's.
 */
export function ifsc(rng: Rng, known = true): string {
  const bank = known ? rng.pick(IFSC_BANK_CODES) : 'XX' + chars(rng, UPPER, 2);
  const branch = rng.chance(0.8) ? rng.digits(6) : chars(rng, UPPER + DIGITS, 6);
  return `${bank}0${branch}`;
}

// Handles of large UPI apps and banks (the part after "@").
export const UPI_HANDLES = [
  'okhdfcbank',
  'okicici',
  'oksbi',
  'okaxis',
  'ybl',
  'ibl',
  'axl',
  'paytm',
  'upi',
  'apl',
] as const;

const GIVEN = ['priya', 'rahul', 'ananya', 'arjun', 'meera', 'vikram', 'sara', 'imran', 'kavya'];
const FAMILY = ['sharma', 'iyer', 'khan', 'das', 'reddy', 'singh', 'nair', 'gupta'];

export type UpiKind = 'name' | 'mobile' | 'unknown';

/**
 * UPI ID. `name`: a name at a known handle; `mobile`: a 10-digit mobile at a
 * known handle; `unknown`: a name at a handle no list will have.
 */
export function upiId(rng: Rng, kind: UpiKind = 'name'): string {
  if (kind === 'mobile') return `${indianMobile(rng)}@${rng.pick(UPI_HANDLES)}`;
  let local = rng.pick(GIVEN);
  if (rng.chance(0.6)) local += rng.pick(['.', '']) + rng.pick(FAMILY);
  if (rng.chance(0.5)) local += String(rng.int(1, 99));
  const handle = kind === 'unknown' ? `zz${chars(rng, LOWER, 4)}` : rng.pick(UPI_HANDLES);
  return `${local}@${handle}`;
}

// Ranges reserved for documentation (RFC 5737, RFC 3849): never routed, so
// an address here is nobody's.
const DOCUMENTATION_V4 = ['192.0.2', '198.51.100', '203.0.113'] as const;

export type IpKind = 'v4' | 'v6' | 'private' | 'loopback' | 'link-local';

/**
 * IP address. `v4`/`v6`: from the documentation ranges, standing in for a
 * public address; `private`: RFC 1918; `loopback`: 127.0.0.1 or ::1;
 * `link-local`: 169.254/16 or fe80::/10.
 */
export function ipAddress(rng: Rng, kind: IpKind = 'v4'): string {
  switch (kind) {
    case 'v4':
      return `${rng.pick(DOCUMENTATION_V4)}.${rng.int(1, 254)}`;
    case 'v6': {
      const group = (): string => rng.int(0, 0xffff).toString(16);
      return rng.chance(0.5)
        ? `2001:db8::${group()}:${group()}`
        : `2001:db8:${group()}:${group()}:${group()}:${group()}:${group()}:${group()}`;
    }
    case 'private':
      return rng.pick([
        `10.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}`,
        `192.168.${rng.int(0, 255)}.${rng.int(1, 254)}`,
        `172.${rng.int(16, 31)}.${rng.int(0, 255)}.${rng.int(1, 254)}`,
      ]);
    case 'loopback':
      return rng.pick(['127.0.0.1', '::1']);
    case 'link-local': {
      const group = (): string => rng.int(0, 0xffff).toString(16);
      return rng.chance(0.5)
        ? `169.254.${rng.int(0, 255)}.${rng.int(1, 254)}`
        : `fe80::${group()}:${group()}:${group()}:${group()}`;
    }
  }
}

const BASE64URL = ALNUM + '-_';

// Each secret is built from its prefix and random characters at run time, so
// no complete key-shaped string ever appears in a file. Shapes follow each
// provider's published key format (prefix and length), loosely: these are
// for planting in text, not for authenticating.
const SECRET_MAKERS = {
  openai: (rng: Rng) => 'sk-' + chars(rng, ALNUM, 48),
  anthropic: (rng: Rng) => 'sk-ant-api03-' + chars(rng, BASE64URL, 93) + 'AA',
  github: (rng: Rng) => 'ghp_' + chars(rng, ALNUM, 36),
  aws: (rng: Rng) => 'AKIA' + chars(rng, UPPER + DIGITS, 16),
  stripe: (rng: Rng) => 'sk_live_' + chars(rng, ALNUM, 24),
  razorpay: (rng: Rng) => 'rzp_live_' + chars(rng, ALNUM, 14),
  slack: (rng: Rng) => `xoxb-${rng.digits(12)}-${rng.digits(13)}-${chars(rng, ALNUM, 24)}`,
  google: (rng: Rng) => 'AIza' + chars(rng, BASE64URL, 35),
  jwt: (rng: Rng) =>
    `eyJ${chars(rng, ALNUM, 33)}.eyJ${chars(rng, ALNUM, rng.int(40, 90))}.${chars(rng, BASE64URL, 43)}`,
  // Not a provider format: what a person types after "password:".
  password: (rng: Rng) =>
    chars(rng, UPPER, 1) +
    chars(rng, LOWER, rng.int(4, 8)) +
    rng.pick(['@', '#', '!', '$', '_']) +
    rng.digits(rng.int(2, 4)),
  // Not a provider format: an opaque token with no prefix.
  token: (rng: Rng) => chars(rng, '0123456789abcdef', 40),
} as const;

export type SecretKind = keyof typeof SECRET_MAKERS;

export const SECRET_KINDS = Object.keys(SECRET_MAKERS) as readonly SecretKind[];

/** A secret of the given kind (an API key format, a JWT, a password or a bare token). */
export function secret(rng: Rng, kind: SecretKind): string {
  return SECRET_MAKERS[kind](rng);
}

const GIVEN_NAMES = [
  'Priya',
  'Rahul',
  'Ananya',
  'Arjun',
  'Meera',
  'Vikram',
  'Sara',
  'Imran',
  'Kavya',
  'John',
  'Fatima',
  'Li',
];
const FAMILY_NAMES = ['Sharma', 'Iyer', 'Khan', 'Das', 'Reddy', 'Singh', 'Nair', 'Gupta', 'Smith'];
const DEVANAGARI_NAMES = [
  'प्रिया शर्मा',
  'राहुल वर्मा',
  'अनन्या सिंह',
  'विक्रम रेड्डी',
  'मीरा नायर',
];

/** A person's name: given and family name, in Latin script or Devanagari. */
export function personName(rng: Rng, script: 'latin' | 'devanagari' = 'latin'): string {
  if (script === 'devanagari') return rng.pick(DEVANAGARI_NAMES);
  return `${rng.pick(GIVEN_NAMES)} ${rng.pick(FAMILY_NAMES)}`;
}

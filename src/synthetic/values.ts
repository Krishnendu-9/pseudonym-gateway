// Synthetic personal values, one generator per data type. Every value is
// built from a seeded Rng, so the same seed always gives the same value.
//
// Handling rule: a random Aadhaar, card, PAN or Indian mobile number can
// coincide with a real one, so generated values live in memory only. They are
// never written to files or snapshots and never printed, including in test
// failure output. See dev_docs/decisions.md (ADR-009).

import { luhnCheckDigit } from '../detection/luhn.js';
import { verhoeffCheckDigit } from '../detection/verhoeff.js';
import type { Rng } from './rng.js';

/** 12-digit Aadhaar: first digit 2-9, last digit a Verhoeff check digit. */
export function aadhaar(rng: Rng): string {
  const payload = String(rng.int(2, 9)) + rng.digits(10);
  return payload + verhoeffCheckDigit(payload);
}

export type CardNetwork = 'visa' | 'mastercard' | 'amex' | 'discover' | 'rupay';

// IIN prefix ranges (inclusive) and lengths, from the table at
// https://en.wikipedia.org/wiki/Payment_card_number. Only the common length
// of each network is generated.
const CARD_NETWORKS: Record<CardNetwork, { ranges: readonly [number, number][]; length: number }> =
  {
    visa: { ranges: [[4, 4]], length: 16 },
    mastercard: {
      ranges: [
        [51, 55],
        [2221, 2720],
      ],
      length: 16,
    },
    amex: {
      ranges: [
        [34, 34],
        [37, 37],
      ],
      length: 15,
    },
    discover: {
      ranges: [
        [6011, 6011],
        [644, 649],
        [65, 65],
      ],
      length: 16,
    },
    rupay: {
      ranges: [
        [60, 60],
        [65, 65],
        [81, 82],
        [508, 508],
      ],
      length: 16,
    },
  };

export const CARD_NETWORK_NAMES = Object.keys(CARD_NETWORKS) as readonly CardNetwork[];

/** Luhn-valid card number with a real issuer prefix for `network` (random if omitted). */
export function cardNumber(rng: Rng, network: CardNetwork = rng.pick(CARD_NETWORK_NAMES)): string {
  const { ranges, length } = CARD_NETWORKS[network];
  const [low, high] = rng.pick(ranges);
  const prefix = String(rng.int(low, high));
  const payload = prefix + rng.digits(length - 1 - prefix.length);
  return payload + luhnCheckDigit(payload);
}

// Fourth character of a PAN: the holder type. Source:
// https://en.wikipedia.org/wiki/Permanent_account_number
export const PAN_ENTITY_CODES = ['A', 'B', 'C', 'F', 'G', 'H', 'L', 'J', 'P', 'T'] as const;

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const letter = (rng: Rng): string => LETTERS[rng.int(0, 25)]!;

/** PAN: 5 letters (the 4th a holder-type code), 4 digits, 1 letter. */
export function pan(rng: Rng): string {
  return (
    letter(rng) +
    letter(rng) +
    letter(rng) +
    rng.pick(PAN_ENTITY_CODES) +
    letter(rng) +
    rng.digits(4) +
    letter(rng)
  );
}

// Domains reserved for documentation and testing (RFC 2606, RFC 6761), so a
// generated address can never reach a real mailbox.
export const RESERVED_EMAIL_DOMAINS = [
  'example.com',
  'example.org',
  'example.net',
  'mail.example',
  'company.test',
] as const;

const GIVEN_NAMES = ['priya', 'rahul', 'ananya', 'arjun', 'meera', 'vikram', 'sara', 'john', 'li'];
const FAMILY_NAMES = ['sharma', 'iyer', 'khan', 'das', 'reddy', 'singh', 'smith', 'wong'];

/** Email address at a reserved domain, e.g. "priya.sharma42@example.com". */
export function email(rng: Rng): string {
  let local = rng.pick(GIVEN_NAMES);
  if (rng.chance(0.7)) local += rng.pick(['.', '_', '-', '']) + rng.pick(FAMILY_NAMES);
  if (rng.chance(0.5)) local += String(rng.int(1, 999));
  if (rng.chance(0.1)) local += '+' + rng.pick(['work', 'shop', 'news']);
  return `${local}@${rng.pick(RESERVED_EMAIL_DOMAINS)}`;
}

/** Indian mobile number, 10 digits starting 6-9, without country code. */
export function indianMobile(rng: Rng): string {
  return String(rng.int(6, 9)) + rng.digits(9);
}

/**
 * UK mobile number from the range Ofcom reserves for drama (07700 900000 to
 * 07700 900999), in international form without the plus: "447700900xxx".
 */
export function ukDramaMobile(rng: Rng): string {
  return '447700900' + String(rng.int(0, 999)).padStart(3, '0');
}

/** Splits `digits` into groups of the given sizes: groupDigits('123456', [3, 3], ' ') === '123 456'. */
export function groupDigits(digits: string, sizes: readonly number[], separator: string): string {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total !== digits.length) {
    throw new RangeError('groupDigits: group sizes must add up to the number of digits');
  }
  const groups: string[] = [];
  let at = 0;
  for (const size of sizes) {
    groups.push(digits.slice(at, at + size));
    at += size;
  }
  return groups.join(separator);
}

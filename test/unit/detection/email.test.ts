// Every address here uses a domain reserved for documentation or testing
// (RFC 2606, RFC 6761), so none can reach a real mailbox.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { detect } from '../../../src/detection/detect.js';
import { createRng } from '../../../src/synthetic/rng.js';
import { email } from '../../../src/synthetic/values.js';
import { compose } from '../../support/compose.js';
import { assertPropertyQuietly, seedArb } from '../../support/quiet-property.js';

/** The emails detect() finds in `text`, as the substrings they cover. */
const emails = (text: string): string[] =>
  detect(text)
    .filter((d) => d.type === 'EMAIL')
    .map((d) => text.slice(d.start, d.end));

describe('email detection', () => {
  it.each([
    'priya@example.com',
    'priya.sharma@example.com',
    'priya.sharma+work@example.org',
    'PRIYA@EXAMPLE.COM',
    'o’brien@example.com'.replace('’', "'"),
    'first_last-99@mail.example',
    'a@b.example',
    'user@sub.domain.example.net',
    'user@xn--80ak6aa92e.example',
    'user@example.xn--p1ai',
    'प्रिया@उदाहरण.भारत',
    'ünsal@bücher.example',
  ])('finds %s', (address) => {
    expect(emails(`Write to ${address} today`)).toEqual([address]);
  });

  it('is never validated and needs no context', () => {
    const { text, spans } = compose`${'priya@example.com'}`;
    expect(detect(text)).toEqual([
      { type: 'EMAIL', ...spans[0]!, validated: false, context: false },
    ]);
  });

  it.each([
    ['a full stop after it', 'Mail priya@example.com.', 'priya@example.com'],
    ['angle brackets', 'Priya <priya@example.com>', 'priya@example.com'],
    ['a mailto: link', '[mail](mailto:priya@example.com)', 'priya@example.com'],
    ['a comma-separated list', 'a@example.com,b@example.org', 'a@example.com'],
    ['a hyphen after it', 'x priya@example.com--thanks', 'priya@example.com'],
    ['a digit after it', 'x priya@example.com1', 'priya@example.com'],
    ['a stray dot before it', 'x .priya@example.com', 'priya@example.com'],
    ['a dotted word before it', 'see.priya@example.com', 'see.priya@example.com'],
  ])('stops at the right place with %s', (_name, text, first) => {
    expect(emails(text)[0] ?? null).toBe(first);
  });

  it('finds both addresses in a comma-separated list', () => {
    expect(emails('a@example.com,b@example.org')).toEqual(['a@example.com', 'b@example.org']);
  });

  it.each([
    ['no top-level domain', 'priya@localhost'],
    ['a one-letter top-level domain', 'priya@example.c'],
    ['a numeric top-level domain', 'priya@example.123'],
    ['nothing before the @', 'mail @example.com'],
    ['a handle', 'follow @priya on the app'],
    ['an empty label', 'priya@example..com'],
    ['a label starting with a hyphen', 'priya@-example.com'],
    ['a spelled-out address (known limit)', 'priya at example dot com'],
    ['a quoted local part (known limit)', '"priya sharma"@example.com'],
    ['an IP-literal domain (known limit)', 'priya@[192.0.2.1]'],
  ])('does not find an email with %s', (_name, text) => {
    // For the quoted form only the part after the space could match, and it
    // does not: the closing quote precedes the @.
    expect(emails(text)).toEqual([]);
  });

  it('finds generated addresses', () => {
    assertPropertyQuietly(
      fc.property(seedArb, (seed) => {
        const address = email(createRng(seed));
        const found = emails(`Contact: ${address}, thanks`);
        return found.length === 1 && found[0] === address;
      }),
    );
  });

  describe('backtracking (ReDoS) safety', () => {
    const fast = (text: string): number => {
      const t = performance.now();
      detect(text);
      return performance.now() - t;
    };

    it('scans a 50,000-character token with no @ in linear time', () => {
      expect(fast('a'.repeat(50_000))).toBeLessThan(1000);
      expect(fast('a.'.repeat(25_000))).toBeLessThan(1000);
    });

    it('scans a long domain with no valid top-level domain in linear time', () => {
      expect(fast(`priya@${'a.'.repeat(25_000)}1`)).toBeLessThan(1000);
      expect(fast(`priya@${'a-'.repeat(25_000)}`)).toBeLessThan(1000);
    });

    it('scans many @ signs in linear time', () => {
      expect(fast('a@'.repeat(25_000))).toBeLessThan(1000);
    });

    it('scans a 50,000-character domain label with no dot in linear time', () => {
      expect(fast(`priya@${'b'.repeat(50_000)}`)).toBeLessThan(1000);
    });
  });

  // The ReDoS guard limits where a match may START; it never skips long
  // input. Nothing in the pattern has a length limit, so a long address is
  // redacted whole, however long it is (fail closed).
  describe('long input fails closed: redacted whole, never skipped', () => {
    const whole = (text: string, address: string): boolean => {
      const start = text.indexOf(address);
      const found = detect(text);
      return (
        found.length === 1 &&
        found[0]!.type === 'EMAIL' &&
        found[0]!.start === start &&
        found[0]!.end === start + address.length
      );
    };

    it.each([
      ['a 300-character address', `${'p'.repeat(285)}@example.com`],
      ['a 50,000-character local part', `${'p'.repeat(50_000)}@example.com`],
      ['a 64-character domain label (over the DNS limit)', `priya@${'b'.repeat(64)}.example`],
      ['a 50,000-character domain label', `priya@${'b'.repeat(50_000)}.example`],
      ['a 5,000-character top-level domain', `priya@example.${'c'.repeat(5_000)}`],
    ])('finds %s', (_name, address) => {
      const t = performance.now();
      expect(whole(`Mail ${address} now`, address)).toBe(true);
      expect(performance.now() - t).toBeLessThan(1000);
    });

    it('finds an address after 100,000 characters of other text', () => {
      const address = 'priya@example.com';
      expect(whole(`${'lorem ipsum '.repeat(8_334)}${address}`, address)).toBe(true);
    });

    it('finds an address glued to the end of a 50,000-character token (the token is redacted too)', () => {
      const text = `${'z'.repeat(50_000)}priya@example.com`;
      expect(whole(text, text)).toBe(true);
    });
  });
});

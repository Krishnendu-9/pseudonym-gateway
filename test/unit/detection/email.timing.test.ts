// Linear-time checks moved from email.test.ts, names unchanged.
// They run in the `timing` project, after every other test and at most
// three files at a time, because load from other tests makes a growth
// ratio unreliable (vitest.config.ts, ADR-032).

import { describe, it } from 'vitest';
import { detect } from '../../../src/detection/detect.js';
import { expectLinearTime } from '../../support/linear-time.js';

describe('email detection', () => {
  // Each case makes the input 4 times longer and checks the time grows
  // about 4 times, not 16 or more (test/support/linear-time.ts).
  describe('backtracking (ReDoS) safety', () => {
    it.each([
      ['a long token with no @', (n: number) => 'a'.repeat(n)],
      ['a long dotted token with no @', (n: number) => 'a.'.repeat(n / 2)],
      [
        'a long domain with no valid top-level domain',
        (n: number) => `priya@${'a.'.repeat(n / 2)}1`,
      ],
      ['a long hyphenated domain', (n: number) => `priya@${'a-'.repeat(n / 2)}`],
      ['many @ signs', (n: number) => 'a@'.repeat(n / 2)],
      ['a long domain label with no dot', (n: number) => `priya@${'b'.repeat(n)}`],
    ])('scans %s in linear time', (_name, make) => {
      expectLinearTime(make, 25_000, detect);
    });
  });

  describe('long input fails closed: redacted whole, never skipped', () => {
    it.each([
      ['a long local part', (n: number) => `Mail ${'p'.repeat(n)}@example.com now`],
      ['a long domain label', (n: number) => `Mail priya@${'b'.repeat(n)}.example now`],
      ['a long top-level domain', (n: number) => `Mail priya@example.${'c'.repeat(n)} now`],
    ])('finds an address with %s in linear time', (_name, make) => {
      expectLinearTime(make, 25_000, detect);
    });
  });
});

describe('email: glued addresses', () => {
  it.each([
    ['glued addresses', (n: number) => 'ab@example.com-'.repeat(Math.ceil(n / 15))],
    ['local parts and "@" only', (n: number) => 'abcd.efg@'.repeat(Math.ceil(n / 9))],
  ])('reads %s in linear time', (_name, make) => {
    expectLinearTime(make, 25_000, detect);
  });
});

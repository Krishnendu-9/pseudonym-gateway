// Linear-time checks moved from number.test.ts, names unchanged.
// They run in the `timing` project, after every other test and at most
// three files at a time, because load from other tests makes a growth
// ratio unreliable (vitest.config.ts, ADR-032).

import { describe, it } from 'vitest';
import { detect } from '../../../src/detection/detect.js';
import type { Span } from '../../../src/detection/normalise.js';
import { unclaimedNumbers } from '../../../src/detection/number.js';
import { expectLinearTime } from '../../support/linear-time.js';

describe('unclaimedNumbers', () => {
  it('runs in linear time, with or without claims', () => {
    const joined = (n: number): string => '1-'.repeat(n / 2);
    expectLinearTime(joined, 250_000, (t) => unclaimedNumbers(t, []));
    // One run a million characters long, with a claim every 20 characters.
    const claims = (text: string): Span[] =>
      Array.from({ length: Math.floor(text.length / 20) }, (_, i) => ({
        start: i * 20,
        end: i * 20 + 4,
      }));
    expectLinearTime(joined, 250_000, (t) => unclaimedNumbers(t, claims(t)));
  });

  it('runs in linear time on one long token full of long numbers', () => {
    // Every stretch would widen over the whole token if it were walked again.
    const token = (n: number): string => '123456789a'.repeat(n / 10);
    expectLinearTime(token, 250_000, (t) => unclaimedNumbers(t, []));
    const lettersThenNumber = (n: number): string => `${'a'.repeat(n)}123456789`;
    expectLinearTime(lettersThenNumber, 250_000, (t) => unclaimedNumbers(t, []));
  });
});

describe('digits joined to a claimed span (J1)', () => {
  it('takes bracket-joined digits after phones in linear time', () => {
    const make = (n: number): string => '98765 43210(12'.repeat(Math.ceil(n / 14));
    expectLinearTime(make, 5_000, detect);
  });
});

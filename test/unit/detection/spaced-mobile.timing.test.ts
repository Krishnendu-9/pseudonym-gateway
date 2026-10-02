// Linear-time checks moved from spaced-mobile.test.ts, names unchanged.
// They run in the `timing` project, after every other test and at most
// three files at a time, because load from other tests makes a growth
// ratio unreliable (vitest.config.ts, ADR-032).

import { describe, it } from 'vitest';
import { spacedMobileCandidates } from '../../../src/detection/spaced-mobile.js';
import { createRng } from '../../../src/synthetic/rng.js';
import { groupDigits, indianMobile } from '../../../src/synthetic/values.js';
import { expectLinearTime, ofLength } from '../../support/linear-time.js';

const rng = createRng(3434);
const mobile = (): string => groupDigits(indianMobile(rng), [5, 5], ' ');

// Each input grows 4 times and the time must grow about 4 times, not 16
// (test/support/linear-time.ts). Every pair costs a libphonenumber check
// (about 0.05 ms), so inputs full of mobiles are small (bug-log 28, 30).
describe('spaced mobiles: linear time', () => {
  const m = mobile();
  it.each([
    [
      'an aligned sheet (every column holds)',
      2_000,
      (n: number) => ofLength(`Home ${m} ${m}\n`, n),
    ],
    ['one line of mobiles', 2_000, (n: number) => ofLength(`${m} `, n)],
    [
      'one long row and many short lines',
      4_000,
      (n: number) => `${ofLength(`${m} `, n / 2)}\n${ofLength('1\n', n / 2)}`,
    ],
    [
      'an amount table with one mobile row',
      32_000,
      (n: number) => `Home ${m} ${m}\n${ofLength('Jan 12345 23456 34567\n', n)}`,
    ],
  ])('the detector alone scans %s in linear time', (_name, size, make) => {
    const scan = (text: string): number => [...spacedMobileCandidates(text)].length;
    expectLinearTime(make, size, scan);
  });
});

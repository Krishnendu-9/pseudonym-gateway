// Linear-time checks moved from dob.test.ts, names unchanged.
// They run in the `timing` project, after every other test and at most
// three files at a time, because load from other tests makes a growth
// ratio unreliable (vitest.config.ts, ADR-032).

import { describe, it } from 'vitest';
import { detect } from '../../../src/detection/detect.js';
import { expectLinearTime } from '../../support/linear-time.js';

// Sizes from one timed run each, so a run takes tens of milliseconds:
// dotted digits cost the IP and safety-net detectors about 25 ms per
// thousand characters (the date detector itself is under 1 ms), and month
// names several times more than the rest (bug-log 28).
describe('date of birth: linear time', () => {
  it.each([
    ['slashed digits', 25_000, (n: number) => '12/'.repeat(n / 3)],
    ['dotted digits', 1_500, (n: number) => '1.2.'.repeat(n / 4)],
    ['month names', 6_250, (n: number) => '7 March '.repeat(n / 8)],
    ['month names and days', 6_250, (n: number) => 'March 7, '.repeat(n / 9)],
    [
      'digits before long runs of spaces',
      25_000,
      (n: number) => `7${' '.repeat(49)}`.repeat(n / 50),
    ],
    // Put together here: typed after its keyword, it would be a date of
    // birth in a file (repo-hygiene.test.ts).
    [
      'dates after keywords',
      25_000,
      (n: number) => ['DOB 07/03/', '1991 '].join('').repeat(n / 16),
    ],
  ])('scans %s in linear time', (_name, size, make) => {
    expectLinearTime(make, size, detect);
  });
});

// Linear-time checks moved from ifsc.test.ts, names unchanged.
// They run in the `timing` project, after every other test and at most
// three files at a time, because load from other tests makes a growth
// ratio unreliable (vitest.config.ts, ADR-032).

import { describe, it } from 'vitest';
import { detect } from '../../../src/detection/detect.js';
import { expectLinearTime } from '../../support/linear-time.js';

// Each case makes the input 4 times longer and checks the time grows about
// 4 times, not 16 (test/support/linear-time.ts). Sizes are chosen so one
// run takes a few milliseconds: "SBIN0" repeated costs the phone detector
// several times more per character than the others (bug-log 28).
describe('IFSC: linear time', () => {
  it.each([
    ['a long run of letters', 25_000, (n: number) => 'A'.repeat(n)],
    ['letters and zeros', 2_000, (n: number) => 'SBIN0'.repeat(n / 5)],
    ['IFSC-shaped codes glued together', 25_000, (n: number) => 'SBIN0001234'.repeat(n / 11)],
    ['IFSC-shaped codes after keywords', 25_000, (n: number) => 'IFSC ZZQX0123456 '.repeat(n / 17)],
  ])('scans %s in linear time', (_name, size, make) => {
    expectLinearTime(make, size, detect);
  });
});

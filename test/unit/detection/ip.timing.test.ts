// Linear-time checks moved from ip.test.ts, names unchanged.
// They run in the `timing` project, after every other test and at most
// three files at a time, because load from other tests makes a growth
// ratio unreliable (vitest.config.ts, ADR-032).

import { describe, it } from 'vitest';
import { detect } from '../../../src/detection/detect.js';
import { ipCandidates } from '../../../src/detection/ip.js';
import { expectLinearTime } from '../../support/linear-time.js';

// Each case makes the input 4 times longer and checks the time grows about
// 4 times, not 16 (test/support/linear-time.ts). Sizes are measured per
// input so that one run takes a few milliseconds (bug-log 28, 30): where
// digit groups sit next to each other the phone detector costs about 25 ms
// per 1,000 characters, so those inputs are small, and the IP detector is
// also timed on its own at full size.
describe('IP: linear time', () => {
  it.each([
    ['a long run of digits and dots', 500, (n: number) => '1.'.repeat(n / 2)],
    ['a long run of colons', 25_000, (n: number) => ':'.repeat(n)],
    ['hex and colons', 25_000, (n: number) => 'ab:'.repeat(n / 3)],
    ['addresses with ports, glued by colons', 500, (n: number) => '10.1.2.3:'.repeat(n / 9)],
    ['addresses after version words', 1_000, (n: number) => 'version 10.1.2.3 '.repeat(n / 17)],
    ['kept addresses', 1_000, (n: number) => '127.0.0.1 '.repeat(n / 10)],
    ['a long run glued to a word', 25_000, (n: number) => `x${'a:'.repeat(n / 2)}`],
  ])('detect() scans %s in linear time', (_name, size, make) => {
    expectLinearTime(make, size, detect);
  });

  it.each([
    ['addresses with ports, glued by colons', (n: number) => '10.1.2.3:'.repeat(n / 9)],
    ['addresses after version words', (n: number) => 'version 10.1.2.3 '.repeat(n / 17)],
    ['kept addresses', (n: number) => '127.0.0.1 '.repeat(n / 10)],
  ])('the IP detector alone scans %s in linear time', (_name, make) => {
    const scan = (text: string): number => [...ipCandidates(text)].length;
    expectLinearTime(make, 100_000, scan);
  });
});

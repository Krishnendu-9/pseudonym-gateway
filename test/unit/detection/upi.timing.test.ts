// Linear-time checks moved from upi.test.ts, names unchanged.
// They run in the `timing` project, after every other test and at most
// three files at a time, because load from other tests makes a growth
// ratio unreliable (vitest.config.ts, ADR-032).

import { describe, it } from 'vitest';
import { detect } from '../../../src/detection/detect.js';
import { UPI_HANDLES } from '../../../src/detection/upi.js';
import { expectLinearTime } from '../../support/linear-time.js';

// Each case makes the input 4 times longer and checks the time grows about
// 4 times, not 16 (test/support/linear-time.ts).
describe('UPI IDs: linear time', () => {
  it.each([
    ['a long name with no "@"', (n: number) => 'a.'.repeat(n / 2)],
    ['names and "@" with no handle', (n: number) => 'a@-'.repeat(n / 3)],
    // Handles on no list: a known one would make these UPI IDs typed in a
    // file (repo-hygiene.test.ts; bug-log 26). Speed does not depend on it.
    ['IDs chained by "@"', (n: number) => 'a@zzq@'.repeat(n / 6)],
    ['IDs each followed by a dot', (n: number) => 'a@zzq.'.repeat(n / 6)],
    ['handles with short domain-like tails', (n: number) => 'a@b.cd.e '.repeat(n / 9)],
    ['one handle with a long domain-like tail', (n: number) => `a@${'b.'.repeat(n / 2)}`],
    ['one handle with a long hyphenated tail', (n: number) => `a@${'b-'.repeat(n / 2)}`],
  ])('scans %s in linear time', (_name, make) => {
    expectLinearTime(make, 25_000, detect);
  });
});

describe('UPI: glued IDs', () => {
  const handle = [...UPI_HANDLES][0]!;

  it('reads glued IDs in linear time', () => {
    const unit = `ab@${handle}-`;
    const make = (n: number): string => unit.repeat(Math.ceil(n / unit.length));
    expectLinearTime(make, 25_000, detect);
  });
});

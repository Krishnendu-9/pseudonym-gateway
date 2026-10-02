// Linear-time checks moved from passport.test.ts, names unchanged.
// They run in the `timing` project, after every other test and at most
// three files at a time, because load from other tests makes a growth
// ratio unreliable (vitest.config.ts, ADR-032).

import { describe, it } from 'vitest';
import { detect } from '../../../src/detection/detect.js';
import { expectLinearTime } from '../../support/linear-time.js';

describe('passport: linear time', () => {
  it.each([
    ['letters and digits glued together', 25_000, (n: number) => 'A1234567'.repeat(n / 8)],
    // Put together here: typed after its keyword, it would be a passport
    // number in a file (repo-hygiene.test.ts).
    [
      'passport shapes after keywords',
      25_000,
      (n: number) => ['passport A', '1234567 '].join('').repeat(n / 18),
    ],
  ])('scans %s in linear time', (_name, size, make) => {
    expectLinearTime(make, size, detect);
  });
});

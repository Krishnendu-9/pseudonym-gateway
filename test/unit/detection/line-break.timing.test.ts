// Linear-time checks moved from line-break.test.ts, names unchanged.
// They run in the `timing` project, after every other test and at most
// three files at a time, because load from other tests makes a growth
// ratio unreliable (vitest.config.ts, ADR-032).

import { describe, it } from 'vitest';
import { detect } from '../../../src/detection/detect.js';
import { createRng } from '../../../src/synthetic/rng.js';
import { indianMobile } from '../../../src/synthetic/values.js';
import { expectLinearTime, ofLength } from '../../support/linear-time.js';

const rng = createRng(30_030);

// Each input grows 4 times and the time must grow about 4 times, not 16
// (test/support/linear-time.ts). Every line join costs a libphonenumber
// call, so inputs made of joins are small (bug-log 28, 30).
describe('line joins: linear time', () => {
  const m = indianMobile(rng);
  it.each([
    ['many short lines of digits', 2_000, (n: number) => ofLength('71234\n', n)],
    ['wrapped mobiles', 2_000, (n: number) => ofLength(`${m.slice(0, 5)}\n${m.slice(5)} x\n`, n)],
    [
      'two long runs on two lines',
      2_000,
      (n: number) => `${ofLength('1 ', n / 2)}\n${ofLength('2 ', n / 2)}`,
    ],
  ])('detect scans %s in linear time', (_name, size, make) => {
    expectLinearTime(make, size, detect);
  });
});

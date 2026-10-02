// Linear-time checks moved from unsafe-regions.test.ts, names unchanged.
// They run in the `timing` project, after every other test and at most
// three files at a time, because load from other tests makes a growth
// ratio unreliable (vitest.config.ts, ADR-032).

import { describe, it } from 'vitest';
import { unsafeRegions } from '../../../src/redaction/unsafe-regions.js';
import { expectLinearTime, ofLength } from '../../support/linear-time.js';

// Bug-log 16: two Phase 2 patterns rescanned to the end of the line from
// every place they could start. The scanner does fixed work per character.
describe('unsafeRegions: linear time (bug-log 16)', () => {
  it.each([
    ['"](< " repeated', '](< '],
    ['"[a " repeated', '[a '],
    ['unclosed "=\\"" repeated', 'a=" '],
    ['unclosed "=\'" repeated', "a=' "],
    ['a URL with a placeholder, repeated', 'https://a.example/[AADHAAR_1] '],
    ['a host label chain, repeated', 'a-b.c'],
    ['prose', 'word word '],
  ])('%s', (_name, unit) => {
    const make = (n: number): string => ofLength(unit, n);
    expectLinearTime(make, 80_000, unsafeRegions);
  });
});

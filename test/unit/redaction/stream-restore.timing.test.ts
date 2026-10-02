// Linear-time checks moved from stream-restore.test.ts, names unchanged.
// They run in the `timing` project, after every other test and at most
// three files at a time, because load from other tests makes a growth
// ratio unreliable (vitest.config.ts, ADR-032).

import { describe, it } from 'vitest';
import { StreamRestorer } from '../../../src/redaction/restore.js';
import { expectLinearTime } from '../../support/linear-time.js';
import { testMapping } from '../../support/restoration-text.js';

const mapping = testMapping();

describe('StreamRestorer: linear time', () => {
  it.each([
    ['placeholders and link syntax, in 3-unit chunks', '[CARD_1] ](< [a Card_1 '],
    ['prose, in 3-unit chunks', 'word word '],
  ])('%s', (_name, unit) => {
    const make = (n: number): string => unit.repeat(n);
    const stream = (text: string): string => {
      const restorer = new StreamRestorer(mapping);
      let out = '';
      for (let i = 0; i < text.length; i += 3) out += restorer.push(text.slice(i, i + 3));
      return out + restorer.end();
    };
    expectLinearTime(make, 2_000, stream);
  });
});

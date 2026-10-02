// Linear-time checks moved from restore.test.ts, names unchanged.
// They run in the `timing` project, after every other test and at most
// three files at a time, because load from other tests makes a growth
// ratio unreliable (vitest.config.ts, ADR-032).

import { describe, it } from 'vitest';
import { PlaceholderMapping } from '../../../src/redaction/mapping.js';
import type { PlaceholderNamespace } from '../../../src/redaction/placeholder.js';
import { restore } from '../../../src/redaction/restore.js';
import { expectLinearTime, ofLength } from '../../support/linear-time.js';

function mappingWith(
  entries: readonly [namespace: PlaceholderNamespace, value: string][],
): PlaceholderMapping {
  const mapping = new PlaceholderMapping();
  for (const [namespace, value] of entries) {
    mapping.getOrAssign(namespace, value, value);
  }
  return mapping;
}

// Bug-log 17: dropping bare matches inside brackets compared every bare
// match with every bracketed one.
describe('restore: linear time (bug-log 17)', () => {
  it.each([
    ['brackets and bare forms mixed', '[CARD_1] CARD_1 '],
    ['placeholders in URLs', 'https://a.example/[CARD_1] '],
    ['prose', 'word word '],
  ])('%s', (_name, unit) => {
    const mapping = mappingWith([['CARD', '4111111111111111']]);
    const make = (n: number): string => ofLength(unit, n);
    expectLinearTime(make, 50_000, (text) => restore(text, mapping));
  });
});

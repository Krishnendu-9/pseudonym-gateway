// restore()'s optional counter (ADR-033): what it restored, and by which
// rule it left a placeholder as it is. The counter must never change the
// output. Values are opaque synthetic strings, so plain `toBe` is safe.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PlaceholderMapping } from '../../../src/redaction/mapping.js';
import type { PlaceholderNamespace } from '../../../src/redaction/placeholder.js';
import {
  emptyRestoreCounts,
  HELD_BACK_RULES,
  restore,
  StreamRestorer,
  type RestoreCounts,
} from '../../../src/redaction/restore.js';
import { assertPropertyQuietly } from '../../support/quiet-property.js';
import { streamedAnswerArb, testMapping } from '../../support/restoration-text.js';

function mappingWith(...namespaces: readonly PlaceholderNamespace[]): PlaceholderMapping {
  const mapping = new PlaceholderMapping();
  for (const namespace of namespaces) mapping.getOrAssign(namespace, namespace, `«${namespace}»`);
  return mapping;
}

/** The counts that are not zero. */
const nonZero = (counts: RestoreCounts): Record<string, number> =>
  Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));

const countsOf = (text: string, mapping = mappingWith('EMAIL', 'CARD', 'AADHAAR')) => {
  const counts = emptyRestoreCounts();
  restore(text, mapping, {}, counts);
  return nonZero(counts);
};

describe('restore counts: restored, and left by rule', () => {
  it('starts every count at zero', () => {
    expect(emptyRestoreCounts()).toEqual({
      restored: 0,
      ...Object.fromEntries(HELD_BACK_RULES.map((rule) => [rule, 0])),
    });
  });

  it.each([
    ['Mail [EMAIL_1] and [CARD_1] today', { restored: 2 }],
    [
      'See [x](https://a.example/?d=[EMAIL_1]) and [CARD_1]',
      { restored: 1, 'markdown-destination': 1 },
    ],
    ['[ref]: https://a.example/?d=[EMAIL_1]', { 'reference-label': 1 }],
    ['<a href="mailto:[EMAIL_1]">[EMAIL_1]</a>', { restored: 1, 'html-attribute': 1 }],
    ['Visit https://a.example/?d=[EMAIL_1] now', { url: 1 }],
    ['[x](<a [EMAIL_1] b\n[CARD_1]', { restored: 1, 'unclosed-angle': 1 }],
    ['<b title="[EMAIL_1]\n[CARD_1]', { 'unclosed-quote': 2 }],
    ['Host [CARD_1].attacker.example, then [CARD_1].', { restored: 1, host: 1 }],
    ['Card 1 was declined; [CARD_1] was not.', { restored: 1, 'bare-space': 1 }],
  ])('%s', (text, expected) => {
    expect(countsOf(text)).toEqual(expected);
  });

  it('a placeholder in a region is counted under the region, even when the host rule also holds', () => {
    expect(countsOf('Visit https://a.example/[EMAIL_1].b now')).toEqual({ url: 1 });
  });

  it('counts only placeholders the mapping holds', () => {
    // Unknown index, unknown namespace, a bare form of an exact-only entry.
    const mapping = mappingWith('PAN');
    mapping.reserve('PAN', 1);
    expect(countsOf('[PAN_7] [PERSON_1] PAN_1 https://a.example/[PAN_7] Pan 7', mapping)).toEqual(
      {},
    );
  });

  it('bare-space: only a `Type N` form of a namespace that has none, outside a bracket', () => {
    // "[Card 1]" is the bracketed form (restored); "Aadhaar 1" is restored
    // (AADHAAR keeps its bare-space form); "CARD 1" is counted.
    expect(countsOf('[Card 1], Aadhaar 1, CARD 1.')).toEqual({ restored: 2, 'bare-space': 1 });
  });

  it('with the safety rules off, nothing is left and everything restores', () => {
    const counts = emptyRestoreCounts();
    const text = '<a href="https://a.example/?d=[EMAIL_1]">[CARD_1].x</a>';
    restore(text, mappingWith('EMAIL', 'CARD'), { restoreInUnsafeRegions: true }, counts);
    expect(nonZero(counts)).toEqual({ restored: 2 });
  });

  it('adds to the counts it is given', () => {
    const counts = emptyRestoreCounts();
    const mapping = mappingWith('EMAIL');
    restore('[EMAIL_1]', mapping, {}, counts);
    restore('https://a.example/[EMAIL_1] [EMAIL_1]', mapping, {}, counts);
    expect(nonZero(counts)).toEqual({ restored: 2, url: 1 });
  });

  it('a stream counts a region rule at end(), when an unclosed construct is known', () => {
    const counts = emptyRestoreCounts();
    const restorer = new StreamRestorer(mappingWith('EMAIL'), {}, counts);
    restorer.push('<b title="[EMAIL_1] x [EMAIL_1].a ');
    expect(nonZero(counts)).toEqual({});
    restorer.push('" [EMAIL_1].a b');
    expect(nonZero(counts)).toEqual({ host: 1 });
    restorer.end();
    expect(nonZero(counts)).toEqual({ 'html-attribute': 2, host: 1 });
  });
});

describe('restore counts: properties', () => {
  const held = (counts: RestoreCounts): number =>
    HELD_BACK_RULES.filter((rule) => rule !== 'bare-space').reduce((n, r) => n + counts[r], 0);

  it('never change the output', () => {
    const mapping = testMapping();
    assertPropertyQuietly(
      fc.property(streamedAnswerArb, ({ text }) => {
        const counts = emptyRestoreCounts();
        return restore(text, mapping, {}, counts) === restore(text, mapping);
      }),
      { numRuns: 5_000 },
    );
  });

  it('are the same however the answer is cut into pieces (bare-space aside)', () => {
    const mapping = testMapping();
    assertPropertyQuietly(
      fc.property(streamedAnswerArb, ({ text, chunks }) => {
        const whole = emptyRestoreCounts();
        restore(text, mapping, {}, whole);
        const streamed = emptyRestoreCounts();
        const restorer = new StreamRestorer(mapping, {}, streamed);
        for (const chunk of chunks) restorer.push(chunk);
        restorer.end();
        return JSON.stringify({ ...whole, 'bare-space': 0 }) === JSON.stringify(streamed);
      }),
      { numRuns: 5_000 },
    );
  });

  it('every placeholder a rule left is restored once the rules are off', () => {
    const mapping = testMapping();
    assertPropertyQuietly(
      fc.property(streamedAnswerArb, ({ text }) => {
        const safe = emptyRestoreCounts();
        restore(text, mapping, {}, safe);
        const off = emptyRestoreCounts();
        restore(text, mapping, { restoreInUnsafeRegions: true }, off);
        return off.restored === safe.restored + held(safe) && held(off) === 0;
      }),
      { numRuns: 5_000 },
    );
  });
});

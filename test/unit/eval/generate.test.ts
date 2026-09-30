// The generated dataset's shape. Its text holds generated values, so these
// tests count and compare; they never print a message.

import { describe, expect, it } from 'vitest';
import {
  CASES_BY_KIND,
  GENERATED_SEED,
  generateCases,
  generateRawCases,
  SHARE_WITHOUT_VALUES,
  VALUES_PER_TYPE,
} from '../../../eval/generate.js';
import { lintCases } from '../../../eval/lint.js';
import { PERSONAL_TYPES, type LabelledCase } from '../../../eval/types.js';

const cases = generateCases();
const messages = cases.flatMap((c) => c.messages);

const tally = <T extends string>(items: readonly T[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item] = (counts[item] ?? 0) + 1;
  return counts;
};

/** Distinct personal values by type (a value in two pieces is one value). */
function valuesByType(set: readonly LabelledCase[]): Record<string, number> {
  const seen = new Map<string, string>();
  for (const c of set) {
    for (const m of c.messages) {
      for (const p of m.pieces) if (p.type !== 'NOT') seen.set(p.valueId, p.type);
    }
  }
  return tally([...seen.values()]);
}

describe('the generated dataset', () => {
  it('has 600 messages in 500 cases, with unique ids', () => {
    expect([cases.length, messages.length]).toEqual([500, 600]);
    expect(new Set(cases.map((c) => c.id)).size).toBe(500);
  });

  it('mixes tickets, emails, chats and records as planned', () => {
    expect(tally(cases.map((c) => c.tags[0]!))).toEqual(CASES_BY_KIND);
    expect(cases.filter((c) => c.tags[0] === 'chat').every((c) => c.messages.length === 3)).toBe(
      true,
    );
    expect(cases.filter((c) => c.tags[0] !== 'chat').every((c) => c.messages.length === 1)).toBe(
      true,
    );
  });

  it('is half English, 30% Hinglish, 10% Hindi and 10% mixed', () => {
    expect(tally(cases.map((c) => c.tags[1]!))).toEqual({
      en: 250,
      hinglish: 150,
      hi: 50,
      mixed: 50,
    });
  });

  it('really is in those languages: Devanagari where it says Hindi, none where it says English', () => {
    // Letters only: a value may be written in Devanagari digits in any message.
    const devanagari = /[ऄ-ह]/;
    const has = (language: string): boolean[] =>
      cases
        .filter((c) => c.tags[1] === language && c.tags[0] !== 'record')
        .map((c) => c.messages.some((m) => devanagari.test(m.text)));
    expect(has('hi').every(Boolean)).toBe(true);
    expect(has('en').some(Boolean)).toBe(false);
    expect(has('mixed').some(Boolean)).toBe(true);
  });

  it(`plants every type exactly ${VALUES_PER_TYPE} times`, () => {
    expect(valuesByType(cases)).toEqual(
      Object.fromEntries(PERSONAL_TYPES.map((type) => [type, VALUES_PER_TYPE])),
    );
  });

  it('leaves one message in five without any personal value', () => {
    const without = messages.filter((m) => m.pieces.every((p) => p.type === 'NOT')).length;
    expect(without).toBe(600 * SHARE_WITHOUT_VALUES);
  });

  it('puts at most six values in a message, and at least one in every other message', () => {
    const counts = messages.map((m) => m.pieces.filter((p) => p.type !== 'NOT').length);
    expect(Math.max(...counts)).toBeLessThanOrEqual(6);
    expect(counts.filter((n) => n === 0)).toHaveLength(120);
  });

  it('contains lookalikes of every kind, and typos and variants', () => {
    const labels = new Set(
      messages.flatMap((m) => m.pieces.map((p) => `${p.type}.${p.label ?? ''}`)),
    );
    for (const expected of [
      'NOT.order',
      'NOT.tracking',
      'NOT.invoice',
      'NOT.ticket',
      'NOT.otp',
      'NOT.reference',
      'NOT.transaction',
      'NOT.timestamp',
      'NOT.sku',
      'NOT.version',
      'NOT.datetime',
      'NOT.private-ip',
      'NOT.loopback',
      'AADHAAR.typo',
      'CARD.typo',
      'CARD.amex',
      'PAN.typo',
      'IFSC.unknown',
      'UPI.mobile',
      'UPI.unknown',
      'SECRET.password',
      'SECRET.jwt',
    ]) {
      expect([expected, labels.has(expected)]).toEqual([expected, true]);
    }
  });

  it('labels stay inside their message and never overlap', () => {
    const ok = messages.every((m) =>
      m.pieces.every(
        (p, i) =>
          p.start >= (i === 0 ? 0 : m.pieces[i - 1]!.end) &&
          p.end <= m.text.length &&
          p.required.length > 0 &&
          p.required.every((at) => at >= p.start && at < p.end),
      ),
    );
    expect(ok).toBe(true);
  });

  it('is the same on every run, and different for another seed', () => {
    const again = generateCases(GENERATED_SEED);
    const other = generateCases(GENERATED_SEED + 1);
    const text = (set: readonly LabelledCase[]): string =>
      set.map((c) => c.messages.map((m) => m.text).join('\n')).join('\n');
    expect([text(again) === text(cases), text(other) === text(cases)]).toEqual([true, false]);
    // Another seed is another dataset of the same shape.
    expect([other.length, valuesByType(other).AADHAAR]).toEqual([500, VALUES_PER_TYPE]);
  });
});

describe('the generator’s templates', () => {
  it('pass the same lint as hand-written cases: nothing typed looks like a value', () => {
    for (const seed of [GENERATED_SEED, 1, 2, 3]) {
      const problems = lintCases(generateRawCases(seed)).map((p) => `${p.caseId}: ${p.rule}`);
      expect(problems).toEqual([]);
    }
  });
});

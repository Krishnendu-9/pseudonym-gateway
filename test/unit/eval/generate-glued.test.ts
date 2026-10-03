// The generated set's glued-literal shape (bug-log 58): values glued to text
// shaped like a placeholder. Counts and where the literal sits only; no
// value is printed (ADR-009).

import { describe, expect, it } from 'vitest';
import { generateCases, SHAPE_VALUES } from '../../../eval/generate.js';
import { SHAPE_TAG } from '../../../eval/types.js';

const cases = generateCases().filter((c) => c.tags.includes(`${SHAPE_TAG}glued-literal`));
// What may sit between a literal and its value: nothing, one joiner, a
// bracket, or a combining mark.
const GLUE_BETWEEN = ['', '-', '.', '(', ')', String.fromCharCode(0x301)];
const LITERAL = /\[(?:PAN|CARD|pan|LITERAL|PERSON|Aadhaar|EMAIL|number)[_ ][1-9]\]/gu;

describe('generated set, shape glued-literal', () => {
  it('has 108 cases of one message and one personal value each', () => {
    expect(SHAPE_VALUES['glued-literal']).toBe(108);
    expect(cases).toHaveLength(108);
    for (const c of cases) {
      expect(c.messages).toHaveLength(1);
      expect(c.messages[0]!.pieces.filter((p) => p.type !== 'NOT')).toHaveLength(1);
    }
  });

  it('covers eight types, each several times', () => {
    const byType: Record<string, number> = {};
    for (const c of cases) {
      for (const p of c.messages[0]!.pieces) {
        if (p.type !== 'NOT') byType[p.type] = (byType[p.type] ?? 0) + 1;
      }
    }
    expect(byType).toEqual({
      NUMBER: 18,
      AADHAAR: 12,
      CARD: 12,
      PHONE: 18,
      UPI: 6,
      EMAIL: 12,
      IP: 6,
      SECRET: 24,
    });
  });

  it('glues every value to a literal: right before or after it, or with one joiner, mark or the literal between', () => {
    const spellings = new Set<string>();
    for (const c of cases) {
      const m = c.messages[0]!;
      const value = m.pieces.find((p) => p.type !== 'NOT')!;
      const literals = [...m.text.matchAll(LITERAL)];
      expect(literals.length).toBeGreaterThan(0);
      for (const l of literals) spellings.add(l[0]);
      const glued = literals.some((l) => {
        const end = l.index + l[0].length;
        const between =
          end <= value.start ? m.text.slice(end, value.start) : m.text.slice(value.end, l.index);
        return GLUE_BETWEEN.includes(between);
      });
      expect(glued).toBe(true);
    }
    expect([...spellings].sort()).toEqual(
      [
        '[PAN_1]',
        '[CARD_2]',
        '[pan 1]',
        '[LITERAL_1]',
        '[PERSON_3]',
        '[Aadhaar 2]',
        '[EMAIL_1]',
        '[number_4]',
      ].sort(),
    );
  });
});

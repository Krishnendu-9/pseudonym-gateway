// The model-rewrite classifier and ADR-017's decision rule. Values here are
// opaque synthetic strings and example.com addresses, so plain assertions
// are safe.

import { describe, expect, it } from 'vitest';
import {
  classifyAnswer,
  decide,
  sentValues,
  totals,
  type ConditionTotals,
} from '../../../eval/rewrites.js';
import { PlaceholderMapping } from '../../../src/redaction/mapping.js';

function mapping(): PlaceholderMapping {
  const m = new PlaceholderMapping();
  m.getOrAssign('EMAIL', 'a', 'a@example.com');
  m.getOrAssign('CARD', 'c', '«card-1»');
  m.getOrAssign('LITERAL', '[PERSON_1]', '[PERSON_1]');
  return m;
}

describe('sentValues', () => {
  it('every value the mapping holds, LITERAL left out, by namespace then index', () => {
    const m = mapping();
    m.getOrAssign('EMAIL', 'b', 'b@example.com');
    expect(sentValues(m)).toEqual([
      { namespace: 'CARD', index: 1 },
      { namespace: 'EMAIL', index: 1 },
      { namespace: 'EMAIL', index: 2 },
    ]);
    expect(sentValues(new PlaceholderMapping())).toEqual([]);
  });
});

describe('classifyAnswer', () => {
  const values = sentValues(mapping());
  const fates = (answer: string) => classifyAnswer(answer, mapping(), values).fates;

  it.each([
    ['exactly', 'Card [CARD_1], email [EMAIL_1].'],
    ['in a form restoration reads', 'Card CARD_1, email [email 1].'],
  ])('restored: %s', (_, answer) => {
    expect(fates(answer)).toEqual(['restored', 'restored']);
  });

  it('held: only a URL would bring it back', () => {
    expect(fates('See https://a.example/?c=[CARD_1] and [EMAIL_1].')).toEqual(['held', 'restored']);
  });

  it.each([
    ['Email 1', 'Email 1'],
    ['[EMAIL_:1]', 'EMAIL_:1'],
    ['email #1', 'email #1'],
    ['EMAIL-1.', 'EMAIL-1'],
  ])('rewritten: %s', (written, form) => {
    const verdict = classifyAnswer(`[CARD_1] and ${written}`, mapping(), values);
    expect(verdict.fates).toEqual(['restored', 'rewritten']);
    expect(verdict.rewrites).toEqual([form]);
  });

  it.each([
    ['not mentioned', '[CARD_1] only.'],
    ['another index', '[CARD_1] and EMAIL 12.'],
    ['glued to a word', '[CARD_1] and XEMAIL 1.'],
    ['too far apart', '[CARD_1] and email: - # 1.'],
  ])('dropped: %s', (_, answer) => {
    expect(fates(answer)).toEqual(['restored', 'dropped']);
  });

  it('invented: placeholder shapes the mapping does not hold, each once', () => {
    const verdict = classifyAnswer(
      '[CARD_1] [EMAIL_1] [PERSON_1] [EMAIL_2] [EMAIL_2] PAN_3 Aadhaar 2 [Step 4]',
      mapping(),
      values,
    );
    expect(verdict.invented).toEqual(['[PERSON_1]', '[EMAIL_2]', '[Step 4]', 'PAN_3', 'Aadhaar 2']);
  });

  it('a bare form inside a bracketed one is not a second invention', () => {
    const verdict = classifyAnswer('[CARD_1] [EMAIL_1] [PAN_2] [Aadhaar 3]', mapping(), values);
    expect(verdict.invented).toEqual(['[PAN_2]', '[Aadhaar 3]']);
  });

  it('nothing invented when every placeholder is held', () => {
    expect(classifyAnswer('[CARD_1] CARD_1 [Email 1]', mapping(), values).invented).toEqual([]);
  });
});

describe('totals and the ADR-017 decision rule', () => {
  const t = (rewritten: number, dropped: number, invented: number): ConditionTotals => ({
    values: 10,
    restored: 10 - rewritten - dropped,
    held: 0,
    rewritten,
    dropped,
    invented,
  });

  it('adds the verdicts of one condition', () => {
    expect(
      totals([
        { fates: ['restored', 'held'], rewrites: [], invented: ['[X_1]'] },
        { fates: ['rewritten', 'dropped', 'restored'], rewrites: ['Email 1'], invented: [] },
      ]),
    ).toEqual({ values: 5, restored: 2, held: 1, rewritten: 1, dropped: 1, invented: 1 });
  });

  it('on, when it leaves fewer values unrestored and invents no more', () => {
    expect(decide(t(1, 0, 0), t(1, 1, 0))).toBe('on');
    expect(decide(t(0, 0, 2), t(3, 0, 2))).toBe('on');
  });

  it('off, when it leaves at least as many unrestored, a tie at 0 included', () => {
    expect(decide(t(1, 1, 0), t(2, 0, 0))).toBe('off');
    expect(decide(t(0, 0, 0), t(0, 0, 0))).toBe('off');
    expect(decide(t(3, 0, 0), t(1, 0, 0))).toBe('off');
  });

  it('off, when it invents more placeholders, even with fewer unrestored', () => {
    expect(decide(t(0, 0, 1), t(5, 0, 0))).toBe('off');
  });
});

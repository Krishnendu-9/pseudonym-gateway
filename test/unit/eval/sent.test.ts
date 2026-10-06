// The count of personal values sent as written (ADR-040). The texts hold a
// synthetic address at example.com and an invented first name only, so
// plain assertions are safe here.

import { describe, expect, it } from 'vitest';
import { knownFailingMismatches, sent, sentByShape, type Redactor } from '../../../eval/sent.js';
import { SHAPE_TAG, type LabelledCase, type TruthPiece } from '../../../eval/types.js';

const piece = (text: string, part: string, type: TruthPiece['type'], n: number): TruthPiece => {
  const start = text.indexOf(part);
  return {
    valueId: `X#${n}`,
    type,
    start,
    end: start + part.length,
    required: Array.from({ length: part.length }, (_, i) => start + i),
  };
};

const TEXT = 'Mail priya@example.com, ask Asha, order 4512.';
const message = {
  role: 'user' as const,
  text: TEXT,
  pieces: [
    piece(TEXT, 'priya@example.com', 'EMAIL', 1),
    piece(TEXT, 'Asha', 'PERSON', 2),
    piece(TEXT, '4512', 'NOT', 3),
  ],
};
const labelled = (id: string, tags: readonly string[] = []): LabelledCase => ({
  id,
  tags,
  messages: [message],
});

describe('sent', () => {
  it('counts labelled personal values only, and those still in the redacted text', () => {
    // The email is redacted; the name is not (names are off), so it is sent;
    // the order number is a lookalike and not counted at all.
    expect(sent([labelled('A')])).toEqual({ values: 2, sent: 1 });
  });

  it('reads what the redactor returns: one that redacts nothing sends every value', () => {
    const nothing: Redactor = (text) => text as ReturnType<Redactor>;
    expect(sent([labelled('A')], { redactor: nothing })).toEqual({ values: 2, sent: 2 });
  });

  it('a value whose text also occurs elsewhere in what is sent counts as sent', () => {
    // The name is redacted by a fake redactor that also writes it back
    // elsewhere: the count errs towards a leak.
    const echoName: Redactor = (text) =>
      `${text.replace('priya@example.com', '[EMAIL_1]').replace('Asha', '[PERSON_1]')} Asha` as ReturnType<Redactor>;
    expect(sent([labelled('A')], { redactor: echoName })).toEqual({ values: 2, sent: 1 });
  });

  it('nothing to count', () => {
    expect(sent([])).toEqual({ values: 0, sent: 0 });
  });
});

describe('sentByShape', () => {
  it('the same parts as the echo: main, then each shape in order of appearance', () => {
    const parts = sentByShape([
      labelled('A', ['ticket', `${SHAPE_TAG}glued-literal`]),
      labelled('B', ['ticket']),
      labelled('C', [`${SHAPE_TAG}glued-literal`]),
    ]);
    expect(Object.keys(parts)).toEqual(['glued-literal', 'main']);
    expect(parts['glued-literal']).toEqual({ values: 4, sent: 2 });
    expect(parts.main).toEqual({ values: 2, sent: 1 });
  });
});

describe('knownFailingMismatches', () => {
  const measured = { 'glued-literal': { values: 108, sent: 3 } };
  const entry = { part: 'glued-literal', sent: 3, why: 'bug-log 61' };

  it('an entry that matches its part exactly is silent', () => {
    expect(knownFailingMismatches([entry], measured)).toEqual([]);
  });

  it('fewer or more sent than the entry says both fail, naming the entry', () => {
    expect(knownFailingMismatches([{ ...entry, sent: 4 }], measured)).toEqual([
      'known-failing glued-literal: the entry says 4 sent, measured 3',
    ]);
    expect(knownFailingMismatches([{ ...entry, sent: 2 }], measured)).toHaveLength(1);
  });

  it('an entry for a part that no longer exists fails', () => {
    expect(knownFailingMismatches([{ ...entry, part: 'gone' }], measured)).toEqual([
      'known-failing gone: the entry says 3 sent, measured no such part',
    ]);
  });
});

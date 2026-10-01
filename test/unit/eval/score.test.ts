// The scorer, on hand-made labels and a scripted detector: text here is
// placeholder letters, never a value.

import { describe, expect, it } from 'vitest';
import { loadCases } from '../../../eval/render.js';
import { percent, prf, score, scoreByTag, type Detector } from '../../../eval/score.js';
import type { LabelledCase, LabelledMessage, TruthPiece, TruthType } from '../../../eval/types.js';

const range = (start: number, end: number): number[] =>
  Array.from({ length: end - start }, (_, i) => start + i);

const piece = (
  valueId: string,
  type: TruthType,
  start: number,
  end: number,
  extra: { required?: number[]; label?: string } = {},
): TruthPiece => ({
  valueId,
  type,
  start,
  end,
  required: extra.required ?? range(start, end),
  ...(extra.label === undefined ? {} : { label: extra.label }),
});

const message = (text: string, pieces: TruthPiece[]): LabelledMessage => ({
  role: 'user',
  text,
  pieces,
});
const oneCase = (...messages: LabelledMessage[]): LabelledCase => ({
  id: 'C',
  tags: ['t'],
  messages,
});

type Found = { type: string; start: number; end: number };
/** A detector that answers from a table: text -> detections. */
const scripted =
  (table: Record<string, Found[]>): Detector =>
  (text) =>
    table[text] ?? [];

const TEXT = 'aa VVVVVVVV bb'; // a value at [3, 11)
const value = (type: TruthType = 'AADHAAR'): TruthPiece => piece('C#1', type, 3, 11);
const row = (found: Found[], pieces: TruthPiece[] = [value()], type = 'AADHAAR') =>
  score([oneCase(message(TEXT, pieces))], scripted({ [TEXT]: found })).types[type as 'AADHAAR'];

describe('score: was the value kept from the provider?', () => {
  it('redacted and typed: one detection of the right type covers it', () => {
    expect(row([{ type: 'AADHAAR', start: 3, end: 11 }])).toMatchObject({
      values: 1,
      redacted: 1,
      typed: 1,
      partial: 0,
      missed: 0,
      detections: 1,
      rightType: 1,
    });
  });

  it('a wider detection still counts', () => {
    expect(row([{ type: 'AADHAAR', start: 0, end: 14 }])).toMatchObject({ redacted: 1, typed: 1 });
  });

  it('redacted but not typed: covered by another type', () => {
    const scored = score(
      [oneCase(message(TEXT, [value()]))],
      scripted({ [TEXT]: [{ type: 'NUMBER', start: 3, end: 11 }] }),
    );
    expect(scored.types.AADHAAR).toMatchObject({ values: 1, redacted: 1, typed: 0 });
    expect(scored.types.NUMBER).toMatchObject({
      detections: 1,
      rightType: 0,
      otherPersonal: 1,
      notPersonal: 0,
    });
  });

  it('redacted but not typed: two detections of the right type, neither covering it all', () => {
    expect(
      row([
        { type: 'AADHAAR', start: 3, end: 7 },
        { type: 'AADHAAR', start: 7, end: 11 },
      ]),
    ).toMatchObject({ redacted: 1, typed: 0, detections: 2, rightType: 2 });
  });

  it('partial: one character left out is a leak, not a redaction', () => {
    expect(row([{ type: 'AADHAAR', start: 3, end: 10 }])).toMatchObject({
      redacted: 0,
      typed: 0,
      partial: 1,
      missed: 0,
    });
  });

  it('missed: nothing covers it', () => {
    expect(row([])).toMatchObject({ values: 1, redacted: 0, partial: 0, missed: 1, detections: 0 });
    expect(row([{ type: 'AADHAAR', start: 0, end: 3 }])).toMatchObject({ missed: 1 });
  });

  it('only the value’s own characters must be covered, not its separators', () => {
    // "VVVV VVV": the space at 7 is not required.
    const spaced = piece('C#1', 'AADHAAR', 3, 11, { required: [3, 4, 5, 6, 8, 9, 10] });
    const found = [
      { type: 'AADHAAR', start: 3, end: 7 },
      { type: 'AADHAAR', start: 8, end: 11 },
    ];
    expect(row(found, [spaced])).toMatchObject({ redacted: 1, typed: 0 });
    expect(row([{ type: 'AADHAAR', start: 3, end: 11 }], [spaced])).toMatchObject({ typed: 1 });
  });

  it('a value in two messages is redacted only if both pieces are', () => {
    const first = message('xx VVVV', [piece('C#1', 'CARD', 3, 7)]);
    const second = message('VVVV yy', [piece('C#1', 'CARD', 0, 4)]);
    const both = scripted({
      'xx VVVV': [{ type: 'CARD', start: 3, end: 7 }],
      'VVVV yy': [{ type: 'CARD', start: 0, end: 4 }],
    });
    const firstOnly = scripted({ 'xx VVVV': [{ type: 'CARD', start: 3, end: 7 }] });
    const mixedTypes = scripted({
      'xx VVVV': [{ type: 'CARD', start: 3, end: 7 }],
      'VVVV yy': [{ type: 'NUMBER', start: 0, end: 4 }],
    });
    expect(score([oneCase(first, second)], both).types.CARD).toMatchObject({
      values: 1,
      redacted: 1,
      typed: 1,
    });
    expect(score([oneCase(first, second)], firstOnly).types.CARD).toMatchObject({
      values: 1,
      redacted: 0,
      partial: 1,
    });
    expect(score([oneCase(first, second)], mixedTypes).types.CARD).toMatchObject({
      redacted: 1,
      typed: 0,
    });
  });

  it('the same value id in two cases is two values', () => {
    const scored = score(
      [oneCase(message(TEXT, [value()])), oneCase(message(TEXT, [value()]))],
      scripted({}),
    );
    expect([scored.types.AADHAAR.values, scored.cases, scored.messages]).toEqual([2, 2, 2]);
  });
});

describe('score: what did each detection cover?', () => {
  it('nothing labelled: an over-redaction of plain text', () => {
    const scored = score(
      [oneCase(message(TEXT, [value()]))],
      scripted({ [TEXT]: [{ type: 'PHONE', start: 0, end: 2 }] }),
    );
    expect(scored.types.PHONE).toMatchObject({ detections: 1, notPersonal: 1 });
    expect(scored.overRedactions).toEqual({ 'plain text': { PHONE: 1 } });
  });

  it('a NOT slot: an over-redaction under the slot’s label', () => {
    const pieces = [piece('C#1', 'NOT', 0, 2, { label: 'order' }), piece('C#2', 'NOT', 3, 11)];
    const scored = score(
      [oneCase(message(TEXT, pieces))],
      scripted({
        [TEXT]: [
          { type: 'NUMBER', start: 0, end: 2 },
          { type: 'NUMBER', start: 3, end: 5 },
          { type: 'AADHAAR', start: 5, end: 11 },
        ],
      }),
    );
    expect(scored.overRedactions).toEqual({
      'NOT.order': { NUMBER: 1 },
      'NOT.unlabelled': { NUMBER: 1, AADHAAR: 1 },
    });
    expect(scored.types.NUMBER.notPersonal).toBe(2);
    // NOT is not a value: nothing to redact, nothing missed.
    expect(Object.values(scored.types).every((t) => t.values === 0)).toBe(true);
  });

  it('a detection over a personal value and a lookalike is not an over-redaction', () => {
    const pieces = [piece('C#1', 'NOT', 0, 2), value('PHONE')];
    expect(row([{ type: 'PHONE', start: 0, end: 11 }], pieces, 'PHONE')).toMatchObject({
      rightType: 1,
      notPersonal: 0,
    });
  });

  it('touching only the fixed text of a value (its "+91") does not count as covering it', () => {
    const withPrefix = piece('C#1', 'PHONE', 0, 11, { required: range(3, 11) });
    const scored = score(
      [oneCase(message(TEXT, [withPrefix]))],
      scripted({ [TEXT]: [{ type: 'NUMBER', start: 0, end: 2 }] }),
    );
    expect(scored.types.NUMBER).toMatchObject({ otherPersonal: 0, notPersonal: 1 });
    expect(scored.types.PHONE).toMatchObject({ missed: 1 });
  });

  it('ignores detections of a type it does not know', () => {
    const scored = score(
      [oneCase(message(TEXT, [value()]))],
      scripted({ [TEXT]: [{ type: 'LITERAL', start: 3, end: 11 }] }),
    );
    // Still covered: redaction is by any span. But no row counts the detection.
    expect(scored.types.AADHAAR).toMatchObject({ redacted: 1, typed: 0 });
    expect(Object.values(scored.types).every((t) => t.detections === 0)).toBe(true);
  });
});

describe('score: with the real detectors', () => {
  it('finds a typed email and a published test card, and leaves plain text alone', () => {
    const cases = loadCases(
      '=== A | t\n@user\nmail {{EMAIL=priya@example.com}} card {{CARD=4111 1111 1111 1111}} on 12 March',
      1,
    );
    const scored = score(cases);
    expect(scored.types.EMAIL).toMatchObject({ values: 1, redacted: 1, typed: 1, rightType: 1 });
    expect(scored.types.CARD).toMatchObject({ values: 1, redacted: 1, typed: 1, rightType: 1 });
    expect(scored.overRedactions).toEqual({});
  });
});

describe('score: by shape (the generated set’s shape block)', () => {
  const tagged = (id: string, tags: string[], text = TEXT): LabelledCase => ({
    id,
    tags,
    messages: [message(text, [piece(`${id}#1`, 'AADHAAR', 3, 11)])],
  });
  const PARTLY = 'aa WWWWWWWW bb';
  const MISSED = 'aa XXXXXXXX bb';
  const detector = scripted({
    [TEXT]: [{ type: 'AADHAAR', start: 3, end: 11 }],
    [PARTLY]: [{ type: 'NUMBER', start: 3, end: 6 }],
  });
  const cases = [
    tagged('A', ['ticket', 'en']),
    tagged('B', ['ticket', 'en', 'shape:line-break'], PARTLY),
    tagged('C', ['chat', 'hi', 'shape:line-break'], MISSED),
    tagged('D', ['ticket', 'en', 'shape:line-break']),
  ];

  it('is not tallied unless asked for', () => {
    expect(score(cases, detector).shapes).toEqual({});
  });

  it('tallies each shape in the order it first appears; a case with no shape tag is "main"', () => {
    expect(score(cases, detector, { byShape: true }).shapes).toEqual({
      main: { values: 1, redacted: 1, partial: 0 },
      'line-break': { values: 3, redacted: 1, partial: 1 },
    });
  });

  it('counts a value in two messages once, and only tags that start with "shape:"', () => {
    const split: LabelledCase = {
      id: 'S',
      tags: ['chat', 'shape-ish', 'shape:message-split'],
      messages: [
        message(TEXT, [piece('S#1', 'AADHAAR', 3, 11)]),
        message(MISSED, [piece('S#1', 'AADHAAR', 3, 11)]),
      ],
    };
    expect(score([split], detector, { byShape: true }).shapes).toEqual({
      'message-split': { values: 1, redacted: 0, partial: 1 },
    });
  });
});

describe('scoreByTag', () => {
  it('scores the cases of each tag; a case with two tags counts under both', () => {
    const tagged = (id: string, tags: string[]): LabelledCase => ({
      id,
      tags,
      messages: [message(TEXT, [value()])],
    });
    const byTag = scoreByTag(
      [tagged('A', ['x', 'y']), tagged('B', ['y'])],
      scripted({ [TEXT]: [{ type: 'AADHAAR', start: 3, end: 11 }] }),
    );
    expect([...byTag.keys()]).toEqual(['x', 'y']);
    expect([byTag.get('x')!.cases, byTag.get('y')!.cases]).toEqual([1, 2]);
    expect(byTag.get('y')!.types.AADHAAR.redacted).toBe(2);
  });
});

describe('percent and prf', () => {
  it('cuts to one decimal and never rounds up', () => {
    expect(percent(2, 3)).toBe('66.6%');
    expect(percent(1, 1)).toBe('100.0%');
    expect(percent(999, 1000)).toBe('99.9%');
    expect(percent(9999, 10000)).toBe('99.9%');
    expect(percent(0, 7)).toBe('0.0%');
    expect(percent(0, 0)).toBe('-');
  });

  it('precision over detections, recall over values, F1 from both', () => {
    const base = row([]);
    expect(prf({ ...base, values: 10, typed: 8, detections: 16, rightType: 8 })).toEqual({
      precision: 0.5,
      recall: 0.8,
      f1: (2 * 0.5 * 0.8) / (0.5 + 0.8),
    });
    expect(prf({ ...base, values: 0, detections: 0 })).toEqual({
      precision: undefined,
      recall: undefined,
      f1: undefined,
    });
    expect(prf({ ...base, values: 4, typed: 0, detections: 2, rightType: 0 }).f1).toBeUndefined();
    expect(prf({ ...base, values: 4, typed: 0, detections: 0 }).precision).toBeUndefined();
  });
});

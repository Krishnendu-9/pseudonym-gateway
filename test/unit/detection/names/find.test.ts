import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  extendOverInvisibles,
  MalformedModelOutput,
  MODEL_POINT,
  modelSpans,
  nameSpans,
} from '../../../../src/detection/names/find.js';
import { GAZETTEER } from '../../../../src/detection/names/gazetteer.js';
import { assertPropertyQuietly } from '../../../support/quiet-property.js';

const TEXT = 'Please ask Asha Rao about it.';
const ASHA_RAO = { start: 11, end: 19 };

describe('modelSpans: what the model may answer (ADR-037)', () => {
  const refused = (texts: readonly string[], output: unknown): void => {
    expect(() => modelSpans(texts, output)).toThrow(MalformedModelOutput);
  };

  it('takes one list of spans per text', () => {
    expect(modelSpans([TEXT, 'none'], [[{ ...ASHA_RAO, score: 0.95 }], []])).toEqual([
      [{ ...ASHA_RAO, score: 0.95 }],
      [],
    ]);
  });

  it('refuses an answer that is not one list per text', () => {
    refused([TEXT], undefined);
    refused([TEXT], {});
    refused([TEXT], []);
    refused([TEXT], [[], []]);
    refused([TEXT], ['spans']);
    refused([TEXT], [null]);
  });

  it('refuses a span that is not an object with three numbers', () => {
    refused([TEXT], [[null]]);
    refused([TEXT], [[7]]);
    refused([TEXT], [[{ start: 11, end: 19 }]]);
    refused([TEXT], [[{ start: '11', end: 19, score: 0.9 }]]);
    refused([TEXT], [[{ start: 11, end: '19', score: 0.9 }]]);
    refused([TEXT], [[{ start: 11, end: 19, score: '0.9' }]]);
  });

  it('refuses offsets past the end, negative offsets, start after end, and non-integers', () => {
    const at = (start: number, end: number): unknown => [[{ start, end, score: 0.9 }]];
    refused([TEXT], at(11, TEXT.length + 1));
    refused([TEXT], at(TEXT.length + 1, TEXT.length + 2));
    refused([TEXT], at(-1, 4));
    refused([TEXT], at(-5, -1));
    refused([TEXT], at(19, 11));
    refused([TEXT], at(11.5, 19));
    refused([TEXT], at(11, Number.NaN));
    refused([TEXT], at(11, Number.POSITIVE_INFINITY));
  });

  it('refuses a score outside [0, 1] or not a number', () => {
    for (const score of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      refused([TEXT], [[{ ...ASHA_RAO, score }]]);
    }
  });

  it('refuses more spans than the text has characters', () => {
    refused(['abc'], [[0, 1, 2, 3].map(() => ({ start: 0, end: 1, score: 0.9 }))]);
    expect(
      modelSpans(['abc'], [[0, 1, 2].map(() => ({ start: 0, end: 1, score: 0.9 }))]),
    ).toHaveLength(1);
  });

  it('drops a span with no characters, at any position, instead of widening it into a word', () => {
    expect(modelSpans([TEXT], [[{ start: 13, end: 13, score: 1 }]])).toEqual([[]]);
    expect(modelSpans([TEXT], [[{ start: TEXT.length, end: TEXT.length, score: 1 }]])).toEqual([
      [],
    ]);
  });

  it('keeps overlapping spans, a span over the whole text, scores 0 and 1, and an edge inside a surrogate pair', () => {
    const spans = [
      { start: 11, end: 15, score: 0 },
      { start: 13, end: 19, score: 1 },
      { start: 0, end: TEXT.length, score: 0.5 },
    ];
    expect(modelSpans([TEXT], [spans])).toEqual([spans]);
    expect(modelSpans(['a😀b'], [[{ start: 2, end: 4, score: 0.9 }]])).toEqual([
      [{ start: 2, end: 4, score: 0.9 }],
    ]);
  });
});

describe('nameSpans: the measured configuration (ADR-035)', () => {
  it('uses B at high 0.9 / mid 0.6', () => {
    expect(MODEL_POINT).toEqual({ high: 0.9, mid: 0.6 });
  });

  it('keeps a model span at 0.9 or more, and at 0.6 or more only with a cue', () => {
    const at = (score: number): unknown => nameSpans(TEXT, [{ ...ASHA_RAO, score }], new Set());
    expect(at(0.9)).toEqual([ASHA_RAO]);
    expect(at(0.89)).toEqual([]);
    expect(at(0.6)).toEqual([]);
    // "Hello" is a cue within 24 characters. F takes nothing here (it needs
    // a capital, and a cue right before the run), so only the model decides.
    const cued = 'Hello, we asked rao today.';
    const rao = { start: 16, end: 19 };
    expect(nameSpans(cued, [], new Set())).toEqual([]);
    expect(nameSpans(cued, [{ ...rao, score: 0.6 }], new Set())).toEqual([rao]);
    expect(nameSpans(cued, [{ ...rao, score: 0.59 }], new Set())).toEqual([]);
  });

  it('widens a model span to whole words', () => {
    expect(nameSpans(TEXT, [{ start: 12, end: 17, score: 0.95 }], new Set())).toEqual([ASHA_RAO]);
  });

  it("adds F's names from the list given, with no model span", () => {
    const latin = [...GAZETTEER].find((name) => /^[a-z]{4,}$/.test(name))!;
    const name = latin[0]!.toUpperCase() + latin.slice(1);
    const text = `We met ${name} today.`;
    expect(nameSpans(text, [], GAZETTEER)).toEqual([{ start: 7, end: 7 + name.length }]);
    expect(nameSpans(text, [], new Set())).toEqual([]);
  });

  it("joins the model's span and F's where they meet", () => {
    const text = 'Dear Asha Rao, hello.';
    // F takes "Asha Rao" after the cue "Dear"; the model only "Rao".
    expect(nameSpans(text, [{ start: 10, end: 13, score: 0.95 }], new Set())).toEqual([
      { start: 5, end: 13 },
    ]);
  });

  it('extends over an invisible character inside a name (option 2, ADR-036)', () => {
    const text = 'Please ask Ash\u00ADa Rao about it.';
    expect(nameSpans(text, [{ start: 11, end: 14, score: 0.95 }], new Set())).toEqual([
      { start: 11, end: 16 },
    ]);
  });
});

describe('extendOverInvisibles: option 2 of ADR-036', () => {
  it('runs on past invisible characters to the end of the word, after a span', () => {
    expect(extendOverInvisibles('Pri\u00ADyanka x', [{ start: 0, end: 3 }])).toEqual([
      { start: 0, end: 9 },
    ]);
    expect(extendOverInvisibles('Pri\u200B\u2060\uFEFFyanka', [{ start: 0, end: 3 }])).toEqual([
      { start: 0, end: 11 },
    ]);
  });

  it('and back to the start of the word, before a span', () => {
    expect(extendOverInvisibles('x Asha\u200Drani', [{ start: 7, end: 11 }])).toEqual([
      { start: 2, end: 11 },
    ]);
  });

  it('repeats, across several invisible characters in one word', () => {
    expect(extendOverInvisibles('a\u00ADb\u00ADc\u00ADd', [{ start: 0, end: 1 }])).toEqual([
      { start: 0, end: 7 },
    ]);
    expect(extendOverInvisibles('a\u00ADb\u00ADc\u00ADd', [{ start: 6, end: 7 }])).toEqual([
      { start: 0, end: 7 },
    ]);
  });

  it('takes a combining mark, and letters outside the BMP whole', () => {
    expect(extendOverInvisibles('ab\u200B\u0301c', [{ start: 0, end: 2 }])).toEqual([
      { start: 0, end: 5 },
    ]);
    expect(extendOverInvisibles('ab\u200B𐐀𐐁', [{ start: 0, end: 2 }])).toEqual([
      { start: 0, end: 7 },
    ]);
    expect(extendOverInvisibles('𐐀\u200Bab', [{ start: 3, end: 5 }])).toEqual([
      { start: 0, end: 5 },
    ]);
  });

  it('does not run past an invisible character that a letter does not follow', () => {
    for (const text of ['Asha\u00AD rest', 'Asha\u00AD', 'Asha\u00AD5', 'Asha\u00AD-x']) {
      expect(extendOverInvisibles(text, [{ start: 0, end: 4 }])).toEqual([{ start: 0, end: 4 }]);
    }
    expect(extendOverInvisibles('\u00ADAsha', [{ start: 1, end: 5 }])).toEqual([
      { start: 1, end: 5 },
    ]);
  });

  it('merges spans that meet once extended', () => {
    expect(
      extendOverInvisibles('Asha\u00ADrani', [
        { start: 0, end: 4 },
        { start: 5, end: 9 },
      ]),
    ).toEqual([{ start: 0, end: 9 }]);
  });

  it('changes nothing in a text without invisible characters', () => {
    const textAndSpans = fc
      .string({ unit: fc.constantFrom('a', 'B', ' ', '-', 'आ', 'ा', '7'), minLength: 1 })
      .chain((text) =>
        fc
          .array(fc.tuple(fc.nat(text.length), fc.nat(text.length)), { maxLength: 5 })
          .map((pairs) => ({
            text,
            spans: pairs.map(([a, b]) => ({ start: Math.min(a, b), end: Math.max(a, b) })),
          })),
      );
    assertPropertyQuietly(
      fc.property(textAndSpans, ({ text, spans }) => {
        const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
        const merged: { start: number; end: number }[] = [];
        for (const s of sorted) {
          const last = merged.at(-1);
          if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
          else merged.push({ ...s });
        }
        return JSON.stringify(extendOverInvisibles(text, spans)) === JSON.stringify(merged);
      }),
    );
  });
});

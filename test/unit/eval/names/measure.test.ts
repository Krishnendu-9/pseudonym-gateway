import { describe, expect, it } from 'vitest';
import type { Span } from '../../../../src/detection/normalise.js';
import { fpPer1000, measure, share, wordsIn } from '../../../../eval/names/measure.js';
import type { LabelledCase, TruthPiece } from '../../../../eval/types.js';

/** A labelled piece over `word` in `text`, every non-space character required. */
function piece(
  text: string,
  word: string,
  type: TruthPiece['type'],
  valueId: string,
  label?: string,
): TruthPiece {
  const start = text.indexOf(word);
  const required: number[] = [];
  for (let i = start; i < start + word.length; i++) if (text[i] !== ' ') required.push(i);
  return { valueId, type, start, end: start + word.length, required, ...(label ? { label } : {}) };
}

const NAMES_TAGS = ['shape:names', 'name-region:north', 'name-form:full', 'name-place:intro'];
const n1 = 'My name is Kavya. Pune is far.';
const n2 = 'Hi Arya.';
const m1 = 'Ask Arjun now. Hello Team.';
const s1 = 'Mail a@example.com now';
const CASES: LabelledCase[] = [
  {
    id: 'N1',
    tags: ['ticket', 'en', ...NAMES_TAGS, 'name-lang:en', 'name-script:latin'],
    messages: [
      {
        role: 'user',
        text: n1,
        pieces: [piece(n1, 'Kavya', 'PERSON', 'N1#1'), piece(n1, 'Pune', 'NOT', 'N1#2', 'place')],
      },
    ],
  },
  {
    id: 'N2',
    tags: ['ticket', 'hi', ...NAMES_TAGS, 'name-lang:hi', 'name-script:devanagari'],
    messages: [{ role: 'user', text: n2, pieces: [piece(n2, 'Arya', 'PERSON', 'N2#1')] }],
  },
  {
    id: 'M1',
    tags: ['ticket', 'en'],
    messages: [{ role: 'user', text: m1, pieces: [piece(m1, 'Arjun', 'PERSON', 'M1#1')] }],
  },
  {
    id: 'S1',
    tags: ['ticket', 'en', 'shape:in-markup'],
    messages: [{ role: 'user', text: s1, pieces: [piece(s1, 'a@example.com', 'EMAIL', 'S1#1')] }],
  },
];

const at = (text: string, word: string): Span => {
  const start = text.indexOf(word);
  return { start, end: start + word.length };
};
const FOUND = new Map<string, Span[]>([
  [n1, [at(n1, 'Kavya'), at(n1, 'Pune')]],
  // Part of the name: the right type, though the value is not redacted.
  [n2, [at(n2, 'Ary')]],
  [m1, [at(m1, 'Arjun'), at(m1, 'Team')]],
  [s1, [at(s1, 'a@example.com')]],
]);

describe('measure', () => {
  const m = measure(CASES, (text) => FOUND.get(text)!);

  it('gives R on the names block only, and the main cases apart', () => {
    expect(m.recall).toEqual({ hit: 1, of: 2 });
    expect(m.main).toEqual({ hit: 1, of: 1 });
  });

  it('gives a row per tag of the reported groups, and no other tag', () => {
    expect(m.rows).toEqual({
      'name-form:full': { hit: 1, of: 2 },
      'name-lang:en': { hit: 1, of: 1 },
      'name-lang:hi': { hit: 0, of: 1 },
      'name-place:intro': { hit: 1, of: 2 },
      'name-region:north': { hit: 1, of: 2 },
      'name-script:devanagari': { hit: 0, of: 1 },
      'name-script:latin': { hit: 1, of: 1 },
    });
  });

  it('counts precision over every case, and over-redactions by what they covered', () => {
    // Kavya, part of Arya and Arjun are right; Pune, Team and the address are not.
    expect(m.precision).toEqual({ hit: 3, of: 6 });
    expect(m.plainText).toBe(1);
    expect(m.lookalikes).toEqual({ 'NOT.place': 1 });
    expect(m.words).toBe(17);
    expect(fpPer1000(m)).toBeCloseTo(1000 / 17);
  });

  it('gives zeros, not NaN, for nothing at all', () => {
    const empty = measure([], () => []);
    expect([fpPer1000(empty), share(empty.recall), empty.plainText]).toEqual([0, 0, 0]);
    expect(wordsIn([])).toBe(0);
    const blank: LabelledCase = {
      id: 'X',
      tags: [],
      messages: [{ role: 'user', text: ' \n ', pieces: [] }],
    };
    expect(wordsIn([blank])).toBe(0);
  });
});

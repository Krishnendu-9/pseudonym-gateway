import { describe, expect, it } from 'vitest';
import { detectionsAt, grid, merge, widenToWords } from '../../../../eval/names/spans.js';

describe('widenToWords', () => {
  it('widens a piece of a word to the whole word, on both sides', () => {
    const text = 'Hi Kavyashree, ok';
    expect(widenToWords(text, { start: 5, end: 8 })).toEqual({ start: 3, end: 13 });
  });

  it('keeps a span that is already whole words, and stops at spaces and punctuation', () => {
    expect(widenToWords('Hi Kavya, ok', { start: 3, end: 8 })).toEqual({ start: 3, end: 8 });
    expect(widenToWords('Kavya', { start: 0, end: 5 })).toEqual({ start: 0, end: 5 });
  });

  it('takes Devanagari vowel signs and viramas with their letters', () => {
    const text = 'नाम कविता है';
    // Only the first letter of the name: the rest are letters and signs.
    expect(widenToWords(text, { start: 4, end: 5 })).toEqual({ start: 4, end: 9 });
    // From inside, a vowel sign and all.
    expect(widenToWords(text, { start: 6, end: 7 })).toEqual({ start: 4, end: 9 });
  });

  it('steps over a letter outside the BMP as one character, and never splits a pair', () => {
    const bold = '\u{1D400}'; // MATHEMATICAL BOLD CAPITAL A, a letter
    expect(widenToWords(`${bold}b`, { start: 2, end: 3 })).toEqual({ start: 0, end: 3 });
    expect(widenToWords(`b${bold}`, { start: 0, end: 1 })).toEqual({ start: 0, end: 3 });
    // A lone high surrogate is no letter.
    expect(widenToWords('\uD835b', { start: 1, end: 2 })).toEqual({ start: 1, end: 2 });
  });
});

describe('merge', () => {
  it('joins overlapping and touching spans, in text order', () => {
    expect(
      merge([
        { start: 10, end: 12 },
        { start: 0, end: 3 },
        { start: 2, end: 5 },
        { start: 5, end: 6 },
        { start: 8, end: 9 },
      ]),
    ).toEqual([
      { start: 0, end: 6 },
      { start: 8, end: 9 },
      { start: 10, end: 12 },
    ]);
    expect(
      merge([
        { start: 0, end: 9 },
        { start: 2, end: 4 },
      ]),
    ).toEqual([{ start: 0, end: 9 }]);
    expect(merge([])).toEqual([]);
  });
});

describe('detectionsAt', () => {
  // "Dear" cues Kavya; nothing cues Karan (more than 24 characters on) or Meera.
  const text = 'Dear Kavya, the file about Karan is with Meera.';
  const at = (word: string, score: number) => {
    const start = text.indexOf(word);
    return { start, end: start + word.length, score };
  };
  const spans = [at('Kavya', 0.4), at('Karan', 0.4), at('Meera', 0.9)];
  const words = (point: Parameters<typeof detectionsAt>[2]): string[] =>
    detectionsAt(text, spans, point).map((s) => text.slice(s.start, s.end));

  it('keeps spans at or above high', () => {
    expect(words({ high: 0.9 })).toEqual(['Meera']);
    expect(words({ high: 0.95 })).toEqual([]);
  });

  it('keeps spans at or above mid only with a cue nearby', () => {
    expect(words({ high: 0.9, mid: 0.4 })).toEqual(['Kavya', 'Meera']);
    expect(words({ high: 0.9, mid: 0.45 })).toEqual(['Meera']);
  });

  it('widens what it keeps to whole words and merges it', () => {
    const piece = [{ start: text.indexOf('Kavya') + 1, end: text.indexOf('Kavya') + 3, score: 1 }];
    expect(detectionsAt(text, [...piece, ...piece], { high: 0.5 })).toEqual([
      { start: 5, end: 10 },
    ]);
  });
});

describe('grid', () => {
  it('is the fixed grid of ADR-035: 10 highs, each alone and with every mid below it', () => {
    const points = grid();
    expect(points).toHaveLength(135);
    expect(points[0]).toEqual({ high: 0.5 });
    expect(points.filter((p) => p.mid === undefined).map((p) => p.high)).toEqual([
      0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95,
    ]);
    expect(points.every((p) => p.mid === undefined || (p.mid >= 0.1 && p.mid < p.high))).toBe(true);
    expect(points.filter((p) => p.high === 0.7).map((p) => p.mid)).toEqual([
      undefined,
      0.1,
      0.15,
      0.2,
      0.25,
      0.3,
      0.35,
      0.4,
      0.45,
      0.5,
      0.55,
      0.6,
      0.65,
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  charAt,
  charBefore,
  digitRuns,
  digitWindows,
  standsAlone,
  widenToRuns,
} from '../../../src/detection/digit-runs.js';

// Small digit strings only: the windows here are shapes, not values.
const windows = (text: string, min: number, max: number) =>
  [...digitWindows(text, min, max)].map((w) => ({
    text: text.slice(w.start, w.end),
    groups: w.groups,
    wholeRun: w.wholeRun,
  }));

describe('digitWindows', () => {
  it('finds every stretch of whole groups with the right number of digits', () => {
    expect(windows('x 12 345 6789 y', 5, 7)).toEqual([
      { text: '12 345', groups: [2, 3], wholeRun: false },
      { text: '345 6789', groups: [3, 4], wholeRun: false },
    ]);
    expect(windows('x 12 345 6789 y', 9, 9)).toEqual([
      { text: '12 345 6789', groups: [2, 3, 4], wholeRun: true },
    ]);
  });

  it.each([
    ['space', '12 34'],
    ['dot', '12.34'],
    ['hyphen', '12-34'],
    ['en dash', '12–34'],
    ['minus sign', '12−34'],
    ['space, hyphen, space', '12 - 34'],
    ['two spaces', '12  34'],
  ])('joins groups separated by a %s', (_name, text) => {
    expect(windows(text, 4, 4)).toEqual([{ text, groups: [2, 2], wholeRun: true }]);
  });

  it('does not join groups separated by four characters, a comma or a slash', () => {
    expect(windows('12 -- 34', 4, 4)).toEqual([]);
    expect(windows('12,34', 4, 4)).toEqual([]);
    expect(windows('12/34', 4, 4)).toEqual([]);
  });

  it('does not end a run on a trailing separator (the full stop of a sentence)', () => {
    expect(windows('is 1234.', 4, 4)).toEqual([{ text: '1234', groups: [4], wholeRun: true }]);
  });

  it('never splits a group', () => {
    expect(windows('123456', 3, 3)).toEqual([]);
  });

  it('skips a window that would go past the maximum', () => {
    expect(windows('1234567890123456789012', 12, 19)).toEqual([]);
  });

  it.each([
    ['a letter', 'A1234 x'],
    ['a Devanagari letter', 'र1234 x'],
    ['an underscore', '_1234 x'],
    ['an @', '@1234 x'],
    ['a plus sign (a phone number)', '+1234 x'],
    ['a letter outside the BMP', '\u{10400}1234 x'],
  ])('rejects a run glued to %s before it', (_name, text) => {
    expect(windows(text, 4, 4)).toEqual([]);
  });

  it.each([
    ['a letter', 'x 1234A'],
    ['a combining mark', 'x 1234́'],
    ['an underscore', 'x 1234_'],
    ['an @ (part of an email address)', 'x 1234@example.com'],
  ])('rejects a run glued to %s after it', (_name, text) => {
    expect(windows(text, 4, 4)).toEqual([]);
  });

  it('still offers the inner groups of a run glued at one end', () => {
    expect(windows('A12 3456 7890', 8, 8)).toEqual([
      { text: '3456 7890', groups: [4, 4], wholeRun: false },
    ]);
    expect(windows('1234 5678 90A', 8, 8)).toEqual([
      { text: '1234 5678', groups: [4, 4], wholeRun: false },
    ]);
  });

  it('accepts a run next to an emoji (a symbol, not a letter)', () => {
    expect(windows('\u{1F4DE}1234\u{1F44D}', 4, 4)).toEqual([
      { text: '1234', groups: [4], wholeRun: true },
    ]);
  });
});

describe('standsAlone', () => {
  const window = (groups: number[], wholeRun: boolean) => ({
    start: 0,
    end: 0,
    digits: '',
    groups,
    wholeRun,
  });

  it('accepts a whole run in any grouping', () => {
    expect(standsAlone(window([2, 5, 5], true), [[4, 4, 4]])).toBe(true);
  });

  it('accepts a single unbroken group inside a longer run', () => {
    expect(standsAlone(window([12], false), [[4, 4, 4]])).toBe(true);
  });

  it('accepts part of a run only in one of the listed layouts', () => {
    expect(standsAlone(window([4, 4, 4], false), [[4, 4, 4]])).toBe(true);
    expect(standsAlone(window([4, 4, 4], false), [[4, 6, 5]])).toBe(false);
    expect(standsAlone(window([4, 8], false), [[4, 4, 4]])).toBe(false);
    expect(standsAlone(window([4, 4], false), [[4, 4, 4]])).toBe(false);
  });
});

describe('charBefore and charAt', () => {
  it('return whole code points, and empty strings at the ends', () => {
    const text = 'a\u{1F600}b';
    expect(charBefore(text, 0)).toBe('');
    expect(charBefore(text, 1)).toBe('a');
    expect(charBefore(text, 3)).toBe('\u{1F600}');
    expect(charAt(text, 1)).toBe('\u{1F600}');
    expect(charAt(text, 4)).toBe('');
  });

  it('treat a lone surrogate as one character', () => {
    expect(charBefore('a\uDE00', 2)).toBe('\uDE00');
    expect(charBefore('\uDE00', 1)).toBe('\uDE00');
  });
});

describe('widenToRuns', () => {
  const text = 'a 12 3456 b 78-90 c';
  const runs = digitRuns(text); // "12 3456" at [2, 9), "78-90" at [12, 17)

  it('finds the runs', () => {
    expect(runs).toEqual([
      { start: 2, end: 9 },
      { start: 12, end: 17 },
    ]);
  });

  it('widens a span inside a run to the whole run', () => {
    expect(widenToRuns({ start: 5, end: 9 }, runs)).toEqual({ start: 2, end: 9 });
  });

  it('widens to every run the span touches', () => {
    expect(widenToRuns({ start: 7, end: 14 }, runs)).toEqual({ start: 2, end: 17 });
  });

  it('leaves a span that touches no run, or only touches one end-to-end, alone', () => {
    expect(widenToRuns({ start: 9, end: 12 }, runs)).toEqual({ start: 9, end: 12 });
    expect(widenToRuns({ start: 0, end: 1 }, runs)).toEqual({ start: 0, end: 1 });
    expect(widenToRuns({ start: 18, end: 19 }, runs)).toEqual({ start: 18, end: 19 });
  });

  it('never shrinks a span that is larger than its runs', () => {
    expect(widenToRuns({ start: 0, end: 19 }, runs)).toEqual({ start: 0, end: 19 });
  });
});

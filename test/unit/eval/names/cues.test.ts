import { describe, expect, it } from 'vitest';
import {
  CUE_WINDOW_AFTER,
  CUE_WINDOW_BEFORE,
  CUES_AFTER,
  CUES_BEFORE,
  hasCue,
} from '../../../../eval/names/cues.js';

/** hasCue for the span of `word` in `text` (its first occurrence). */
const cued = (text: string, word: string): boolean => {
  const start = text.indexOf(word);
  return hasCue(text, start, start + word.length);
};

describe('hasCue', () => {
  it('finds a cue before the span, in any case', () => {
    expect(cued('My name is Kavya.', 'Kavya')).toBe(true);
    expect(cued('NAME: Kavya', 'Kavya')).toBe(true);
    expect(cued('Dear Kavya,', 'Kavya')).toBe(true);
    expect(cued('मेरा नाम कविता है।', 'कविता')).toBe(true);
  });

  it('finds a cue after the span', () => {
    expect(cued('Please tell Sharma ji.', 'Sharma')).toBe(true);
    expect(cued('Ask Sharma जी', 'Sharma')).toBe(true);
  });

  it('needs the cue as a whole word', () => {
    expect(cued('A surname like Kavya', 'Kavya')).toBe(false);
    expect(cued('Ask Sharma jiva', 'Sharma')).toBe(false);
    expect(cued('History of Kavya', 'Kavya')).toBe(false);
  });

  it('judges word edges on the whole text, not on the window', () => {
    // The window starts inside "surname", at its "name".
    const text = `surname${' '.repeat(CUE_WINDOW_BEFORE - 4)}Kavya`;
    expect(text.indexOf('Kavya') - CUE_WINDOW_BEFORE).toBe(3);
    expect(cued(text, 'Kavya')).toBe(false);
  });

  it('has the windows fixed by ADR-035', () => {
    expect([CUE_WINDOW_BEFORE, CUE_WINDOW_AFTER]).toEqual([24, 10]);
  });

  it('looks only within the windows', () => {
    expect(cued(`name${' '.repeat(CUE_WINDOW_BEFORE)}Kavya`, 'Kavya')).toBe(false);
    expect(cued(`name${' '.repeat(CUE_WINDOW_BEFORE - 4)}Kavya`, 'Kavya')).toBe(true);
    expect(cued(`Sharma${' '.repeat(CUE_WINDOW_AFTER)}ji`, 'Sharma')).toBe(false);
    expect(cued(`Sharma${' '.repeat(CUE_WINDOW_AFTER - 2)}ji`, 'Sharma')).toBe(true);
  });

  it('never takes the span itself as its cue', () => {
    expect(hasCue('Dear Kavya', 0, 10)).toBe(false);
  });

  it('lists cues in lower case, without duplicates', () => {
    for (const cues of [CUES_BEFORE, CUES_AFTER]) {
      expect(cues.every((c) => c === c.toLowerCase())).toBe(true);
      expect(new Set(cues).size).toBe(cues.length);
    }
  });
});

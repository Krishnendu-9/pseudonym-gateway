import { describe, expect, it } from 'vitest';
import { bertWords, glinerWords, type Word } from '../../../../eval/names/words.js';

const texts = (words: readonly Word[]): string[] => words.map((w) => w.text);

describe('bertWords', () => {
  it('splits on whitespace and makes each punctuation character a word', () => {
    const words = bertWords('Hi, K. S. Ramesh!\nok done');
    expect(texts(words)).toEqual(['Hi', ',', 'K', '.', 'S', '.', 'Ramesh', '!', 'ok', 'done']);
    expect(words[6]).toEqual({ text: 'Ramesh', start: 10, end: 16 });
  });

  it("takes BERT's punctuation: ASCII symbols and Unicode P, not other symbols", () => {
    expect(texts(bertWords('a+b=c|d~e'))).toEqual(['a', '+', 'b', '=', 'c', '|', 'd', '~', 'e']);
    expect(texts(bertWords('है। ₹500 “ok”'))).toEqual(['है', '।', '₹500', '“', 'ok', '”']);
  });

  it('drops control and format characters, inside the offsets of their word', () => {
    const words = bertWords('Ra​mesh ​ x');
    expect(words).toEqual([
      { text: 'Ramesh', start: 0, end: 7 },
      { text: 'x', start: 10, end: 11 },
    ]);
    expect(bertWords('​‍')).toEqual([]);
  });

  it('keeps a letter outside the BMP whole', () => {
    expect(bertWords('a\u{1D400}b')).toEqual([{ text: 'a\u{1D400}b', start: 0, end: 4 }]);
  });
});

describe('glinerWords', () => {
  it('keeps hyphenated words and Devanagari words whole; other characters stand alone', () => {
    const words = glinerWords('Hello-world K. कविता_जी!');
    expect(texts(words)).toEqual(['Hello-world', 'K', '.', 'कविता_जी', '!']);
    expect(words[3]).toEqual({ text: 'कविता_जी', start: 15, end: 23 });
  });

  it('gives nothing for blank text', () => {
    expect(glinerWords(' \n ')).toEqual([]);
  });
});

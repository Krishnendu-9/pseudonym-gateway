import { describe, expect, it } from 'vitest';
import {
  fedTokens,
  labelWords,
  personSpans,
  windows,
  type BertSetup,
  type EncodedWord,
} from '../../../../eval/names/token-classification.js';

const LABELS = ['O', 'B-PER', 'I-PER', 'B-LOC'];
// 12 tokens a window: 10 after [CLS] and [SEP], a core of 6 and 2 of context a side.
const SETUP: BertSetup = { clsId: 101, sepId: 102, labels: LABELS, maxTokens: 12, context: 2 };

/** Words of the given token counts, one character each, their ids counting up from 1. */
function encoded(sizes: readonly number[]): EncodedWord[] {
  let next = 1;
  return sizes.map((size, i) => ({
    text: 'w',
    start: i * 2,
    end: i * 2 + 1,
    ids: Array.from({ length: size }, () => next++),
  }));
}

const tokens = (words: readonly EncodedWord[], from: number, to: number): number =>
  words.slice(from, to).reduce((n, w) => n + Math.min(w.ids.length, 6), 0);

describe('windows', () => {
  it('gives every word to exactly one core, in order, within the token budgets', () => {
    const words = encoded([1, 2, 3, 1, 1, 2, 2, 1, 3, 1, 1]);
    const ws = windows(words, SETUP);
    // Cores of 6 tokens at most: 1+2+3, 1+1+2+2, 1+3+1+1.
    expect(ws.map((w) => [w.coreFrom, w.coreTo])).toEqual([
      [0, 3],
      [3, 7],
      [7, 11],
    ]);
    for (const w of ws) {
      expect(tokens(words, w.coreFrom, w.coreTo)).toBeLessThanOrEqual(6);
      expect(tokens(words, w.from, w.coreFrom)).toBeLessThanOrEqual(2);
      expect(tokens(words, w.coreTo, w.to)).toBeLessThanOrEqual(2);
      expect(tokens(words, w.from, w.to)).toBeLessThanOrEqual(10);
    }
    // Context, word by word while 2 tokens hold it: two 1-token words after
    // the first core; none before the second (its neighbour has 3 tokens) and
    // one 1-token word after it; one 2-token word before the third.
    expect(ws.map((w) => [w.from, w.to])).toEqual([
      [0, 5],
      [3, 8],
      [6, 11],
    ]);
  });

  it('gives a word longer than a core a core of its own', () => {
    const ws = windows(encoded([1, 9, 1]), SETUP);
    expect(ws.map((w) => [w.coreFrom, w.coreTo])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it('gives no window for no words', () => {
    expect(windows([], SETUP)).toEqual([]);
  });
});

describe('labelWords', () => {
  it("labels each word by its first token's softmax maximum, window by window", async () => {
    const words = encoded([1, 2, 3, 1, 1, 2, 2, 1, 3, 1, 1]);
    const runs: number[][] = [];
    // Each token's row puts ln 3 on label (id % 4) and 0 elsewhere: p = 3 / 6.
    const run = async (ids: readonly number[]): Promise<Float32Array> => {
      runs.push([...ids]);
      const rows = new Float32Array(ids.length * LABELS.length);
      ids.forEach((id, t) => (rows[t * LABELS.length + (id % LABELS.length)] = Math.log(3)));
      return rows;
    };
    const labelled = await labelWords(words, SETUP, run);
    expect(labelled.map((l) => l.label)).toEqual(
      words.map((w) => LABELS[w.ids[0]! % LABELS.length]),
    );
    expect(labelled.every((l) => Math.abs(l.score - 0.5) < 1e-6)).toBe(true);
    expect(runs).toHaveLength(3);
    expect(runs.every((ids) => ids[0] === 101 && ids.at(-1) === 102 && ids.length <= 12)).toBe(
      true,
    );
  });

  it('cuts a word longer than a core to the core', async () => {
    const lengths: number[] = [];
    const run = async (ids: readonly number[]): Promise<Float32Array> => {
      lengths.push(ids.length);
      return new Float32Array(ids.length * LABELS.length);
    };
    const labelled = await labelWords(encoded([9]), SETUP, run);
    expect(lengths).toEqual([8]);
    expect(labelled).toEqual([{ label: 'O', score: 0.25 }]);
  });
});

describe('personSpans', () => {
  const words = 'a b c d e f g'
    .split(' ')
    .map((text, i) => ({ text, start: i * 2, end: i * 2 + 1 }));
  const labels = (...ls: string[]) => ls.map((label, i) => ({ label, score: (i + 1) / 10 }));

  it('joins B-PER and the I-PER after it; a stray I-PER starts a name', () => {
    expect(
      personSpans(words, labels('B-PER', 'I-PER', 'O', 'I-PER', 'I-PER', 'B-LOC', 'B-PER')),
    ).toEqual([
      { start: 0, end: 3, score: 0.15000000000000002 },
      { start: 6, end: 9, score: 0.45 },
      { start: 12, end: 13, score: 0.7 },
    ]);
  });

  it('starts a new name at every B-PER', () => {
    const found = personSpans(words.slice(0, 2), labels('B-PER', 'B-PER'));
    expect(found.map((s) => [s.start, s.end])).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });
});

describe('fedTokens', () => {
  it('counts exactly what labelWords sends, window by window', async () => {
    for (const sizes of [[1, 2, 3, 1, 1, 2, 2, 1, 3, 1, 1], [1, 9, 1], [9], []]) {
      const words = encoded(sizes);
      let sent = 0;
      await labelWords(words, SETUP, async (ids) => {
        sent += ids.length;
        return new Float32Array(ids.length * LABELS.length);
      });
      expect([sizes.join(','), fedTokens(words, SETUP)]).toEqual([sizes.join(','), sent]);
    }
    expect(fedTokens(encoded([1, 2, 3, 1, 1, 2, 2, 1, 3, 1, 1]), SETUP)).toBe(29);
  });
});

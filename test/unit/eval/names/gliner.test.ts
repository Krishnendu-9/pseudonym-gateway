import { describe, expect, it } from 'vitest';
import {
  decode,
  glinerFedTokens,
  glinerPrompt,
  feeds,
  glinerSpans,
  glinerWindows,
  type GlinerFeeds,
  type GlinerSetup,
} from '../../../../eval/names/gliner.js';
import type { EncodedWord } from '../../../../eval/names/token-classification.js';

const SETUP: GlinerSetup = {
  clsId: 1,
  sepId: 2,
  prompt: [900, 50, 51, 901],
  labels: 1,
  maxWidth: 3,
  maxWords: 4,
  maxTokens: 14,
  floor: 0.1,
};

/** Words with the given token counts; word i sits at [10i, 10i + 5) and its ids are 100i, 100i + 1… */
const encoded = (sizes: readonly number[]): EncodedWord[] =>
  sizes.map((size, i) => ({
    text: 'w',
    start: i * 10,
    end: i * 10 + 5,
    ids: Array.from({ length: size }, (_, t) => 100 * (i + 1) + t),
  }));

const logit = (p: number): number => Math.log(p / (1 - p));

describe('feeds', () => {
  it('builds the prompt, the words and their first-token marks as GLiNER.js does', () => {
    const f = feeds(encoded([1, 2]), SETUP);
    expect(f.inputIds).toEqual([1, 900, 50, 51, 901, 100, 200, 201, 2]);
    expect(f.wordsMask).toEqual([0, 0, 0, 0, 0, 1, 2, 0, 0]);
    expect(f.attentionMask).toEqual(f.inputIds.map(() => 1));
    expect(f.textLength).toBe(2);
  });

  it('lists maxWidth spans per word, clamped to the last word and masked past it', () => {
    const f = feeds(encoded([1, 1]), SETUP);
    expect(f.spanIdx).toEqual([0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1]);
    expect(f.spanMask).toEqual([true, true, false, true, false, false]);
  });
});

describe('glinerWindows', () => {
  it('cuts at maxWords words and at the token budget left by the prompt', () => {
    // Budget: 14 - 2 - 4 = 8 tokens.
    expect(glinerWindows(encoded([1, 1, 1, 1, 1, 1]), SETUP)).toEqual([
      { from: 0, to: 4 },
      { from: 4, to: 6 },
    ]);
    expect(glinerWindows(encoded([3, 3, 3]), SETUP)).toEqual([
      { from: 0, to: 2 },
      { from: 2, to: 3 },
    ]);
    // A word over the budget gets a window of its own.
    expect(glinerWindows(encoded([9, 1]), SETUP)).toEqual([
      { from: 0, to: 1 },
      { from: 1, to: 2 },
    ]);
    expect(glinerWindows([], SETUP)).toEqual([]);
  });
});

describe('decode', () => {
  const words = encoded([1, 1, 1]);
  /** Logits [3 words, 3 widths] from probabilities; 0 is far below the floor. */
  const logits = (ps: readonly number[]): Float32Array =>
    Float32Array.from(ps, (p) => (p === 0 ? -20 : logit(p)));

  it('keeps spans at or above the floor, the best first, none overlapping, in text order', () => {
    // Spans: [0,0] 0.3, [0,1] 0.9, [1,1] 0.95, [2,2] 0.5, [1,2] 0.6.
    const found = decode(logits([0.3, 0.9, 0, 0.95, 0.6, 0, 0.5, 0, 0]), words, SETUP);
    // 0.95 blocks 0.9 and 0.6; 0.5 and 0.3 overlap nothing kept.
    expect(found.map((s) => [s.start, s.end, Math.round(s.score * 100)])).toEqual([
      [0, 5, 30],
      [10, 15, 95],
      [20, 25, 50],
    ]);
  });

  it('never reads a span past the last word', () => {
    // Only the three positions that run past the third word score high.
    expect(decode(logits([0, 0, 0, 0, 0, 0.9, 0, 0.9, 0.9]), words, SETUP)).toEqual([]);
  });

  it('keeps a span scored exactly at the floor', () => {
    // sigmoid(0) is exactly 0.5.
    const found = decode(Float32Array.from([0, -20, -20, -20, -20, -20, -20, -20, -20]), words, {
      ...SETUP,
      floor: 0.5,
    });
    expect(found).toEqual([{ start: 0, end: 5, score: 0.5, label: 0 }]);
  });

  it('drops spans under the floor', () => {
    expect(decode(logits([0.05, 0, 0, 0, 0, 0, 0, 0, 0]), words, SETUP)).toEqual([]);
  });
});

describe('glinerSpans', () => {
  it('runs the model window by window and maps word spans back to the text', async () => {
    const seen: GlinerFeeds[] = [];
    const run = async (f: GlinerFeeds): Promise<Float32Array> => {
      seen.push(f);
      // The first word of each window is a one-word name.
      return Float32Array.from({ length: f.textLength * SETUP.maxWidth }, (_, i) =>
        i === 0 ? logit(0.8) : -20,
      );
    };
    const found = await glinerSpans(encoded([1, 1, 1, 1, 1, 1]), SETUP, run);
    expect(seen.map((f) => f.textLength)).toEqual([4, 2]);
    expect(found.map((s) => [s.start, s.end])).toEqual([
      [0, 5],
      [40, 45],
    ]);
  });
});

describe('glinerFedTokens', () => {
  it('counts exactly what glinerSpans sends, window by window', async () => {
    for (const sizes of [[1, 1, 1, 1, 1, 1], [3, 3, 3], [9, 1], []]) {
      const words = encoded(sizes);
      let sent = 0;
      await glinerSpans(words, SETUP, async (f) => {
        sent += f.inputIds.length;
        return new Float32Array(f.textLength * SETUP.maxWidth).fill(-20);
      });
      expect([sizes.join(','), glinerFedTokens(words, SETUP)]).toEqual([sizes.join(','), sent]);
    }
    expect(glinerFedTokens(encoded([1, 1, 1, 1, 1, 1]), SETUP)).toBe(18);
  });
});

describe('glinerPrompt', () => {
  it('puts <<ENT>> before each label, then <<SEP>>', () => {
    expect(glinerPrompt([900], [901], [[50, 51], [60]])).toEqual([900, 50, 51, 900, 60, 901]);
  });
});

describe('decode with several labels', () => {
  it('reads one column per label and keeps the best label of overlapping spans', () => {
    const three = { ...SETUP, labels: 3 };
    const words = encoded([1, 1]);
    // Logits [2 words, 3 widths, 3 labels], all far below the floor except:
    // word 0 alone as label 2 (0.9) and as label 1 (0.7); word 1 alone as label 0 (0.6).
    const logits = new Float32Array(2 * 3 * 3).fill(-20);
    logits[(0 * 3 + 0) * 3 + 2] = logit(0.9);
    logits[(0 * 3 + 0) * 3 + 1] = logit(0.7);
    logits[(1 * 3 + 0) * 3 + 0] = logit(0.6);
    const found = decode(logits, words, three);
    expect(found.map((s) => [s.start, s.end, s.label, Math.round(s.score * 100)])).toEqual([
      [0, 5, 2, 90],
      [10, 15, 0, 60],
    ]);
  });
});

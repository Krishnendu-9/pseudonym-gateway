// Candidate D: GLiNER (span classification with labels given at run time),
// ported from GLiNER.js 0.0.19 (MIT): src/lib/processor.ts, decoder.ts and
// model.ts, SpanModel with flat (non-overlapping) decoding.
//
// The prompt is `<<ENT>> person <<SEP>>`, then the text's words. Each
// element is encoded on its own; the first token of each text word is
// marked in `words_mask` with the word's number (from 1). Every span of 1
// to `maxWidth` words is scored; a span's score is the sigmoid of its
// logit. Spans are chosen greedily by score with no overlaps.
//
// Long texts are cut into windows of at most `maxWords` words and
// `maxTokens` tokens, without overlap, as GLiNER.js does.

import type { ScoredSpan } from './spans.js';
import type { EncodedWord } from './token-classification.js';

export interface GlinerSetup {
  readonly clsId: number;
  readonly sepId: number;
  /** The prompt's tokens: <<ENT>>, the label's tokens, <<SEP>>. */
  readonly prompt: readonly number[];
  readonly maxWidth: number;
  readonly maxWords: number;
  readonly maxTokens: number;
  /** Spans scored below this are not kept at all (the lowest point of the grid). */
  readonly floor: number;
}

/** The model's inputs for one window, flat, with their shapes. */
export interface GlinerFeeds {
  readonly inputIds: readonly number[];
  readonly attentionMask: readonly number[];
  readonly wordsMask: readonly number[];
  readonly textLength: number;
  /** [start, end] word pairs, `maxWidth` per word. */
  readonly spanIdx: readonly number[];
  readonly spanMask: readonly boolean[];
}

/** Runs the model on one window; returns logits [words, maxWidth, 1 label]. */
export type RunSpans = (feeds: GlinerFeeds) => Promise<Float32Array>;

export function feeds(words: readonly EncodedWord[], setup: GlinerSetup): GlinerFeeds {
  const inputIds = [setup.clsId, ...setup.prompt];
  const wordsMask = inputIds.map(() => 0);
  words.forEach((word, i) => {
    word.ids.forEach((id, t) => {
      inputIds.push(id);
      wordsMask.push(t === 0 ? i + 1 : 0);
    });
  });
  inputIds.push(setup.sepId);
  wordsMask.push(0);
  const spanIdx: number[] = [];
  const spanMask: boolean[] = [];
  for (let i = 0; i < words.length; i++) {
    for (let j = 0; j < setup.maxWidth; j++) {
      // A span running past the last word is clamped and masked out.
      // (GLiNER.js tests the clamped end, so its mask is always true; the
      // decoder below never reads those spans either way.)
      spanIdx.push(i, Math.min(i + j, words.length - 1));
      spanMask.push(i + j < words.length);
    }
  }
  return {
    inputIds,
    attentionMask: inputIds.map(() => 1),
    wordsMask,
    textLength: words.length,
    spanIdx,
    spanMask,
  };
}

/** Windows of whole words: at most `maxWords` words and `maxTokens` tokens with the prompt. */
export function glinerWindows(
  words: readonly EncodedWord[],
  setup: GlinerSetup,
): { from: number; to: number }[] {
  const budget = setup.maxTokens - 2 - setup.prompt.length;
  const out: { from: number; to: number }[] = [];
  for (let from = 0; from < words.length;) {
    let to = from;
    let used = 0;
    while (
      to < words.length &&
      to - from < setup.maxWords &&
      (to === from || used + words[to]!.ids.length <= budget)
    ) {
      used += words[to]!.ids.length;
      to++;
    }
    out.push({ from, to });
    from = to;
  }
  return out;
}

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/**
 * Spans from one window's logits: every span scoring at least the floor,
 * then greedily by score, keeping those that overlap none kept before.
 * Choosing among spans at or above the floor and then applying a higher
 * threshold gives the same spans as choosing at that threshold: a span is
 * only ever blocked by a higher-scoring one.
 */
export function decode(
  logits: Float32Array,
  words: readonly EncodedWord[],
  setup: GlinerSetup,
): ScoredSpan[] {
  const found: { first: number; last: number; score: number }[] = [];
  for (let i = 0; i < words.length; i++) {
    for (let j = 0; j < setup.maxWidth && i + j < words.length; j++) {
      const score = sigmoid(logits[i * setup.maxWidth + j]!);
      if (score >= setup.floor) found.push({ first: i, last: i + j, score });
    }
  }
  found.sort((a, b) => b.score - a.score);
  const kept: typeof found = [];
  for (const span of found) {
    if (kept.every((k) => span.last < k.first || k.last < span.first)) kept.push(span);
  }
  return kept
    .sort((a, b) => a.first - b.first)
    .map((k) => ({ start: words[k.first]!.start, end: words[k.last]!.end, score: k.score }));
}

/** Every name in the text: the model run window by window. */
export async function glinerSpans(
  words: readonly EncodedWord[],
  setup: GlinerSetup,
  run: RunSpans,
): Promise<ScoredSpan[]> {
  const out: ScoredSpan[] = [];
  for (const { from, to } of glinerWindows(words, setup)) {
    const window = words.slice(from, to);
    out.push(...decode(await run(feeds(window, setup)), window, setup));
  }
  return out;
}

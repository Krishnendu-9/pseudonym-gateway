// Candidate D: GLiNER (span classification with labels given at run time),
// ported from GLiNER.js 0.0.19 (MIT): src/lib/processor.ts, decoder.ts and
// model.ts, SpanModel with flat (non-overlapping) decoding.
//
// The prompt is `<<ENT>> person <<SEP>>` (one `<<ENT>>` and label per label
// asked for), then the text's words. Each
// element is encoded on its own; the first token of each text word is
// marked in `words_mask` with the word's number (from 1). Every span of 1
// to `maxWidth` words is scored; a span's score is the sigmoid of its
// logit, per label. Spans of any label are chosen greedily by score with
// no overlaps (the same words under two labels overlap).
//
// Long texts are cut into windows of at most `maxWords` words and
// `maxTokens` tokens, without overlap, as GLiNER.js does.

import type { ScoredSpan } from '../../src/detection/names/spans.js';
import type { EncodedWord } from '../../src/detection/names/token-classification.js';

export interface GlinerSetup {
  readonly clsId: number;
  readonly sepId: number;
  /** The prompt's tokens (glinerPrompt): <<ENT>> and a label's tokens per label, then <<SEP>>. */
  readonly prompt: readonly number[];
  /** How many labels the prompt holds: the logits have one column per label. */
  readonly labels: number;
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

/** A span with the index of its label in the prompt. */
export interface GlinerSpan extends ScoredSpan {
  readonly label: number;
}

/** The prompt's tokens: for each label, <<ENT>> and the label's tokens; then <<SEP>>. */
export function glinerPrompt(
  ent: readonly number[],
  sep: readonly number[],
  labels: readonly (readonly number[])[],
): number[] {
  return [...labels.flatMap((label) => [...ent, ...label]), ...sep];
}

/** Runs the model on one window; returns logits [words, maxWidth, labels]. */
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

/** Tokens the model is given for `words`: per window, [CLS], the prompt, the words, [SEP]. */
export function glinerFedTokens(words: readonly EncodedWord[], setup: GlinerSetup): number {
  return glinerWindows(words, setup).reduce(
    (n, { from, to }) =>
      n + 2 + setup.prompt.length + words.slice(from, to).reduce((m, w) => m + w.ids.length, 0),
    0,
  );
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
): GlinerSpan[] {
  const found: { first: number; last: number; score: number; label: number }[] = [];
  for (let i = 0; i < words.length; i++) {
    for (let j = 0; j < setup.maxWidth && i + j < words.length; j++) {
      for (let label = 0; label < setup.labels; label++) {
        const score = sigmoid(logits[(i * setup.maxWidth + j) * setup.labels + label]!);
        if (score >= setup.floor) found.push({ first: i, last: i + j, score, label });
      }
    }
  }
  found.sort((a, b) => b.score - a.score);
  const kept: typeof found = [];
  for (const span of found) {
    if (kept.every((k) => span.last < k.first || k.last < span.first)) kept.push(span);
  }
  return kept
    .sort((a, b) => a.first - b.first)
    .map((k) => ({
      start: words[k.first]!.start,
      end: words[k.last]!.end,
      score: k.score,
      label: k.label,
    }));
}

/** Every span the model finds in the text, window by window. */
export async function glinerSpans(
  words: readonly EncodedWord[],
  setup: GlinerSetup,
  run: RunSpans,
): Promise<GlinerSpan[]> {
  const out: GlinerSpan[] = [];
  for (const { from, to } of glinerWindows(words, setup)) {
    const window = words.slice(from, to);
    out.push(...decode(await run(feeds(window, setup)), window, setup));
  }
  return out;
}

// Candidates A and B: BERT token classification (BIO labels per token).
//
// The text is split into BERT's words (words.ts), each word encoded on its
// own, and the model run on windows of at most 512 tokens. A window
// predicts only for its middle ("core") words and gives them up to
// CONTEXT tokens of text on each side, so a word at a window's edge still
// has words around it. A word's label is its first token's (the usual
// "first" aggregation); its score is that label's softmax probability.
// Consecutive PER words make one name; a name's score is the mean of its
// words' scores (Hugging Face's "simple" aggregation).

import type { ScoredSpan } from './spans.js';
import type { Word } from './words.js';

export interface EncodedWord extends Word {
  /** Token ids, without special tokens. */
  readonly ids: readonly number[];
}

export interface BertSetup {
  readonly clsId: number;
  readonly sepId: number;
  /** Label of each output column, `O`, `B-PER`, `I-PER`… */
  readonly labels: readonly string[];
  /** Tokens per window, special tokens included (512 for BERT). */
  readonly maxTokens: number;
  /** Tokens of context on each side of a window's core. */
  readonly context: number;
}

/** Runs the model on one window's ids; returns logits, one row of labels.length per id. */
export type RunTokens = (ids: readonly number[]) => Promise<Float32Array>;

interface Window {
  /** Words in the window, and which of them it predicts for. */
  readonly from: number;
  readonly to: number;
  readonly coreFrom: number;
  readonly coreTo: number;
}

/** Words whose tokens do not fit a window lose their extra tokens; only the first counts. */
export const fit = (word: EncodedWord, budget: number): number => Math.min(word.ids.length, budget);

export function windows(words: readonly EncodedWord[], setup: BertSetup): Window[] {
  const budget = setup.maxTokens - 2;
  const coreBudget = budget - 2 * setup.context;
  const out: Window[] = [];
  for (let coreFrom = 0; coreFrom < words.length;) {
    let coreTo = coreFrom;
    let used = 0;
    while (
      coreTo < words.length &&
      (coreTo === coreFrom || used + fit(words[coreTo]!, coreBudget) <= coreBudget)
    ) {
      used += fit(words[coreTo]!, coreBudget);
      coreTo++;
    }
    let from = coreFrom;
    let left = 0;
    while (from > 0 && left + fit(words[from - 1]!, coreBudget) <= setup.context) {
      left += fit(words[--from]!, coreBudget);
    }
    let to = coreTo;
    let right = 0;
    while (to < words.length && right + fit(words[to]!, coreBudget) <= setup.context) {
      right += fit(words[to++]!, coreBudget);
    }
    out.push({ from, to, coreFrom, coreTo });
    coreFrom = coreTo;
  }
  return out;
}

const softmaxMax = (row: Float32Array): { label: number; probability: number } => {
  let best = 0;
  for (let i = 1; i < row.length; i++) if (row[i]! > row[best]!) best = i;
  let sum = 0;
  for (const value of row) sum += Math.exp(value - row[best]!);
  return { label: best, probability: 1 / sum };
};

/** Each word's label and score, from the model run window by window. */
export async function labelWords(
  words: readonly EncodedWord[],
  setup: BertSetup,
  run: RunTokens,
): Promise<{ label: string; score: number }[]> {
  const coreBudget = setup.maxTokens - 2 - 2 * setup.context;
  const out: { label: string; score: number }[] = [];
  for (const w of windows(words, setup)) {
    const ids = [setup.clsId];
    const firstToken: number[] = [];
    for (let i = w.from; i < w.to; i++) {
      firstToken.push(ids.length);
      ids.push(...words[i]!.ids.slice(0, coreBudget));
    }
    ids.push(setup.sepId);
    const logits = await run(ids);
    const width = setup.labels.length;
    for (let i = w.coreFrom; i < w.coreTo; i++) {
      const token = firstToken[i - w.from]!;
      const best = softmaxMax(logits.subarray(token * width, (token + 1) * width));
      out.push({ label: setup.labels[best.label]!, score: best.probability });
    }
  }
  return out;
}

/** Consecutive PER words as names: B-PER starts one, I-PER continues it (or starts one). */
export function personSpans(
  words: readonly Word[],
  labels: readonly { label: string; score: number }[],
): ScoredSpan[] {
  const spans: ScoredSpan[] = [];
  let open: { start: number; end: number; scores: number[] } | undefined;
  const close = (): void => {
    if (open) {
      const score = open.scores.reduce((a, b) => a + b, 0) / open.scores.length;
      spans.push({ start: open.start, end: open.end, score });
    }
    open = undefined;
  };
  words.forEach((word, i) => {
    const { label, score } = labels[i]!;
    if (label === 'B-PER' || (label === 'I-PER' && !open)) {
      close();
      open = { start: word.start, end: word.end, scores: [score] };
    } else if (label === 'I-PER') {
      open!.end = word.end;
      open!.scores.push(score);
    } else {
      close();
    }
  });
  close();
  return spans;
}

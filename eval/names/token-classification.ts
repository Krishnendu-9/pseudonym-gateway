// Counting what candidates A and B are fed, for the latency report. The
// windows and labelling are in src/detection/names/token-classification.ts
// (ADR-036 step 2).

import {
  fit,
  windows,
  type BertSetup,
  type EncodedWord,
} from '../../src/detection/names/token-classification.js';

/**
 * Tokens the model is given for `words`, window by window: each window's
 * words (a word cut to the core budget, as labelWords cuts it), context
 * included, plus [CLS] and [SEP].
 */
export function fedTokens(words: readonly EncodedWord[], setup: BertSetup): number {
  const coreBudget = setup.maxTokens - 2 - 2 * setup.context;
  return windows(words, setup).reduce(
    (n, w) => n + 2 + words.slice(w.from, w.to).reduce((m, word) => m + fit(word, coreBudget), 0),
    0,
  );
}

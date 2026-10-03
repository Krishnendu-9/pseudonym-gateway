// GLiNER's word splitter, for candidate D only. BERT's, which the gateway
// uses, is in src/detection/names/words.ts (ADR-036 step 2).

import type { Word } from '../../src/detection/names/words.js';

// GLiNER's splitter, `\w+(?:[-_]\w+)*|\S`, written with Unicode classes.
// GLiNER.js uses the regex without the `u` flag, so `\w` there is ASCII
// only and every Devanagari letter becomes a word of its own; Python's
// `\w` covers letters and digits of every script but not combining marks.
// Here a word also takes combining marks, so a Devanagari word stays whole.
const GLINER_WORD = /[\p{L}\p{M}\p{N}_]+(?:[-_][\p{L}\p{M}\p{N}_]+)*|\S/gu;

export function glinerWords(text: string): Word[] {
  return [...text.matchAll(GLINER_WORD)].map((m) => ({
    text: m[0],
    start: m.index,
    end: m.index + m[0].length,
  }));
}

// Splitting text into the words each model family reads, with their
// offsets, so that a model's answer about word i maps back to the text.
// Every model's tokenizer then encodes one word at a time (as Hugging
// Face's `is_split_into_words` does), which keeps the offsets exact.

import type { Span } from '../normalise.js';

export interface Word extends Span {
  readonly text: string;
}

// BERT's basic tokenizer (the BertPreTokenizer the A and B models were
// trained with): whitespace splits, and each punctuation character is a
// word of its own. Punctuation is BERT's: every ASCII character that is
// not a letter, digit or space, and Unicode's P categories. Control and
// format characters are dropped, as BERT's text cleaning drops them; a
// word's offsets still run over any it contains.
const BERT_PUNCTUATION = /^[!-/:-@[-`{-~\p{P}]$/u;
const DROPPED = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}�]$/u;
const SPACE = /^\s$/u;

export function bertWords(text: string): Word[] {
  const words: Word[] = [];
  let current = '';
  let start = 0;
  let end = 0;
  const close = (): void => {
    if (current !== '') words.push({ text: current, start, end });
    current = '';
  };
  for (let at = 0; at < text.length;) {
    const ch = String.fromCodePoint(text.codePointAt(at)!);
    const next = at + ch.length;
    if (SPACE.test(ch)) {
      close();
    } else if (BERT_PUNCTUATION.test(ch)) {
      close();
      words.push({ text: ch, start: at, end: next });
    } else if (!DROPPED.test(ch)) {
      if (current === '') start = at;
      current += ch;
      end = next;
    }
    at = next;
  }
  close();
  return words;
}

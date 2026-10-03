// Words that say a person's name is near: option c of the Phase 6 proposal
// (ADR-035). A span the model is only fairly sure of is kept when one of
// these is close by. Fixed before any model run; changing them afterwards
// needs a note in ADR-035 saying what was seen first.
//
// They are the conventional ways of introducing, addressing or signing as
// a person (a name word, an honorific, a greeting, a sign-off), in English,
// romanised Hindi and Hindi. Verbs that often take a person ("ask",
// "spoke to") are left out on purpose: they would fit the dataset's own
// sentences, which share an author with this list.

/** Cues that come before a name, lower case, matched as whole words. */
export const CUES_BEFORE: readonly string[] = [
  // English
  'name',
  'named',
  'called',
  'i am',
  "i'm",
  'this is',
  'mr',
  'mrs',
  'ms',
  'miss',
  'dr',
  'prof',
  'dear',
  'hi',
  'hello',
  'regards',
  'thanks',
  'thank you',
  'sincerely',
  'cheers',
  // Indian honorifics, in Latin script
  'shri',
  'sri',
  'smt',
  'kumari',
  // Romanised Hindi
  'naam',
  'namaste',
  'dhanyavaad',
  'dhanyawad',
  'shukriya',
  // Hindi
  'नाम',
  'श्री',
  'श्रीमती',
  'सुश्री',
  'डॉ',
  'प्रिय',
  'नमस्ते',
  'धन्यवाद',
  'सादर',
  'शुक्रिया',
];

/** Cues that come after a name ("Sharma ji"). */
export const CUES_AFTER: readonly string[] = [
  'ji',
  'sir',
  'madam',
  "ma'am",
  'bhai',
  'ben',
  'saab',
  'sahab',
  'जी',
  'साहब',
];

/** How far before a span a cue may end, and how far after it one may start, in characters. */
export const CUE_WINDOW_BEFORE = 24;
export const CUE_WINDOW_AFTER = 10;

// A cue is a whole word: no letter, mark or digit touches it.
const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;
const isWordChar = (ch: string | undefined): boolean => ch !== undefined && WORD_CHAR.test(ch);

/**
 * True when `word` is written (in any case) as a whole word wholly inside
 * text[from, to). Word edges are judged on the whole text, so a window
 * that starts inside "surname" does not find "name".
 */
function wordWithin(text: string, word: string, from: number, to: number): boolean {
  for (let at = Math.max(0, from); at + word.length <= to; at++) {
    if (
      text.slice(at, at + word.length).toLowerCase() === word &&
      !isWordChar(text[at - 1]) &&
      !isWordChar(text[at + word.length])
    ) {
      return true;
    }
  }
  return false;
}

/**
 * True when a cue lies within the window before `start` or after `end`.
 * The windows stop at the span's own edges, so a span never cues itself.
 */
export function hasCue(text: string, start: number, end: number): boolean {
  return (
    CUES_BEFORE.some((cue) => wordWithin(text, cue, start - CUE_WINDOW_BEFORE, start)) ||
    CUES_AFTER.some((cue) => wordWithin(text, cue, end, end + CUE_WINDOW_AFTER))
  );
}

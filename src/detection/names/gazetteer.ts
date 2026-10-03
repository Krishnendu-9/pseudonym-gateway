// Candidate F: no model. Names from a list, and words placed where a name
// goes (ADR-035). Fixed before any model run, like the cues.
//
// 1. A list run: adjacent words, each a listed name written with a capital
//    (or in Devanagari) or an initial, with at least one listed name.
// 2. A cue run: adjacent words written with a capital (or in Devanagari,
//    not a function word) or initials, right after a cue that comes before
//    a name ("Name: …", "Dear …", "मेरा नाम …") or right before one that
//    comes after it ("… ji").
// A cue word is never part of a cue run ("Dear" in "Dear Asha"). A run has
// at most four words, and is taken whole: F cannot tell a capitalised first
// word of a sentence from a name ("Ask Asha ji" gives "Ask Asha"). The list is the `gazetteer` half of the
// Wikidata lists, which shares no name with the dataset's `eval` half, so
// on the generated set rule 2 does nearly all the work.

import { WIKIDATA_NAMES } from '../../synthetic/wikidata-names.js';
import { CUES_AFTER, CUES_BEFORE } from './cues.js';
import type { ScoredSpan } from './spans.js';

const WORD = /[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu;
const DEVANAGARI = /\p{Script=Devanagari}/u;
const CAPITALISED = /^\p{Lu}/u;
const INITIAL = /^\p{Lu}$/u;
/** The most words a run may have. */
const MAX_RUN = 4;

// Hindi words that end a name rather than continue it.
const DEVANAGARI_STOP = new Set([
  'है',
  'हूँ',
  'हैं',
  'था',
  'थी',
  'ने',
  'से',
  'को',
  'का',
  'की',
  'के',
  'में',
  'पर',
  'और',
  'बोल',
  'रही',
  'रहा',
  'जी',
]);

// Between a cue and the name it introduces: spaces, a colon, comma or
// dash, and at most one linking word ("name is", "naam hai" is not one).
const GAP_AFTER_CUE = /^[\s,:\-–—]*(?:(?:is|am|was)\s+)?$/iu;

interface ListWord {
  readonly start: number;
  readonly end: number;
  readonly listed: boolean;
  readonly initial: boolean;
  /** Capitalised Latin, or Devanagari that is not a function word. */
  readonly nameShaped: boolean;
}

export function words(text: string, list: ReadonlySet<string>): ListWord[] {
  return [...text.matchAll(WORD)].map((m) => {
    const word = m[0];
    const devanagari = DEVANAGARI.test(word);
    return {
      start: m.index,
      end: m.index + word.length,
      listed: list.has(devanagari ? word : word.toLowerCase()),
      initial: INITIAL.test(word),
      nameShaped: devanagari ? !DEVANAGARI_STOP.has(word) : CAPITALISED.test(word),
    };
  });
}

// Two words are adjacent when only one space, or an initial's full stop
// and a space, lies between them.
function adjacent(text: string, a: ListWord, b: ListWord): boolean {
  const gap = text.slice(a.end, b.start);
  return gap === ' ' || (a.initial && (gap === '. ' || gap === '.'));
}

/** Runs of adjacent words for which `fits` holds, at most MAX_RUN long. */
function runs(text: string, ws: readonly ListWord[], fits: (w: ListWord) => boolean): ListWord[][] {
  const out: ListWord[][] = [];
  let run: ListWord[] = [];
  for (const w of ws) {
    const continues =
      run.length > 0 && run.length < MAX_RUN && adjacent(text, run[run.length - 1]!, w);
    if (fits(w) && (run.length === 0 || continues)) {
      run.push(w);
    } else {
      if (run.length > 0) out.push(run);
      run = fits(w) ? [w] : [];
    }
  }
  if (run.length > 0) out.push(run);
  return out;
}

const LETTER = /[\p{L}\p{M}\p{N}]/u;
const isWordChar = (ch: string | undefined): boolean => ch !== undefined && LETTER.test(ch);

/** The longest gap GAP_AFTER_CUE is looked for in ("  is  " and some punctuation). */
const MAX_GAP = 12;

/** True when a cue, as a whole word, ends just before `runStart` with only a gap between. */
function cueBefore(text: string, runStart: number): boolean {
  return CUES_BEFORE.some((cue) => {
    for (let gap = 0; gap <= MAX_GAP; gap++) {
      const at = runStart - gap - cue.length;
      if (
        at >= 0 &&
        text.slice(at, at + cue.length).toLowerCase() === cue &&
        !isWordChar(text[at - 1]) &&
        !isWordChar(text[at + cue.length]) &&
        GAP_AFTER_CUE.test(text.slice(at + cue.length, runStart))
      ) {
        return true;
      }
    }
    return false;
  });
}

/** True when a cue that follows a name ("ji") comes after `runEnd`, past at least one space. */
function cueAfter(text: string, runEnd: number): boolean {
  const gap = /^\s*/u.exec(text.slice(runEnd))![0].length;
  if (gap === 0) return false;
  const at = runEnd + gap;
  return CUES_AFTER.some(
    (cue) =>
      text.slice(at, at + cue.length).toLowerCase() === cue && !isWordChar(text[at + cue.length]),
  );
}

// One-word cues, which never start or continue a cue run.
const CUE_WORDS: ReadonlySet<string> = new Set(
  [...CUES_BEFORE, ...CUES_AFTER].filter((cue) => !cue.includes(' ')),
);

/** The names candidate F finds in `text`, with the list given. */
export function listSpans(text: string, list: ReadonlySet<string>): ScoredSpan[] {
  const ws = words(text, list);
  const isCue = (w: ListWord): boolean => CUE_WORDS.has(text.slice(w.start, w.end).toLowerCase());
  const spans: ScoredSpan[] = [];
  const add = (run: readonly ListWord[]): void => {
    spans.push({ start: run[0]!.start, end: run[run.length - 1]!.end, score: 1 });
  };
  for (const run of runs(text, ws, (w) => (w.listed && w.nameShaped) || w.initial)) {
    if (run.some((w) => w.listed)) add(run);
  }
  for (const run of runs(text, ws, (w) => (w.nameShaped || w.initial) && !isCue(w))) {
    if (run.every((w) => w.initial)) continue;
    if (cueBefore(text, run[0]!.start) || cueAfter(text, run[run.length - 1]!.end)) add(run);
  }
  return spans;
}

/**
 * F's list as measured in 6a: the `gazetteer` half, Latin spellings lower
 * case, Devanagari as written (moved from scripts/compare-names.ts, ADR-036).
 */
export const GAZETTEER: ReadonlySet<string> = new Set(
  Object.values(WIKIDATA_NAMES).flatMap((r) =>
    [...r.gazetteerGiven, ...r.gazetteerFamily].flatMap(([latin, devanagari]) =>
      devanagari === undefined ? [latin.toLowerCase()] : [latin.toLowerCase(), devanagari],
    ),
  ),
);

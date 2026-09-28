// Normalisation for detection, with an offset map back to the original text.
//
// Detectors run on normalised text, so a full-width or Devanagari Aadhaar, or
// one split by zero-width characters, looks like plain ASCII digits. But the
// replacement happens in the original text (that is what gets sent), so every
// normalised code unit remembers which range of the original it came from.
//
// Steps, in order:
//   1. Remove invisible characters: everything Unicode classes as
//      Default_Ignorable_Code_Point (zero-width space/joiners, word joiner, BOM,
//      soft hyphen, bidi controls, variation selectors, tag characters).
//   2. Split what is left into grapheme clusters (user-perceived characters).
//   3. NFKC each cluster (full-width and mathematical digits become ASCII, NBSP
//      becomes a space), then map Devanagari digits to ASCII.
//
// NFKC is applied cluster by cluster, not to the whole string, so that every
// output code unit has one known source range. That is only safe at boundaries
// where NFKC does not compose across: Hangul compatibility jamo, for example,
// are separate clusters that NFKC joins into one syllable. So a cluster is
// merged into the previous group whenever normalising the two together differs
// from normalising them apart. The result equals whole-string NFKC of the
// visible text. Removing invisibles before segmenting means a zero-width
// character cannot split a letter from its accent.

/** Half-open range [start, end) of UTF-16 code unit indices. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

const INVISIBLE_RUN = /\p{Default_Ignorable_Code_Point}+/gu;
const DEVANAGARI_DIGIT = /[०-९]/g;
const DEVANAGARI_ZERO = 0x0966;

// Grapheme segmentation does not depend on the locale.
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

export class NormalisedText {
  readonly text: string;
  // Normalised code unit i came from original[starts[i], ends[i]): one cluster,
  // or a group of clusters that NFKC composes together.
  readonly #starts: readonly number[];
  readonly #ends: readonly number[];

  constructor(text: string, starts: readonly number[], ends: readonly number[]) {
    this.text = text;
    this.#starts = starts;
    this.#ends = ends;
  }

  /**
   * Maps a span of the normalised text to the smallest span of the original
   * text that contains all of its source characters. The result rounds
   * outwards to whole clusters (so it never splits a surrogate pair, an
   * accent from its letter, or an expansion like "½" -> "1⁄2"), and includes
   * any invisible characters between the first and last source character, so
   * replacing it hides the value completely. Invisible characters just before
   * the first or after the last source character are left outside: they carry
   * nothing, and two values separated only by an invisible character must not
   * both claim it.
   */
  toOriginal(span: Span): Span {
    const { start, end } = span;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end > this.text.length ||
      start >= end
    ) {
      throw new RangeError(
        `toOriginal: invalid span [${start}, ${end}) for normalised text of length ${this.text.length}`,
      );
    }
    return { start: this.#starts[start]!, end: this.#ends[end - 1]! };
  }
}

function devanagariDigitsToAscii(s: string): string {
  return s.replace(DEVANAGARI_DIGIT, (d) => String(d.charCodeAt(0) - DEVANAGARI_ZERO));
}

export function normalise(original: string): NormalisedText {
  // Step 1: drop invisible characters, remembering where each kept code unit came from.
  let visible = '';
  const visibleToOriginal: number[] = [];
  let cursor = 0;
  const keep = (from: number, to: number): void => {
    visible += original.slice(from, to);
    for (let i = from; i < to; i++) visibleToOriginal.push(i);
  };
  for (const match of original.matchAll(INVISIBLE_RUN)) {
    keep(cursor, match.index);
    cursor = match.index + match[0].length;
  }
  keep(cursor, original.length);

  // Steps 2 and 3: normalise cluster by cluster, merging clusters that NFKC
  // would compose. A group covers visible[groupStart, groupEnd).
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let groupStart = 0;
  let groupEnd = 0;
  let groupNormalised = '';
  const flush = (): void => {
    if (groupEnd === groupStart) return;
    const out = devanagariDigitsToAscii(groupNormalised);
    const start = visibleToOriginal[groupStart]!;
    const end = visibleToOriginal[groupEnd - 1]! + 1;
    text += out;
    for (let i = 0; i < out.length; i++) {
      starts.push(start);
      ends.push(end);
    }
  };
  for (const { segment, index } of graphemes.segment(visible)) {
    const isAscii = segment.charCodeAt(0) < 0x80;
    // A lone ASCII character is already in NFKC.
    const normalised = isAscii && segment.length === 1 ? segment : segment.normalize('NFKC');
    // Nothing composes with a following ASCII character, so skip the check.
    if (groupEnd > groupStart && !isAscii) {
      const joined = groupNormalised + normalised;
      const together = joined.normalize('NFKC');
      if (together !== joined) {
        groupEnd = index + segment.length;
        groupNormalised = together;
        continue;
      }
    }
    flush();
    groupStart = index;
    groupEnd = index + segment.length;
    groupNormalised = normalised;
  }
  flush();
  return new NormalisedText(text, starts, ends);
}

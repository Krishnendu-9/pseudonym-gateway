// Finding numbers written with separators, for the Aadhaar and card detectors.
//
// People write "2345 6789 0123", "4111-1111-1111-1111" or "2345.6789.0123",
// and obfuscated text spreads digits out ("2 3 4 5 ..."). A *run* is digit
// groups joined by short separators (1-3 of space, dot, hyphen or dash). A
// *window* is a stretch of whole consecutive groups inside a run. Detectors
// look at windows with the right number of digits.
//
// A window that is the whole run, or a single unbroken group, is always a
// candidate, whatever its grouping. A window made of several groups inside a
// longer run must use one of the type's usual groupings: in "1 2345 6789 0123"
// (a row number, then a 4-4-4 number) the Aadhaar detector sees the 4-4-4
// part, but a list of small numbers does not add up to 12-digit windows by
// accident.
//
// This runs on normalised text, where every decimal digit is already ASCII.

import type { Span } from './normalise.js';

const SEPARATOR = '[ .\\-\\u2010-\\u2015\\u2212]';
const DIGIT_RUN = new RegExp(`[0-9]+(?:${SEPARATOR}{1,3}[0-9]+)*`, 'g');
const DIGIT_GROUP = /[0-9]+/g;
const SEPARATOR_CHAR = new RegExp(`^${SEPARATOR}$`);

/** True if `char` is one of the separators that join digit groups into a run. */
export const isRunSeparator = (char: string): boolean => SEPARATOR_CHAR.test(char);

// A number glued to a letter, digit, combining mark or underscore is part of
// a longer token (a hash, an identifier, an API key), not a value on its own.
// Glued to "@" it is part of an email address, which the email detector owns.
// After "+" it is a phone number with its country code.
const GLUED_BEFORE = /[\p{L}\p{N}\p{M}_@+]/u;
const GLUED_AFTER = /[\p{L}\p{N}\p{M}_@]/u;

export interface DigitWindow extends Span {
  /** The window's digits with the separators removed. */
  readonly digits: string;
  /** Number of digits in each group, e.g. [4, 4, 4]. */
  readonly groups: readonly number[];
  /** True if the window is the whole run. */
  readonly wholeRun: boolean;
}

/** Every run of digit groups in `text`, in text order. */
export function digitRuns(text: string): Span[] {
  return [...text.matchAll(DIGIT_RUN)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
  }));
}

/**
 * Widens `span` to cover every digit run it overlaps. A value found inside a
 * longer number (the 4-4-4 start of a 4-4-4-4 card with a typo) then takes
 * the whole number with it, instead of leaving the rest visible: when in
 * doubt, redact more (fail closed).
 */
export function widenToRuns(span: Span, runs: readonly Span[]): Span {
  // Binary search for the first run that ends after the span starts.
  let lo = 0;
  let hi = runs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid]!.end <= span.start) lo = mid + 1;
    else hi = mid;
  }
  let { start, end } = span;
  for (let i = lo; i < runs.length && runs[i]!.start < span.end; i++) {
    start = Math.min(start, runs[i]!.start);
    end = Math.max(end, runs[i]!.end);
  }
  return { start, end };
}

/** The code point just before `index`, or '' at the start. */
export function charBefore(text: string, index: number): string {
  if (index === 0) return '';
  const isPair = index >= 2 && /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(text.slice(index - 2, index));
  return String.fromCodePoint(text.codePointAt(isPair ? index - 2 : index - 1)!);
}

/** The code point starting at `index`, or '' at the end. */
export function charAt(text: string, index: number): string {
  return index < text.length ? String.fromCodePoint(text.codePointAt(index)!) : '';
}

/** Windows of `minDigits` to `maxDigits` digits, in the order they appear. */
export function* digitWindows(
  text: string,
  minDigits: number,
  maxDigits: number,
): Generator<DigitWindow> {
  for (const run of text.matchAll(DIGIT_RUN)) {
    const runStart = run.index;
    const runEnd = runStart + run[0].length;
    const groups = [...run[0].matchAll(DIGIT_GROUP)].map((g) => ({
      start: runStart + g.index,
      end: runStart + g.index + g[0].length,
    }));
    const cleanStart = !GLUED_BEFORE.test(charBefore(text, runStart));
    const cleanEnd = !GLUED_AFTER.test(charAt(text, runEnd));

    for (let first = 0; first < groups.length; first++) {
      if (first === 0 && !cleanStart) continue;
      let digits = '';
      const sizes: number[] = [];
      for (let last = first; last < groups.length; last++) {
        const group = groups[last]!;
        digits += text.slice(group.start, group.end);
        sizes.push(group.end - group.start);
        if (digits.length > maxDigits) break;
        if (digits.length < minDigits) continue;
        const isLast = last === groups.length - 1;
        if (isLast && !cleanEnd) continue;
        yield {
          start: groups[first]!.start,
          end: group.end,
          digits,
          groups: [...sizes],
          wholeRun: first === 0 && isLast,
        };
      }
    }
  }
}

/**
 * True if a window can stand as a number on its own: it is the whole run, or
 * one unbroken group, or it is grouped exactly like one of `layouts`.
 */
export function standsAlone(window: DigitWindow, layouts: readonly (readonly number[])[]): boolean {
  return (
    window.wholeRun ||
    window.groups.length === 1 ||
    layouts.some(
      (layout) =>
        layout.length === window.groups.length &&
        layout.every((size, i) => size === window.groups[i]),
    )
  );
}

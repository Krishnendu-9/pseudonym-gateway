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
// A run never crosses a line break: two runs on neighbouring lines are tried
// as one number only by `crossLineWindows` (ADR-030), whose windows always
// take the whole run on at least one of the two lines.
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

// A number wrapped onto the next line (ADR-030): one line break, LF or CRLF,
// with at most two separators before it ("4111-1111-", newline) and two
// spaces after it. Nothing else may sit between the two runs.
const LINE_BREAK_GAP = new RegExp(`^${SEPARATOR}{0,2}\\r?\\n {0,2}$`);

/**
 * Pairs of whole digit runs with one line break between them (ADR-030):
 * `[first, second]`, each a run as `digitRuns` finds it, in text order. A
 * run can be in two pairs (as the second of one and the first of the next).
 */
export function* lineJoins(text: string): Generator<readonly [Span, Span]> {
  const runs = digitRuns(text);
  for (let i = 0; i + 1 < runs.length; i++) {
    const [first, second] = [runs[i]!, runs[i + 1]!];
    if (LINE_BREAK_GAP.test(text.slice(first.end, second.start))) yield [first, second];
  }
}

/** A window across one line break (crossLineWindows). */
export interface LineWindow extends DigitWindow {
  /** The window starts at the first group of the first line's run. */
  readonly startsRun: boolean;
  /** The window ends at the last group of the second line's run. */
  readonly endsRun: boolean;
}

/**
 * Windows of `minDigits` to `maxDigits` digits across one line break
 * (ADR-030): the last groups of one line's run and the first groups of the
 * next line's, with at least one of the two runs taken whole. A wrapped
 * value then still counts with a number beside it on one of its lines
 * (`"Room 3 2345 6789"`, newline, `"0123"`). `wholeRun` means both runs are
 * whole. No glue checks: `lineJoinedWindows` adds them.
 */
export function* crossLineWindows(
  text: string,
  minDigits: number,
  maxDigits: number,
): Generator<LineWindow> {
  for (const [first, second] of lineJoins(text)) {
    const before = groupsOf(text, first);
    const after = groupsOf(text, second);
    let tail = '';
    const tailSizes: number[] = [];
    for (let i = before.length - 1; i >= 0 && tail.length < maxDigits; i--) {
      const group = before[i]!;
      tail = text.slice(group.start, group.end) + tail;
      tailSizes.unshift(group.end - group.start);
      let digits = tail;
      const sizes = [...tailSizes];
      for (let j = 0; j < after.length; j++) {
        const next = after[j]!;
        digits += text.slice(next.start, next.end);
        sizes.push(next.end - next.start);
        if (digits.length > maxDigits) break;
        const startsRun = i === 0;
        const endsRun = j === after.length - 1;
        if (digits.length < minDigits || !(startsRun || endsRun)) continue;
        yield {
          start: group.start,
          end: next.end,
          digits,
          groups: [...sizes],
          wholeRun: startsRun && endsRun,
          startsRun,
          endsRun,
        };
      }
    }
  }
}

/** Every digit group in `text[span]`, as spans of `text`. */
function groupsOf(text: string, span: Span): Span[] {
  return [...text.slice(span.start, span.end).matchAll(DIGIT_GROUP)].map((group) => ({
    start: span.start + group.index,
    end: span.start + group.index + group[0].length,
  }));
}

/**
 * `crossLineWindows`, with the same glue rules as `digitWindows` where a
 * window reaches the outer end of a run.
 */
export function* lineJoinedWindows(
  text: string,
  minDigits: number,
  maxDigits: number,
): Generator<DigitWindow> {
  for (const window of crossLineWindows(text, minDigits, maxDigits)) {
    if (window.startsRun && GLUED_BEFORE.test(charBefore(text, window.start))) continue;
    if (window.endsRun && GLUED_AFTER.test(charAt(text, window.end))) continue;
    yield window;
  }
}

/**
 * True if a window across a line break can be a number on its own: it is
 * grouped like one of `layouts`, or it is the whole of both runs as two
 * unbroken groups, one on each line (a number written without spaces and
 * wrapped). Like a window inside a longer run on one line, one that is only
 * part of a run must have one of the type's usual groupings.
 */
export function wrapsAlone(window: DigitWindow, layouts: readonly (readonly number[])[]): boolean {
  return (
    (window.wholeRun && window.groups.length === 2) ||
    layouts.some(
      (layout) =>
        layout.length === window.groups.length &&
        layout.every((size, i) => size === window.groups[i]),
    )
  );
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

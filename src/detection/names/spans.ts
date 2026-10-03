// What every name candidate returns, and how its spans become detections
// (ADR-035): kept by the tiers (option c), widened to whole words, merged.

import type { Span } from '../normalise.js';
import { hasCue } from './cues.js';

/** A stretch a candidate takes for a name, with how sure it is (1 when it has no score). */
export interface ScoredSpan extends Span {
  readonly score: number;
}

/**
 * An operating point: keep a span scored at least `high`, or at least `mid`
 * with a cue nearby. Without `mid`, `high` alone decides.
 */
export interface Point {
  readonly high: number;
  readonly mid?: number;
}

const LETTER_OR_MARK = /[\p{L}\p{M}]/u;
const inWord = (ch: string | undefined): boolean => ch !== undefined && LETTER_OR_MARK.test(ch);

/**
 * Widens a span to whole words: over letters and combining marks on both
 * sides, so that a model's piece of a word ("Priya" of "Priyanka", a
 * Devanagari letter without its vowel sign) never leaves the rest visible.
 * Surrogate pairs are never split: a lone half is neither letter nor mark,
 * and a whole pair is tested as one character.
 */
export function widenToWords(text: string, span: Span): Span {
  let { start, end } = span;
  while (start > 0) {
    // The character ending at `start`: a surrogate pair if a pair ends there.
    const pair = start >= 2 && text.codePointAt(start - 2)! > 0xffff;
    const ch = text.slice(start - (pair ? 2 : 1), start);
    if (!inWord(ch)) break;
    start -= ch.length;
  }
  while (end < text.length) {
    const ch = String.fromCodePoint(text.codePointAt(end)!);
    if (!inWord(ch)) break;
    end += ch.length;
  }
  return { start, end };
}

/** Joins spans that overlap or touch, in text order. */
export function merge(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Span[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && span.start <= last.end) {
      out[out.length - 1] = { start: last.start, end: Math.max(last.end, span.end) };
    } else {
      out.push({ start: span.start, end: span.end });
    }
  }
  return out;
}

/** The detections a candidate's spans give at one operating point. */
export function detectionsAt(text: string, spans: readonly ScoredSpan[], point: Point): Span[] {
  const kept = spans.filter(
    (s) =>
      s.score >= point.high ||
      (point.mid !== undefined && s.score >= point.mid && hasCue(text, s.start, s.end)),
  );
  return merge(kept.map((s) => widenToWords(text, s)));
}

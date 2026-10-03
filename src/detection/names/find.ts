// From the model's answer to the name spans the gateway redacts (ADR-037).
//
// The path is the configuration ADR-035 measured, in the moved code: B's
// spans at high 0.9 / mid 0.6, F's at NO_SCORE, each widened to whole words
// and joined by joinDetections. Then option 2 of ADR-036 for a name cut
// short at an invisible character, which changes nothing on the measured
// texts (it fired 0 times on the generated set).
//
// The model's answer is checked first, and it is untrusted: in step 4 it
// arrives from a worker. Anything that is not a list of in-range spans with
// scores between 0 and 1, one list per text, refuses the request: we cannot
// tell which part of the text a broken answer meant, so we cannot know what
// it left visible. A span with no characters claims nothing and is dropped
// (widening it would invent a name around a position). Overlapping spans and
// a span over the whole text are answers, not errors: they are joined, and
// what they cover is redacted.

import { charAt, charBefore } from '../digit-runs.js';
import type { Span } from '../normalise.js';
import { listSpans } from './gazetteer.js';
import { joinDetections, NO_SCORE } from './join.js';
import { detectionsAt, merge, type Point, type ScoredSpan } from './spans.js';

/** B's operating point (ADR-035): kept at 0.9, or at 0.6 with a cue nearby. */
export const MODEL_POINT: Point = { high: 0.9, mid: 0.6 };

/** The model's answer is not something we can read: the request is refused. */
export class MalformedModelOutput extends Error {
  constructor() {
    super('the name model returned an answer that is not a list of spans per text');
    this.name = 'MalformedModelOutput';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Checks the model's answer for `texts` and returns its spans, without the
 * empty ones. Throws MalformedModelOutput unless it is one list per text,
 * each span with integer offsets 0 <= start <= end <= the text's length and
 * a score in [0, 1], and no list longer than its text (the model gives at
 * most one span per word, so more spans than characters is not an answer).
 */
export function modelSpans(texts: readonly string[], output: unknown): ScoredSpan[][] {
  if (!Array.isArray(output) || output.length !== texts.length) throw new MalformedModelOutput();
  return texts.map((text, i) => {
    const spans: unknown = output[i];
    if (!Array.isArray(spans) || spans.length > text.length) throw new MalformedModelOutput();
    const kept: ScoredSpan[] = [];
    for (const span of spans as unknown[]) {
      if (!isRecord(span)) throw new MalformedModelOutput();
      const { start, end, score } = span;
      if (
        typeof start !== 'number' ||
        typeof end !== 'number' ||
        typeof score !== 'number' ||
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        start > end ||
        end > text.length ||
        !(score >= 0 && score <= 1)
      ) {
        throw new MalformedModelOutput();
      }
      if (start < end) kept.push({ start, end, score });
    }
    return kept;
  });
}

/** The names in `text`: the model's checked spans and F's (from `list`), joined and extended. */
export function nameSpans(
  text: string,
  model: readonly ScoredSpan[],
  list: ReadonlySet<string>,
): Span[] {
  const joined = joinDetections(
    detectionsAt(text, model, MODEL_POINT),
    detectionsAt(text, listSpans(text, list), NO_SCORE),
  );
  return extendOverInvisibles(text, joined);
}

const INVISIBLE = /\p{Default_Ignorable_Code_Point}/u;
const LETTER_OR_MARK = /[\p{L}\p{M}]/u;

/**
 * Option 2 of ADR-036: where a span's edge stops at invisible characters
 * with a letter or mark right behind them (`Asha` of `Asha<soft hyphen>rani`),
 * the span extends over them and the letters and marks after them,
 * repeatedly, to the end of the word. Spans that then meet are merged.
 */
export function extendOverInvisibles(text: string, spans: readonly Span[]): Span[] {
  return merge(
    spans.map((span) => ({ start: extendStart(text, span.start), end: extendEnd(text, span.end) })),
  );
}

function extendEnd(text: string, end: number): number {
  let reach = end;
  for (;;) {
    let at = reach;
    let ch = charAt(text, at);
    if (!INVISIBLE.test(ch)) return reach;
    while (INVISIBLE.test(ch)) {
      at += ch.length;
      ch = charAt(text, at);
    }
    if (!LETTER_OR_MARK.test(ch)) return reach;
    while (LETTER_OR_MARK.test(ch)) {
      at += ch.length;
      ch = charAt(text, at);
    }
    reach = at;
  }
}

function extendStart(text: string, start: number): number {
  let reach = start;
  for (;;) {
    let at = reach;
    let ch = charBefore(text, at);
    if (!INVISIBLE.test(ch)) return reach;
    while (INVISIBLE.test(ch)) {
      at -= ch.length;
      ch = charBefore(text, at);
    }
    if (!LETTER_OR_MARK.test(ch)) return reach;
    while (LETTER_OR_MARK.test(ch)) {
      at -= ch.length;
      ch = charBefore(text, at);
    }
    reach = at;
  }
}

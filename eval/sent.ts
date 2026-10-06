// The count of personal values sent as written (ADR-040): what the
// redaction lets out, beside the detection scores, which measure what
// `detect()` finds. Bugs 58 and 61 showed the two can differ: a value can
// be detected and still be sent.
//
// For every case: redact its messages in order with one mapping (as the
// gateway redacts a request), and for every labelled personal value (any
// slot but NOT: lookalikes are meant to pass through), check whether its
// text, exactly as written in its message, appears in that message's
// redacted text. Verbatim only: a value sent partly (a placeholder over
// some of its characters) is not counted here (ADR-040, "the blind spot").
// The count reads redactMessage's output; the request body built from it
// is checked on raw bytes by the gateway's no-leak test.
//
// Counts only: no text, no case id.

import { PlaceholderMapping } from '../src/redaction/mapping.js';
import { redactMessage } from '../src/redaction/redact.js';
import { casesByPart } from './echo.js';
import type { LabelledCase } from './types.js';

export interface SentScore {
  /** Labelled personal values (every mention counts). */
  readonly values: number;
  /** Of them, values whose text appears, as written, in what is sent. */
  readonly sent: number;
}

export type Redactor = typeof redactMessage;

/** The sent count of `cases`. The redactor is for tests. */
export function sent(
  cases: readonly LabelledCase[],
  { redactor = redactMessage }: { readonly redactor?: Redactor } = {},
): SentScore {
  let values = 0;
  let sentCount = 0;
  for (const labelled of cases) {
    const mapping = new PlaceholderMapping();
    for (const message of labelled.messages) {
      const out = redactor(message.text, mapping);
      for (const piece of message.pieces) {
        if (piece.type === 'NOT') continue;
        values++;
        if (out.includes(message.text.slice(piece.start, piece.end))) sentCount++;
      }
    }
  }
  return { values, sent: sentCount };
}

/** The generated set's sent count by part: `main`, then each shape. */
export function sentByShape(cases: readonly LabelledCase[]): Record<string, SentScore> {
  return Object.fromEntries([...casesByPart(cases)].map(([part, set]) => [part, sent(set)]));
}

/**
 * A part where some values are known to be sent and that is accepted, with
 * why: written by hand in eval/baseline.json, never by a run (ADR-040).
 */
export interface KnownFailing {
  readonly part: string;
  /** The exact number of values sent there. */
  readonly sent: number;
  readonly why: string;
}

/**
 * Every known-failing entry whose part no longer sends exactly its number,
 * in either direction: a fix or a regression must edit the entry on
 * purpose, so that someone notices.
 */
export function knownFailingMismatches(
  entries: readonly KnownFailing[],
  measured: Readonly<Record<string, SentScore>>,
): string[] {
  return entries.flatMap(({ part, sent: expected }) => {
    const now = measured[part]?.sent;
    return now === expected
      ? []
      : [
          `known-failing ${part}: the entry says ${expected} sent, measured ${now ?? 'no such part'}`,
        ];
  });
}

// Finds a planted value in captured text (outgoing requests, responses, log
// lines, errors) in any form it could take (CLAUDE.md, "No-leak test"):
//  - raw: exactly as planted, invisible characters and all;
//  - lowercased;
//  - normalised: through the same normalise() detection uses, so a value
//    planted in Devanagari digits is found if it went out as ASCII;
//  - squashed: normalised, lowercased, with separators (whitespace, dots,
//    hyphens and dashes, brackets, slashes, `+`) removed on both sides, so
//    `4111-1111…` is found as `41111111…`.
// Captured text that is JSON is also decoded, so an escaped zero-width space or a
// value inside an escaped string is compared as the characters it stands
// for.
//
// Squashing removes separators, not every non-digit: `[CARD_1] [CARD_2]`
// squashes to `card_1card_2`, and the letters and underscores keep unrelated
// digits from running together into a false match.
//
// A result names the form only, never the value (ADR-009).

import { normalise } from '../../src/detection/normalise.js';

export type LeakForm = 'raw' | 'lowercased' | 'normalised' | 'squashed';

// Whitespace, dots, hyphens, the Unicode dashes U+2010-U+2015 and minus
// U+2212, brackets, slashes and plus.
const SEPARATORS = /[\s.\-‐-―−()[\]{}/\\+]/gu;

const squash = (text: string): string => normalise(text).text.toLowerCase().replace(SEPARATORS, '');

function jsonStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) jsonStrings(item, out);
  else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      jsonStrings(item, out);
    }
  }
}

/** The text itself plus, for each line that parses as JSON, its decoded strings. */
export function expandCaptured(text: string): string {
  const parts = [text];
  for (const line of text.split('\n')) {
    try {
      const strings: string[] = [];
      jsonStrings(JSON.parse(line), strings);
      parts.push(...strings);
    } catch {
      // Not JSON: the raw text above already covers it.
    }
  }
  return parts.join('\n');
}

// The forms of the captured text last asked about. A test checks many
// planted values against one captured text, and normalising that text twice
// per value was most of the no-leak test's running time (bug-log 23).
let last: { captured: string; lower: string; normalised: string; squashed: string } | undefined;

function formsOf(captured: string): NonNullable<typeof last> {
  if (last?.captured !== captured) {
    last = {
      captured,
      lower: captured.toLowerCase(),
      normalised: normalise(captured).text,
      squashed: squash(captured),
    };
  }
  return last;
}

/**
 * The first form in which `value` appears in `captured`, or undefined if it
 * appears in none. `captured` should already be expanded (expandCaptured).
 */
export function leakedForm(captured: string, value: string): LeakForm | undefined {
  if (captured.includes(value)) return 'raw';
  const forms = formsOf(captured);
  if (forms.lower.includes(value.toLowerCase())) return 'lowercased';
  if (forms.normalised.includes(normalise(value).text)) return 'normalised';
  const squashedValue = squash(value);
  if (squashedValue.length > 0 && forms.squashed.includes(squashedValue)) return 'squashed';
  return undefined;
}

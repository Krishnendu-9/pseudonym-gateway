// The safety net (ADR-011): long numbers that no detector claimed.
//
// Every detector recognises a shape (an Aadhaar, a card, a phone number) and
// can be confused by an unusual layout: two mobiles glued by a hyphen form one
// 20-digit run that nothing claims (bug-log 8). A bank account number (9 to
// 18 digits in India) has no detector at all. So after the detectors have
// run, any stretch of at least MIN_NUMBER_DIGITS digits that none of them
// claimed is redacted as a generic NUMBER. It is the least specific type and
// never beats a real detection.
//
// Digits count across joiners (dots, hyphens and dashes, brackets, "+"), the
// ways bug 8 glued numbers together. A space is not a joiner: with it,
// "2024-09-28 14:30" and table rows of small numbers would reach 9 digits
// (measured in ADR-011). Unlike the detectors, the net ignores what the
// digits are glued to, so "UID234567890123" is caught too.
//
// What the digits are glued to goes with them (ADR-011 amendment, Phase 5b):
// a stretch found inside a longer token takes the whole token, letters,
// digits and underscores on both sides. Otherwise the net would cut nine
// digits out of a 40-character token and send the other 31 characters, and
// part of a secret is a leak, not a redaction. It stops at anything a real
// detection claimed.
//
// This runs on normalised text, where every decimal digit is ASCII.

import { charAt, charBefore } from './digit-runs.js';
import type { Span } from './normalise.js';
import type { Candidate } from './types.js';

/** A stretch of unclaimed digits this long or longer is redacted. */
export const MIN_NUMBER_DIGITS = 9;

const JOINER = '[.\\-\\u2010-\\u2015\\u2212()[\\]+]';
const NUMBER_RUN = new RegExp(`[0-9]+(?:${JOINER}{1,3}[0-9]+)*`, 'g');
const DIGIT = /[0-9]/;
// What makes a token: the same "glued" characters the detectors look at.
const TOKEN_CHAR = /[\p{L}\p{N}\p{M}_]/u;

/**
 * NUMBER candidates for the stretches of digit runs that no span in `claimed`
 * covers. `claimed` must be sorted by start and must not overlap.
 */
export function unclaimedNumbers(text: string, claimed: readonly Span[]): Candidate[] {
  const found: Candidate[] = [];
  let next = 0; // first claimed span that ends after `at`
  for (const run of text.matchAll(NUMBER_RUN)) {
    const runEnd = run.index + run[0].length;
    // Walk the run, splitting it at every claimed span. A claimed span may
    // start before the run or reach past it (a card claimed across spaces
    // covers several runs), so `next` only moves past spans that end before
    // the current position.
    let at = run.index;
    while (at < runEnd) {
      while (next < claimed.length && claimed[next]!.end <= at) next++;
      const claim = claimed[next];
      // Every claimed span before `next` ends at or before `at`.
      const floor = next > 0 ? claimed[next - 1]!.end : 0;
      if (!claim || claim.start >= runEnd) {
        addIfLong(text, at, runEnd, floor, claim ? claim.start : text.length, found);
        break;
      }
      addIfLong(text, at, claim.start, floor, claim.start, found);
      at = claim.end;
    }
  }
  return found;
}

// Trims joiners off both ends of text[start, end) and, if it holds enough
// digits, adds it widened to the whole token it is glued into, without
// leaving [floor, ceiling): the claimed spans on either side. An empty or
// reversed range holds no digits.
function addIfLong(
  text: string,
  start: number,
  end: number,
  floor: number,
  ceiling: number,
  found: Candidate[],
): void {
  let digits = 0;
  let first = -1;
  let last = -1;
  for (let i = start; i < end; i++) {
    if (!DIGIT.test(text[i]!)) continue;
    digits++;
    if (first < 0) first = i;
    last = i;
  }
  if (digits < MIN_NUMBER_DIGITS) return;

  let from = first;
  let to = last + 1;
  const previous = found.at(-1);
  if (previous && first < previous.end) {
    // This stretch starts inside the token the previous one was widened
    // over ("123456789abc987654321"): one token, one detection. The token is
    // not walked again, so a long token full of numbers stays linear.
    if (to <= previous.end) return;
    from = previous.start;
    found.pop();
  } else {
    for (let ch = charBefore(text, from); from > floor && TOKEN_CHAR.test(ch);) {
      from -= ch.length;
      ch = charBefore(text, from);
    }
  }
  for (let ch = charAt(text, to); to < ceiling && TOKEN_CHAR.test(ch);) {
    to += ch.length;
    ch = charAt(text, to);
  }
  found.push({ type: 'NUMBER', start: from, end: to, validated: false });
}

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
// digits are glued to, so "UID234567890123" is caught too, at the cost of
// sometimes cutting a digit stretch out of a hash.
//
// This runs on normalised text, where every decimal digit is ASCII.

import type { Span } from './normalise.js';
import type { Candidate } from './types.js';

/** A stretch of unclaimed digits this long or longer is redacted. */
export const MIN_NUMBER_DIGITS = 9;

const JOINER = '[.\\-\\u2010-\\u2015\\u2212()[\\]+]';
const NUMBER_RUN = new RegExp(`[0-9]+(?:${JOINER}{1,3}[0-9]+)*`, 'g');
const DIGIT = /[0-9]/;

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
      if (!claim || claim.start >= runEnd) {
        addIfLong(text, at, runEnd, found);
        break;
      }
      addIfLong(text, at, claim.start, found);
      at = claim.end;
    }
  }
  return found;
}

// Trims joiners off both ends of text[start, end) and adds it if it holds
// enough digits. An empty or reversed range holds none.
function addIfLong(text: string, start: number, end: number, found: Candidate[]): void {
  let digits = 0;
  let first = -1;
  let last = -1;
  for (let i = start; i < end; i++) {
    if (!DIGIT.test(text[i]!)) continue;
    digits++;
    if (first < 0) first = i;
    last = i;
  }
  if (digits >= MIN_NUMBER_DIGITS) {
    found.push({ type: 'NUMBER', start: first, end: last + 1, validated: false });
  }
}

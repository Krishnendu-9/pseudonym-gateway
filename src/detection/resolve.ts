// Overlap resolution for the pipeline (ADR-003, amended by ADR-029).
//
// 1. The plain rule (overlap.ts) picks winners: validated first, then the
//    longer, counting letters and digits only, then type priority.
// 2. Containing span: a candidate that lost, but wholly contains every
//    winner it touches, replaces them, longest first. An email address with
//    a PAN in its local part is one email, not a PAN with the rest of the
//    address left over; `token: abc-<mobile>` is one secret. A replacement
//    that holds a validated value of its own type counts as validated.
// 3. Remainders: every other candidate that lost keeps the part of its text
//    that nothing kept so far covers, as a detection of its own type, best
//    ranked first. Two values that overlap without one containing the other
//    (`<Aadhaar>-name@example.com`, where the address's local part starts
//    inside the Aadhaar) are then both redacted, wholly. Where such a part
//    was cut off, characters other than letters and digits at the cut stay
//    text, as at a cut between widened values (ADR-028). Digits in a run a
//    kept detection touches are left alone: widening gives them to it, so a
//    16-digit number stays one detection instead of two.
//
// Both steps are near-linear: replacements are tracked with a Fenwick tree
// over text positions, remainders by painting each position once.

import { charAt, charBefore } from './digit-runs.js';
import type { Span } from './normalise.js';
import { compareCandidates, resolveOverlaps, type SizeOf } from './overlap.js';
import type { Detection } from './types.js';

const SIGNIFICANT = /[\p{L}\p{N}]/u;

/** Letters and digits in a span, in constant time after one pass over `text`. */
export function significantSize(text: string): SizeOf {
  const prefix = new Uint32Array(text.length + 1);
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!;
    const counts = SIGNIFICANT.test(String.fromCodePoint(code));
    prefix[i + 1] = prefix[i]! + (counts ? 1 : 0);
    if (code > 0xffff) {
      i++;
      prefix[i + 1] = prefix[i]!;
    }
  }
  return (span) => prefix[span.end]! - prefix[span.start]!;
}

/**
 * Winners for `accepted`, in text order, not overlapping (steps 1 to 3
 * above). `widen` is how the pipeline will widen a kept detection.
 */
export function resolveCandidates(
  text: string,
  accepted: readonly Detection[],
  widen: (detection: Detection) => Span,
): Detection[] {
  const sizeOf = significantSize(text);
  const kept = replaceByContaining(
    text.length,
    accepted,
    resolveOverlaps(accepted, sizeOf),
    sizeOf,
  );
  return withRemainders(text, accepted, kept, sizeOf, widen);
}

/** First index in `sorted` (by start, not overlapping) whose span ends after `at`. */
function firstEndingAfter(sorted: readonly Span[], at: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]!.end <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index in `sorted` whose span starts at or after `at`. */
function firstStartingFrom(sorted: readonly Span[], at: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]!.start < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Counts marked positions in a range; each position is marked at most once. */
class MarkedPositions {
  private readonly tree: Uint32Array;
  constructor(size: number) {
    this.tree = new Uint32Array(size + 1);
  }
  mark(position: number): void {
    for (let i = position + 1; i < this.tree.length; i += i & -i) this.tree[i]!++;
  }
  /** Marked positions in [0, end). */
  private before(end: number): number {
    let sum = 0;
    for (let i = end; i > 0; i -= i & -i) sum += this.tree[i]!;
    return sum;
  }
  any(span: Span): boolean {
    return this.before(span.end) - this.before(span.start) > 0;
  }
}

/**
 * Step 2. A replacement is never replaced again: a later loser is no longer
 * than it, so it cannot contain it (and the same span is not a replacement).
 * So a loser qualifies if it touches no replacement and its first and last
 * touched winners lie inside it; the winners between them do too.
 */
function replaceByContaining(
  length: number,
  accepted: readonly Detection[],
  winners: readonly Detection[],
  sizeOf: SizeOf,
): Detection[] {
  const won = new Set(winners);
  const losers = accepted
    .filter((c) => !won.has(c))
    .sort((a, b) => sizeOf(b) - sizeOf(a) || a.start - b.start);
  const replaced = new MarkedPositions(length);
  const alive = winners.map(() => true);
  const replacements: Detection[] = [];
  for (const loser of losers) {
    // A loser lost to a winner it overlaps, so it touches at least one:
    // first <= last.
    const first = firstEndingAfter(winners, loser.start);
    const last = firstStartingFrom(winners, loser.end) - 1;
    const a = winners[first]!;
    const b = winners[last]!;
    if (a.start < loser.start || b.end > loser.end) continue; // not containing
    if (first === last && a.start === loser.start && a.end === loser.end) continue;
    if (replaced.any(loser)) continue;
    for (let i = first; i <= last; i++) alive[i] = false;
    for (let at = loser.start; at < loser.end; at++) replaced.mark(at);
    const holdsValidated = winners
      .slice(first, last + 1)
      .some((w) => w.validated && w.type === loser.type);
    replacements.push(holdsValidated ? { ...loser, validated: true } : loser);
  }
  return [...winners.filter((_, i) => alive[i]), ...replacements].sort((x, y) => x.start - y.start);
}

/**
 * Step 3. Each position is painted by the best-ranked candidate that covers
 * it and that no kept detection covers; `next` skips painted positions, so
 * each is visited once. Runs of one candidate's paint become detections.
 */
function withRemainders(
  text: string,
  accepted: readonly Detection[],
  kept: readonly Detection[],
  sizeOf: SizeOf,
  widen: (detection: Detection) => Span,
): Detection[] {
  const keptSet = new Set(kept);
  const losers = accepted
    .filter((c) => !keptSet.has(c))
    .sort((a, b) => compareCandidates(a, b, sizeOf));
  if (losers.length === 0) return [...kept];

  const NONE = -1;
  const KEPT = -2;
  const owner = new Int32Array(text.length).fill(NONE);
  for (const d of kept) {
    const wide = widen(d);
    owner.fill(KEPT, wide.start, wide.end);
  }
  // next[i]: the first position at or after i that is not painted.
  const next = new Int32Array(text.length + 1);
  for (let i = text.length; i >= 0; i--) {
    next[i] = i < text.length && owner[i] !== NONE ? next[i + 1]! : i;
  }
  const find = (i: number): number => {
    let root = i;
    while (next[root] !== root) root = next[root]!;
    while (next[i] !== root) {
      const up = next[i]!;
      next[i] = root;
      i = up;
    }
    return root;
  };
  for (const [index, loser] of losers.entries()) {
    for (let i = find(loser.start); i < loser.end; i = find(i + 1)) {
      owner[i] = index;
      next[i] = i + 1;
    }
  }

  const remainders: Detection[] = [];
  for (let i = 0; i < text.length;) {
    const index = owner[i]!;
    let end = i + 1;
    while (end < text.length && owner[end] === index) end++;
    if (index >= 0) {
      const loser = losers[index]!;
      let start = i;
      let stop = end;
      // Whole code points: a letter outside the BMP is two code units.
      if (start !== loser.start) {
        for (let ch = charAt(text, start); start < stop && !SIGNIFICANT.test(ch);) {
          start += ch.length;
          ch = charAt(text, start);
        }
      }
      if (stop !== loser.end) {
        for (let ch = charBefore(text, stop); stop > start && !SIGNIFICANT.test(ch);) {
          stop -= ch.length;
          ch = charBefore(text, stop);
        }
      }
      // Every run has a cut on at least one side (a loser touches what is
      // kept), and trimming from a cut removes everything that is not a
      // letter or digit: so a run that is not empty now holds one.
      if (stop > start) remainders.push({ ...loser, start, end: stop });
    }
    i = end;
  }
  return [...kept, ...remainders].sort((x, y) => x.start - y.start);
}

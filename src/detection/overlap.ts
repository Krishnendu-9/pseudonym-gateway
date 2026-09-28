// When detections overlap, one wins (ADR-003):
//   1. a validated detection beats an unvalidated one;
//   2. then the longer span wins;
//   3. then the fixed type priority: Aadhaar > Card > PAN > Phone > Email
//      (IFSC, UPI, IPv6, IPv4 and secrets slot in when their detectors exist).
// Ties after that go to the earlier span, so the result never depends on the
// order the detectors ran in.
//
// Candidates are ranked by these rules and taken greedily: each one is kept
// unless it overlaps one already kept. Spans are half-open, so two spans that
// only touch ([0, 4) and [4, 8)) do not overlap.

import { DETECTION_TYPES, type Candidate } from './types.js';

const PRIORITY = new Map(DETECTION_TYPES.map((type, rank) => [type, rank]));

/** Negative if `a` beats `b`. */
export function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    Number(b.validated) - Number(a.validated) ||
    b.end - b.start - (a.end - a.start) ||
    PRIORITY.get(a.type)! - PRIORITY.get(b.type)! ||
    a.start - b.start
  );
}

/** The winners, in text order, with no two overlapping. */
export function resolveOverlaps<T extends Candidate>(candidates: readonly T[]): T[] {
  const kept: T[] = []; // sorted by start, never overlapping
  for (const candidate of [...candidates].sort(compareCandidates)) {
    // Binary search for the first kept span that ends after this one starts.
    let lo = 0;
    let hi = kept.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (kept[mid]!.end <= candidate.start) lo = mid + 1;
      else hi = mid;
    }
    // Kept spans do not overlap each other, so that one is the only possible clash.
    if (lo < kept.length && kept[lo]!.start < candidate.end) continue;
    kept.splice(lo, 0, candidate);
  }
  return kept;
}

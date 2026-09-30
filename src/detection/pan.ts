// PAN (Permanent Account Number): 5 letters, 4 digits, 1 letter, e.g. the
// shape AAAPA9999A. The 4th letter says what kind of holder it is (P for a
// person, C for a company, ...). Validated (ADR-003) when that letter is a
// known holder-type code; otherwise an unvalidated candidate, accepted only
// with a keyword such as "PAN" nearby (ADR-010).
//
// Matched in any case: people type "abcpe1234f" too. It has no check digit.

import type { Candidate } from './types.js';

// Holder-type codes. Source: https://en.wikipedia.org/wiki/Permanent_account_number
// (written independently of the generator's list in src/synthetic/values.ts).
const HOLDER_TYPES = new Set(['P', 'C', 'H', 'F', 'A', 'T', 'B', 'L', 'J', 'G']);

// Not glued to other letters, digits, marks or underscores: a PAN-shaped
// stretch inside a longer token (an API key, a hash) is not a PAN. Nor to
// "@": there it is part of an email address or a UPI ID, which their
// detectors own, as for digits (digit-runs.ts; bug-log 27).
const PAN_PATTERN = /(?<![\p{L}\p{N}\p{M}_@])[A-Za-z]{5}[0-9]{4}[A-Za-z](?![\p{L}\p{N}\p{M}_@])/gu;

export function isValidPan(pan: string): boolean {
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/i.test(pan) && HOLDER_TYPES.has(pan[3]!.toUpperCase());
}

export function* panCandidates(text: string): Generator<Candidate> {
  for (const m of text.matchAll(PAN_PATTERN)) {
    yield { type: 'PAN', start: m.index, end: m.index + 10, validated: isValidPan(m[0]) };
  }
}

// Voter ID (EPIC, the Elector's Photo Identity Card) numbers: three letters,
// then seven digits. Keyword only (ADR-031): no check digit, and order,
// transaction and reference codes are often written the same way (ORD and
// seven digits), so a candidate is never validated and is accepted only
// with "voter", "EPIC" or मतदाता nearby (context.ts, ADR-010).
//
// Matched in any case, like PAN. Not glued to a letter, digit, mark,
// underscore or "@", the same rule as PAN and IFSC.
//
// Known limit (ADR-031): the older state-issued formats (with slashes, or
// two letters) are not matched.

import type { Candidate } from './types.js';

const VOTER_PATTERN = /(?<![\p{L}\p{N}\p{M}_@])[A-Za-z]{3}[0-9]{7}(?![\p{L}\p{N}\p{M}_@])/gu;

export function* voterCandidates(text: string): Generator<Candidate> {
  for (const m of text.matchAll(VOTER_PATTERN)) {
    yield { type: 'VOTER', start: m.index, end: m.index + 10, validated: false };
  }
}

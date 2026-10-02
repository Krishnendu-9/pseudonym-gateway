// Indian passport numbers: one letter, then seven digits. Keyword only
// (ADR-031): the shape has no check digit and no structure to validate,
// and every model number, ticket or invoice code of the same shape would
// match it, so a candidate is never validated and is accepted only with
// "passport" or पासपोर्ट nearby (context.ts, ADR-010).
//
// Matched in any case, like PAN. Not glued to a letter, digit, mark,
// underscore or "@", the same rule as PAN and IFSC: a passport-shaped
// stretch inside a longer token is not a passport number.
//
// Known limits (ADR-031): a number written with a space or hyphen after its
// letter (`A 1234567`), and the older formats of other countries.

import type { Candidate } from './types.js';

const PASSPORT_PATTERN = /(?<![\p{L}\p{N}\p{M}_@])[A-Za-z][0-9]{7}(?![\p{L}\p{N}\p{M}_@])/gu;

export function* passportCandidates(text: string): Generator<Candidate> {
  for (const m of text.matchAll(PASSPORT_PATTERN)) {
    yield { type: 'PASSPORT', start: m.index, end: m.index + 8, validated: false };
  }
}

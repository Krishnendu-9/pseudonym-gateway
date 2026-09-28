// Phone numbers, Indian and international, found by libphonenumber-js with
// its full ("max") metadata (ADR-004). Numbers without a country code are
// read as Indian.
//
// libphonenumber searches in two strictness levels:
// - VALID: the number is valid for its country (ADR-003's "validated"). This
//   level also rejects numbers with letters right next to them.
// - POSSIBLE: the right length for its country, but not necessarily an
//   assigned range. These become unvalidated candidates, accepted only with a
//   keyword such as "phone" or "call" nearby (ADR-010). This catches numbers
//   whose range the metadata does not know about yet.
//
// POSSIBLE does not check the neighbouring characters, so its extra matches
// get the same "not glued to a word" check as the other detectors. Digits
// glued to "@" belong to an email address (9123456780@example.com), not a
// phone: otherwise the validated phone would win the overlap and leave the
// rest of the address unredacted.
//
// A match glued to a digit is kept, not dropped (bug-log 7): libphonenumber
// sometimes stops inside a digit run ("<a>(<b>" reports a piece), and
// dropping that match would leave both numbers visible. detect() widens a
// kept match to the whole digit runs it touches, so nothing is cut.
//
// libphonenumber reads ",", ";", "#", "~", "x", "ext" and similar after a
// number as the start of an extension, and then reports one match running
// from the first number of a list ("<a>, <b>") into the middle of the second.
// So it gets a copy of the text with every extension marker replaced by
// newlines of the same length: offsets stay the same, and a newline ends a
// number. Extensions are lost; they are not personal data. The labels are
// libphonenumber's own (createExtensionPattern.js), in the NFKC form the
// detectors see.

import { findPhoneNumbersInText } from 'libphonenumber-js/max';
import { charAt, charBefore } from './digit-runs.js';
import type { Candidate } from './types.js';

const DEFAULT_COUNTRY = 'IN';
const GLUED = /[\p{L}\p{M}_@]/u;
const EXTENSION_MARKER =
  /[,;#~]|(?<![\p{L}\p{N}\p{M}_])(?:e?xt(?:ensi[oó])?n?|x|int|доб|anexo)(?![\p{L}\p{N}\p{M}_])/giu;

/** `text` with every extension marker blanked out, for libphonenumber only. */
export const hideExtensionMarkers = (text: string): string =>
  text.replace(EXTENSION_MARKER, (marker) => '\n'.repeat(marker.length));

const isFree = (text: string, start: number, end: number): boolean =>
  !GLUED.test(charBefore(text, start)) && !GLUED.test(charAt(text, end));

export function* phoneCandidates(text: string): Generator<Candidate> {
  const searched = hideExtensionMarkers(text);
  for (const found of findPhoneNumbersInText(searched, { defaultCountry: DEFAULT_COUNTRY })) {
    if (!isFree(text, found.startsAt, found.endsAt)) continue;
    yield { type: 'PHONE', start: found.startsAt, end: found.endsAt, validated: true };
  }
  const possible = findPhoneNumbersInText(searched, {
    defaultCountry: DEFAULT_COUNTRY,
    extended: true,
  });
  for (const found of possible) {
    // Valid ones were reported above, unless the VALID search rejected them.
    if (found.number.isValid() || !isFree(text, found.startsAt, found.endsAt)) continue;
    yield { type: 'PHONE', start: found.startsAt, end: found.endsAt, validated: false };
  }
}

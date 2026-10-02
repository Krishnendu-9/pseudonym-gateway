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
// detectors see. A label counts when it stands alone or right after a digit
// ("…1234X", the last letter of a PAN or a key): libphonenumber reads the
// latter as an extension too, and then reports nothing for a spaced number
// after it (bug-log 36). One glued to a letter, or followed by a letter or
// digit ("24x7", "6789x123"), is left alone.
//
// libphonenumber does not look inside a stretch of spaced digit groups that
// is not a valid number as a whole, so a mobile written 5 + 5 with another
// group beside it is found by spaced-mobile.ts instead (bug-log 34).
//
// A number wrapped onto the next line (ADR-030) is tried as one number, the
// line break read as a space, but only as an unvalidated candidate: two
// lines of five digits are as often two amounts as one mobile, so a phone
// keyword is needed.

import { findPhoneNumbersInText } from 'libphonenumber-js/max';
import { charAt, charBefore, crossLineWindows } from './digit-runs.js';
import { spacedMobileCandidates } from './spaced-mobile.js';
import type { Candidate } from './types.js';

const DEFAULT_COUNTRY = 'IN';
const GLUED = /[\p{L}\p{M}_@]/u;
const EXTENSION_MARKER =
  /[,;#~]|(?<![\p{L}\p{M}_])(?:e?xt(?:ensi[oó])?n?|x|int|доб|anexo)(?![\p{L}\p{N}\p{M}_])/giu;

/** `text` with every extension marker blanked out, for libphonenumber only. */
export const hideExtensionMarkers = (text: string): string =>
  text.replace(EXTENSION_MARKER, (marker) => '\n'.repeat(marker.length));

const isFree = (text: string, start: number, end: number): boolean =>
  !GLUED.test(charBefore(text, start)) && !GLUED.test(charAt(text, end));

export function* phoneCandidates(text: string): Generator<Candidate> {
  const withinLines = [...oneLinePhoneCandidates(text)];
  yield* withinLines;
  yield* wrappedPhoneCandidates(text, withinLines);
}

function* oneLinePhoneCandidates(text: string): Generator<Candidate> {
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
  yield* spacedMobileCandidates(text);
}

// Phone numbers have 7 to 15 digits (E.164), country code included. A
// window that holds a whole valid phone found within a line is not a phone
// split by the line break: "Flat 12", newline, "<mobile>" would otherwise
// contain the mobile, replace it (ADR-029) and take the flat number with it
// (bug-log 41). Only valid ones count: "+91 98765" alone is a possible
// number, and the window over it and the next line is the real mobile. A
// window starting with "+" is kept anyway: "+1", newline, "<number>" is
// the country code on a line of its own.
function* wrappedPhoneCandidates(
  text: string,
  withinLines: readonly Candidate[],
): Generator<Candidate> {
  const sorted = withinLines.filter((c) => c.validated).sort((a, b) => a.start - b.start);
  // Binary search for the first one starting in the window; only the few
  // starting inside it can lie inside it.
  const holdsOne = (from: number, to: number): boolean => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]!.start < from) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < sorted.length && sorted[k]!.start < to; k++) {
      if (sorted[k]!.end <= to) return true;
    }
    return false;
  };
  for (const window of crossLineWindows(text, 7, 15)) {
    const plus = window.startsRun && text[window.start - 1] === '+';
    const start = plus ? window.start - 1 : window.start;
    if (!isFree(text, start, window.end) || (!plus && holdsOne(start, window.end))) continue;
    const piece = text.slice(start, window.end).replace(/[\r\n]/g, ' ');
    // POSSIBLE includes VALID; the match must be the whole window.
    const found = findPhoneNumbersInText(piece, {
      defaultCountry: DEFAULT_COUNTRY,
      extended: true,
    });
    if (found.some((f) => f.startsAt === 0 && f.endsAt === piece.length)) {
      yield { type: 'PHONE', start, end: window.end, validated: false };
    }
  }
}

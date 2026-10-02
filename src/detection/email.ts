// Email addresses. Pattern only: there is nothing to validate without
// sending mail, so an email is never "validated" (ADR-003). The pattern is
// specific enough to be accepted without context (ADR-010).
//
// Accepts what people actually type, including Unicode local parts and
// internationalised domains (प्रिया@उदाहरण.भारत). Does not accept quoted local
// parts ("a b"@example.com), IP-literal domains (a@[192.0.2.1]) or spelled-out
// forms ("priya at example dot com"). Known limits, documented in the README.
//
// Found at every "@" (ADR-029): the local part is read leftwards from it, as
// far as local-part characters go (a dot only between two of them), and the
// domain rightwards. A left-to-right search cannot return two addresses that
// overlap, and glued addresses do: in "a@example.com-priya.sharma@example.org"
// the first domain may run to "sharma", and the second local part starts
// inside it. Both are candidates; the overlap rule decides, and what the
// loser leaves uncovered stays redacted (resolve.ts).
//
// Linear: neither direction crosses another "@" (no local-part or domain
// character is one), so each stretch is read at most twice. That also rules
// out the catastrophic backtracking of bug-log 3: no pattern is tried at
// every position of a long token.
//
// A UPI ID (<name>@okaxis) is not an email: it has no top-level domain, so
// this pattern never matches it, and the UPI detector steps aside wherever
// this pattern does match (<name>@okaxis.com is an email).
//
// Fails closed: nothing has a length limit. DNS caps a domain label at 63
// characters, but an address with a longer label still names a person, so
// it is redacted rather than let through as "not a real address".

import { charBefore } from './digit-runs.js';
import type { Candidate } from './types.js';

// RFC 5322's local-part characters, except "/", "=" and "?" (bug-log 49,
// ADR-034): with them, an address in a URL's query or path took the URL
// with it (`https:[EMAIL_1]` for `https://a.example/?id=<address>`), and
// the URL rule of restoration safety could no longer see a URL. A
// deliberate fail-open trade: an address that really uses one of the three
// (`a/b@example.com`) is redacted only from the character after it, and
// what is before it is sent. Providers do not issue such addresses; URLs
// with an address in them are common.
const LOCAL_CHAR = "[\\p{L}\\p{N}\\p{M}!#$%&'*+^_`{|}~-]";
const LABEL = '[\\p{L}\\p{N}\\p{M}](?:[\\p{L}\\p{N}\\p{M}-]*[\\p{L}\\p{N}\\p{M}])?';
// Top-level domain: punycode, or letters (a Devanagari TLD needs its vowel
// signs, \p{M}). Punycode is tried first, or "xn--p1ai" would stop at "xn".
const TLD = '(?:xn--[a-z0-9-]*[a-z0-9]|\\p{L}[\\p{L}\\p{M}]+)';

/**
 * The part after the "@": labels, a top-level domain, and a check that the
 * top-level domain is not cut off in the middle of a word. Any other
 * character may follow; stopping early redacts too little, never too much.
 * Exported so the UPI detector gives way exactly where this pattern matches
 * (upi.ts): the two can never disagree about what is an email domain.
 */
export const EMAIL_DOMAIN = `(?:${LABEL}\\.)+${TLD}(?![\\p{L}\\p{M}])`;

const IS_LOCAL_CHAR = new RegExp(`^${LOCAL_CHAR}$`, 'u');
// Sticky: tried once, right after an "@".
const DOMAIN_HERE = new RegExp(EMAIL_DOMAIN, 'iuy');

/**
 * Where the local part ending at `at` starts: as far left as local-part
 * characters go, a dot only between two of them. A stray dot does not
 * block: ".priya@example.com" finds priya@example.com.
 */
function localPartStart(text: string, at: number): number {
  let start = at;
  for (;;) {
    const ch = charBefore(text, start);
    if (ch !== '' && IS_LOCAL_CHAR.test(ch)) start -= ch.length;
    else if (ch === '.' && start < at && IS_LOCAL_CHAR.test(charBefore(text, start - 1))) start--;
    else return start;
  }
}

export function* emailCandidates(text: string): Generator<Candidate> {
  for (let at = text.indexOf('@'); at >= 0; at = text.indexOf('@', at + 1)) {
    const start = localPartStart(text, at);
    if (start === at) continue;
    DOMAIN_HERE.lastIndex = at + 1;
    if (!DOMAIN_HERE.test(text)) continue;
    yield { type: 'EMAIL', start, end: DOMAIN_HERE.lastIndex, validated: false };
  }
}

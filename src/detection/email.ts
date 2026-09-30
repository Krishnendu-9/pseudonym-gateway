// Email addresses. Pattern only: there is nothing to validate without
// sending mail, so an email is never "validated" (ADR-003). The pattern is
// specific enough to be accepted without context (ADR-010).
//
// Accepts what people actually type, including Unicode local parts and
// internationalised domains (प्रिया@उदाहरण.भारत). Does not accept quoted local
// parts ("a b"@example.com), IP-literal domains (a@[192.0.2.1]) or spelled-out
// forms ("priya at example dot com"). Known limits, documented in the README.
//
// Written to avoid catastrophic backtracking (ReDoS): the local part may only
// start where no local-part character precedes it, so a long token without an
// "@" is scanned once, not once per position.
//
// A UPI ID (<name>@okaxis) is not an email: it has no top-level domain, so
// this pattern never matches it, and the UPI detector steps aside wherever
// this pattern does match (<name>@okaxis.com is an email).
//
// Fails closed: nothing has a length limit. DNS caps a domain label at 63
// characters, but an address with a longer label still names a person, so
// it is redacted rather than let through as "not a real address".

import type { Candidate } from './types.js';

const LOCAL_CHAR = "[\\p{L}\\p{N}\\p{M}!#$%&'*+/=?^_`{|}~-]";
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

// Before: not inside a local part (no local-part character, optionally
// followed by a dot, just before). A stray dot on its own does not block a
// match: ".priya@example.com" still finds priya@example.com.
const EMAIL_PATTERN = new RegExp(
  `(?<!${LOCAL_CHAR}\\.?)${LOCAL_CHAR}+(?:\\.${LOCAL_CHAR}+)*@${EMAIL_DOMAIN}`,
  'giu',
);

export function* emailCandidates(text: string): Generator<Candidate> {
  for (const m of text.matchAll(EMAIL_PATTERN)) {
    yield { type: 'EMAIL', start: m.index, end: m.index + m[0].length, validated: false };
  }
}

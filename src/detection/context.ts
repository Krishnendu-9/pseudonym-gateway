// Context: is there a keyword for a data type near a value?
//
// Luhn and Verhoeff each accept about 1 in 10 random numbers, so a check digit
// alone is weak evidence. A nearby "aadhaar" or "card" is more. The policy
// (ADR-010): a validated candidate is accepted whatever its context; an
// unvalidated one (right shape, failed checks) is accepted only with a keyword
// nearby. Every detection records whether context was found, so Phase 5 can
// measure how much it matters.
//
// Keywords are matched in the normalised text, case-insensitively, as whole
// words: "card" matches "Card:" and "card-holder" but not "discard".

import { normalise, type Span } from './normalise.js';
import type { DetectionType } from './types.js';

/** How far (UTF-16 code units, normalised text) to look on each side of a value. */
export const CONTEXT_WINDOW = 40;

// Email has no keywords: its pattern is evidence enough (ADR-010).
const KEYWORDS: Readonly<Partial<Record<DetectionType, readonly string[]>>> = {
  AADHAAR: ['aadhaar', 'aadhar', 'adhaar', 'adhar', 'uid', 'uidai', 'आधार'],
  CARD: [
    'card',
    'cards',
    'credit',
    'debit',
    'visa',
    'mastercard',
    'amex',
    'rupay',
    'diners',
    'jcb',
    'unionpay',
    'cvv',
    'कार्ड',
  ],
  PAN: ['pan', 'permanent account number', 'पैन'],
  PHONE: [
    'phone',
    'ph',
    'mobile',
    'mob',
    'cell',
    'tel',
    'telephone',
    'call',
    'whatsapp',
    'contact',
    'sms',
    'फ़ोन',
    'फोन',
    'मोबाइल',
  ],
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Keywords are normalised exactly like the text they are matched in (for
// example NFKC splits the Devanagari "फ़" into फ + nukta), and a space in a
// keyword matches any run of whitespace. Longer keywords are tried first.
function keywordPattern(words: readonly string[]): RegExp {
  const alternatives = words
    .map((w) => normalise(w).text)
    .sort((a, b) => b.length - a.length)
    .map((w) => escapeRegExp(w).replace(/ /g, '\\s+'));
  return new RegExp(
    `(?<![\\p{L}\\p{N}\\p{M}])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}\\p{M}])`,
    'giu',
  );
}

const PATTERNS: Partial<Record<DetectionType, RegExp>> = Object.fromEntries(
  Object.entries(KEYWORDS).map(([type, words]) => [type, keywordPattern(words)]),
);

/** True if a whole keyword lies inside text[from, to), judged with its real neighbours. */
function keywordWithin(pattern: RegExp, text: string, from: number, to: number): boolean {
  // Two extra code units on each side (one code point, even outside the BMP)
  // let the word-boundary checks see the real neighbouring characters.
  const lo = Math.max(0, from - 2);
  const slice = text.slice(lo, Math.min(text.length, to + 2));
  for (const match of slice.matchAll(pattern)) {
    const start = lo + match.index;
    if (start >= from && start + match[0].length <= to) return true;
  }
  return false;
}

/** True if a keyword for `type` appears within CONTEXT_WINDOW before or after `span`. */
export function hasContext(text: string, span: Span, type: DetectionType): boolean {
  const pattern = PATTERNS[type];
  if (!pattern) return false;
  return (
    keywordWithin(pattern, text, Math.max(0, span.start - CONTEXT_WINDOW), span.start) ||
    keywordWithin(pattern, text, span.end, span.end + CONTEXT_WINDOW)
  );
}

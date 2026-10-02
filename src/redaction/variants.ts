// The shapes a placeholder can appear in besides exactly `[TYPE_N]`: a case
// change or a different tag/index separator, from the user's own typed text
// or a provider's rewrite of what Pseudonym sent it (ADR-002). LITERAL
// detection, the loose-variant reservation scan (both redact.ts) and
// tolerant restoration (restore.ts) all build their patterns from this one
// module, so the three can never disagree about what counts as a variant of
// TYPE_N (ADR-002's "one grammar, shared" rule).
//
// Three shapes, each needing a namespace tag and an index
// (PLACEHOLDER_INDEX_PATTERN, ADR-013):
//
//  - Bracketed: [TYPE_N], [type_n], [Type N] - tag in any case, underscore
//    or space before the index. Recognised for every namespace: nobody
//    writes a bracket around an ordinary word by accident, so there is no
//    "reads as prose" risk to weigh.
//  - Bare, underscore-separated: TYPE_N or Type_N - UPPERCASE or Title Case
//    only, never all-lowercase (an underscore between two lowercase words
//    reads as code either way, but it carries no case signal to tell it
//    apart from an identifier, so it is excluded for the same reason as the
//    bare-space form below, kept simple by applying the rule everywhere).
//    Every namespace.
//  - Bare, space-separated: TYPE N or Type N - UPPERCASE or Title Case only,
//    and only for the namespaces in BARE_SPACE_NAMESPACES. Every other
//    namespace's tag is an ordinary English word that pairs naturally with a
//    number at a sentence's start ("Card 1 is declined", "Pan 1: heat the
//    oil", "our Number 1 priority", "CARD 1" in a receipt) - restoring it
//    would rewrite a sentence that was never a placeholder. Decided
//    2026-09-29 (ADR-013): only AADHAAR (not an English word) and LITERAL
//    (never occurs in ordinary prose) keep this form. PASSPORT, VOTER and
//    DOB (ADR-031) do not: "Passport 1 of 2", "Voter 1" and a form's
//    "DOB 1" (the first applicant's) are ordinary text.

import { DETECTION_TYPES } from '../detection/types.js';
import {
  formatPlaceholder,
  MAX_PLACEHOLDER_INDEX,
  PLACEHOLDER_INDEX_PATTERN,
  type PlaceholderNamespace,
} from './placeholder.js';

/** Every namespace a placeholder can belong to: the detection types, then LITERAL. */
export const ALL_NAMESPACES: readonly PlaceholderNamespace[] = [...DETECTION_TYPES, 'LITERAL'];

/** Namespaces whose bare, space-separated form ("Aadhaar 1") is still
 * restored. Every other namespace's tag reads as ordinary English. */
export const BARE_SPACE_NAMESPACES: ReadonlySet<PlaceholderNamespace> = new Set([
  'AADHAAR',
  'LITERAL',
]);

/** "CARD" -> "Card". Namespaces are always stored upper-case. */
export const titleCase = (namespace: string): string =>
  namespace[0] + namespace.slice(1).toLowerCase();

// Not glued to a letter, digit, mark or underscore on either side: the same
// "part of a longer token" rule the detectors use (see digit-runs.ts).
const GLUE = '[\\p{L}\\p{N}\\p{M}_]';
const notGlued = (inner: string): string => `(?<!${GLUE})${inner}(?!${GLUE})`;

/**
 * Every bracketed variant of the given namespaces: tag in any case,
 * underscore or space before the index. Capture group 1 is the matched tag
 * (any case - callers normalise with `.toUpperCase()`), group 2 the index.
 */
export function bracketPattern(namespaces: readonly PlaceholderNamespace[]): RegExp {
  const tags = namespaces.join('|');
  return new RegExp(`\\[(${tags})[_ ](${PLACEHOLDER_INDEX_PATTERN})\\]`, 'giu');
}

/**
 * Every bare (unbracketed) variant of the given namespaces, in UPPERCASE or
 * Title Case only, with `separator` between the tag and the index. Capture
 * group 1 is the matched tag (exact case as typed), group 2 the index.
 */
export function barePattern(
  namespaces: readonly PlaceholderNamespace[],
  separator: '_' | ' ',
): RegExp {
  const tags = namespaces.flatMap((namespace) => [namespace, titleCase(namespace)]).join('|');
  return new RegExp(notGlued(`(${tags})${separator}(${PLACEHOLDER_INDEX_PATTERN})`), 'gu');
}

// Streaming restoration (ADR-018) holds back the end of the text only while
// it could still turn into a placeholder, or is one whose restoration
// depends on characters that have not arrived yet. The patterns below say
// which end that is. They are built from the same pieces as the patterns
// above, so the stream holds back exactly what the grammar could still
// match. What "undecided" covers:
//  - a prefix of a bracketed or bare form: `[`, `[Car`, `[CARD_`, `Aadh`,
//    `CARD_12` (another digit, `]` or a separator may follow);
//  - a complete bare form (`CARD_1`), until the next character shows
//    whether it is glued to a longer token; if that character is the high
//    half of a surrogate pair, until the low half arrives too;
//  - a complete form followed by "." (or "-" for bare forms), until the
//    next character decides the host rule (unsafe-regions.ts);
//  - a complete bracketed form, until the next character shows whether it
//    is ".".

const prefixesOf = (words: readonly string[]): string =>
  [...new Set(words.flatMap((word) => [...word].map((_, i) => word.slice(0, i + 1))))].join('|');

const ALL_TAGS = ALL_NAMESPACES.join('|');
const BARE_TAGS = ALL_NAMESPACES.flatMap((namespace) => [namespace, titleCase(namespace)]);
const SPACE_TAGS = [...BARE_SPACE_NAMESPACES].flatMap((namespace) => [
  namespace,
  titleCase(namespace),
]);
const INDEX = PLACEHOLDER_INDEX_PATTERN;

const UNDECIDED_BRACKET = new RegExp(
  `\\[(?:${prefixesOf(ALL_NAMESPACES)}|(?:${ALL_TAGS})[_ ](?:${INDEX}(?:\\]\\.?)?)?)?$`,
  'giu',
);
const UNDECIDED_BARE = new RegExp(
  `(?<!${GLUE})(?:${prefixesOf(BARE_TAGS)}|(?:(?:${BARE_TAGS.join('|')})_|(?:${SPACE_TAGS.join('|')}) )(?:${INDEX}(?:[.-]|[\\uD800-\\uDBFF])?)?)$`,
  'gu',
);

const LONGEST_NAMESPACE = ALL_NAMESPACES.toSorted((a, b) => b.length - a.length)[0]!;

/**
 * The most text (UTF-16 code units) a stream restorer ever holds back: the
 * longest bracketed placeholder, `[PASSPORT_9999]`, plus the "." after it,
 * while it waits for the character that decides the host rule. 16 with
 * today's namespaces (15 until PASSPORT, ADR-031); it grows by itself if a
 * longer tag is added.
 */
export const MAX_HELD_BACK = formatPlaceholder(LONGEST_NAMESPACE, MAX_PLACEHOLDER_INDEX).length + 1;

/**
 * Where the undecided end of `text` starts (see above), or `text.length` if
 * nothing is undecided. A lone high surrogate at the very end is always
 * held, so a character is never split between two outputs. `before` is the
 * text just before `text` (at least the last code point), for the "not
 * glued" check.
 */
export function undecidedFrom(before: string, text: string): number {
  const from = Math.max(0, text.length - MAX_HELD_BACK);
  const context = (before + text.slice(0, from)).slice(-2);
  const window = context + text.slice(from);
  const last = text.charCodeAt(text.length - 1);
  let at = last >= 0xd800 && last <= 0xdbff ? text.length - 1 : text.length;
  // The context is only looked at (by the "not glued" lookbehind), never
  // matched: a search starting inside it could take text already given
  // back for the start of a placeholder (bug-log 18).
  for (const pattern of [UNDECIDED_BRACKET, UNDECIDED_BARE]) {
    pattern.lastIndex = context.length;
    const match = pattern.exec(window);
    if (match) at = Math.min(at, from + match.index - context.length);
  }
  return at;
}

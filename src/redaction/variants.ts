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
//    (never occurs in ordinary prose) keep this form.

import { PLACEHOLDER_INDEX_PATTERN, type PlaceholderNamespace } from './placeholder.js';

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
const notGlued = (inner: string): string =>
  `(?<![\\p{L}\\p{N}\\p{M}_])${inner}(?![\\p{L}\\p{N}\\p{M}_])`;

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

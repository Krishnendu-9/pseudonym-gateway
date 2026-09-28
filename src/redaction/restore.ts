// Tolerant restoration (design doc, "Tolerant restoration"): turns
// placeholders back into real values. A provider may rewrite what Pseudonym
// sent it (`[PAN_1]`) into a different case or a bare form (`PAN_1`,
// `Pan 1`) before the user sees it; `restore` matches every variant this
// session's grammar allows (variants.ts, ADR-013), but only for a
// placeholder `mapping` actually holds - an unknown or invented one (the
// model made it up, or it names an index nothing was ever assigned) is left
// exactly as found.
//
// Restoration safety (design doc): by default, a match inside a URL,
// markdown link/image target, or HTML attribute value (unsafe-regions.ts) is
// left as a placeholder rather than restored, since a client rendering the
// provider's answer could turn a restored value into a network request. This
// is the one exfiltration path Pseudonym mitigates, not a general defence
// against prompt injection.

import { DETECTION_TYPES } from '../detection/types.js';
import type { PlaceholderMapping } from './mapping.js';
import type { PlaceholderNamespace } from './placeholder.js';
import { isInUnsafeRegion, unsafeRegions } from './unsafe-regions.js';
import { BARE_SPACE_NAMESPACES, barePattern, bracketPattern } from './variants.js';

const ALL_NAMESPACES: readonly PlaceholderNamespace[] = [...DETECTION_TYPES, 'LITERAL'];

const BRACKET_PATTERN = bracketPattern(ALL_NAMESPACES);
const BARE_UNDERSCORE_PATTERN = barePattern(ALL_NAMESPACES, '_');
const BARE_SPACE_PATTERN = barePattern([...BARE_SPACE_NAMESPACES], ' ');

interface Candidate {
  readonly start: number;
  readonly end: number;
  readonly namespace: PlaceholderNamespace;
  readonly index: number;
  /** A bracketed match restores even for a placeholder marked exact-only
   * (ADR-013); a bare match (either separator) does not. */
  readonly bracketed: boolean;
}

function collect(text: string, pattern: RegExp, bracketed: boolean): Candidate[] {
  return [...text.matchAll(pattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    namespace: match[1]!.toUpperCase() as PlaceholderNamespace,
    index: Number(match[2]),
    bracketed,
  }));
}

const overlapsAny = (spans: readonly Candidate[], start: number, end: number): boolean =>
  spans.some((span) => span.start < end && start < span.end);

export interface RestoreOptions {
  /** Restore even inside a URL, markdown link/image target, or HTML
   * attribute value. Default false (CLAUDE.md, "Restoration safety"). */
  readonly restoreInUnsafeRegions?: boolean;
}

/** Restores every placeholder in `text` that `mapping` has a value for. */
export function restore(
  text: string,
  mapping: PlaceholderMapping,
  options: RestoreOptions = {},
): string {
  const bracketMatches = collect(text, BRACKET_PATTERN, true);
  // A bare match under a bracket's span (both patterns can match "CARD_1"
  // inside "[CARD_1]", since "[" and "]" are not glue characters) is not a
  // separate placeholder: the bracket already covers it.
  const bareMatches = [
    ...collect(text, BARE_UNDERSCORE_PATTERN, false),
    ...collect(text, BARE_SPACE_PATTERN, false),
  ].filter((candidate) => !overlapsAny(bracketMatches, candidate.start, candidate.end));

  const candidates = [...bracketMatches, ...bareMatches].sort((a, b) => a.start - b.start);
  const unsafe = options.restoreInUnsafeRegions ? [] : unsafeRegions(text);

  let out = '';
  let cursor = 0;
  for (const candidate of candidates) {
    const entry = mapping.lookup(candidate.namespace, candidate.index);
    const restorable =
      entry !== undefined &&
      (candidate.bracketed || !entry.exactOnly) &&
      !isInUnsafeRegion(unsafe, candidate.start, candidate.end);
    out += text.slice(cursor, candidate.start);
    out += restorable ? entry!.value : text.slice(candidate.start, candidate.end);
    cursor = candidate.end;
  }
  return out + text.slice(cursor);
}

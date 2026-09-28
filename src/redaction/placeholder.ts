// Placeholder formatting and the shared numbering limit (ADR-002).
//
// A placeholder Pseudonym assigns always looks like `[TYPE_N]`: the detected
// type, an underscore, and a 1-based index counting first appearances within
// one request. `LITERAL` is not a detection type (see detection/types.ts);
// it is the separate namespace for exact placeholder-shaped text found in
// the user's own input (ADR-002), so it can never collide with a real
// detection.

import type { DetectionType } from '../detection/types.js';

/** A namespace a placeholder index is drawn from: a real detection type, or
 * `LITERAL` for placeholder-shaped text copied from the user's own input. */
export type PlaceholderNamespace = DetectionType | 'LITERAL';

/**
 * The highest placeholder index Pseudonym will assign, per namespace, per
 * request (ADR-002). Bounds how many distinct values of one type a single
 * request may carry, the loose-variant reservation scan, and the Phase 4
 * streaming lookahead.
 */
export const MAX_PLACEHOLDER_INDEX = 9999;

/**
 * Matches exactly the strings `formatPlaceholder` can produce for the index
 * part: 1 to 4 digits, no leading zero (`String(n)` for any integer
 * 1..MAX_PLACEHOLDER_INDEX never has one). Recognising anything looser (a
 * leading zero, or 5+ digits) as placeholder-shaped would accept strings
 * Pseudonym itself never emits and a model has no reason to invent, so
 * LITERAL detection and tolerant restoration (ADR-002, ADR-013) both use
 * this, not a bare `[0-9]+`. Tied to MAX_PLACEHOLDER_INDEX being exactly
 * four digits (9999); revisit together if that ever changes.
 */
export const PLACEHOLDER_INDEX_PATTERN = '[1-9][0-9]{0,3}';

/**
 * Thrown when a request would need more than MAX_PLACEHOLDER_INDEX distinct
 * values of one namespace. Callers turn this into a clean 4xx (Phase 3); the
 * message never includes the value that pushed the namespace over the limit.
 */
export class PlaceholderLimitError extends Error {
  readonly namespace: PlaceholderNamespace;

  constructor(namespace: PlaceholderNamespace) {
    super(`too many distinct ${namespace} values in one request (max ${MAX_PLACEHOLDER_INDEX})`);
    this.name = 'PlaceholderLimitError';
    this.namespace = namespace;
  }
}

/**
 * Formats a placeholder Pseudonym assigns: always `[TYPE_N]`, no leading
 * zeros. Throws PlaceholderLimitError if `index` is out of range.
 */
export function formatPlaceholder(namespace: PlaceholderNamespace, index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > MAX_PLACEHOLDER_INDEX) {
    throw new PlaceholderLimitError(namespace);
  }
  return `[${namespace}_${index}]`;
}

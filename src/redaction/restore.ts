// Tolerant restoration (design doc, "Tolerant restoration"): turns
// placeholders back into real values. A provider may rewrite what Pseudonym
// sent it (`[PAN_1]`) into a different case or a bare form (`PAN_1`,
// `Pan 1`) before the user sees it; restoration matches every variant this
// session's grammar allows (variants.ts, ADR-013), but only for a
// placeholder `mapping` actually holds - an unknown or invented one (the
// model made it up, or it names an index nothing was ever assigned) is left
// exactly as found.
//
// Restoration safety (design doc): by default, a match inside a URL,
// markdown link/image target, or HTML attribute value (unsafe-regions.ts),
// or one followed by what would make its value part of a hostname (the host
// rule, ADR-018), is left as a placeholder rather than restored, since a
// client rendering the provider's answer could turn a restored value into a
// network request. This is the one exfiltration path Pseudonym mitigates,
// not a general defence against prompt injection.
//
// Streaming (ADR-018): `StreamRestorer` takes the answer in pieces and
// gives back restored text as soon as it is decided. It holds back only the
// end that could still become a placeholder (at most MAX_HELD_BACK code
// units; variants.ts), and it decides every placeholder from the text on
// its left, so the pieces never change the result. `restore()` is the same
// restorer fed the whole text at once: one implementation, so streamed and
// non-streamed answers cannot drift apart.

import type { PlaceholderMapping } from './mapping.js';
import type { PlaceholderNamespace } from './placeholder.js';
import { startsHost, UnsafeRegionScanner } from './unsafe-regions.js';
import {
  ALL_NAMESPACES,
  BARE_SPACE_NAMESPACES,
  barePattern,
  bracketPattern,
  undecidedFrom,
} from './variants.js';

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

const byStart = (a: Candidate, b: Candidate): number => a.start - b.start;

/** Every placeholder-shaped match in `text`, in order, never overlapping. */
function candidates(text: string): Candidate[] {
  const brackets = collect(text, BRACKET_PATTERN, true);
  const bare = [
    ...collect(text, BARE_UNDERSCORE_PATTERN, false),
    ...collect(text, BARE_SPACE_PATTERN, false),
  ].sort(byStart);
  // A bare match under a bracket's span (both patterns can match "CARD_1"
  // inside "[CARD_1]", since "[" and "]" are not glue characters) is not a
  // separate placeholder: the bracket already covers it. Both lists are in
  // text order and brackets never overlap each other, so one pass over the
  // two finds every such pair (bug-log 17).
  const kept: Candidate[] = [];
  let b = 0;
  for (const candidate of bare) {
    while (b < brackets.length && brackets[b]!.end <= candidate.start) b++;
    const bracket = brackets[b];
    if (!bracket || bracket.start >= candidate.end) kept.push(candidate);
  }
  return [...brackets, ...kept].sort(byStart);
}

export interface RestoreOptions {
  /** Restore even inside a URL, markdown link/image target, or HTML
   * attribute value, or before a hostname. Default false (CLAUDE.md,
   * "Restoration safety"). */
  readonly restoreInUnsafeRegions?: boolean;
}

/** Restores an answer that arrives in pieces (ADR-018). */
export class StreamRestorer {
  readonly #mapping: PlaceholderMapping;
  /** Undefined when restoration safety is switched off. */
  readonly #scanner: UnsafeRegionScanner | undefined;
  /** Received, not yet given back. Starts where no placeholder is open. */
  #held = '';
  /** The last two code units given back: what a placeholder at the start
   * of `#held` must not be glued to. */
  #before = '';
  /** Where `#held` starts in the whole answer. */
  #offset = 0;

  constructor(mapping: PlaceholderMapping, options: RestoreOptions = {}) {
    this.#mapping = mapping;
    this.#scanner = options.restoreInUnsafeRegions ? undefined : new UnsafeRegionScanner();
  }

  /** How much text is held back right now (at most MAX_HELD_BACK). */
  get heldBack(): number {
    return this.#held.length;
  }

  /** Takes the next piece; returns the restored text that is now decided. */
  push(piece: string): string {
    this.#held += piece;
    return this.#release(undecidedFrom(this.#before, this.#held));
  }

  /** The answer is complete (or cut off): restores and returns the rest. */
  end(): string {
    return this.#release(this.#held.length);
  }

  // Gives back #held up to `cut`. Placeholders are matched on the text
  // just before, the part given back, and the part still held (for the
  // "not glued" check and the host rule), but only those that end by `cut`
  // are decided now; by construction none crosses it.
  #release(cut: number): string {
    const text = this.#before + this.#held;
    const base = this.#before.length;
    const stop = base + cut;
    let out = '';
    let cursor = base;
    for (const candidate of candidates(text)) {
      if (candidate.start < base) continue;
      if (candidate.end > stop) break;
      out += text.slice(cursor, candidate.start);
      this.#scanner?.feed(text.slice(cursor, candidate.end));
      out += this.#restorable(candidate, text, base)
        ? this.#mapping.lookup(candidate.namespace, candidate.index)!.value
        : text.slice(candidate.start, candidate.end);
      cursor = candidate.end;
    }
    out += text.slice(cursor, stop);
    this.#scanner?.feed(text.slice(cursor, stop));

    this.#before = text.slice(Math.max(0, stop - 2), stop);
    this.#held = text.slice(stop);
    this.#offset += cut;
    return out;
  }

  #restorable(candidate: Candidate, text: string, base: number): boolean {
    const entry = this.#mapping.lookup(candidate.namespace, candidate.index);
    if (entry === undefined || (!candidate.bracketed && entry.exactOnly)) return false;
    if (this.#scanner === undefined) return true;
    const start = this.#offset + candidate.start - base;
    const end = this.#offset + candidate.end - base;
    return (
      !this.#scanner.overlaps(start, end) &&
      !startsHost(text.slice(candidate.end, candidate.end + 2), candidate.bracketed)
    );
  }
}

/** Restores every placeholder in `text` that `mapping` has a value for. */
export function restore(
  text: string,
  mapping: PlaceholderMapping,
  options: RestoreOptions = {},
): string {
  const restorer = new StreamRestorer(mapping, options);
  return restorer.push(text) + restorer.end();
}

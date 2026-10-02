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

//
// Counting (ADR-033): given a `RestoreCounts`, the restorer also adds up the
// placeholders it restored and, by rule, those a safety rule left as they
// are. It changes nothing in the output; it exists for the evaluation.

import type { PlaceholderMapping } from './mapping.js';
import type { PlaceholderNamespace } from './placeholder.js';
import { startsHost, UnsafeRegionScanner, type UnsafeRule } from './unsafe-regions.js';
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
// "Card 1": a form restoration never rewrites (ADR-013); only counted.
const OTHER_BARE_SPACE_PATTERN = barePattern(
  ALL_NAMESPACES.filter((namespace) => !BARE_SPACE_NAMESPACES.has(namespace)),
  ' ',
);

/**
 * Why a placeholder the mapping holds was left as it is: a region rule
 * (unsafe-regions.ts), the host rule, or `bare-space`, a `Type N` form of a
 * namespace whose bare-space form is never restored (ADR-013). In a model's
 * answer that is most likely a rewrite; in a user's own words it is
 * ordinary prose that happens to match.
 */
export type HeldBackRule = UnsafeRule | 'host' | 'bare-space';

export const HELD_BACK_RULES: readonly HeldBackRule[] = [
  'markdown-destination',
  'reference-label',
  'html-attribute',
  'url',
  'unclosed-angle',
  'unclosed-quote',
  'host',
  'bare-space',
];

/** What a restorer did with the placeholders the mapping holds (ADR-033). */
export type RestoreCounts = Record<HeldBackRule | 'restored', number>;

export const emptyRestoreCounts = (): RestoreCounts => ({
  restored: 0,
  ...(Object.fromEntries(HELD_BACK_RULES.map((rule) => [rule, 0])) as Record<HeldBackRule, number>),
});

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

// A bare match under a bracket's span (both patterns can match "CARD_1"
// inside "[CARD_1]", since "[" and "]" are not glue characters) is not a
// separate placeholder: the bracket already covers it. Both lists are in
// text order and brackets never overlap each other, so one pass over the
// two finds every such pair (bug-log 17).
function outsideBrackets(brackets: readonly Candidate[], bare: readonly Candidate[]): Candidate[] {
  const kept: Candidate[] = [];
  let b = 0;
  for (const candidate of bare) {
    while (b < brackets.length && brackets[b]!.end <= candidate.start) b++;
    const bracket = brackets[b];
    if (!bracket || bracket.start >= candidate.end) kept.push(candidate);
  }
  return kept;
}

/** Every placeholder-shaped match in `text`, in order, never overlapping. */
function candidates(text: string): Candidate[] {
  const brackets = collect(text, BRACKET_PATTERN, true);
  const bare = [
    ...collect(text, BARE_UNDERSCORE_PATTERN, false),
    ...collect(text, BARE_SPACE_PATTERN, false),
  ].sort(byStart);
  return [...brackets, ...outsideBrackets(brackets, bare)].sort(byStart);
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
  readonly #counts: RestoreCounts | undefined;
  /** Left as they are by a region rule, counted at `end()`: an unclosed
   * construct's rule is only known once the answer has ended. */
  readonly #inRegions: { start: number; end: number }[] = [];

  /** With `counts`, adds to them what it restores and what it leaves by a
   * safety rule (ADR-033); `restore()` adds the `bare-space` count. */
  constructor(mapping: PlaceholderMapping, options: RestoreOptions = {}, counts?: RestoreCounts) {
    this.#mapping = mapping;
    this.#counts = counts;
    this.#scanner = options.restoreInUnsafeRegions
      ? undefined
      : new UnsafeRegionScanner({ classify: counts !== undefined });
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
    const out = this.#release(this.#held.length);
    if (this.#counts) {
      for (const { start, end } of this.#inRegions)
        this.#counts[this.#scanner!.ruleAt(start, end)!]++;
    }
    this.#inRegions.length = 0;
    return out;
  }

  // Gives back #held up to `cut`. Placeholders are matched on the text
  // just before, the part given back, and the part still held (for the
  // "not glued" check and the host rule), but only those that end by `cut`
  // are decided now; by construction none crosses it.
  #release(cut: number): string {
    const text = this.#before + this.#held;
    const base = this.#before.length;
    const stop = base + cut;
    // From a position in `text` to one in the whole answer.
    const shift = this.#offset - base;
    let out = '';
    let cursor = base;
    for (const candidate of candidates(text)) {
      if (candidate.start < base) continue;
      if (candidate.end > stop) break;
      out += text.slice(cursor, candidate.start);
      this.#scanner?.feed(text.slice(cursor, candidate.end));
      const start = shift + candidate.start;
      const end = shift + candidate.end;
      const heldBy = this.#heldBy(candidate, text, start, end);
      if (heldBy === undefined) {
        out += this.#mapping.lookup(candidate.namespace, candidate.index)!.value;
      } else out += text.slice(candidate.start, candidate.end);
      if (this.#counts) {
        if (heldBy === undefined) this.#counts.restored++;
        else if (heldBy === 'host') this.#counts.host++;
        else if (heldBy === 'region') this.#inRegions.push({ start, end });
      }
      cursor = candidate.end;
    }
    out += text.slice(cursor, stop);
    this.#scanner?.feed(text.slice(cursor, stop));

    this.#before = text.slice(Math.max(0, stop - 2), stop);
    this.#held = text.slice(stop);
    this.#offset += cut;
    return out;
  }

  // Undefined if `candidate` (at `start`..`end` in the whole answer) is
  // restored. Otherwise why not: the mapping has no value for that form
  // (not one of this request's placeholders, or a bare form of an exact-only
  // one), it is in an unsafe region, or the host rule holds it.
  #heldBy(
    candidate: Candidate,
    text: string,
    start: number,
    end: number,
  ): 'mapping' | 'region' | 'host' | undefined {
    const entry = this.#mapping.lookup(candidate.namespace, candidate.index);
    if (entry === undefined || (!candidate.bracketed && entry.exactOnly)) return 'mapping';
    if (this.#scanner === undefined) return undefined;
    if (this.#scanner.overlaps(start, end)) return 'region';
    if (startsHost(text.slice(candidate.end, candidate.end + 2), candidate.bracketed)) {
      return 'host';
    }
    return undefined;
  }
}

/**
 * Restores every placeholder in `text` that `mapping` has a value for. With
 * `counts`, also adds up what it restored and what it left, by rule
 * (ADR-033); the output is the same either way.
 */
export function restore(
  text: string,
  mapping: PlaceholderMapping,
  options: RestoreOptions = {},
  counts?: RestoreCounts,
): string {
  const restorer = new StreamRestorer(mapping, options, counts);
  const out = restorer.push(text) + restorer.end();
  if (counts) {
    // Over the whole text, so that no piece boundary can split one.
    const brackets = collect(text, BRACKET_PATTERN, true);
    for (const form of outsideBrackets(brackets, collect(text, OTHER_BARE_SPACE_PATTERN, false))) {
      if (mapping.lookup(form.namespace, form.index)) counts['bare-space']++;
    }
  }
  return out;
}

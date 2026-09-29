// Restoration written the slow, obvious way, twice, for differential tests of
// the scanner and the streaming restorer (ADR-018). Neither is used by the
// gateway.
//
//  - `legacy`: the Phase 2 rules as committed in 370e266. The only edit is
//    a capture group around the two URL patterns, so all five report their
//    region the same way; the regions are unchanged. The Phase 4 rules must
//    never restore a placeholder these left alone.
//  - `oracle`: the Phase 4 rules (ADR-018) as regular expressions. Markdown
//    destinations, reference definitions and URLs are tried from every place
//    they could start (a lookahead makes each match zero-width, so matchAll
//    visits every position); quoted HTML values are read left to right. The
//    production scanner must find exactly these regions, and the production
//    restorer must give exactly this output.
//
// Both are quadratic on purpose-built input (bug-log 16): keep inputs small.
// Candidates come from the shared grammar in variants.ts (ADR-002), so these
// references test the region rules and the streaming machinery, not the
// grammar.

import type { Span } from '../../src/detection/normalise.js';
import type { PlaceholderMapping } from '../../src/redaction/mapping.js';
import type { PlaceholderNamespace } from '../../src/redaction/placeholder.js';
import {
  ALL_NAMESPACES,
  BARE_SPACE_NAMESPACES,
  barePattern,
  bracketPattern,
} from '../../src/redaction/variants.js';

export type Rules = 'legacy' | 'oracle';

function merge(regions: readonly Span[]): Span[] {
  const sorted = regions
    .filter((region) => region.end > region.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: { start: number; end: number }[] = [];
  for (const region of sorted) {
    const last = merged.at(-1);
    if (last && region.start <= last.end) last.end = Math.max(last.end, region.end);
    else merged.push({ ...region });
  }
  return merged;
}

function groupSpans(text: string, pattern: RegExp): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(pattern)) {
    const indices = match.indices!.slice(1).find((pair) => pair !== undefined);
    if (indices) spans.push({ start: indices[0], end: indices[1] });
  }
  return spans;
}

// --- Phase 2 (370e266), unchanged ---
const LEGACY_MARKDOWN_TARGET = /\]\(\s*(<[^>\n]*>|[^\s]*)/dg;
const LEGACY_REFERENCE_DEFINITION = /\[(?:[^\]\\\n]|\\.)+\]:\s*(<[^>\n]*>|[^\s]+)/dg;
const LEGACY_HTML_ATTRIBUTE_VALUE = /=\s*(?:"([^"]*)"|'([^']*)')/dg;
const LEGACY_SCHEME_URL = /\b((?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/|mailto:)[^\s<>()"']+)/dg;
const LEGACY_BARE_HOST_URL = /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\/[^\s<>()"']*)/dgi;

export function legacyUnsafeRegions(text: string): Span[] {
  return merge(
    [
      LEGACY_MARKDOWN_TARGET,
      LEGACY_REFERENCE_DEFINITION,
      LEGACY_HTML_ATTRIBUTE_VALUE,
      LEGACY_SCHEME_URL,
      LEGACY_BARE_HOST_URL,
    ].flatMap((pattern) => groupSpans(text, pattern)),
  );
}

// --- Phase 4 (ADR-018) ---
const MARKDOWN_TARGET = /(?=\]\(\s*(<[^>\n]*>?|[^\s]*))/dg;
const REFERENCE_DEFINITION = /(?=\[(?:[^\]\\\n]|\\.)+\]:\s*(<[^>\n]*>?|[^\s]+))/dg;
const HTML_ATTRIBUTE_VALUE = /=\s*(?:"([^"]*)"?|'([^']*)'?)/dg;
const SCHEME_URL = /(?=\b((?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/|mailto:)[^\s<>()"']+))/dg;
const BARE_HOST_URL = /(?=\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\/[^\s<>()"']*))/dgi;

export function oracleUnsafeRegions(text: string): Span[] {
  return merge(
    [
      MARKDOWN_TARGET,
      REFERENCE_DEFINITION,
      HTML_ATTRIBUTE_VALUE,
      SCHEME_URL,
      BARE_HOST_URL,
    ].flatMap((pattern) => groupSpans(text, pattern)),
  );
}

// The ADR-018 host rule: a placeholder that could be the first label of a
// hostname (`CARD_1.attacker.example/`).
const BARE_HOST_START = /^[.-][A-Za-z0-9-]/;
const BRACKET_HOST_START = /^\.[A-Za-z0-9-]/;

// --- Candidates and decisions, the Phase 2 algorithm ---
export interface PlannedCandidate {
  readonly start: number;
  readonly end: number;
  readonly namespace: PlaceholderNamespace;
  readonly index: number;
  readonly bracketed: boolean;
  /** Known to the mapping and allowed in this form: restored unless unsafe. */
  readonly known: boolean;
  readonly restored: boolean;
}

function collect(text: string, pattern: RegExp, bracketed: boolean) {
  return [...text.matchAll(pattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    namespace: match[1]!.toUpperCase() as PlaceholderNamespace,
    index: Number(match[2]),
    bracketed,
  }));
}

export function plan(
  text: string,
  mapping: PlaceholderMapping,
  rules: Rules,
  options: { restoreInUnsafeRegions?: boolean } = {},
): PlannedCandidate[] {
  const brackets = collect(text, bracketPattern(ALL_NAMESPACES), true);
  const bare = [
    ...collect(text, barePattern(ALL_NAMESPACES, '_'), false),
    ...collect(text, barePattern([...BARE_SPACE_NAMESPACES], ' '), false),
  ].filter((c) => !brackets.some((b) => b.start < c.end && c.start < b.end));
  const candidates = [...brackets, ...bare].sort((a, b) => a.start - b.start);

  const unsafe = rules === 'legacy' ? legacyUnsafeRegions(text) : oracleUnsafeRegions(text);
  return candidates.map((candidate) => {
    const entry = mapping.lookup(candidate.namespace, candidate.index);
    const known = entry !== undefined && (candidate.bracketed || !entry.exactOnly);
    const after = text.slice(candidate.end);
    const hostStart =
      rules === 'oracle' &&
      (candidate.bracketed ? BRACKET_HOST_START : BARE_HOST_START).test(after);
    const safe =
      options.restoreInUnsafeRegions === true ||
      (!unsafe.some((r) => r.start < candidate.end && candidate.start < r.end) && !hostStart);
    return { ...candidate, known, restored: known && safe };
  });
}

export function referenceRestore(
  text: string,
  mapping: PlaceholderMapping,
  rules: Rules,
  options: { restoreInUnsafeRegions?: boolean } = {},
): string {
  let out = '';
  let cursor = 0;
  for (const candidate of plan(text, mapping, rules, options)) {
    out += text.slice(cursor, candidate.start);
    out += candidate.restored
      ? mapping.lookup(candidate.namespace, candidate.index)!.value
      : text.slice(candidate.start, candidate.end);
    cursor = candidate.end;
  }
  return out + text.slice(cursor);
}

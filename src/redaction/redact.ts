// Redacting one message's text against a per-request PlaceholderMapping
// ("Stateless, deterministic redaction" in CLAUDE.md). Call this once per
// message, in the order the conversation has them, reusing the same
// mapping instance: that is what gives every real value one placeholder for
// the whole history, numbered by first appearance, with no server-side state
// between requests.
//
// Two kinds of span are replaced in one pass over the message:
//  - LITERAL: text that already looks like a Pseudonym placeholder
//    (`[PAN_1]`, `[pan 1]`, `[literal_1]`) is copied byte-for-byte into its
//    own namespace (ADR-002), so it can never be confused with a real
//    detection. A literal-shaped match always wins over a real detection
//    that overlaps it. That was once thought unreachable; it is not: a
//    value glued to a literal (`[PAN_1]123456789012`, a keyword secret
//    running over one) is a detection that overlaps it, and is then dropped
//    whole and sent (bug-log 58, not fixed yet). A name is cut around the
//    literals instead (ADR-037). `[CARD 4111111111111111]` is not a
//    literal (its index is capped at 4 digits, ADR-013), so the card in it
//    is left for detect() to claim on its own.
//  - Real detections from detect() (src/detection/detect.ts), including the
//    person names the name finder found, when names are on (ADR-037),
//    replaced by a placeholder for a type-specific *value key* (ADR-013):
//    the same person, card, PAN, email or phone written two different ways
//    in the request
//    still gets one placeholder. The placeholder restores to the first
//    surface form seen, not the key.
//
// A third pass, over the same text, never replaces anything: it scans for
// loose variants typed as ordinary prose (`Person_1`, but not `Person 1` for
// most types - see variants.ts) and reserves their index (ADR-002), so a
// real value of that type never lands on an index the model could later
// confuse with this message's own wording.

import { detect } from '../detection/detect.js';
import { charAt, charBefore } from '../detection/digit-runs.js';
import { normalise } from '../detection/normalise.js';
import { ipValueKey } from '../detection/ip.js';
import { DETECTION_TYPES, type DetectionType } from '../detection/types.js';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { PlaceholderMapping } from './mapping.js';
import type { PlaceholderNamespace } from './placeholder.js';
import { BARE_SPACE_NAMESPACES, barePattern, bracketPattern } from './variants.js';

const ALL_NAMESPACES: readonly PlaceholderNamespace[] = [...DETECTION_TYPES, 'LITERAL'];

const LITERAL_PATTERN = bracketPattern(ALL_NAMESPACES);
const BARE_UNDERSCORE_PATTERN = barePattern(ALL_NAMESPACES, '_');
const BARE_SPACE_PATTERN = barePattern([...BARE_SPACE_NAMESPACES], ' ');

/**
 * Text that has been through redactMessage() (or is Pseudonym's own fixed
 * text, see gateway/instruction.ts). A compile-time tag only: at run time it
 * is a plain string. Provider adapters accept nothing else, so text that
 * skipped redaction cannot be sent to a provider without a type error.
 */
export type RedactedText = string & { readonly __brand: 'RedactedText' };

interface Span {
  readonly start: number;
  readonly end: number;
}

interface ReplacementSpan extends Span {
  readonly namespace: PlaceholderNamespace;
  readonly key: string;
  readonly value: string;
}

const overlapsAny = (spans: readonly Span[], start: number, end: number): boolean =>
  spans.some((span) => span.start < end && start < span.end);

// The identity a value is deduplicated by (ADR-013): the same person, card,
// PAN, IFSC, email, UPI ID or phone written two different ways in one
// request still gets one placeholder. UPI IDs, like emails, ignore case:
// payment apps treat <NAME>@OKAXIS and <name>@okaxis as one ID; so do PANs,
// IFSCs, passport and voter ID numbers, which are defined in capitals.
// `surface` is a detection's original-text slice.
function valueKey(type: DetectionType, surface: string): string {
  const normalised = normalise(surface).text;
  switch (type) {
    case 'AADHAAR':
    case 'CARD':
    case 'NUMBER':
      return normalised.replace(/[^0-9]/g, '');
    case 'PAN':
    case 'IFSC':
    case 'PASSPORT':
    case 'VOTER':
      return normalised.toUpperCase();
    case 'DOB':
      // As written, ignoring case and spacing: "7 march 1991" and
      // "7 March  1991" are one date. Not a calendar key: 03/07/1991 is
      // 3 July or 7 March depending on who wrote it (ADR-031).
      return normalised.toLowerCase().replace(/\s+/g, ' ');
    case 'EMAIL':
    case 'UPI':
      return normalised.toLowerCase();
    case 'PERSON':
      // As written, ignoring case and spacing, like DOB: "Asha Rao" and
      // "ASHA  RAO" are one person. "Asha" and "Asha Rao" are two values
      // (Phase 6 decision: a part of a name is not linked to the whole).
      return normalised.toLowerCase().replace(/\s+/g, ' ');
    case 'SECRET':
      // Exactly as written: two passwords that differ only in case are two
      // passwords.
      return normalised;
    case 'IP':
      return ipValueKey(normalised);
    case 'PHONE': {
      // A number wrapped onto the next line (ADR-030) is the same number:
      // libphonenumber parses nothing with a line break in it.
      const oneLine = normalised.replace(/[\r\n]/g, ' ');
      const parsed = parsePhoneNumberFromString(oneLine, { defaultCountry: 'IN' });
      return parsed ? parsed.number : normalised;
    }
  }
}

// Loose variants overlapping a literal span are not "left as ordinary
// prose": that text is about to become [LITERAL_N], so nothing ambiguous
// remains in the output for them to reserve against.
function reserveLooseVariants(
  text: string,
  literalSpans: readonly Span[],
  mapping: PlaceholderMapping,
): void {
  for (const pattern of [BARE_UNDERSCORE_PATTERN, BARE_SPACE_PATTERN]) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (overlapsAny(literalSpans, start, end)) continue;
      mapping.reserve(match[1]!.toUpperCase() as PlaceholderNamespace, Number(match[2]));
    }
  }
}

/**
 * Person names the name finder found in one text (ADR-037), with the text
 * they were found in.
 */
export interface NameSpans {
  /** The text the spans index into. redactMessage() refuses any other. */
  readonly text: string;
  readonly spans: readonly Span[];
}

/**
 * Name spans were handed to the wrong text: a bug in the caller, never a
 * reason to redact without them. The request is refused (500).
 */
export class NameTextMismatchError extends Error {
  constructor() {
    super('name spans do not belong to the text being redacted');
    this.name = 'NameTextMismatchError';
  }
}

const KEEPS_AT_CUT = /[\p{L}\p{N}]/u;

// A name span may run over text that is about to become a literal (a
// model's span over "Asha [PAN_1] Rao"). Detections that overlap a literal
// are dropped below, so such a name would be dropped whole and sent. It is
// cut around the literals instead: the literal keeps its own text, every
// piece of the name outside it is redacted. At a cut, characters other
// than letters and digits stay text, as at a cut between widened values
// (ADR-028, ADR-029). Marks too: a mark right after a literal's "]" is in
// the "]"'s cluster, which rounding out to clusters would take into the
// literal, and the piece would then be dropped after all (bug-log 58).
function outsideLiterals(text: string, names: readonly Span[], literals: readonly Span[]): Span[] {
  const pieces: Span[] = [];
  for (const name of names) {
    // Literals are sorted and never overlap: the first that ends after the name starts.
    let lo = 0;
    let hi = literals.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (literals[mid]!.end <= name.start) lo = mid + 1;
      else hi = mid;
    }
    let start = name.start;
    let cutBefore = false;
    for (let i = lo; i <= literals.length; i++) {
      const literal = literals[i];
      const inside = literal !== undefined && literal.start < name.end;
      let end = inside ? Math.max(start, literal.start) : name.end;
      if (cutBefore) {
        while (start < end && !KEEPS_AT_CUT.test(charAt(text, start))) {
          start += charAt(text, start).length;
        }
      }
      if (inside) {
        while (end > start && !KEEPS_AT_CUT.test(charBefore(text, end))) {
          end -= charBefore(text, end).length;
        }
      }
      if (start < end) pieces.push({ start, end });
      if (!inside) break;
      start = Math.min(Math.max(start, literal.end), name.end);
      cutBefore = true;
    }
  }
  return pieces;
}

/**
 * Redacts one message's text, assigning placeholders from (and into)
 * `mapping`. `names`, when given, must have been found in this exact text.
 */
export function redactMessage(
  text: string,
  mapping: PlaceholderMapping,
  names?: NameSpans,
): RedactedText {
  if (names !== undefined && names.text !== text) throw new NameTextMismatchError();
  const literalSpans: ReplacementSpan[] = [...text.matchAll(LITERAL_PATTERN)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    namespace: 'LITERAL',
    key: match[0],
    value: match[0],
  }));

  reserveLooseVariants(text, literalSpans, mapping);

  const nameSpans = names && outsideLiterals(text, names.spans, literalSpans);
  const detectionSpans: ReplacementSpan[] = detect(text, nameSpans)
    .flatMap((d) => {
      if (!overlapsAny(literalSpans, d.start, d.end)) return [d];
      // A name cut around the literals above can still reach into one once
      // rounded out to whole clusters (a mark right after a literal's "]"
      // is in the "]"'s cluster), so it is cut again here, never dropped.
      // Other types are still dropped whole: bug-log 58, not fixed.
      if (d.type !== 'PERSON') return [];
      return outsideLiterals(text, [d], literalSpans).map((piece) => ({ ...d, ...piece }));
    })
    .map((d) => {
      const value = text.slice(d.start, d.end);
      return { start: d.start, end: d.end, namespace: d.type, key: valueKey(d.type, value), value };
    });

  const spans = [...literalSpans, ...detectionSpans].sort((a, b) => a.start - b.start);

  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out +=
      text.slice(cursor, span.start) + mapping.getOrAssign(span.namespace, span.key, span.value);
    cursor = span.end;
  }
  return (out + text.slice(cursor)) as RedactedText;
}

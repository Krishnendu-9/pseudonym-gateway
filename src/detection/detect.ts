// The detection pipeline: normalise, run every detector, keep the candidates
// the context policy accepts, resolve overlaps, and map spans back to the
// original text.
//
// The result says where personal values are, never what they are: callers
// slice the original text themselves (see types.ts).

import { aadhaarCandidates } from './aadhaar.js';
import { cardCandidates } from './card.js';
import { charBefore, digitRuns, widenToRuns } from './digit-runs.js';
import { hasContext } from './context.js';
import { emailCandidates } from './email.js';
import { ifscCandidates } from './ifsc.js';
import { ipCandidates } from './ip.js';
import { normalise, type Span } from './normalise.js';
import { unclaimedNumbers } from './number.js';
import { resolveOverlaps } from './overlap.js';
import { panCandidates } from './pan.js';
import { phoneCandidates } from './phone.js';
import { secretCandidates } from './secret.js';
import { upiCandidates } from './upi.js';
import type { Candidate, Detection, DetectionType } from './types.js';

const DETECTORS: readonly ((text: string) => Iterable<Candidate>)[] = [
  aadhaarCandidates,
  cardCandidates,
  panCandidates,
  ifscCandidates,
  phoneCandidates,
  upiCandidates,
  emailCandidates,
  ipCandidates,
  secretCandidates,
];

// Types whose pattern alone is enough evidence (ADR-010).
const PATTERN_ONLY: ReadonlySet<DetectionType> = new Set(['EMAIL']);

/** Finds personal values in `original`. Spans index into `original`, in text order. */
export function detect(original: string): Detection[] {
  const normalised = normalise(original);
  const text = normalised.text;

  const accepted: Detection[] = [];
  const kept: Candidate[] = [];
  for (const detector of DETECTORS) {
    for (const candidate of detector(text)) {
      if (candidate.keep) {
        kept.push(candidate);
        continue;
      }
      const context = candidate.context ?? hasContext(text, candidate, candidate.type);
      if (candidate.validated || context || PATTERN_ONLY.has(candidate.type)) {
        accepted.push({ ...candidate, context });
      }
    }
  }

  // Resolve in the normalised text, where lengths count what the detectors
  // saw rather than invisible characters. Only then widen each winner to the
  // whole digit runs it touches, so that the types are decided first (a card
  // still beats an Aadhaar found in its first 12 digits) and no part of a
  // number is left visible. Widening can make winners in one run overlap, so
  // resolve again. Then the safety net claims long numbers nobody else did
  // (ADR-011). Finally map back, and resolve once more: rounding out to whole
  // clusters could, in principle, make two neighbours share a character.
  const runs = digitRuns(text);
  const widened = resolveOverlaps(
    resolveOverlaps(accepted).map((d) => ({
      ...d,
      ...(d.type === 'IP' ? widenAddress(text, d, runs) : widenToRuns(d, runs)),
    })),
  );

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
  return resolveOverlaps(mapped);
}

const spanKey = (span: Span): string => `${span.start}:${span.end}`;

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

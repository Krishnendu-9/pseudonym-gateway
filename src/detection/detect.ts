// The detection pipeline: normalise, run every detector, keep the candidates
// the context policy accepts, resolve overlaps, and map spans back to the
// original text.
//
// The result says where personal values are, never what they are: callers
// slice the original text themselves (see types.ts).

import { aadhaarCandidates } from './aadhaar.js';
import { cardCandidates } from './card.js';
import { digitRuns, widenToRuns } from './digit-runs.js';
import { hasContext } from './context.js';
import { emailCandidates } from './email.js';
import { normalise } from './normalise.js';
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
  phoneCandidates,
  upiCandidates,
  emailCandidates,
  secretCandidates,
];

// Types whose pattern alone is enough evidence (ADR-010).
const PATTERN_ONLY: ReadonlySet<DetectionType> = new Set(['EMAIL']);

/** Finds personal values in `original`. Spans index into `original`, in text order. */
export function detect(original: string): Detection[] {
  const normalised = normalise(original);
  const text = normalised.text;

  const accepted: Detection[] = [];
  for (const detector of DETECTORS) {
    for (const candidate of detector(text)) {
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
    resolveOverlaps(accepted).map((d) => ({ ...d, ...widenToRuns(d, runs) })),
  );
  const numbers = unclaimedNumbers(text, widened).map((d) => ({ ...d, context: false }));
  const mapped = [...widened, ...numbers].map((d) => ({ ...d, ...normalised.toOriginal(d) }));
  return resolveOverlaps(mapped);
}

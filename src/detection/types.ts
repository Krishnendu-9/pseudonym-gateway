// Shapes shared by the detectors, the overlap rule and the pipeline.
//
// A detection never holds the value it found, only where it is. Anything that
// needs the value slices it out of the text, so detections are safe to log,
// count and compare in tests.

import type { Span } from './normalise.js';

/** Data types detected so far, in overlap priority order (ADR-003), highest first. */
export const DETECTION_TYPES = ['AADHAAR', 'CARD', 'PAN', 'PHONE', 'EMAIL'] as const;

export type DetectionType = (typeof DETECTION_TYPES)[number];

/**
 * A match a detector found in the normalised text: the right shape for its
 * type. `validated` means it also passed the type's checks (ADR-003).
 */
export interface Candidate extends Span {
  readonly type: DetectionType;
  readonly validated: boolean;
}

/** A candidate that was accepted, with its span mapped back to the original text. */
export interface Detection extends Span {
  readonly type: DetectionType;
  readonly validated: boolean;
  /** A keyword for this type appears near the value (ADR-010). */
  readonly context: boolean;
}

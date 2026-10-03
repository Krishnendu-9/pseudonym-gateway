// The B+F join that ADR-035 measured: F's spans kept at NO_SCORE, then the
// union of the model's detections and F's, merged. Moved from
// scripts/compare-names.ts (ADR-036, constraint on step 3), so that the
// gateway runs the code the measurement scored.

import type { Span } from '../normalise.js';
import { merge, type Point } from './spans.js';

/** The point for a candidate with no scores (F, E): every span is kept. */
export const NO_SCORE: Point = { high: 0.5 };

/** The union of a model's detections and F's, merged. */
export function joinDetections(model: readonly Span[], list: readonly Span[]): Span[] {
  return merge([...model, ...list]);
}

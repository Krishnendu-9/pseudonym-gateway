import type { Span } from '../../src/detection/normalise.js';

/** The detection the safety net (ADR-011) reports for a long unclaimed number. */
export const numberAt = (span: Span) => ({
  type: 'NUMBER',
  ...span,
  validated: false,
  context: false,
});

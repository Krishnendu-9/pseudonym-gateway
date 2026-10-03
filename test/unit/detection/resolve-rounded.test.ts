// resolveRounded (ADR-037, bug-log 59): the last overlap pass with names on.
// Overlaps here come only from rounding out to whole clusters; the loser of
// each keeps its parts outside the winners instead of being dropped whole.

import { describe, expect, it } from 'vitest';
import { resolveRounded } from '../../../src/detection/detect.js';
import type { Detection, DetectionType } from '../../../src/detection/types.js';

const d = (type: DetectionType, start: number, end: number, validated = false): Detection => ({
  type,
  start,
  end,
  validated,
  context: false,
});

describe('resolveRounded', () => {
  it('returns the plain winners when nothing overlaps', () => {
    const spans = [d('PERSON', 0, 4), d('EMAIL', 5, 9)];
    expect(resolveRounded(spans)).toEqual(spans);
  });

  it('keeps the loser outside the winner, on either side', () => {
    expect(resolveRounded([d('PERSON', 0, 6), d('EMAIL', 5, 20)])).toEqual([
      d('PERSON', 0, 5),
      d('EMAIL', 5, 20),
    ]);
    expect(resolveRounded([d('EMAIL', 0, 15), d('PERSON', 14, 18)])).toEqual([
      d('EMAIL', 0, 15),
      d('PERSON', 15, 18),
    ]);
  });

  it('keeps every part of a loser that two winners cut into three', () => {
    // The validated cards win over the longer unvalidated name between them.
    const out = resolveRounded([
      d('PERSON', 0, 30),
      d('CARD', 4, 10, true),
      d('CARD', 14, 20, true),
    ]);
    expect(out).toEqual([
      d('PERSON', 0, 4),
      d('CARD', 4, 10, true),
      d('PERSON', 10, 14),
      d('CARD', 14, 20, true),
      d('PERSON', 20, 30),
    ]);
  });

  it('cuts several losers, best ranked first, each against what is kept by then', () => {
    const out = resolveRounded([
      d('AADHAAR', 10, 20, true),
      d('PERSON', 8, 12),
      d('EMAIL', 18, 26),
      d('NUMBER', 11, 19),
    ]);
    expect(out).toEqual([d('PERSON', 8, 10), d('AADHAAR', 10, 20, true), d('EMAIL', 20, 26)]);
  });
});

// growthRatio (bug-log 20): a ratio at or over the limit is measured again,
// the smallest is kept, and quadratic code still fails.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  growthRatio,
  MAX_GROWTH_RATIO,
  MEASUREMENTS,
  ofLength,
} from '../../support/linear-time.js';

/** Makes each timed run take the next of `durations` milliseconds. */
function scriptDurations(durations: number[]): { runs: () => number } {
  let clock = 0;
  let calls = 0;
  const queue = [...durations];
  vi.spyOn(performance, 'now').mockImplementation(() => {
    // time() reads the clock twice per run: before and after.
    if (calls++ % 2 === 1) clock += queue.shift() ?? 1;
    return clock;
  });
  return { runs: () => calls / 2 };
}

/** One measurement of one run per size: every timing comes from the script. */
const scriptedRatio = (): number =>
  growthRatio(
    (n) => 'x'.repeat(n),
    10,
    () => 0,
    1,
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe('growthRatio', () => {
  it('measures once when the first ratio is under the limit', () => {
    const { runs } = scriptDurations([10, 50]);
    expect(scriptedRatio()).toBe(5);
    expect(runs()).toBe(2);
  });

  it('measures again when a ratio is at or over the limit, and keeps the smallest', () => {
    const { runs } = scriptDurations([10, 100, 10, 45]);
    expect(scriptedRatio()).toBe(4.5);
    expect(runs()).toBe(4);
  });

  it(`gives up after ${MEASUREMENTS} measurements, reporting the smallest`, () => {
    const { runs } = scriptDurations([10, 160, 10, 120, 10, 170, 10, 40]);
    expect(scriptedRatio()).toBe(12);
    expect(runs()).toBe(2 * MEASUREMENTS);
  });

  it('still fails real quadratic work', () => {
    vi.restoreAllMocks();
    const quadratic = (text: string): number => {
      let count = 0;
      for (let i = 0; i < text.length; i++) {
        for (let j = i; j < text.length; j++) if (text.charCodeAt(j) === 0x2c) count++;
      }
      return count;
    };
    // Small on purpose: quadratic work measured three times is slow, ten
    // times slower again under coverage (38.7 s at n = 2,000; bug-log 20).
    expect(growthRatio((n) => ofLength('a,', n), 1_000, quadratic, 3)).toBeGreaterThanOrEqual(
      MAX_GROWTH_RATIO,
    );
  });
});

describe('ofLength', () => {
  it('repeats a unit to at least the given length', () => {
    expect(ofLength('abc', 7)).toBe('abcabcabc');
    expect(ofLength('abc', 6)).toBe('abcabc');
  });
});

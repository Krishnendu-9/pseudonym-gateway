// growthRatio (bug-log 20): a ratio at or over the limit is measured again,
// the smallest is kept, and quadratic code still fails. It climbs from a
// small size and stops at the first measurable step that is too high
// (bug-log 24), so quadratic code fails in seconds at any size.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  growthRatio,
  MAX_GROWTH_RATIO,
  MEASURABLE_MS,
  MEASUREMENTS,
  ofLength,
  SMALLEST_SIZE,
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

describe('growthRatio climbs from a small size (bug-log 24)', () => {
  // n = 16 * SMALLEST_SIZE gives three steps: 100 -> 400, 400 -> 1,600, and
  // the last one, 1,600 -> 6,400.
  const n = 16 * SMALLEST_SIZE;
  const climb = (): { ratio: number; sizes: number[] } => {
    const sizes: number[] = [];
    const ratio = growthRatio(
      (size) => {
        sizes.push(size);
        return 'x'.repeat(size);
      },
      n,
      () => 0,
      1,
    );
    return { ratio, sizes };
  };
  const tooFast = MEASURABLE_MS / 2;

  it('does not judge a step whose small input is too fast to measure', () => {
    const { runs } = scriptDurations([tooFast, 20 * tooFast, 2, 8, 8, 36]);
    expect(climb()).toEqual({ ratio: 4.5, sizes: [n / 16, n / 4, n, 4 * n] });
    expect(runs()).toBe(6);
  });

  it('stops at the first measurable step that stays at or over the limit', () => {
    const { runs } = scriptDurations([tooFast, 4 * tooFast, 3, 48, 3, 45, 3, 60]);
    expect(climb()).toEqual({ ratio: 15, sizes: [n / 16, n / 4, n] });
    expect(runs()).toBe(2 + 2 * MEASUREMENTS);
  });

  it('goes on when a measurable step clears the limit on a second measurement', () => {
    const { runs } = scriptDurations([3, 30, 3, 12, 12, 48, 48, 192]);
    expect(climb()).toEqual({ ratio: 4, sizes: [n / 16, n / 4, n, 4 * n] });
    expect(runs()).toBe(8);
  });

  it('always judges the last step, however fast', () => {
    const lastStep = Array.from({ length: MEASUREMENTS }, () => [tooFast, 16 * tooFast]).flat();
    const { runs } = scriptDurations([tooFast, 4 * tooFast, tooFast, 4 * tooFast, ...lastStep]);
    expect(climb().ratio).toBe(16);
    expect(runs()).toBe(4 + 2 * MEASUREMENTS);
  });

  it('fails quadratic work in seconds at a size it could never finish', () => {
    vi.restoreAllMocks();
    const quadratic = (text: string): number => {
      let count = 0;
      for (let i = 0; i < text.length; i++) {
        for (let j = i; j < text.length; j++) if (text.charCodeAt(j) === 0x2c) count++;
      }
      return count;
    };
    // One run on 4,000,000 characters would take hours. The climb must stop
    // long before; `make` refuses to build anything close. It stops at
    // 3,906 -> 15,625 here (15 ms, then 250 ms); only a machine more than 16
    // times faster would need 62,500. The limit is that tight on purpose:
    // one run at 250,000 already takes about a minute, so a climb that
    // failed to stop would make this test slow before it failed
    // (bug-log 25).
    const make = (size: number): string => {
      if (size > 62_500) throw new Error('climbed too far');
      return ofLength('a,', size);
    };
    expect(growthRatio(make, 1_000_000, quadratic, 3)).toBeGreaterThanOrEqual(MAX_GROWTH_RATIO);
  });
});

describe('ofLength', () => {
  it('repeats a unit to at least the given length', () => {
    expect(ofLength('abc', 7)).toBe('abcabcabc');
    expect(ofLength('abc', 6)).toBe('abcabc');
  });
});

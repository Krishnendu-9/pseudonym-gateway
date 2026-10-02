// The helper's own checks that use the real clock, moved from
// linear-time.test.ts with their names unchanged. They expect quadratic
// work to measure at least MAX_GROWTH_RATIO, and load can pull a ratio
// down as well as up: in the main project one measured 6.36 (bug-log 48).
// So they run in the `timing` project with the rest (ADR-032).

import { describe, expect, it } from 'vitest';
import { growthRatio, MAX_GROWTH_RATIO, ofLength } from '../../support/linear-time.js';

const quadratic = (text: string): number => {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    for (let j = i; j < text.length; j++) if (text.charCodeAt(j) === 0x2c) count++;
  }
  return count;
};

describe('growthRatio', () => {
  it('still fails real quadratic work', () => {
    // Small on purpose: quadratic work measured three times is slow, ten
    // times slower again under coverage (38.7 s at n = 2,000; bug-log 20).
    expect(growthRatio((n) => ofLength('a,', n), 1_000, quadratic, 3)).toBeGreaterThanOrEqual(
      MAX_GROWTH_RATIO,
    );
  });
});

describe('growthRatio climbs from a small size (bug-log 24)', () => {
  it('fails quadratic work in seconds at a size it could never finish', () => {
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

// Seeded pseudo-random numbers for synthetic test data. Not cryptographic:
// the point is that one seed always gives the same data, so a dataset or a
// failing test can be reproduced from its seed alone, independent of any
// test library's internals.
//
// Generator: splitmix32, as published at
// https://github.com/bryc/code/blob/master/jshash/PRNGs.md

export interface Rng {
  /** Uniform integer in [min, max], both inclusive. The range may span at most 2^32 values. */
  int(min: number, max: number): number;
  /** Uniformly chosen element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** `count` uniformly random ASCII digits. */
  digits(count: number): string;
  /** True with probability `p`. */
  chance(p: number): boolean;
}

const TWO_POW_32 = 2 ** 32;

export function createRng(seed: number): Rng {
  let state = seed | 0;
  const nextUint32 = (): number => {
    state = (state + 0x9e3779b9) | 0;
    let t = state ^ (state >>> 15);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };

  const int = (min: number, max: number): number => {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
      throw new RangeError('Rng.int: min and max must be integers with min <= max');
    }
    const range = max - min + 1;
    if (range > TWO_POW_32) {
      throw new RangeError('Rng.int: the range may span at most 2^32 values');
    }
    // Rejection sampling: `x % range` alone would favour small values
    // whenever 2^32 is not a multiple of range.
    const limit = TWO_POW_32 - (TWO_POW_32 % range);
    let x = nextUint32();
    while (x >= limit) x = nextUint32();
    return min + (x % range);
  };

  return {
    int,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new RangeError('Rng.pick: items must not be empty');
      return items[int(0, items.length - 1)]!;
    },
    digits(count: number): string {
      let out = '';
      for (let i = 0; i < count; i++) out += String(int(0, 9));
      return out;
    },
    chance(p: number): boolean {
      return nextUint32() / TWO_POW_32 < p;
    },
  };
}

import { describe, expect, it } from 'vitest';
import { createRng } from '../../../src/synthetic/rng.js';

const sample = (seed: number, count: number): number[] => {
  const rng = createRng(seed);
  return Array.from({ length: count }, () => rng.int(0, 1_000_000));
};

describe('createRng', () => {
  it('gives the same sequence for the same seed', () => {
    expect(sample(42, 50)).toEqual(sample(42, 50));
  });

  it('gives different sequences for different seeds', () => {
    expect(sample(42, 50)).not.toEqual(sample(43, 50));
  });

  it('treats seeds modulo 2^32', () => {
    expect(sample(2 ** 32 + 7, 20)).toEqual(sample(7, 20));
  });

  it('int stays within [min, max] and reaches both ends', () => {
    const rng = createRng(1);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const x = rng.int(-3, 3);
      expect(x).toBeGreaterThanOrEqual(-3);
      expect(x).toBeLessThanOrEqual(3);
      seen.add(x);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([-3, -2, -1, 0, 1, 2, 3]);
  });

  it('int is roughly uniform', () => {
    const rng = createRng(2);
    const counts = new Array<number>(10).fill(0);
    for (let i = 0; i < 100_000; i++) counts[rng.int(0, 9)]!++;
    // Expected 10,000 each; +/-5% is more than 15 standard deviations.
    for (const c of counts) {
      expect(c).toBeGreaterThan(9500);
      expect(c).toBeLessThan(10500);
    }
  });

  it('int stays unbiased when rejection sampling has to retry', () => {
    // A range of 3 * 2^30 values: a quarter of raw draws are rejected. Plain
    // `x % range` would put half of all results in [0, 2^30); the true share
    // is a third.
    const range = 3 * 2 ** 30;
    const rng = createRng(12);
    let lowThird = 0;
    for (let i = 0; i < 10_000; i++) {
      const x = rng.int(0, range - 1);
      expect(x >= 0 && x < range).toBe(true);
      if (x < 2 ** 30) lowThird++;
    }
    // Expected 3,333 with a standard deviation of about 47.
    expect(lowThird).toBeGreaterThan(3100);
    expect(lowThird).toBeLessThan(3570);
  });

  it('int accepts a range of exactly 2^32 values', () => {
    const x = createRng(3).int(0, 2 ** 32 - 1);
    expect(Number.isInteger(x) && x >= 0 && x < 2 ** 32).toBe(true);
  });

  it.each([
    [2, 1],
    [0.5, 2],
    [0, 2 ** 32],
    [0, Number.NaN],
  ])('int(%d, %d) throws', (min, max) => {
    expect(() => createRng(1).int(min, max)).toThrow(RangeError);
  });

  it('pick returns an element, and throws on an empty array', () => {
    const rng = createRng(4);
    expect(['a', 'b', 'c']).toContain(rng.pick(['a', 'b', 'c']));
    expect(() => rng.pick([])).toThrow(RangeError);
  });

  it('digits returns the requested number of ASCII digits', () => {
    const rng = createRng(5);
    expect(rng.digits(0)).toBe('');
    expect(rng.digits(25)).toMatch(/^[0-9]{25}$/);
  });

  it('chance(0) is never true and chance(1) is always true', () => {
    const rng = createRng(6);
    for (let i = 0; i < 1000; i++) {
      expect(rng.chance(0)).toBe(false);
      expect(rng.chance(1)).toBe(true);
    }
  });
});

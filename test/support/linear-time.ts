// Linear-time checks that machine load cannot make flaky.
//
// An absolute limit ("under 1 s") fails whenever the machine is busy, and a
// generous one misses a slow regression. Instead, time the same work on an
// input and on one four times as long: linear code takes about 4 times as
// long, quadratic about 16 times, catastrophic backtracking far more.
//
// Two things keep the ratio stable when test files run in parallel:
// - the runs alternate between the two sizes, so a burst of load hits both;
// - the fastest run of each size is used, because load and garbage
//   collection only ever add time.
// Quadrupling rather than doubling leaves room for noise: a ratio of 8 is
// twice what linear code gives, and half what quadratic code gives.
//
// Pick `n` so that one run on the small input takes several milliseconds.
// Below about 2 ms, timer resolution and noise decide the ratio.

/** How many times larger the second input is. */
export const GROWTH = 4;

/** Largest ratio worth passing: between linear (4) and quadratic (16). */
export const MAX_GROWTH_RATIO = 8;

/**
 * How much longer `work` takes when its input grows GROWTH times: the
 * fastest run on `make(GROWTH * n)` divided by the fastest on `make(n)`.
 */
export function growthRatio(
  make: (n: number) => string,
  n: number,
  work: (input: string) => unknown,
  repeats = 5,
): number {
  const small = make(n);
  const large = make(GROWTH * n);
  work(small); // warm up the JIT before timing
  let bestSmall = Infinity;
  let bestLarge = Infinity;
  for (let i = 0; i < repeats; i++) {
    bestSmall = Math.min(bestSmall, time(work, small));
    bestLarge = Math.min(bestLarge, time(work, large));
  }
  return bestLarge / bestSmall;
}

function time(work: (input: string) => unknown, input: string): number {
  const start = performance.now();
  work(input);
  return performance.now() - start;
}

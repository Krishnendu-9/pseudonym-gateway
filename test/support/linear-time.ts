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
// That was not quite enough (bug-log 20): for linear code the ratio has a
// median of about 4.5 but a tail past 7, and a full suite run failed on
// 8.13. So a ratio at or over the limit is measured again, up to
// MEASUREMENTS times, and the smallest is kept. Linear code clears the
// limit on a second try; quadratic code is about 16 on every try. Load can
// only push a ratio up, so the smallest measurement is the truest one, and
// the extra measurements cost nothing unless the first one looks bad.
//
// Pick `n` so that one run on the small input takes several milliseconds.
// Below about 2 ms, timer resolution and noise decide the ratio.

/** How many times larger the second input is. */
export const GROWTH = 4;

/** Largest ratio worth passing: between linear (4) and quadratic (16). */
export const MAX_GROWTH_RATIO = 8;

/** How many times a ratio at or over the limit is measured before it counts. */
export const MEASUREMENTS = 3;

/**
 * How much longer `work` takes when its input grows GROWTH times: the
 * fastest run on `make(GROWTH * n)` divided by the fastest on `make(n)`,
 * measured again (up to MEASUREMENTS times, smallest kept) while it is at
 * or over MAX_GROWTH_RATIO.
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
  let best = Infinity;
  for (let m = 0; m < MEASUREMENTS && best >= MAX_GROWTH_RATIO; m++) {
    let bestSmall = Infinity;
    let bestLarge = Infinity;
    for (let i = 0; i < repeats; i++) {
      bestSmall = Math.min(bestSmall, time(work, small));
      bestLarge = Math.min(bestLarge, time(work, large));
    }
    best = Math.min(best, bestLarge / bestSmall);
  }
  return best;
}

function time(work: (input: string) => unknown, input: string): number {
  const start = performance.now();
  work(input);
  return performance.now() - start;
}

/**
 * `unit` repeated to at least `chars` characters. Linear-time tests size
 * their input by characters, not repeats: 20,000 repeats of a 30-character
 * unit is 600 KB where a 4-character unit gives 80 KB, and under coverage
 * that one test ran into the 30 s hang guard once the suite grew
 * (bug-log 19).
 */
export const ofLength = (unit: string, chars: number): string =>
  unit.repeat(Math.ceil(chars / unit.length));

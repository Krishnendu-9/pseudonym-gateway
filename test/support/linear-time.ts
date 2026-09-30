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
// It must also fail fast (bug-log 24). `n` is sized for correct code: at
// 1,000,000 characters a quadratic mutant needs hours for one run, a
// synchronous call no test timeout can interrupt, so a regression hung the
// run instead of failing a test. So the ratio is found by climbing: from a
// small size, each size is compared with the next one up (n / 64 with
// n / 16, …, n with GROWTH * n). A step is judged once its small input
// takes at least MEASURABLE_MS, the level below which noise decides the
// ratio; if it stays at or over the limit, the climb stops there and
// returns it. Quadratic code crosses MEASURABLE_MS early, and at the first
// step it does, its small run is under 16 times MEASURABLE_MS, so a failing
// test takes seconds whatever `n` is. Linear code is too fast to judge
// until near `n`, and the climb below `n` costs about a third more work.
// The last step, `n` against GROWTH * n, is always judged, as before.
//
// Pick `n` so that one run on it takes several milliseconds.

/** How many times larger the second input is. */
export const GROWTH = 4;

/** Largest ratio worth passing: between linear (4) and quadratic (16). */
export const MAX_GROWTH_RATIO = 8;

/** How many times a ratio at or over the limit is measured before it counts. */
export const MEASUREMENTS = 3;

/** A step below `n` is judged only once its small input takes this long. */
export const MEASURABLE_MS = 2;

/** The climb starts at the smallest n / GROWTH^k that is at least this. */
export const SMALLEST_SIZE = 100;

/**
 * How much longer `work` takes when its input grows GROWTH times: the
 * fastest run on the larger input divided by the fastest on the smaller,
 * measured again (up to MEASUREMENTS times, smallest kept) while it is at
 * or over MAX_GROWTH_RATIO. Sizes climb to `n` and GROWTH * n, and the
 * first measurable step at or over the limit is returned without going
 * further. Sizes are in whatever unit `make` takes.
 */
export function growthRatio(
  make: (n: number) => string,
  n: number,
  work: (input: string) => unknown,
  repeats = 5,
): number {
  const sizes = [n];
  while (Math.round(sizes[0]! / GROWTH) >= SMALLEST_SIZE) {
    sizes.unshift(Math.round(sizes[0]! / GROWTH));
  }
  let small = make(sizes[0]!);
  work(small); // warm up the JIT before timing
  for (const next of sizes.slice(1)) {
    const large = make(next);
    const first = measure(work, small, large, repeats);
    if (first.smallMs >= MEASURABLE_MS) {
      const ratio = confirm(work, small, large, repeats, first.ratio);
      if (ratio >= MAX_GROWTH_RATIO) return ratio;
    }
    small = large;
  }
  const large = make(GROWTH * n);
  return confirm(work, small, large, repeats, measure(work, small, large, repeats).ratio);
}

/** `ratio`, measured again while it is at or over the limit; smallest kept. */
function confirm(
  work: (input: string) => unknown,
  small: string,
  large: string,
  repeats: number,
  ratio: number,
): number {
  let best = ratio;
  for (let m = 1; m < MEASUREMENTS && best >= MAX_GROWTH_RATIO; m++) {
    best = Math.min(best, measure(work, small, large, repeats).ratio);
  }
  return best;
}

/** Fastest run of each input, alternating the two, and their ratio. */
function measure(
  work: (input: string) => unknown,
  small: string,
  large: string,
  repeats: number,
): { ratio: number; smallMs: number } {
  let bestSmall = Infinity;
  let bestLarge = Infinity;
  for (let i = 0; i < repeats; i++) {
    bestSmall = Math.min(bestSmall, time(work, small));
    bestLarge = Math.min(bestLarge, time(work, large));
  }
  return { ratio: bestLarge / bestSmall, smallMs: bestSmall };
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

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
// limit on a second try; quadratic code is about 16 on every try. Load
// mostly pushes a ratio up, so the smallest measurement is the truest one,
// and the extra measurements cost nothing unless the first one looks bad.
// Mostly, not always: load on every small run can pull it down, and a
// quadratic check once measured 6.36 (bug-log 48).
//
// Even so, load decides too much: the larger input's runs are interrupted
// more than the smaller one's. So every timing test lives in a
// *.timing.test.ts file and runs in the `timing` project, after the rest
// and at most three files at a time (vitest.config.ts, ADR-032).
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
//
// With PSEUDONYM_TIMING_LOG set to a file path, every result is also
// appended to that file as one JSON line (the test's name, the ratio, the
// fastest run on each input, how many measurements it took), so that runs
// can be compared when they pass, not only when one fails (Phase 6c, the
// machine sampler's effect). Lengths and times only, never an input.

import { appendFileSync } from 'node:fs';
import { expect } from 'vitest';

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

/** One measurement: every run on each input, and the ratio of the fastest. */
export interface Measurement {
  readonly smallChars: number;
  readonly largeChars: number;
  readonly smallMs: readonly number[];
  readonly largeMs: readonly number[];
  readonly ratio: number;
}

/** What growthRatio decided, and the measurement behind it. */
export interface Growth {
  readonly ratio: number;
  readonly measurement: Measurement;
  /** How many times the deciding step was measured (1 to MEASUREMENTS). */
  readonly measurements: number;
}

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
  return measureGrowth(make, n, work, repeats).ratio;
}

/**
 * Asserts that `work` grows linearly (growthRatio under MAX_GROWTH_RATIO).
 * A failure names the input sizes and every run's time, so a failure on a
 * busy or remote machine explains itself (ADR-032). Only lengths and times
 * are printed, never an input.
 */
export function expectLinearTime(
  make: (n: number) => string,
  n: number,
  work: (input: string) => unknown,
  repeats = 5,
): void {
  const growth = measureGrowth(make, n, work, repeats);
  expect(growth.ratio, growthReport(growth)).toBeLessThan(MAX_GROWTH_RATIO);
}

/** The measurement behind a growth ratio, in one line. */
export function growthReport({ ratio, measurement, measurements }: Growth): string {
  const ms = (runs: readonly number[]): string => runs.map((t) => t.toFixed(2)).join(', ');
  return (
    `growth ratio ${ratio.toFixed(2)} from ${measurement.smallChars} to ${measurement.largeChars} ` +
    `characters (smallest of ${measurements} measurement${measurements === 1 ? '' : 's'}); ` +
    `runs on the smaller input: ${ms(measurement.smallMs)} ms; ` +
    `on the larger: ${ms(measurement.largeMs)} ms`
  );
}

function measureGrowth(
  make: (n: number) => string,
  n: number,
  work: (input: string) => unknown,
  repeats: number,
): Growth {
  const growth = climb(make, n, work, repeats);
  const log = process.env.PSEUDONYM_TIMING_LOG;
  if (log) {
    const { ratio, measurement, measurements } = growth;
    appendFileSync(
      log,
      `${JSON.stringify({
        test: expect.getState().currentTestName ?? '',
        ratio,
        smallChars: measurement.smallChars,
        smallMs: Math.min(...measurement.smallMs),
        largeMs: Math.min(...measurement.largeMs),
        measurements,
      })}\n`,
    );
  }
  return growth;
}

function climb(
  make: (n: number) => string,
  n: number,
  work: (input: string) => unknown,
  repeats: number,
): Growth {
  const sizes = [n];
  while (Math.round(sizes[0]! / GROWTH) >= SMALLEST_SIZE) {
    sizes.unshift(Math.round(sizes[0]! / GROWTH));
  }
  let small = make(sizes[0]!);
  work(small); // warm up the JIT before timing
  for (const next of sizes.slice(1)) {
    const large = make(next);
    const first = measure(work, small, large, repeats);
    if (Math.min(...first.smallMs) >= MEASURABLE_MS) {
      const growth = confirm(work, small, large, repeats, first);
      if (growth.ratio >= MAX_GROWTH_RATIO) return growth;
    }
    small = large;
  }
  const large = make(GROWTH * n);
  return confirm(work, small, large, repeats, measure(work, small, large, repeats));
}

/** `first`, measured again while its ratio is at or over the limit; smallest kept. */
function confirm(
  work: (input: string) => unknown,
  small: string,
  large: string,
  repeats: number,
  first: Measurement,
): Growth {
  let best = first;
  let measurements = 1;
  for (; measurements < MEASUREMENTS && best.ratio >= MAX_GROWTH_RATIO; measurements++) {
    const next = measure(work, small, large, repeats);
    if (next.ratio < best.ratio) best = next;
  }
  return { ratio: best.ratio, measurement: best, measurements };
}

/** Every run of each input, alternating the two, and the ratio of the fastest. */
function measure(
  work: (input: string) => unknown,
  small: string,
  large: string,
  repeats: number,
): Measurement {
  const smallMs: number[] = [];
  const largeMs: number[] = [];
  for (let i = 0; i < repeats; i++) {
    smallMs.push(time(work, small));
    largeMs.push(time(work, large));
  }
  return {
    smallChars: small.length,
    largeChars: large.length,
    smallMs,
    largeMs,
    ratio: Math.min(...largeMs) / Math.min(...smallMs),
  };
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

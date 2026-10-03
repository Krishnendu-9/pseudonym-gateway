// The Phase 6a stopping rule (ADR-035), as code. Written down before any
// model run: a change here after one needs its own note in ADR-035.

import { fpPer1000, JUDGED_GROUPS, share, type Metrics } from './measure.js';
import type { Point } from '../../src/detection/names/spans.js';

/** Hard limits: a candidate over any of them is not eligible. */
export const LIMITS = {
  fpPer1000Words: 1.0,
  msPerKiB: 60,
  memoryBytes: 1.5 * 2 ** 30,
} as const;
/** R and every judged row at or above these: names are covered. */
export const COVERED_RECALL = 0.9;
export const COVERED_ROW = 0.8;
/** The lowest R shipped at all (passport numbers, 93/153, ADR-031). */
export const SHIP_RECALL = 0.6;
/** Rows with fewer values are reported, not judged. */
export const MIN_ROW_VALUES = 50;
/** Within this much R, the faster candidate is chosen. */
export const NEAR = 0.02;

/** One candidate (or a combination with F) at its operating point, with its costs. */
export interface Measured {
  readonly id: string;
  readonly point: Point;
  readonly metrics: Metrics;
  /** Infinity when it was stopped over the limit. */
  readonly msPerKiB: number;
  readonly memoryBytes: number;
  /** Measured on the names block only (too slow for the whole set): never eligible. */
  readonly partial?: true;
}

/** The limits a candidate fails, by name; empty when it is eligible. */
export function failedLimits(m: Measured): string[] {
  const failed: string[] = [];
  if (m.partial) failed.push('measured on the names block only');
  if (fpPer1000(m.metrics) > LIMITS.fpPer1000Words) failed.push('false positives');
  if (m.msPerKiB > LIMITS.msPerKiB) failed.push('speed');
  if (m.memoryBytes > LIMITS.memoryBytes) failed.push('memory');
  return failed;
}

const recallOf = (m: { readonly metrics: Metrics }): number => share(m.metrics.recall);

/** The judged rows (language and script, with enough values) below COVERED_ROW. */
export function weakRows(m: Measured): string[] {
  return Object.entries(m.metrics.rows)
    .filter(([tag]) => JUDGED_GROUPS.some((g) => tag.startsWith(g)))
    .filter(([, row]) => row.of >= MIN_ROW_VALUES && share(row) < COVERED_ROW)
    .map(([tag]) => tag)
    .sort();
}

const isCovered = (m: Measured): boolean =>
  recallOf(m) >= COVERED_RECALL && weakRows(m).length === 0;

/**
 * A candidate's operating point: the highest R among the points within
 * the false-positive limit; ties to the lower FP, then the higher `high`.
 * When no point is within the limit, the one with the fewest false
 * positives (it is then not eligible).
 */
export function choosePoint<T extends { point: Point; metrics: Metrics }>(tried: readonly T[]): T {
  const fp = (t: T): number => fpPer1000(t.metrics);
  const within = tried.filter((t) => fp(t) <= LIMITS.fpPer1000Words);
  if (within.length === 0) {
    return [...tried].sort((a, b) => fp(a) - fp(b) || recallOf(b) - recallOf(a))[0]!;
  }
  return [...within].sort(
    (a, b) => recallOf(b) - recallOf(a) || fp(a) - fp(b) || b.point.high - a.point.high,
  )[0]!;
}

export type Tier = 'covered' | 'partly covered' | 'too costly' | 'not shipped';

export interface Decision {
  readonly tier: Tier;
  /** What ships (absent when nothing does). */
  readonly chosen?: Measured;
  /** Why, one line each, for the report. */
  readonly reasons: readonly string[];
}

/** Covered or partly covered, for a choice within the limits that reaches SHIP_RECALL. */
function shipped(chosen: Measured, reasons: string[]): Decision {
  if (isCovered(chosen)) return { tier: 'covered', chosen, reasons };
  reasons.push(`weak rows: ${weakRows(chosen).join(', ') || 'none'}`);
  return { tier: 'partly covered', chosen, reasons };
}

/** Of `pool`, the highest R; within NEAR of it, the fastest. */
function best(pool: readonly Measured[]): Measured | undefined {
  if (pool.length === 0) return undefined;
  const top = Math.max(...pool.map(recallOf));
  return pool
    .filter((m) => recallOf(m) >= top - NEAR)
    .sort((a, b) => a.msPerKiB - b.msPerKiB || recallOf(b) - recallOf(a))[0];
}

/**
 * The decision of ADR-035. `candidates` are each at their operating point;
 * `combined(m)` is m combined with F (the union of their detections), or
 * undefined when m is F itself.
 */
export function decide(
  candidates: readonly Measured[],
  combined: (m: Measured) => Measured | undefined,
): Decision {
  const reasons: string[] = [];
  const eligible = candidates.filter((m) => failedLimits(m).length === 0);
  let chosen = best(eligible);
  if (chosen) {
    reasons.push(`eligible with the highest R (fastest within ${NEAR * 100} points): ${chosen.id}`);
    if (!isCovered(chosen)) {
      const both = combined(chosen);
      if (both && recallOf(both) > recallOf(chosen) && failedLimits(both).length === 0) {
        reasons.push(`combined with F: R goes up and it stays within the limits (${both.id})`);
        chosen = both;
      } else if (both) {
        reasons.push(`combined with F: not taken (${both.id})`);
      }
    }
    if (recallOf(chosen) >= SHIP_RECALL) return shipped(chosen, reasons);
    reasons.push(`its R is below ${SHIP_RECALL * 100}%`);
  } else {
    reasons.push('no candidate is within all three limits');
  }
  // Every candidate and every combination with F, the highest R first.
  const everything = candidates
    .flatMap((m) => [m, combined(m)])
    .filter((m): m is Measured => m !== undefined)
    .filter((m) => recallOf(m) >= SHIP_RECALL)
    .sort((a, b) => recallOf(b) - recallOf(a));
  // Step 3 (amended before any run): another candidate's combination with F
  // that is within the limits and reaches 60%.
  const rescue = everything.find((m) => failedLimits(m).length === 0);
  if (rescue) {
    reasons.push(`${rescue.id} reaches it within the limits`);
    return shipped(rescue, reasons);
  }
  // Whatever reaches 60% now fails a limit: nothing within them does.
  const fallback = everything[0];
  if (fallback) {
    reasons.push(`${fallback.id} reaches it but fails: ${failedLimits(fallback).join(', ')}`);
    return { tier: 'too costly', chosen: fallback, reasons };
  }
  reasons.push(`nothing reaches R ${SHIP_RECALL * 100}%`);
  return { tier: 'not shipped', reasons };
}

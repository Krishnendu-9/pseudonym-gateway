// The comparison's grid of operating points (ADR-035). The spans and the
// tiers are in src/detection/names/spans.ts (ADR-036 step 2).

import type { Point } from '../../src/detection/names/spans.js';

/**
 * The fixed grid of operating points (ADR-035): `high` from 0.50 to 0.95 in
 * steps of 0.05; `mid` none, or from 0.10 to `high` − 0.05 in steps of 0.05.
 * Steps are counted in hundredths, so 0.7 is exactly 0.7.
 */
export function grid(): Point[] {
  const points: Point[] = [];
  for (let high = 50; high <= 95; high += 5) {
    points.push({ high: high / 100 });
    for (let mid = 10; mid < high; mid += 5) points.push({ high: high / 100, mid: mid / 100 });
  }
  return points;
}

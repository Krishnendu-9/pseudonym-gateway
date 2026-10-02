// Linear-time checks moved from resolve.test.ts, names unchanged.
// They run in the `timing` project, after every other test and at most
// three files at a time, because load from other tests makes a growth
// ratio unreliable (vitest.config.ts, ADR-032).

import { describe, it } from 'vitest';
import type { Span } from '../../../src/detection/normalise.js';
import { resolveCandidates } from '../../../src/detection/resolve.js';
import type { Detection, DetectionType } from '../../../src/detection/types.js';
import { expectLinearTime } from '../../support/linear-time.js';

const d = (type: DetectionType, start: number, end: number, validated = true): Detection => ({
  type,
  start,
  end,
  validated,
  context: false,
});
const noWidening = (s: Span): Span => ({ start: s.start, end: s.end });

// Linear time (test/support/linear-time.ts): many candidates, each
// containing or overlapping its neighbours.
describe('resolveCandidates: linear time', () => {
  const unit = 'aaaa bbbb ';
  const make = (n: number): string => unit.repeat(Math.ceil(n / unit.length));
  const candidatesFor = (text: string): Detection[] => {
    const out: Detection[] = [];
    for (let at = 0; at + 14 <= text.length; at += 10) {
      out.push(
        d('PHONE', at, at + 4),
        d('EMAIL', at, at + 9, false),
        d('SECRET', at + 2, at + 14, false),
      );
    }
    return out;
  };
  it('paints many losers over one long stretch in linear time', () => {
    // The worst case for the painting: the best-ranked loser paints almost
    // everything, then every other loser starts inside what it painted.
    const make = (n: number): string => 'a'.repeat(n);
    const work = (text: string): number => {
      const n = text.length;
      const losers = [d('SECRET', 0, n - 1, false)];
      for (let at = 1; at < n - 2; at += 4) losers.push(d('EMAIL', at, n - 1, false));
      return resolveCandidates(text, [d('PHONE', n - 2, n), ...losers], noWidening).length;
    };
    expectLinearTime(make, 20_000, work);
  });

  it('resolves containing and overlapping candidates in linear time', () => {
    const work = (text: string): number =>
      resolveCandidates(text, candidatesFor(text), noWidening).length;
    expectLinearTime(make, 20_000, work);
  });
});

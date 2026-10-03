import { describe, expect, it } from 'vitest';
import type { Metrics } from '../../../../eval/names/measure.js';
import {
  choosePoint,
  decide,
  failedLimits,
  LIMITS,
  weakRows,
  type Measured,
} from '../../../../eval/names/rule.js';
import type { Point } from '../../../../src/detection/names/spans.js';

/** Metrics with R = hit / 100, rows given, `fp` plain-text over-redactions per 1,000 words. */
function metrics(hit: number, rows: Record<string, [number, number]> = {}, fp = 0): Metrics {
  return {
    recall: { hit, of: 100 },
    rows: Object.fromEntries(Object.entries(rows).map(([t, [h, o]]) => [t, { hit: h, of: o }])),
    main: { hit: 0, of: 0 },
    precision: { hit: 0, of: 0 },
    plainText: fp,
    words: 1000,
    lookalikes: {},
  };
}

function candidate(id: string, hit: number, extra: Partial<Measured> = {}): Measured {
  return {
    id,
    point: { high: 0.5 },
    metrics: metrics(hit),
    msPerKiB: 10,
    memoryBytes: 2 ** 20,
    ...extra,
  };
}

describe('failedLimits', () => {
  it('names every limit a candidate fails, and nothing for one within them', () => {
    expect(failedLimits(candidate('A', 50))).toEqual([]);
    expect(
      failedLimits(
        candidate('E', 50, {
          partial: true,
          metrics: metrics(50, {}, 2),
          msPerKiB: Number.POSITIVE_INFINITY,
          memoryBytes: LIMITS.memoryBytes + 1,
        }),
      ),
    ).toEqual(['measured on the names block only', 'false positives', 'speed', 'memory']);
  });

  it('takes each limit itself as within', () => {
    const edge = candidate('A', 50, {
      metrics: metrics(50, {}, LIMITS.fpPer1000Words),
      msPerKiB: LIMITS.msPerKiB,
      memoryBytes: LIMITS.memoryBytes,
    });
    expect(failedLimits(edge)).toEqual([]);
  });
});

describe('weakRows', () => {
  it('lists judged rows (language, script) with 50+ values under 80%, sorted', () => {
    const m = candidate('A', 90, {
      metrics: metrics(90, {
        'name-script:latin': [79, 100],
        'name-lang:hi': [30, 49],
        'name-lang:en': [39, 50],
        'name-region:south': [10, 100],
        'name-lang:hinglish': [80, 100],
      }),
    });
    expect(weakRows(m)).toEqual(['name-lang:en', 'name-script:latin']);
  });
});

describe('choosePoint', () => {
  const tried = (high: number, hit: number, fp: number, mid?: number) => ({
    point: (mid === undefined ? { high } : { high, mid }) as Point,
    metrics: metrics(hit, {}, fp),
  });

  it('takes the highest R within the false-positive limit', () => {
    const best = choosePoint([tried(0.5, 90, 1.5), tried(0.6, 80, 1), tried(0.7, 70, 0)]);
    expect(best.point).toEqual({ high: 0.6 });
  });

  it('breaks ties by fewer false positives, then by the higher high', () => {
    expect(choosePoint([tried(0.5, 80, 0.8), tried(0.6, 80, 0.2)]).point).toEqual({ high: 0.6 });
    expect(choosePoint([tried(0.5, 80, 0.2, 0.3), tried(0.7, 80, 0.2)]).point).toEqual({
      high: 0.7,
    });
  });

  it('takes the fewest false positives when no point is within the limit', () => {
    const best = choosePoint([tried(0.5, 90, 3), tried(0.9, 40, 2), tried(0.8, 60, 2)]);
    expect(best.point).toEqual({ high: 0.8 });
  });
});

describe('decide', () => {
  const none = (): undefined => undefined;

  it('covered: the eligible candidate with the highest R, every judged row 80% or more', () => {
    const d = decide([candidate('A', 95), candidate('B', 80)], () => {
      throw new Error('a covered candidate is never combined');
    });
    expect([d.tier, d.chosen?.id]).toEqual(['covered', 'A']);
  });

  it('within 2 points of the best R, the faster candidate', () => {
    const d = decide(
      [candidate('A', 95, { msPerKiB: 50 }), candidate('B', 93, { msPerKiB: 5 })],
      none,
    );
    expect([d.tier, d.chosen?.id]).toEqual(['covered', 'B']);
    const far = decide(
      [candidate('A', 95, { msPerKiB: 50 }), candidate('B', 92, { msPerKiB: 5 })],
      none,
    );
    expect(far.chosen?.id).toBe('A');
    const tie = decide([candidate('A', 94), candidate('B', 95)], none);
    expect(tie.chosen?.id).toBe('B');
  });

  it('not covered with R 90% or more when a judged row is weak', () => {
    const weak = candidate('A', 95, {
      metrics: metrics(95, { 'name-script:devanagari': [40, 100] }),
    });
    const d = decide([weak], none);
    expect([d.tier, d.reasons.at(-1)]).toEqual([
      'partly covered',
      'weak rows: name-script:devanagari',
    ]);
  });

  it('partly covered: combined with F when R goes up within the limits', () => {
    const d = decide([candidate('A', 70)], (m) => candidate(`${m.id}+F`, 75));
    expect([d.tier, d.chosen?.id]).toEqual(['partly covered', 'A+F']);
    expect(d.reasons).toContain('weak rows: none');
  });

  it('keeps the candidate alone when the combination is no better or fails a limit', () => {
    const lower = decide([candidate('A', 70)], (m) => candidate(`${m.id}+F`, 70));
    expect([lower.chosen?.id, lower.reasons[1]]).toEqual(['A', 'combined with F: not taken (A+F)']);
    const costly = decide([candidate('A', 70)], (m) =>
      candidate(`${m.id}+F`, 80, { msPerKiB: LIMITS.msPerKiB + 1 }),
    );
    expect(costly.chosen?.id).toBe('A');
  });

  it('F alone is never combined with itself', () => {
    const d = decide([candidate('F', 65)], none);
    expect([d.tier, d.chosen?.id, d.reasons.some((r) => r.startsWith('combined'))]).toEqual([
      'partly covered',
      'F',
      false,
    ]);
  });

  it('too costly: nothing eligible reaches 60%, a candidate over a limit does', () => {
    const d = decide(
      [
        candidate('A', 50),
        candidate('D', 70, { msPerKiB: 200 }),
        candidate('E', 80, { partial: true }),
      ],
      none,
    );
    expect([d.tier, d.chosen?.id]).toEqual(['too costly', 'E']);
    expect(d.reasons).toContain('its R is below 60%');
    expect(d.reasons.at(-1)).toBe('E reaches it but fails: measured on the names block only');
  });

  it('too costly: a combination over a limit counts too', () => {
    const d = decide([candidate('D', 55, { msPerKiB: 200 })], (m) =>
      candidate(`${m.id}+F`, 65, { msPerKiB: 210 }),
    );
    expect([d.tier, d.chosen?.id, d.reasons[0]]).toEqual([
      'too costly',
      'D+F',
      'no candidate is within all three limits',
    ]);
  });

  it('covered needs R 90%: 85% with every row fine is partly covered', () => {
    expect(decide([candidate('A', 85)], none).tier).toBe('partly covered');
    expect(decide([candidate('A', 90)], none).tier).toBe('covered');
  });

  it("below 60%, another candidate's combination with F within the limits takes its place", () => {
    const combos: Record<string, number> = { A: 58, B: 65 };
    const d = decide([candidate('A', 55), candidate('B', 50)], (m) =>
      candidate(`${m.id}+F`, combos[m.id]!),
    );
    expect([d.tier, d.chosen?.id]).toEqual(['partly covered', 'B+F']);
    expect(d.reasons).toContain('B+F reaches it within the limits');
    // And it is judged like any choice: covered if it is.
    const high = decide([candidate('A', 55), candidate('B', 50)], (m) =>
      candidate(`${m.id}+F`, m.id === 'B' ? 95 : 58),
    );
    expect([high.tier, high.chosen?.id]).toEqual(['covered', 'B+F']);
  });

  it('takes 60% itself as reached, at every step', () => {
    expect(decide([candidate('A', 60)], none).tier).toBe('partly covered');
    const rescued = decide([candidate('A', 55), candidate('B', 50)], (m) =>
      candidate(`${m.id}+F`, m.id === 'B' ? 60 : 58),
    );
    expect(rescued.chosen?.id).toBe('B+F');
    // At 60% the chosen candidate stays, even with a better combination elsewhere.
    const kept = decide([candidate('A', 60), candidate('B', 50)], (m) =>
      candidate(`${m.id}+F`, m.id === 'B' ? 70 : 58),
    );
    expect(kept.chosen?.id).toBe('A');
    const costly = decide([candidate('D', 60, { msPerKiB: 200 })], none);
    expect([costly.tier, costly.chosen?.id]).toEqual(['too costly', 'D']);
  });

  it('not shipped: nothing reaches 60%', () => {
    const d = decide([candidate('A', 59), candidate('D', 50, { msPerKiB: 200 })], (m) =>
      m.id === 'F' ? undefined : candidate(`${m.id}+F`, 59),
    );
    expect([d.tier, d.chosen, d.reasons.at(-1)]).toEqual([
      'not shipped',
      undefined,
      'nothing reaches R 60%',
    ]);
  });
});

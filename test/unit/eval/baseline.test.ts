import { describe, expect, it } from 'vitest';
import {
  compare,
  compareAll,
  merge,
  nextBaseline,
  scoresHeldOut,
  verdict,
  type Baseline,
  type Measurement,
  type StoredDataset,
} from '../../../eval/baseline.js';
import type { DatasetScore, TypeScore } from '../../../eval/score.js';
import { PERSONAL_TYPES } from '../../../eval/types.js';

const row = (values: number, redacted: number, typed: number, notPersonal: number): TypeScore => ({
  values,
  redacted,
  typed,
  partial: 0,
  missed: values - redacted,
  detections: typed + notPersonal,
  rightType: typed,
  otherPersonal: 0,
  notPersonal,
});

const dataset = (
  rows: Partial<Record<string, TypeScore>> = {},
  size: { cases?: number; messages?: number } = {},
  shapes: DatasetScore['shapes'] = {},
): DatasetScore => ({
  cases: size.cases ?? 10,
  messages: size.messages ?? 12,
  types: Object.fromEntries(
    PERSONAL_TYPES.map((type) => [type, rows[type] ?? row(0, 0, 0, 0)]),
  ) as DatasetScore['types'],
  overRedactions: {},
  shapes,
});

const BASE = dataset({ AADHAAR: row(10, 8, 7, 3), PHONE: row(5, 5, 5, 0) });
const stored = (score: DatasetScore): StoredDataset => ({
  cases: score.cases,
  messages: score.messages,
  types: score.types,
  ...(Object.keys(score.shapes).length > 0 ? { shapes: score.shapes } : {}),
});

describe('a type the stored baseline predates (PASSPORT, VOTER, DOB in Phase 5c)', () => {
  const older = Object.fromEntries(Object.entries(BASE.types).filter(([t]) => t !== 'PASSPORT'));
  const before: StoredDataset = { cases: 10, messages: 12, types: older as StoredDataset['types'] };

  it('reads as an empty row: no values now is no change at all', () => {
    expect(compare('held-out', before, BASE)).toEqual({ worse: [], better: [], changed: [] });
  });

  it('values for it now are a changed dataset, not a crash', () => {
    const now = dataset({ ...BASE.types, PASSPORT: row(3, 0, 0, 0) });
    expect(compare('generated', before, now).changed).toEqual([
      'generated PASSPORT: 0 values -> 3',
    ]);
  });
});

describe('compare, by shape (the generated set’s shape block)', () => {
  const shaped = (shapes: DatasetScore['shapes']): DatasetScore => dataset(BASE.types, {}, shapes);
  const BEFORE = stored(
    shaped({
      main: { values: 10, redacted: 8, partial: 1 },
      contained: { values: 4, redacted: 0, partial: 4 },
    }),
  );

  it.each([
    ['the same counts', { values: 4, redacted: 0, partial: 4 }, 'nothing', []],
    [
      'more redacted',
      { values: 4, redacted: 3, partial: 1 },
      'better',
      ['generated shape contained: redacted 0 -> 3'],
    ],
    ['partial moves alone', { values: 4, redacted: 0, partial: 2 }, 'nothing', []],
    [
      'more values',
      { values: 5, redacted: 0, partial: 4 },
      'changed',
      ['generated shape contained: 4 values -> 5'],
    ],
  ] as const)('%s: %s', (_name, contained, side, lines) => {
    const result = compare(
      'generated',
      BEFORE,
      shaped({ main: { values: 10, redacted: 8, partial: 1 }, contained }),
    );
    const expected = { worse: [], better: [], changed: [] } as Record<string, readonly string[]>;
    if (side !== 'nothing') expected[side] = lines;
    expect(result).toEqual(expected);
  });

  it('fewer redacted is worse', () => {
    const now = shaped({
      main: { values: 10, redacted: 7, partial: 1 },
      contained: { values: 4, redacted: 0, partial: 4 },
    });
    expect(compare('generated', BEFORE, now).worse).toEqual([
      'generated shape main: redacted 8 -> 7',
    ]);
  });

  it('a shape that appears or disappears is a changed dataset', () => {
    const now = shaped({
      main: { values: 10, redacted: 8, partial: 1 },
      'short-id': { values: 6, redacted: 0, partial: 0 },
    });
    expect(compare('generated', BEFORE, now).changed).toEqual([
      'generated shape contained: 4 values -> 0',
      'generated shape short-id: 0 values -> 6',
    ]);
  });

  it('a stored dataset with no shapes and a score with none: nothing to compare', () => {
    expect(compare('held-out', stored(BASE), BASE)).toEqual({ worse: [], better: [], changed: [] });
  });
});

describe('compare', () => {
  it('the same counts: nothing to say', () => {
    expect(compare('generated', stored(BASE), BASE)).toEqual({
      worse: [],
      better: [],
      changed: [],
    });
  });

  it.each([
    ['redacted up', 'better', row(10, 9, 7, 3), 'generated AADHAAR: redacted 8 -> 9'],
    ['redacted down', 'worse', row(10, 7, 7, 3), 'generated AADHAAR: redacted 8 -> 7'],
    [
      'right type up',
      'better',
      row(10, 8, 8, 3),
      'generated AADHAAR: redacted with the right type 7 -> 8',
    ],
    [
      'right type down',
      'worse',
      row(10, 8, 6, 3),
      'generated AADHAAR: redacted with the right type 7 -> 6',
    ],
    [
      'over-redactions down',
      'better',
      row(10, 8, 7, 2),
      'generated AADHAAR: over-redactions 3 -> 2',
    ],
    ['over-redactions up', 'worse', row(10, 8, 7, 4), 'generated AADHAAR: over-redactions 3 -> 4'],
  ] as const)('%s is %s', (_name, side, aadhaar, line) => {
    const result = compare('generated', stored(BASE), dataset({ ...BASE.types, AADHAAR: aadhaar }));
    expect(result[side]).toEqual([line]);
    expect(result[side === 'better' ? 'worse' : 'better']).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  it('one run can be better in one count and worse in another', () => {
    const result = compare(
      'generated',
      stored(BASE),
      dataset({ AADHAAR: row(10, 9, 7, 5), PHONE: row(5, 4, 4, 0) }),
    );
    expect(result.better).toEqual(['generated AADHAAR: redacted 8 -> 9']);
    expect(result.worse).toEqual([
      'generated AADHAAR: over-redactions 3 -> 5',
      'generated PHONE: redacted 5 -> 4',
      'generated PHONE: redacted with the right type 5 -> 4',
    ]);
  });

  it('a different number of values is a changed dataset, and its counts are not compared', () => {
    const result = compare(
      'held-out',
      stored(BASE),
      dataset({ AADHAAR: row(11, 2, 2, 9), PHONE: row(5, 5, 5, 0) }),
    );
    expect(result).toEqual({
      worse: [],
      better: [],
      changed: ['held-out AADHAAR: 10 values -> 11'],
    });
  });

  it('a different number of cases or messages is a changed dataset', () => {
    expect(compare('generated', stored(BASE), dataset(BASE.types, { cases: 11 })).changed).toEqual([
      'generated: 10 cases / 12 messages -> 11 / 12',
    ]);
    expect(
      compare('generated', stored(BASE), dataset(BASE.types, { messages: 13 })).changed,
    ).toEqual(['generated: 10 cases / 12 messages -> 10 / 13']);
  });

  it('counts that are not thresholds (detections, partial) may move freely', () => {
    const moved = dataset({
      ...BASE.types,
      AADHAAR: { ...row(10, 8, 7, 3), detections: 99, partial: 1, missed: 1, otherPersonal: 4 },
    });
    expect(compare('generated', stored(BASE), moved)).toEqual({
      worse: [],
      better: [],
      changed: [],
    });
  });

  it('a dataset with no baseline and no cases is nothing; the first measurement is "better"', () => {
    expect(compare('held-out', null, undefined)).toEqual({ worse: [], better: [], changed: [] });
    expect(compare('held-out', null, BASE).better).toEqual([
      'held-out: measured for the first time',
    ]);
  });

  it('a baseline whose dataset has gone is a changed dataset', () => {
    expect(compare('held-out', stored(BASE), undefined).changed).toEqual([
      'held-out: has a baseline but no cases now',
    ]);
  });
});

describe('merge and verdict', () => {
  const a = { worse: ['w'], better: [], changed: [] };
  const b = { worse: [], better: ['b'], changed: ['c'] };

  it('merge keeps every line', () => {
    expect(merge(a, b)).toEqual({ worse: ['w'], better: ['b'], changed: ['c'] });
  });

  it.each([
    ['same', { worse: [], better: [], changed: [] }],
    ['better', { worse: [], better: ['b'], changed: [] }],
    ['needs-note', a],
    ['needs-note', { worse: [], better: [], changed: ['c'] }],
    ['needs-note', merge(a, b)],
  ] as const)('%s', (expected, comparison) => {
    expect(verdict(comparison)).toBe(expected);
  });
});

const measurement = (generated: DatasetScore, heldOut?: DatasetScore, seed = 1): Measurement => ({
  date: '2026-10-02',
  generated: { score: generated, seed },
  heldOut,
});

const BASELINE: Baseline = {
  measuredOn: '2026-09-30',
  generated: { ...stored(BASE), seed: 1 },
  heldOut: null,
  history: [],
};

describe('compareAll', () => {
  it('no baseline yet: everything is new', () => {
    expect(compareAll(undefined, measurement(BASE))).toEqual({
      worse: [],
      better: ['no baseline yet'],
      changed: [],
    });
  });

  it('the same measurement is the same', () => {
    expect(verdict(compareAll(BASELINE, measurement(BASE)))).toBe('same');
  });

  it('a different seed is a changed dataset', () => {
    expect(compareAll(BASELINE, measurement(BASE, undefined, 2)).changed).toEqual([
      'generated: seed 1 -> 2',
    ]);
  });

  it('compares both datasets', () => {
    const result = compareAll(
      { ...BASELINE, heldOut: stored(BASE) },
      measurement(
        dataset({ ...BASE.types, PHONE: row(5, 4, 4, 0) }),
        dataset({ ...BASE.types, PHONE: row(5, 5, 5, 1) }),
      ),
    );
    expect(result.worse).toEqual([
      'generated PHONE: redacted 5 -> 4',
      'generated PHONE: redacted with the right type 5 -> 4',
      'held-out PHONE: over-redactions 0 -> 1',
    ]);
  });
});

describe('scoresHeldOut', () => {
  it('not while it is being written: no baseline for it, and nobody asked', () => {
    expect(scoresHeldOut(undefined, false)).toBe(false);
    expect(scoresHeldOut(BASELINE, false)).toBe(false);
  });

  it('when its first measurement is asked for, and on every run once it has a baseline', () => {
    expect(scoresHeldOut(undefined, true)).toBe(true);
    expect(scoresHeldOut(BASELINE, true)).toBe(true);
    expect(scoresHeldOut({ ...BASELINE, heldOut: stored(BASE) }, false)).toBe(true);
  });
});

describe('nextBaseline', () => {
  it('the first baseline needs no note and has no history', () => {
    expect(nextBaseline(undefined, measurement(BASE), undefined)).toEqual({
      measuredOn: '2026-10-02',
      generated: { ...stored(BASE), seed: 1 },
      heldOut: null,
      history: [],
    });
  });

  it('stores counts only, not the over-redaction breakdown', () => {
    const next = nextBaseline(undefined, measurement(BASE, BASE), undefined);
    expect(Object.keys(next.generated).sort()).toEqual(['cases', 'messages', 'seed', 'types']);
    expect(Object.keys(next.heldOut!).sort()).toEqual(['cases', 'messages', 'types']);
  });

  it('stores the shape counts when the score has them, and no shapes key when it has none', () => {
    const shapes = { main: { values: 10, redacted: 8, partial: 1 } };
    const next = nextBaseline(
      undefined,
      measurement(dataset(BASE.types, {}, shapes), BASE),
      undefined,
    );
    expect(next.generated.shapes).toEqual(shapes);
    expect(Object.keys(next.heldOut!)).not.toContain('shapes');
  });

  it('a better measurement moves the floor up without a note', () => {
    const better = dataset({ ...BASE.types, AADHAAR: row(10, 9, 9, 3) });
    const next = nextBaseline(BASELINE, measurement(better), undefined);
    expect(next.generated.types.AADHAAR.redacted).toBe(9);
    expect([next.measuredOn, next.history]).toEqual(['2026-10-02', []]);
  });

  it('the first held-out measurement needs no note', () => {
    const next = nextBaseline(BASELINE, measurement(BASE, BASE), undefined);
    expect(next.heldOut).toEqual(stored(BASE));
    expect(next.history).toEqual([]);
  });

  it.each([undefined, '', '   '])('a worse measurement is refused without a note (%j)', (note) => {
    const worse = dataset({ ...BASE.types, AADHAAR: row(10, 7, 7, 3) });
    expect(() => nextBaseline(BASELINE, measurement(worse), note)).toThrow('--accept');
  });

  it('a changed dataset is refused without a note', () => {
    expect(() =>
      nextBaseline(BASELINE, measurement(dataset(BASE.types, { cases: 11 })), undefined),
    ).toThrow('--accept');
  });

  it('with a note it is accepted, and the history says what moved and why', () => {
    const previous: Baseline = {
      ...BASELINE,
      history: [{ date: '2026-09-30', note: 'earlier', changes: ['x'] }],
    };
    const worse = dataset({ ...BASE.types, AADHAAR: row(10, 9, 7, 5) }, { cases: 11 });
    const next = nextBaseline(previous, measurement(worse), '  ADR-022: join line breaks ');
    expect(next.generated.types.AADHAAR).toMatchObject({ redacted: 9, notPersonal: 5 });
    expect(next.history).toEqual([
      { date: '2026-09-30', note: 'earlier', changes: ['x'] },
      {
        date: '2026-10-02',
        note: 'ADR-022: join line breaks',
        changes: [
          'generated AADHAAR: over-redactions 3 -> 5',
          'generated: 10 cases / 12 messages -> 11 / 12',
        ],
      },
    ]);
  });

  it('a note given for a better measurement is not recorded: there is nothing to justify', () => {
    const better = dataset({ ...BASE.types, AADHAAR: row(10, 9, 9, 3) });
    expect(nextBaseline(BASELINE, measurement(better), 'unneeded').history).toEqual([]);
  });
});

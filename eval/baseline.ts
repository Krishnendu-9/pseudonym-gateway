// The thresholds CI holds the detectors to (ADR-021): the exact counts of the
// last accepted measurement, in eval/baseline.json.
//
// Both datasets are deterministic, so a count that moves is a real change,
// never noise, and needs no margin:
//  - a worse count fails the run; the baseline can only be moved that way
//    with a note that names the decision (an ADR), kept in its history;
//  - a better count fails the run too, until the baseline is updated, so
//    that the file, and the README table made from it, never lag behind;
//  - a dataset that changed shape (more cases, more values) needs a note as
//    well, because every count is then measured on different text.
//
// A type added after a baseline was stored (PASSPORT, VOTER and DOB in
// Phase 5c) is read as an empty row there, so that its values show up as a
// changed dataset, not as a crash.
//
// The echo measurement (ADR-033) is held the same way, part by part:
// restored placeholders may only go up; what a rule held back, later
// mentions restored in their first form, and broken round trips may only
// go down.

import type { EchoScore } from './echo.js';
import type { DatasetScore, ShapeScore, TypeScore } from './score.js';
import { PERSONAL_TYPES, type PersonalType } from './types.js';
import { HELD_BACK_RULES } from '../src/redaction/restore.js';

export interface StoredDataset {
  readonly cases: number;
  readonly messages: number;
  readonly types: Readonly<Record<PersonalType, TypeScore>>;
  /** The generated set's values by the way they are written (Phase 5c); absent before. */
  readonly shapes?: Readonly<Record<string, ShapeScore>>;
  /**
   * The echo measurement (Phase 5d, ADR-033), by part: the generated set's
   * `main` cases and each shape; the held-out set as one part, `all`.
   * Absent before it existed.
   */
  readonly echo?: Readonly<Record<string, EchoScore>>;
}

/** A type's row, or an empty one for a type the stored dataset predates. */
export const rowOf = (dataset: StoredDataset, type: PersonalType): TypeScore =>
  (dataset.types as Partial<Record<PersonalType, TypeScore>>)[type] ?? {
    values: 0,
    redacted: 0,
    typed: 0,
    partial: 0,
    missed: 0,
    detections: 0,
    rightType: 0,
    otherPersonal: 0,
    notPersonal: 0,
  };

export interface Baseline {
  /** The day the counts were last accepted (YYYY-MM-DD). */
  readonly measuredOn: string;
  readonly generated: StoredDataset & { readonly seed: number };
  /** Null until the held-out set has cases. */
  readonly heldOut: StoredDataset | null;
  /** Every time a worse count or a changed dataset was accepted, and why. */
  readonly history: readonly {
    readonly date: string;
    readonly note: string;
    readonly changes: readonly string[];
  }[];
}

export interface Comparison {
  /** Counts that got worse. */
  readonly worse: readonly string[];
  /** Counts that got better. */
  readonly better: readonly string[];
  /** The dataset is not the one the baseline was measured on. */
  readonly changed: readonly string[];
}

// The counts a threshold is kept on, and which way is better.
const METRICS: readonly { key: keyof TypeScore; higherIsBetter: boolean; name: string }[] = [
  { key: 'redacted', higherIsBetter: true, name: 'redacted' },
  { key: 'typed', higherIsBetter: true, name: 'redacted with the right type' },
  { key: 'notPersonal', higherIsBetter: false, name: 'over-redactions' },
];

// The same thresholds for each shape of the generated set's shape block.
const SHAPE_METRICS: readonly {
  key: 'redacted' | 'typed' | 'overRedactions';
  higherIsBetter: boolean;
  name: string;
}[] = [
  { key: 'redacted', higherIsBetter: true, name: 'redacted' },
  { key: 'typed', higherIsBetter: true, name: 'redacted with the right type' },
  { key: 'overRedactions', higherIsBetter: false, name: 'over-redactions' },
];

/** Compares one dataset's fresh score with its stored one. */
export function compare(
  name: string,
  stored: StoredDataset | null,
  current: DatasetScore | undefined,
): Comparison {
  const worse: string[] = [];
  const better: string[] = [];
  const changed: string[] = [];

  if (!stored && !current) return { worse, better, changed };
  if (!stored) return { worse, better: [`${name}: measured for the first time`], changed };
  if (!current) return { worse, better, changed: [`${name}: has a baseline but no cases now`] };

  if (stored.cases !== current.cases || stored.messages !== current.messages) {
    changed.push(
      `${name}: ${stored.cases} cases / ${stored.messages} messages -> ${current.cases} / ${current.messages}`,
    );
  }
  for (const type of PERSONAL_TYPES) {
    const before = rowOf(stored, type);
    const now = current.types[type];
    if (before.values !== now.values) {
      changed.push(`${name} ${type}: ${before.values} values -> ${now.values}`);
      continue;
    }
    for (const { key, higherIsBetter, name: metric } of METRICS) {
      if (before[key] === now[key]) continue;
      const line = `${name} ${type}: ${metric} ${before[key]} -> ${now[key]}`;
      (now[key] > before[key] === higherIsBetter ? better : worse).push(line);
    }
  }
  const empty: ShapeScore = { values: 0, redacted: 0, partial: 0, typed: 0, overRedactions: 0 };
  const shapes = new Set([...Object.keys(stored.shapes ?? {}), ...Object.keys(current.shapes)]);
  for (const shape of shapes) {
    // A shape stored before its typed and over-redaction counts were kept
    // has them as 0.
    const before = { ...empty, ...stored.shapes?.[shape] };
    const now = current.shapes[shape] ?? empty;
    if (before.values !== now.values) {
      changed.push(`${name} shape ${shape}: ${before.values} values -> ${now.values}`);
      continue;
    }
    for (const { key, higherIsBetter, name: metric } of SHAPE_METRICS) {
      if (before[key] === now[key]) continue;
      const line = `${name} shape ${shape}: ${metric} ${before[key]} -> ${now[key]}`;
      (now[key] > before[key] === higherIsBetter ? better : worse).push(line);
    }
  }
  return { worse, better, changed };
}

// The echo counts a threshold is kept on. Restored is the naturalness the
// user gets; every held-back rule, a later mention restored in its first
// form, and a broken round trip are costs.
const ECHO_METRICS: readonly {
  name: string;
  higherIsBetter: boolean;
  of: (score: EchoScore) => number;
}[] = [
  { name: 'restored', higherIsBetter: true, of: (s) => s.restored },
  ...HELD_BACK_RULES.map((rule) => ({
    name: `left by ${rule}`,
    higherIsBetter: false,
    of: (s: EchoScore) => s.heldBack[rule],
  })),
  { name: 'later mentions in their first form', higherIsBetter: false, of: (s) => s.firstForm },
  { name: 'not restored correctly', higherIsBetter: false, of: (s) => s.broken },
];

/**
 * Compares one dataset's echo with its stored one. A part that appears or
 * disappears, or whose message count moved, is a changed dataset: that is
 * also how the measurement's first run is recorded.
 */
export function compareEcho(
  name: string,
  stored: Readonly<Record<string, EchoScore>> | undefined,
  current: Readonly<Record<string, EchoScore>> | undefined,
): Comparison {
  const worse: string[] = [];
  const better: string[] = [];
  const changed: string[] = [];
  const parts = new Set([...Object.keys(stored ?? {}), ...Object.keys(current ?? {})]);
  for (const part of parts) {
    const before = stored?.[part];
    const now = current?.[part];
    if (!before || !now || before.messages !== now.messages) {
      changed.push(
        `${name} echo ${part}: ${before?.messages ?? 0} messages -> ${now?.messages ?? 0}`,
      );
      continue;
    }
    for (const { name: metric, higherIsBetter, of } of ECHO_METRICS) {
      if (of(before) === of(now)) continue;
      const line = `${name} echo ${part}: ${metric} ${of(before)} -> ${of(now)}`;
      (of(now) > of(before) === higherIsBetter ? better : worse).push(line);
    }
  }
  return { worse, better, changed };
}

/**
 * Whether the held-out set is scored in this run. While it is being written
 * it has no baseline and is only linted; it is measured from the moment its
 * author asks for the first measurement, and on every run after that.
 */
export const scoresHeldOut = (previous: Baseline | undefined, firstMeasurement: boolean): boolean =>
  firstMeasurement || (previous?.heldOut ?? null) !== null;

export const merge = (...comparisons: readonly Comparison[]): Comparison => ({
  worse: comparisons.flatMap((c) => c.worse),
  better: comparisons.flatMap((c) => c.better),
  changed: comparisons.flatMap((c) => c.changed),
});

export type Verdict = 'same' | 'better' | 'needs-note';

/** `needs-note` if anything is worse or the dataset changed; else `better` if anything improved. */
export function verdict(comparison: Comparison): Verdict {
  if (comparison.worse.length + comparison.changed.length > 0) return 'needs-note';
  return comparison.better.length > 0 ? 'better' : 'same';
}

const stored = (
  score: DatasetScore,
  echo: Readonly<Record<string, EchoScore>> | undefined,
): StoredDataset => ({
  cases: score.cases,
  messages: score.messages,
  types: score.types,
  ...(Object.keys(score.shapes).length > 0 ? { shapes: score.shapes } : {}),
  ...(echo ? { echo } : {}),
});

export interface Measurement {
  readonly date: string;
  readonly generated: {
    readonly score: DatasetScore;
    readonly seed: number;
    /** By part (`main`, then each shape); absent in a run that does not echo. */
    readonly echo?: Readonly<Record<string, EchoScore>>;
  };
  readonly heldOut: DatasetScore | undefined;
  /** The held-out set's echo, one total. */
  readonly heldOutEcho?: EchoScore;
}

const heldOutEcho = (now: Measurement): Record<string, EchoScore> | undefined =>
  now.heldOutEcho ? { all: now.heldOutEcho } : undefined;

/** How a fresh measurement differs from the baseline (everything is new if there is none). */
export function compareAll(previous: Baseline | undefined, now: Measurement): Comparison {
  if (!previous) return { worse: [], better: ['no baseline yet'], changed: [] };
  const seedChanged =
    previous.generated.seed === now.generated.seed
      ? []
      : [`generated: seed ${previous.generated.seed} -> ${now.generated.seed}`];
  return merge(
    { worse: [], better: [], changed: seedChanged },
    compare('generated', previous.generated, now.generated.score),
    compare('held-out', previous.heldOut, now.heldOut),
    compareEcho('generated', previous.generated.echo, now.generated.echo),
    compareEcho('held-out', previous.heldOut?.echo, heldOutEcho(now)),
  );
}

/**
 * The baseline after accepting `now`. A worse count or a changed dataset is
 * accepted only with a note, which is kept in the history with what changed.
 */
export function nextBaseline(
  previous: Baseline | undefined,
  now: Measurement,
  note: string | undefined,
): Baseline {
  const comparison = compareAll(previous, now);
  const needsNote = verdict(comparison) === 'needs-note';
  if (needsNote && !note?.trim()) {
    throw new Error(
      'the baseline can only move this way with a note naming the decision: --accept "ADR-0xx: why"',
    );
  }
  const history = [...(previous?.history ?? [])];
  if (needsNote) {
    history.push({
      date: now.date,
      note: note!.trim(),
      changes: [...comparison.worse, ...comparison.changed],
    });
  }
  return {
    measuredOn: now.date,
    generated: { ...stored(now.generated.score, now.generated.echo), seed: now.generated.seed },
    heldOut: now.heldOut ? stored(now.heldOut, heldOutEcho(now)) : null,
    history,
  };
}

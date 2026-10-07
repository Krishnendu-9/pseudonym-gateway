// `npm run eval:names` (Phase 6b step 4b): the measured configuration, B+F
// at 0.9 / 0.6, run by the code that ships (the worker thread, NameDetector,
// the request path), checked against what ADR-035 published. The published
// 81.8% and 41 of 45 describe the comparison script's spans; this is what
// shows the gateway's spans are the same spans.
//
// What is compared, all of it exactly (eval/names-baseline.json):
//  - the messages: the first 1,998 generated messages, the set 6a measured
//    (the generated set has grown since; the later messages were never
//    scored for names), by the SHA-256 of their texts;
//  - B's own spans, before any threshold, in 6a's format (`spanHash` in the
//    script's runChild: [start, end, score] per span, scores at full
//    precision);
//  - the names the detector returns, in D0's format (ADR-036: {start, end}
//    per span);
//  - every metric of ADR-035's B+F row.
// Speed and memory are reported, not compared: they belong to the machine.
//
// One baseline per CPU model (Phase 6c, option C1; ADR-036, "Result, the
// GitHub runners"): the same code gives identical spans on some CPUs and
// slightly different ones on another, so each run is compared with the
// baseline of the CPU model it runs on, looked up by the exact model
// string in eval/names-baselines.json. Keyed by CPU model, not by
// instruction set, on purpose: that explanation is a hypothesis from three
// CPUs, and a key built on it could pass a CPU nobody has measured. A CPU
// with no baseline is a new machine: the run passes with a warning, writes
// its result, and its baseline needs a human commit. And every run puts the
// messages through twice (option C3): the two passes must give the same
// hashes, or the run fails, whatever the baseline says.

import { createHash } from 'node:crypto';
import type { Span } from '../../src/detection/normalise.js';
import type { ScoredSpan } from '../../src/detection/names/spans.js';
import type { LabelledCase } from '../types.js';
import type { Metrics } from './measure.js';

export interface NamesBaseline {
  /** The messages measured: how many (from the first), and the SHA-256 of their texts. */
  readonly dataset: { readonly messages: number; readonly sha256: string };
  /** SHA-256 of B's spans (6a's format) and of the names returned (D0's format). */
  readonly spans: { readonly model: string; readonly names: string };
  /** Name detections over all the messages. */
  readonly detections: number;
  readonly metrics: Metrics;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The cases holding exactly the first `messages` messages; throws if a case would be cut. */
export function firstMessages(cases: readonly LabelledCase[], messages: number): LabelledCase[] {
  const out: LabelledCase[] = [];
  let count = 0;
  for (const c of cases) {
    if (count === messages) break;
    out.push(c);
    count += c.messages.length;
  }
  if (count !== messages) {
    throw new Error(`the generated set does not end a case at message ${messages}`);
  }
  return out;
}

export const messageTexts = (cases: readonly LabelledCase[]): string[] =>
  cases.flatMap((c) => c.messages.map((m) => m.text));

export const textsSha256 = (texts: readonly string[]): string => sha256(JSON.stringify(texts));

/** B's spans per message, hashed as 6a hashed them. */
export const modelSpansSha256 = (spans: readonly (readonly ScoredSpan[])[]): string =>
  sha256(JSON.stringify(spans.map((list) => list.map((s) => [s.start, s.end, s.score]))));

/** The names per message, hashed as D0 hashed the joined detections. */
export const nameSpansSha256 = (spans: readonly (readonly Span[])[]): string =>
  sha256(JSON.stringify(spans.map((list) => list.map((s) => ({ start: s.start, end: s.end })))));

/**
 * A value written with its object keys sorted, so that key order never
 * counts as a difference. (The baseline holds no arrays; one would be
 * written as an object of its indices, which still compares exactly.)
 */
function canonical(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    // An object's keys are distinct, so no two compare equal.
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The fields that differ between the baseline and this run, by name; empty when they agree. */
export function differences(baseline: NamesBaseline, measured: NamesBaseline): string[] {
  const fields: [string, (b: NamesBaseline) => unknown][] = [
    ['dataset', (b) => b.dataset],
    ['spans.model', (b) => b.spans.model],
    ['spans.names', (b) => b.spans.names],
    ['detections', (b) => b.detections],
    ...(Object.keys({ ...baseline.metrics, ...measured.metrics }).sort() as (keyof Metrics)[]).map(
      (key): [string, (b: NamesBaseline) => unknown] => [`metrics.${key}`, (b) => b.metrics[key]],
    ),
  ];
  return fields
    .filter(([, read]) => canonical(read(baseline)) !== canonical(read(measured)))
    .map(([name]) => name);
}

/** A CPU model's baseline: the file holding it (in eval/) and where it came from. */
export interface BaselineEntry {
  readonly file: string;
  readonly source: string;
}

/** eval/names-baselines.json: the exact CPU model string → its baseline. */
export type BaselineIndex = Readonly<Record<string, BaselineEntry>>;

const BASELINE_FILE = /^names-baseline[\w.-]*\.json$/u;

/** Reads the index, refusing anything that is not CPU model → { file, source }, file a bare names-baseline*.json name. */
export function parseIndex(value: unknown): BaselineIndex {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('the baseline index is not an object of CPU models');
  }
  for (const [model, entry] of Object.entries(value)) {
    const { file, source } = (entry ?? {}) as Partial<BaselineEntry>;
    if (model.trim() !== model || model === '') {
      throw new Error(`a CPU model in the baseline index is empty or padded: "${model}"`);
    }
    if (typeof file !== 'string' || !BASELINE_FILE.test(file) || typeof source !== 'string') {
      throw new Error(
        `the baseline index entry for "${model}" needs a names-baseline*.json file and a source`,
      );
    }
  }
  return value as BaselineIndex;
}

/**
 * The baseline for the CPU this run is on: the exact model string, only
 * its surrounding whitespace trimmed (no matching by family or instruction
 * set). Undefined for a CPU model never measured.
 */
export const baselineFor = (index: BaselineIndex, cpuModel: string): BaselineEntry | undefined =>
  Object.hasOwn(index, cpuModel.trim()) ? index[cpuModel.trim()] : undefined;

/** What a run decides, and with what exit code. */
export type Outcome =
  | { readonly kind: 'identical' }
  | { readonly kind: 'different'; readonly fields: readonly string[] }
  | { readonly kind: 'new-cpu' }
  | { readonly kind: 'not-repeatable' };

/**
 * The run's outcome: the second pass first (two passes that disagree on
 * either hash make the run worthless, whatever the baseline says), then the
 * CPU's baseline, if it has one.
 */
export function outcome(
  measured: NamesBaseline,
  repeat: NamesBaseline['spans'],
  baseline: NamesBaseline | undefined,
): Outcome {
  if (repeat.model !== measured.spans.model || repeat.names !== measured.spans.names) {
    return { kind: 'not-repeatable' };
  }
  if (!baseline) return { kind: 'new-cpu' };
  const fields = differences(baseline, measured);
  return fields.length === 0 ? { kind: 'identical' } : { kind: 'different', fields };
}

/** 0 for identical and for a new CPU (it passes with a warning); 1 otherwise. */
export const exitCode = (o: Outcome): 0 | 1 =>
  o.kind === 'identical' || o.kind === 'new-cpu' ? 0 : 1;

/** The lines the run ends with. */
export function outcomeLines(o: Outcome, cpuModel: string, entry?: BaselineEntry): string[] {
  switch (o.kind) {
    case 'identical':
      return [
        `Identical to the baseline for ${cpuModel} (eval/${entry!.file}): messages, B's spans, the names, every metric.`,
      ];
    case 'different':
      return [
        `DIFFERENT from the baseline for ${cpuModel} (eval/${entry!.file}): ${o.fields.join(', ')}`,
      ];
    case 'not-repeatable':
      return [
        'NOT REPEATABLE: the two passes over the messages gave different hashes on this CPU, so neither can be compared with a baseline.',
      ];
    case 'new-cpu':
      return [
        `NEW CPU: no baseline for "${cpuModel}". It passes; its results are withheld from this log and written only to names-result.json.`,
        'Before opening names-result.json: write the predicted group for this CPU model into ADR-036 and commit it (the standing step for a new CPU).',
        'Its baseline needs two separate runs on this CPU model that agree (ADR-036), then a human commit: copy "measured" from names-result.json into eval/names-baseline-<cpu>.json and add the CPU model to eval/names-baselines.json.',
      ];
  }
}

/**
 * Whether this run's results stay out of the log: on a CPU model with no
 * baseline, so that the prediction for it (ADR-036's standing step) can be
 * written and committed before anyone sees its hashes, counts or speed.
 * They are still all written to names-result.json.
 */
export const withholdResults = (entry: BaselineEntry | undefined): boolean => entry === undefined;

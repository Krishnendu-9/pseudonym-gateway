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

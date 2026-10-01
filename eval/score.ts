// Scoring: labelled cases against what a detector finds in them.
//
// Two questions, kept apart:
//
//  - Was the value kept from the provider? A value is REDACTED when every
//    one of its characters lies inside some detection, of any type. This is
//    the number the project's promise is about. One character left out is a
//    leak, so that value counts as PARTIAL, not as redacted.
//  - Was it recognised for what it is? A value is TYPED when it is redacted
//    and each of its pieces lies inside one detection of its own type. An
//    Aadhaar caught only by the NUMBER safety net is redacted, not typed.
//
// And for every detection: did it cover a personal value of its own type
// (right type), of another type, or nothing personal at all (an
// over-redaction, which costs the reader nothing in privacy but replaces
// text that was fine to send).
//
// Everything is counted from offsets. No value is read, kept or printed.

import { detect } from '../src/detection/detect.js';
import type { Span } from '../src/detection/normalise.js';
import {
  PERSONAL_TYPES,
  SHAPE_TAG,
  type LabelledCase,
  type PersonalType,
  type TruthPiece,
} from './types.js';

/** What the scorer needs from a detector: typed spans over the text. */
export type Detector = (text: string) => readonly (Span & { readonly type: string })[];

export interface TypeScore {
  /** Personal values labelled with this type. */
  values: number;
  /** Of those: every character inside some detection. */
  redacted: number;
  /** Of the redacted: each piece inside one detection of this type. */
  typed: number;
  /** Some characters inside a detection, some not. */
  partial: number;
  /** No character inside any detection. */
  missed: number;
  /** Detections of this type. */
  detections: number;
  /** Of those: covering (part of) a personal value of this type. */
  rightType: number;
  /** Covering personal values of other types only. */
  otherPersonal: number;
  /** Covering nothing personal: an over-redaction. */
  notPersonal: number;
}

/** The shape of the cases that carry no shape tag. */
export const MAIN_SHAPE = 'main';

/** The privacy side of a TypeScore, for the values written one way (a shape). */
export interface ShapeScore {
  values: number;
  redacted: number;
  partial: number;
}

export interface DatasetScore {
  readonly cases: number;
  readonly messages: number;
  readonly types: Readonly<Record<PersonalType, TypeScore>>;
  /**
   * By shape (`main`, `line-break`, `short-id`…), in the order the shapes
   * first appear; only when asked for, and only the generated set asks.
   */
  readonly shapes: Readonly<Record<string, ShapeScore>>;
  /**
   * Over-redactions by what was redacted, then by the detection's type. The
   * first key is `plain text` or the label of a NOT slot (`NOT.order`).
   */
  readonly overRedactions: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

const emptyScore = (): TypeScore => ({
  values: 0,
  redacted: 0,
  typed: 0,
  partial: 0,
  missed: 0,
  detections: 0,
  rightType: 0,
  otherPersonal: 0,
  notPersonal: 0,
});

const isPersonalType = (type: string): type is PersonalType =>
  (PERSONAL_TYPES as readonly string[]).includes(type);

const contains = (span: Span, offset: number): boolean => offset >= span.start && offset < span.end;

/**
 * Scores `cases` against a detector (Pseudonym's own `detect` by default).
 * With `byShape`, also tallies the values of cases tagged `shape:<name>`.
 */
export function score(
  cases: readonly LabelledCase[],
  detector: Detector = detect,
  { byShape = false }: { readonly byShape?: boolean } = {},
): DatasetScore {
  const types = Object.fromEntries(PERSONAL_TYPES.map((t) => [t, emptyScore()])) as Record<
    PersonalType,
    TypeScore
  >;
  const overRedactions: Record<string, Record<string, number>> = {};
  const shapes: Record<string, ShapeScore> = {};
  let messages = 0;

  for (const labelled of cases) {
    // A value's pieces may sit in different messages: gather before judging.
    const values = new Map<
      string,
      { type: PersonalType; required: number; covered: number; typed: boolean }
    >();

    for (const message of labelled.messages) {
      messages++;
      const detections = detector(message.text);

      for (const piece of message.pieces) {
        if (piece.type === 'NOT') continue;
        const value = values.get(piece.valueId) ?? {
          type: piece.type,
          required: 0,
          covered: 0,
          typed: true,
        };
        value.required += piece.required.length;
        value.covered += piece.required.filter((at) =>
          detections.some((d) => contains(d, at)),
        ).length;
        value.typed &&= detections.some(
          (d) => d.type === piece.type && piece.required.every((at) => contains(d, at)),
        );
        values.set(piece.valueId, value);
      }

      for (const detection of detections) {
        if (!isPersonalType(detection.type)) continue;
        const row = types[detection.type];
        row.detections++;
        const touched = message.pieces.filter((piece) => touches(detection, piece));
        const personal = touched.filter((piece) => piece.type !== 'NOT');
        if (personal.some((piece) => piece.type === detection.type)) row.rightType++;
        else if (personal.length > 0) row.otherPersonal++;
        else {
          row.notPersonal++;
          const what = touched[0] ? `NOT.${touched[0].label ?? 'unlabelled'}` : 'plain text';
          const byType = (overRedactions[what] ??= {});
          byType[detection.type] = (byType[detection.type] ?? 0) + 1;
        }
      }
    }

    // A case with no shape tag is written the usual way: `main`.
    const tagged = labelled.tags
      .filter((tag) => tag.startsWith(SHAPE_TAG))
      .map((tag) => tag.slice(SHAPE_TAG.length));
    const caseShapes = !byShape ? [] : tagged.length > 0 ? tagged : [MAIN_SHAPE];
    for (const value of values.values()) {
      const row = types[value.type];
      row.values++;
      const redacted = value.covered === value.required;
      const partial = !redacted && value.covered > 0;
      if (redacted) {
        row.redacted++;
        if (value.typed) row.typed++;
      } else if (partial) row.partial++;
      else row.missed++;
      for (const shape of caseShapes) {
        const tally = (shapes[shape] ??= { values: 0, redacted: 0, partial: 0 });
        tally.values++;
        if (redacted) tally.redacted++;
        if (partial) tally.partial++;
      }
    }
  }

  return { cases: cases.length, messages, types, overRedactions, shapes };
}

/** The score of the cases carrying each tag (a case with two tags counts under both). */
export function scoreByTag(
  cases: readonly LabelledCase[],
  detector: Detector = detect,
): Map<string, DatasetScore> {
  const tags = [...new Set(cases.flatMap((c) => c.tags))].sort();
  return new Map(
    tags.map((tag) => [
      tag,
      score(
        cases.filter((c) => c.tags.includes(tag)),
        detector,
      ),
    ]),
  );
}

// A detection touches a personal piece through the value's own characters,
// and a NOT piece anywhere in its stretch.
function touches(detection: Span, piece: TruthPiece): boolean {
  if (piece.type === 'NOT') return detection.start < piece.end && piece.start < detection.end;
  return piece.required.some((at) => contains(detection, at));
}

/** `part / whole` as a percentage cut (never rounded up) to one decimal; `-` for 0/0. */
export function percent(part: number, whole: number): string {
  if (whole === 0) return '-';
  return `${(Math.floor((part * 1000) / whole) / 10).toFixed(1)}%`;
}

/** Typed precision, recall and F1 of one row, as fractions (undefined for 0/0). */
export function prf(row: TypeScore): {
  precision: number | undefined;
  recall: number | undefined;
  f1: number | undefined;
} {
  const precision = row.detections === 0 ? undefined : row.rightType / row.detections;
  const recall = row.values === 0 ? undefined : row.typed / row.values;
  const f1 =
    precision === undefined || recall === undefined || precision + recall === 0
      ? undefined
      : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

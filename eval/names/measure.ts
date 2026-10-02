// The comparison's metrics (ADR-035), computed with the evaluation's own
// scorer from offsets only: a candidate's detections are scored as PERSON
// detections on their own, without detect().

import type { Span } from '../../src/detection/normalise.js';
import { score, scoreByTag, type Detector } from '../score.js';
import { SHAPE_TAG, type LabelledCase } from '../types.js';

export const NAMES_SHAPE = `${SHAPE_TAG}names`;
/** The tag groups the names block is reported by; the first two are judged. */
export const ROW_GROUPS = [
  'name-lang:',
  'name-script:',
  'name-region:',
  'name-form:',
  'name-place:',
] as const;
export const JUDGED_GROUPS: readonly string[] = ['name-lang:', 'name-script:'];

export interface Count {
  readonly hit: number;
  readonly of: number;
}

export interface Metrics {
  /** PERSON values of the names block redacted. */
  readonly recall: Count;
  /** The same, per tag of ROW_GROUPS. */
  readonly rows: Readonly<Record<string, Count>>;
  /** PERSON values of the main cases redacted (their 12 × 9 names). */
  readonly main: Count;
  /** Detections covering a PERSON value, of all detections. */
  readonly precision: Count;
  /** Detections touching no labelled value and no NOT slot. */
  readonly plainText: number;
  /** Words in the scored messages. */
  readonly words: number;
  /** Over-redactions by lookalike kind (`NOT.month`…). */
  readonly lookalikes: Readonly<Record<string, number>>;
}

/** Plain-text over-redactions per 1,000 words. */
export const fpPer1000 = (m: Metrics): number =>
  m.words === 0 ? 0 : (m.plainText * 1000) / m.words;

/** The share a count is, 0 for 0 of 0. */
export const share = (c: Count): number => (c.of === 0 ? 0 : c.hit / c.of);

const WORD = /\S+/g;
export const wordsIn = (cases: readonly LabelledCase[]): number =>
  cases.reduce(
    (n, c) => n + c.messages.reduce((m, msg) => m + (msg.text.match(WORD)?.length ?? 0), 0),
    0,
  );

const isNames = (c: LabelledCase): boolean => c.tags.includes(NAMES_SHAPE);
const isMain = (c: LabelledCase): boolean => !c.tags.some((t) => t.startsWith(SHAPE_TAG));

/**
 * Scores a candidate's detections (`find`, from a message's text) on
 * `cases`. Values outside the names block and the main cases (the other
 * shapes) count only towards precision and over-redactions.
 */
export function measure(
  cases: readonly LabelledCase[],
  find: (text: string) => readonly Span[],
): Metrics {
  const detector: Detector = (text) => find(text).map((s) => ({ ...s, type: 'PERSON' }));
  const names = cases.filter(isNames);
  const all = score(cases, detector);
  const block = score(names, detector).types.PERSON;
  const main = score(cases.filter(isMain), detector).types.PERSON;
  const rows: Record<string, Count> = {};
  for (const [tag, tagScore] of scoreByTag(names, detector)) {
    if (ROW_GROUPS.some((group) => tag.startsWith(group))) {
      rows[tag] = { hit: tagScore.types.PERSON.redacted, of: tagScore.types.PERSON.values };
    }
  }
  const lookalikes: Record<string, number> = {};
  for (const [what, byType] of Object.entries(all.overRedactions)) {
    // Every detection here is a PERSON one, so a row exists only with a PERSON count.
    if (what !== 'plain text') lookalikes[what] = byType.PERSON!;
  }
  return {
    recall: { hit: block.redacted, of: block.values },
    rows,
    main: { hit: main.redacted, of: main.values },
    precision: { hit: all.types.PERSON.rightType, of: all.types.PERSON.detections },
    plainText: all.overRedactions['plain text']?.PERSON ?? 0,
    words: wordsIn(cases),
    lookalikes,
  };
}

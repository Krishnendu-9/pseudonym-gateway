// Labelled text for the evaluation (Phase 5): messages in which the place of
// every personal value is known, so detect()'s output can be scored.
//
// Both datasets end up in this shape: the generated one (generate.ts) and
// the held-out one kept in a file (held-out.txt, through format.ts, lint.ts and
// render.ts). Like a Detection, a label says where a value is, never what it
// is (ADR-009): scoring and reports work on offsets and counts only.

/**
 * What a labelled value is. The first ten are detected today; PERSON gets a
 * detector in Phase 6, and PASSPORT, VOTER (a voter ID, EPIC) and DOB (a
 * date of birth) in Phase 5c. Each is labelled before its detector exists,
 * so that "before" is measured too.
 */
export const PERSONAL_TYPES = [
  'AADHAAR',
  'CARD',
  'PAN',
  'PHONE',
  'EMAIL',
  'NUMBER',
  'IFSC',
  'UPI',
  'IP',
  'SECRET',
  'PERSON',
  'PASSPORT',
  'VOTER',
  'DOB',
] as const;

export type PersonalType = (typeof PERSONAL_TYPES)[number];

/**
 * Tags of the generated set's shape block (Phase 5c) start with this:
 * `shape:line-break`. Only the generated set is scored by shape; a held-out
 * case's tags are its author's text and are never reported.
 */
export const SHAPE_TAG = 'shape:';

/** NOT marks text that looks like a value but is not personal (an order number, a version). */
export type TruthType = PersonalType | 'NOT';

export type Role = 'system' | 'user' | 'assistant';

/**
 * One stretch of a labelled value in a message. A value usually has one
 * piece; one written across a line break or two messages has several, with
 * the same `valueId`.
 */
export interface TruthPiece {
  /** Unique in a dataset: the case id, `#`, and a counter. */
  readonly valueId: string;
  readonly type: TruthType;
  /** The slot's variant (`amex`, `unknown`, `order`…) or `typo`, if any. */
  readonly label?: string;
  /** The whole stretch, separators and fixed text such as `+91` included. */
  readonly start: number;
  readonly end: number;
  /**
   * Offsets of the characters that are the value itself (UTF-16 units). All
   * of them must be inside a detection for the value to count as redacted;
   * separators between digit groups need not be.
   */
  readonly required: readonly number[];
}

export interface LabelledMessage {
  readonly role: Role;
  readonly text: string;
  /** In text order, never overlapping. */
  readonly pieces: readonly TruthPiece[];
}

export interface LabelledCase {
  readonly id: string;
  readonly tags: readonly string[];
  readonly messages: readonly LabelledMessage[];
}

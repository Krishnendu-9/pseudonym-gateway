// The held-out adversarial set: where it lives, how it is loaded, and what
// may be said about it.
//
// eval/held-out.txt is written by hand by someone who did not write the
// detectors, before the Phase 5 detectors exist, and is never used for
// tuning (ADR-021). This code reads it; the detectors' author does not. So
// everything here reports counts, case ids, line numbers and rule names,
// and never a line of the file.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Problem, RawCase } from './format.js';
import { checkCaseFile, loadCases } from './render.js';
import { parseSegments } from './slots.js';
import type { LabelledCase, LabelledMessage } from './types.js';

export const HELD_OUT_PATH = join(import.meta.dirname, 'held-out.txt');

/** Fixed, so the set renders to the same text on every run. */
export const HELD_OUT_SEED = 20_261_001;

export interface CaseFileSummary {
  readonly cases: number;
  readonly messages: number;
  /** Slots by type (continuations counted with the value they continue, once). */
  readonly values: Readonly<Record<string, number>>;
  readonly tags: Readonly<Record<string, number>>;
}

const tally = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

/** Counts only: how many cases, messages, values of each type, and cases per tag. */
export function summarise(cases: readonly RawCase[]): CaseFileSummary {
  const values: Record<string, number> = {};
  const tags: Record<string, number> = {};
  let messages = 0;
  for (const raw of cases) {
    for (const tag of raw.tags) tally(tags, tag);
    for (const message of raw.messages) {
      messages++;
      for (const segment of parseSegments(message.text)) {
        if (segment.kind === 'slot' && segment.slot.type !== undefined) {
          tally(values, segment.slot.type);
        }
      }
    }
  }
  return { cases: cases.length, messages, values, tags };
}

/**
 * A rendered message with every character of a value replaced by "•": the
 * layout an author wants to check, without the generated value.
 */
export function maskedText(message: LabelledMessage): string {
  const hidden = new Set(message.pieces.flatMap((piece) => piece.required));
  let out = '';
  for (let i = 0; i < message.text.length; i++) {
    if (!hidden.has(i)) {
      out += message.text[i];
      continue;
    }
    out += '•';
    // A character outside the BMP is two units and one mark.
    const unit = message.text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) i++;
  }
  return out;
}

/** The file's cases and every problem in them, without rendering anything. */
export function checkHeldOut(path = HELD_OUT_PATH): { cases: RawCase[]; problems: Problem[] } {
  return checkCaseFile(readFileSync(path, 'utf8'));
}

/** The held-out set, rendered. Throws CaseFileError if the file has any problem. */
export function loadHeldOut(path = HELD_OUT_PATH): LabelledCase[] {
  return loadCases(readFileSync(path, 'utf8'), HELD_OUT_SEED);
}

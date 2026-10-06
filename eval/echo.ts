// The echo measurement (Phase 5d, ADR-033): what restoration does to an
// answer that repeats the redacted messages back unchanged, the best case a
// model can give it. Deterministic, so it runs in CI with the rest.
//
// For every message: redact the case's messages in order with one mapping
// (as a request is redacted), then restore each redacted message as if the
// model had echoed it, counting with `restore`'s counter. Two questions:
//
//  - How many of Pseudonym's placeholders stay placeholders, and which rule
//    held each one back (a URL, a markdown destination, "[label]:", an HTML
//    attribute value, an unclosed `<` or `="`, the host rule). Every
//    placeholder must be either restored or held by a named rule.
//  - Does everything else come back exactly? Restoring with the safety
//    rules off must give the original message, except that a value written
//    again in another form ("PRIYA@EXAMPLE.COM" after "priya@example.com")
//    comes back as it was first written (ADR-013). Such a message is
//    counted apart when the restored text is the redacted one with every
//    placeholder replaced by its value, and the original is the same with
//    only later mentions written differently. Anything else is a bug.
//
// Counts only: no text, no case id, and the held-out set as one total.

import { PlaceholderMapping } from '../src/redaction/mapping.js';
import { redactMessage } from '../src/redaction/redact.js';
import {
  emptyRestoreCounts,
  HELD_BACK_RULES,
  restore,
  type HeldBackRule,
  type RestoreCounts,
} from '../src/redaction/restore.js';
import { ALL_NAMESPACES, bracketPattern } from '../src/redaction/variants.js';
import type { PlaceholderNamespace } from '../src/redaction/placeholder.js';
import { SHAPE_TAG, type LabelledCase } from './types.js';

export interface EchoScore {
  readonly messages: number;
  /** Pseudonym's own placeholders in the redacted messages. */
  readonly placeholders: number;
  readonly restored: number;
  /** Placeholders left as they are, by the rule that held them; and
   * `bare-space`, `Type N` text never restored (in an echo, the user's own
   * words). */
  readonly heldBack: Readonly<Record<HeldBackRule, number>>;
  /** Messages that come back exactly, with the safety rules off. */
  readonly exact: number;
  /** Messages that come back exactly except for a later mention of a value
   * written another way, restored as first written (ADR-013). */
  readonly firstForm: number;
  /** Messages that do neither, or whose placeholders do not add up. */
  readonly broken: number;
}

export type Restorer = typeof restore;
export type Redactor = typeof redactMessage;

const PLACEHOLDER = bracketPattern(ALL_NAMESPACES);

/** One stretch of a redacted message that is a placeholder, and what it must restore to. */
export interface Slot {
  readonly start: number;
  readonly end: number;
  /** What the placeholder restores to. */
  readonly value: string;
  /** Its first mention in the case: the original has its value there. A
   * later mention may have been written any other way. */
  readonly first: boolean;
}

/** `redacted` with every slot replaced by its value. */
export function filled(redacted: string, slots: readonly Slot[]): string {
  let out = '';
  let cursor = 0;
  for (const slot of slots) {
    out += redacted.slice(cursor, slot.start) + slot.value;
    cursor = slot.end;
  }
  return out + redacted.slice(cursor);
}

/**
 * Whether `original` is `redacted` with each slot replaced: a first
 * mention by its value, a later one by any non-empty text. Every way of splitting the
 * original is tried at once (a set of positions), so the answer never
 * depends on which way a free slot was read.
 */
export function restoresWithLaterForms(
  original: string,
  redacted: string,
  slots: readonly Slot[],
): boolean {
  let at = new Set([0]);
  const literal = (text: string): void => {
    const next = new Set<number>();
    for (const p of at) if (original.startsWith(text, p)) next.add(p + text.length);
    at = next;
  };
  let cursor = 0;
  for (const slot of slots) {
    literal(redacted.slice(cursor, slot.start));
    if (slot.first) literal(slot.value);
    else {
      const from = Math.min(...at);
      const next = new Set<number>();
      for (let p = from + 1; p <= original.length; p++) next.add(p);
      at = next;
    }
    cursor = slot.end;
  }
  literal(redacted.slice(cursor));
  return at.has(original.length);
}

const heldTotal = (counts: RestoreCounts): number =>
  HELD_BACK_RULES.filter((rule) => rule !== 'bare-space').reduce((n, rule) => n + counts[rule], 0);

/** Echoes every message of `cases` (see above). The options are for tests. */
export function echo(
  cases: readonly LabelledCase[],
  {
    restorer = restore,
    redactor = redactMessage,
  }: { readonly restorer?: Restorer; readonly redactor?: Redactor } = {},
): EchoScore {
  const counts = emptyRestoreCounts();
  let messages = 0;
  let placeholders = 0;
  let exact = 0;
  let firstForm = 0;
  let broken = 0;
  for (const labelled of cases) {
    const mapping = new PlaceholderMapping();
    const redacted = labelled.messages.map((message) => redactor(message.text, mapping));
    // Placeholders already mentioned in this case, in the order redaction met them.
    const seen = new Set<string>();
    labelled.messages.forEach((message, i) => {
      const text = redacted[i]!;
      messages++;
      const slots: Slot[] = [...text.matchAll(PLACEHOLDER)].map((match) => {
        // Every placeholder in a redacted message is one redaction assigned.
        const { value } = mapping.lookup(
          match[1]!.toUpperCase() as PlaceholderNamespace,
          Number(match[2]),
        )!;
        const first = !seen.has(match[0]);
        seen.add(match[0]);
        return { start: match.index, end: match.index + match[0].length, value, first };
      });
      placeholders += slots.length;

      const before = counts.restored + heldTotal(counts);
      const counted = restorer(text, mapping, {}, counts);
      const accounted = counts.restored + heldTotal(counts) - before === slots.length;
      const unchanged = counted === restorer(text, mapping);
      const all = restorer(text, mapping, { restoreInUnsafeRegions: true });
      if (!accounted || !unchanged) broken++;
      else if (all === message.text) exact++;
      else if (all === filled(text, slots) && restoresWithLaterForms(message.text, text, slots)) {
        firstForm++;
      } else broken++;
    });
  }
  const { restored, ...heldBack } = counts;
  return { messages, placeholders, restored, heldBack, exact, firstForm, broken };
}

/**
 * The generated set's cases by part: `main` (no shape tag), then each
 * shape, in order of appearance. The echo and the sent count (ADR-040) use
 * the same parts.
 */
export function casesByPart(cases: readonly LabelledCase[]): Map<string, LabelledCase[]> {
  const parts = new Map<string, LabelledCase[]>();
  for (const labelled of cases) {
    const tag = labelled.tags.find((t) => t.startsWith(SHAPE_TAG));
    const part = tag === undefined ? 'main' : tag.slice(SHAPE_TAG.length);
    const set = parts.get(part) ?? [];
    set.push(labelled);
    parts.set(part, set);
  }
  return parts;
}

/** The generated set's echo by part: `main` (no shape tag), then each shape. */
export function echoByShape(cases: readonly LabelledCase[]): Record<string, EchoScore> {
  return Object.fromEntries([...casesByPart(cases)].map(([part, set]) => [part, echo(set)]));
}

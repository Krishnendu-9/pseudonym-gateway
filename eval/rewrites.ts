// Model rewrites (Phase 5d part 4, ADR-017): what a real model does with
// the placeholders it is sent. The model run itself is
// scripts/measure-rewrites.ts (it needs Ollama, so it is not part of CI);
// this module only classifies an answer and applies the decision rule,
// both fixed in ADR-017 before the first call.
//
// Per value the request carried, in the model's raw answer, the first that
// applies:
//  - restored: the restored answer contains the value;
//  - held: it is restored only with the safety rules off (the model put the
//    placeholder in a URL, a link target or an attribute);
//  - rewritten: the placeholder's tag and index with at most 3 other
//    non-alphanumeric characters between them, in any case (`Email 1`,
//    `[EMAIL_:1]`, `CARD-1`), which restoration's grammar does not read;
//  - dropped: none of those.
// Invented: placeholder-shaped text whose tag and index the mapping does
// not hold.
//
// Works on offsets and model text only; the result holds categories,
// counts, and the placeholder-shaped strings the model wrote, never a
// value.

import type { PlaceholderMapping } from '../src/redaction/mapping.js';
import type { PlaceholderNamespace } from '../src/redaction/placeholder.js';
import { restore } from '../src/redaction/restore.js';
import { ALL_NAMESPACES, BARE_SPACE_NAMESPACES, barePattern } from '../src/redaction/variants.js';

/** One value the request carried, by its placeholder. */
export interface SentValue {
  readonly namespace: PlaceholderNamespace;
  readonly index: number;
}

export type Fate = 'restored' | 'held' | 'rewritten' | 'dropped';

export interface AnswerVerdict {
  /** One per value, in the order given. */
  readonly fates: readonly Fate[];
  /** What each rewritten value was written as (model text, no value). */
  readonly rewrites: readonly string[];
  /** Placeholder-shaped text the mapping does not hold. */
  readonly invented: readonly string[];
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The tag and index of `value` with up to 3 non-alphanumerics between, any case. */
const rewritePattern = ({ namespace, index }: SentValue): RegExp =>
  new RegExp(`(?<![A-Za-z0-9])${escape(namespace)}[^A-Za-z0-9\\n]{0,3}${index}(?![0-9])`, 'giu');

// Any bracketed word and number, and the bare forms restoration reads. A
// bare form inside a bracketed one is part of it (as in restore.ts), so
// `[EMAIL_2]` is one invented placeholder, not two (bug-log 51).
const BRACKETED = /\[([A-Za-z]+)[_ ]([0-9]{1,4})\]/gu;
const BARE: readonly RegExp[] = [
  barePattern(ALL_NAMESPACES, '_'),
  barePattern([...BARE_SPACE_NAMESPACES], ' '),
];

/** All the values a mapping holds outside LITERAL, by namespace then index. */
export function sentValues(mapping: PlaceholderMapping): SentValue[] {
  const values: SentValue[] = [];
  for (const namespace of ALL_NAMESPACES) {
    if (namespace === 'LITERAL') continue;
    for (let index = 1; mapping.lookup(namespace, index); index++)
      values.push({ namespace, index });
  }
  return values;
}

/** Classifies a model's raw `answer` (see above). */
export function classifyAnswer(
  answer: string,
  mapping: PlaceholderMapping,
  values: readonly SentValue[],
): AnswerVerdict {
  const restored = restore(answer, mapping);
  const unguarded = restore(answer, mapping, { restoreInUnsafeRegions: true });
  const rewrites: string[] = [];
  const fates = values.map((sent): Fate => {
    const { value } = mapping.lookup(sent.namespace, sent.index)!;
    if (restored.includes(value)) return 'restored';
    if (unguarded.includes(value)) return 'held';
    const forms = [...answer.matchAll(rewritePattern(sent))].map((match) => match[0]);
    if (forms.length === 0) return 'dropped';
    rewrites.push(...forms);
    return 'rewritten';
  });
  const brackets = [...answer.matchAll(BRACKETED)];
  const insideBracket = (at: number): boolean =>
    brackets.some((b) => at > b.index && at < b.index + b[0].length);
  const shapes = [
    ...brackets,
    ...BARE.flatMap((pattern) => [...answer.matchAll(pattern)]).filter(
      (match) => !insideBracket(match.index),
    ),
  ];
  // Distinct per answer: a made-up placeholder written three times is one.
  const invented = new Set<string>();
  for (const match of shapes) {
    const namespace = match[1]!.toUpperCase() as PlaceholderNamespace;
    if (!mapping.lookup(namespace, Number(match[2]))) invented.add(match[0]);
  }
  return { fates, rewrites, invented: [...invented] };
}

export interface ConditionTotals {
  readonly values: number;
  readonly restored: number;
  readonly held: number;
  readonly rewritten: number;
  readonly dropped: number;
  readonly invented: number;
}

/** Adds up the verdicts of one condition. */
export function totals(verdicts: readonly AnswerVerdict[]): ConditionTotals {
  const fates = verdicts.flatMap((v) => v.fates);
  const count = (fate: Fate): number => fates.filter((f) => f === fate).length;
  return {
    values: fates.length,
    restored: count('restored'),
    held: count('held'),
    rewritten: count('rewritten'),
    dropped: count('dropped'),
    invented: verdicts.reduce((n, v) => n + v.invented.length, 0),
  };
}

/**
 * ADR-017's rule, fixed before measuring: keep the instruction on unless,
 * with it, at least as many values are unrestored (rewritten plus dropped)
 * as without it, or more placeholders are invented.
 */
export function decide(on: ConditionTotals, off: ConditionTotals): 'on' | 'off' {
  const unrestored = (t: ConditionTotals): number => t.rewritten + t.dropped;
  return unrestored(on) >= unrestored(off) || on.invented > off.invented ? 'off' : 'on';
}

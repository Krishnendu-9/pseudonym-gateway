// Slots: how a message in the held-out file (and a template of the generated
// dataset) says "a personal value goes here" without containing one.
//
//   {{AADHAAR}}                       a valid value, generated in memory
//   {{AADHAAR:#### ####\n####}}       the same, laid out by a mask: each #
//                                     takes the next character of the value
//   {{AADHAAR!:#### #### ####}}       a value with a typo (fails its check)
//   {{CARD.amex:#### ###### #####}}   a variant of the type
//   {{AADHAAR@a:#### ####}} {{@a:####}}   one value in two pieces
//   {{PAN|lower}}  {{PHONE|devanagari|invisible:+91 ##########}}   modifiers
//   {{EMAIL=priya@example.com}}       a literal the author typed (allowed
//                                     only where it cannot be a real value)
//   {{NOT:ORD-######}}  {{NOT=10.0.0.1}}   looks like a value, is not personal
//
// This module only parses. lint.ts decides what is allowed, render.ts turns
// slots into text and labels. The full rules are in HELD-OUT-FORMAT.md.

import { SECRET_KINDS } from '../src/synthetic/identifiers.js';
import { PERSONAL_TYPES, type TruthType } from './types.js';

export interface Slot {
  /** Missing for a continuation (`{{@a:####}}`). */
  readonly type?: TruthType;
  readonly variant?: string;
  /** `!`: the value fails its check (a typo), but is still personal. */
  readonly typo: boolean;
  /** `@name`: lets later slots continue this value. */
  readonly name?: string;
  readonly modifiers: readonly string[];
  readonly mask?: string;
  readonly literal?: string;
}

export type Segment =
  | { readonly kind: 'text'; readonly text: string; readonly offset: number }
  | { readonly kind: 'slot'; readonly slot: Slot; readonly offset: number; readonly raw: string }
  /** `{{…}}` that is not a slot, or `{{` that is never closed. */
  | { readonly kind: 'broken'; readonly offset: number; readonly raw: string };

const SLOT = /\{\{([\s\S]*?)\}\}/g;
const INNER =
  /^(?:([A-Z]+)(?:\.([a-z0-9-]+))?(!)?)?(?:@([a-z][a-z0-9]*))?((?:\|[a-z]+)*)(?:([:=])([\s\S]*))?$/;

const TYPES: ReadonlySet<string> = new Set([...PERSONAL_TYPES, 'NOT']);

function parseSlot(inner: string): Slot | undefined {
  const m = INNER.exec(inner);
  if (!m) return undefined;
  const [, type, variant, typo, name, modifiers, sign, body] = m;
  if (type === undefined && name === undefined) return undefined;
  if (type !== undefined && !TYPES.has(type)) return undefined;
  return {
    ...(type === undefined ? {} : { type: type as TruthType }),
    ...(variant === undefined ? {} : { variant }),
    typo: typo !== undefined,
    ...(name === undefined ? {} : { name }),
    modifiers: modifiers ? modifiers.slice(1).split('|') : [],
    // After a sign the body always matches, if only as the empty string.
    ...(sign === ':' ? { mask: body! } : {}),
    ...(sign === '=' ? { literal: body! } : {}),
  };
}

/** Splits a message's text into plain text and slots, in order. */
export function parseSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let at = 0;
  const pushText = (end: number): void => {
    if (end <= at) return;
    const plain = text.slice(at, end);
    const open = plain.indexOf('{{');
    if (open < 0) {
      segments.push({ kind: 'text', text: plain, offset: at });
    } else {
      // An opening with no closing: everything from it on is broken.
      if (open > 0) segments.push({ kind: 'text', text: plain.slice(0, open), offset: at });
      segments.push({ kind: 'broken', offset: at + open, raw: plain.slice(open) });
    }
  };
  for (const match of text.matchAll(SLOT)) {
    pushText(match.index);
    const slot = parseSlot(match[1]!);
    segments.push(
      slot
        ? { kind: 'slot', slot, offset: match.index, raw: match[0] }
        : { kind: 'broken', offset: match.index, raw: match[0] },
    );
    at = match.index + match[0].length;
  }
  pushText(text.length);
  return segments;
}

/** What a slot type allows. lint.ts enforces it; render.ts relies on it. */
export interface TypeSpec {
  /** The number of characters in a generated value, if it is fixed. */
  readonly length?: (variant: string | undefined) => number;
  /** Variants the type knows; `any` for free labels (NOT). */
  readonly variants: readonly string[] | 'any';
  readonly variantRequired?: true;
  /** `!` is allowed. */
  readonly typo?: true;
  /** A value can be generated: with a mask (`optional`, `required`) or only whole (`never`). */
  readonly generated?: { readonly mask: 'optional' | 'required' | 'never' };
  /** A literal (`=`) is allowed. */
  readonly literal?: true;
  /** `@name` and continuations are allowed. */
  readonly named?: true;
}

export const TYPE_SPECS: Readonly<Record<TruthType, TypeSpec>> = {
  AADHAAR: {
    length: () => 12,
    variants: [],
    typo: true,
    generated: { mask: 'optional' },
    named: true,
  },
  CARD: {
    length: (variant) => (variant === 'amex' ? 15 : 16),
    variants: ['amex'],
    typo: true,
    generated: { mask: 'optional' },
    literal: true,
    named: true,
  },
  PAN: { length: () => 10, variants: [], typo: true, generated: { mask: 'optional' }, named: true },
  PHONE: {
    length: () => 10,
    variants: [],
    generated: { mask: 'optional' },
    literal: true,
    named: true,
  },
  NUMBER: { variants: [], generated: { mask: 'required' }, named: true },
  EMAIL: { variants: [], generated: { mask: 'never' }, literal: true },
  IFSC: {
    length: () => 11,
    variants: ['unknown'],
    generated: { mask: 'optional' },
    literal: true,
    named: true,
  },
  UPI: { variants: ['mobile', 'unknown'], generated: { mask: 'never' } },
  IP: { variants: [], literal: true },
  SECRET: { variants: SECRET_KINDS, variantRequired: true, generated: { mask: 'never' } },
  PERSON: { variants: [], literal: true },
  NOT: { variants: 'any', generated: { mask: 'required' }, literal: true },
};

/** Characters in a mask that are replaced by generated ones. */
export const maskMarks = (type: TruthType): RegExp => (type === 'NOT' ? /[#?]/g : /#/g);

// Digit zero of each script a `|script` modifier can write a value in.
export const DIGIT_SCRIPTS: Readonly<Record<string, number>> = {
  devanagari: 0x0966,
  bengali: 0x09e6,
  gujarati: 0x0ae6,
  tamil: 0x0be6,
  arabic: 0x0660,
  fullwidth: 0xff10,
  mathbold: 0x1d7ce,
};

export const MODIFIERS: ReadonlySet<string> = new Set([
  ...Object.keys(DIGIT_SCRIPTS),
  'invisible',
  'lower',
  'upper',
]);

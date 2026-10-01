// Turns cases written with slots into labelled text: every slot becomes a
// value generated in memory (or the literal the author typed), and a label
// records where it landed.
//
// Values come from a seed and the case id, so a case always renders the
// same way and editing one case never changes another. Nothing here is
// written to disk or printed (ADR-009).

import {
  aadhaarWithTypo,
  cardWithTypo,
  dateOfBirth,
  ifsc,
  ipAddress,
  panWithTypo,
  passportNumber,
  secret,
  upiId,
  voterId,
  type SecretKind,
  type UpiKind,
} from '../src/synthetic/identifiers.js';
import { INVISIBLES } from '../src/synthetic/obfuscate.js';
import { createRng, type Rng } from '../src/synthetic/rng.js';
import {
  aadhaar,
  cardNumber,
  email,
  indianMobile,
  pan,
  RESERVED_EMAIL_DOMAINS,
} from '../src/synthetic/values.js';
import { parseCases, type Problem, type RawCase } from './format.js';
import { lintCases } from './lint.js';
import { DIGIT_SCRIPTS, parseSegments, SECRET_CONTAINING, type Slot } from './slots.js';
import type { LabelledCase, LabelledMessage, TruthPiece, TruthType } from './types.js';

/** One character of a rendered slot (or an invisible one inserted into it). */
interface Unit {
  readonly text: string;
  /** Part of the value itself, as opposed to a separator or fixed text. */
  readonly required: boolean;
}

/** A value being placed: its label and the characters not placed yet. */
interface Value {
  readonly id: string;
  readonly type: TruthType;
  readonly label: string | undefined;
  readonly modifiers: readonly string[];
  /** The whole value, for the types that are generated in one go. */
  readonly whole: string | undefined;
  /** The next character; for NUMBER and NOT, which have no fixed value, a fresh one. */
  readonly next: (mark: string) => string;
}

const SIXTEEN_DIGIT_NETWORKS = ['visa', 'mastercard', 'discover', 'rupay'] as const;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const NAMES = ['priya', 'rahul', 'meera', 'arjun', 'kavya'] as const;

/** A checked value with more of a longer value around it (EMAIL_CONTAINING, SECRET_CONTAINING). */
function containing(type: 'EMAIL' | 'SECRET', variant: string, rng: Rng): string {
  const address = (local: string): string =>
    `${local}.${rng.pick(NAMES)}@${rng.pick(RESERVED_EMAIL_DOMAINS)}`;
  const tail = (): string => `-x${rng.int(1, 9)}`;
  if (type === 'EMAIL') {
    if (variant === 'pan') return address(pan(rng));
    if (variant === 'ifsc') return address(ifsc(rng));
    return address(indianMobile(rng));
  }
  if (variant === 'ifsc-tail') return ifsc(rng) + tail();
  if (variant === 'ip-tail') return ipAddress(rng, 'v4') + tail();
  return `${rng.pick(NAMES).slice(0, 3)}-${indianMobile(rng)}`;
}

/** The whole value a slot stands for, for the types that have one. */
function generate(slot: Slot, rng: Rng): string | undefined {
  switch (slot.type) {
    case 'AADHAAR':
      return slot.typo ? aadhaarWithTypo(rng) : aadhaar(rng);
    case 'CARD':
      if (slot.typo) return cardWithTypo(rng);
      return cardNumber(rng, slot.variant === 'amex' ? 'amex' : rng.pick(SIXTEEN_DIGIT_NETWORKS));
    case 'PAN':
      return slot.typo ? panWithTypo(rng) : pan(rng);
    case 'PHONE':
      return indianMobile(rng);
    case 'EMAIL':
      return slot.variant === undefined ? email(rng) : containing('EMAIL', slot.variant, rng);
    case 'IFSC':
      return ifsc(rng, slot.variant !== 'unknown');
    case 'UPI':
      return upiId(rng, (slot.variant ?? 'name') as UpiKind);
    case 'SECRET':
      return SECRET_CONTAINING.includes(slot.variant as (typeof SECRET_CONTAINING)[number])
        ? containing('SECRET', slot.variant!, rng)
        : secret(rng, slot.variant as SecretKind);
    case 'PASSPORT':
      return passportNumber(rng);
    case 'VOTER':
      return voterId(rng);
    case 'DOB':
      return dateOfBirth(rng);
    default:
      // NUMBER and NOT are made mark by mark; IP and PERSON are always typed.
      return undefined;
  }
}

function startValue(slot: Slot, id: string, rng: Rng): Value {
  const whole = slot.literal === undefined ? generate(slot, rng) : undefined;
  let at = 0;
  let first = true;
  return {
    id,
    type: slot.type!,
    label: slot.typo ? 'typo' : slot.variant,
    modifiers: slot.modifiers,
    whole,
    next: (mark) => {
      if (whole !== undefined) return whole[at++]!;
      if (mark === '?') return LETTERS[rng.int(0, 25)]!;
      // A number does not start with 0.
      const digit = String(rng.int(first ? 1 : 0, 9));
      first = false;
      return digit;
    },
  };
}

function maskUnits(mask: string, value: Value): Unit[] {
  const isMark = (ch: string): boolean => ch === '#' || (ch === '?' && value.type === 'NOT');
  return [...mask].map((ch) =>
    isMark(ch) ? { text: value.next(ch), required: true } : { text: ch, required: false },
  );
}

const wholeUnits = (text: string): Unit[] =>
  [...text].map((ch) => ({ text: ch, required: !/\s/u.test(ch) }));

function applyModifiers(units: Unit[], modifiers: readonly string[], rng: Rng): Unit[] {
  let out = units;
  for (const modifier of modifiers) {
    const zero = DIGIT_SCRIPTS[modifier];
    if (zero !== undefined) {
      out = out.map((u) =>
        /^[0-9]$/.test(u.text) ? { ...u, text: String.fromCodePoint(zero + Number(u.text)) } : u,
      );
    } else if (modifier === 'lower') {
      out = out.map((u) => ({ ...u, text: u.text.toLowerCase() }));
    } else if (modifier === 'upper') {
      out = out.map((u) => ({ ...u, text: u.text.toUpperCase() }));
    } else if (out.length > 1) {
      // `invisible`: characters a reader cannot see, between (never around)
      // the slot's characters, and at least one of them.
      const forced = rng.int(1, out.length - 1);
      out = out.flatMap((u, i) => {
        const hidden: Unit[] = [];
        if (i === forced) hidden.push({ text: rng.pick(INVISIBLES), required: false });
        while (i > 0 && rng.chance(0.3)) {
          hidden.push({ text: rng.pick(INVISIBLES), required: false });
        }
        return [...hidden, u];
      });
    }
  }
  return out;
}

// FNV-1a: a seed for each case from the dataset seed and the case id.
function caseSeed(seed: number, caseId: string): number {
  let hash = 0x811c9dc5;
  for (const ch of `${seed}:${caseId}`) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Renders one case. The case must have passed lintCases(). */
export function renderCase(raw: RawCase, seed: number): LabelledCase {
  const rng = createRng(caseSeed(seed, raw.id));
  const named = new Map<string, Value>();
  let count = 0;

  const messages: LabelledMessage[] = raw.messages.map((message) => {
    let text = '';
    const pieces: TruthPiece[] = [];
    for (const segment of parseSegments(message.text)) {
      if (segment.kind === 'text') {
        text += segment.text;
        continue;
      }
      if (segment.kind === 'broken') throw new Error('renderCase: the case did not pass the lint');
      const { slot } = segment;

      let value: Value;
      if (slot.type === undefined) {
        const earlier = named.get(slot.name!);
        if (!earlier) throw new Error('renderCase: the case did not pass the lint');
        value = earlier;
      } else {
        value = startValue(slot, `${raw.id}#${++count}`, rng);
        if (slot.name !== undefined) named.set(slot.name, value);
      }

      let units: Unit[];
      if (slot.literal !== undefined) units = wholeUnits(slot.literal);
      else if (slot.mask !== undefined) units = maskUnits(slot.mask, value);
      else if (value.whole !== undefined) units = wholeUnits(value.whole);
      else throw new Error('renderCase: the case did not pass the lint');
      units = applyModifiers(units, value.modifiers, rng);

      const start = text.length;
      const required: number[] = [];
      for (const unit of units) {
        if (unit.required) {
          for (let i = 0; i < unit.text.length; i++) required.push(text.length + i);
        }
        text += unit.text;
      }
      pieces.push({
        valueId: value.id,
        type: value.type,
        ...(value.label === undefined ? {} : { label: value.label }),
        start,
        end: text.length,
        required,
      });
    }
    return { role: message.role, text, pieces };
  });

  return { id: raw.id, tags: raw.tags, messages };
}

/** Thrown when a case file has problems. Its message lists cases, lines and rules, never text. */
export class CaseFileError extends Error {
  constructor(readonly problems: readonly Problem[]) {
    super(
      `${problems.length} problem(s) in the case file: ` +
        problems
          .slice(0, 5)
          .map((p) => `${p.caseId} line ${p.line}: ${p.rule}`)
          .join('; '),
    );
    this.name = 'CaseFileError';
  }
}

/** Every problem in a case file: its format and its slots. */
export function checkCaseFile(source: string): { cases: RawCase[]; problems: Problem[] } {
  const { cases, problems } = parseCases(source);
  return { cases, problems: [...problems, ...lintCases(cases)] };
}

/** Parses, checks and renders a case file. Throws CaseFileError if it has any problem. */
export function loadCases(source: string, seed: number): LabelledCase[] {
  const { cases, problems } = checkCaseFile(source);
  if (problems.length > 0) throw new CaseFileError(problems);
  return cases.map((raw) => renderCase(raw, seed));
}

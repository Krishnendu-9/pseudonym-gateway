// The check every held-out case must pass before it is used.
//
// Two jobs. First, the slots must make sense (known type, a mask with the
// right number of #, a continuation that finishes its value). Second, and
// the reason this exists: nothing the author *typed* may look like a real
// personal value (ADR-009, rule 4). Values are generated in memory from
// slots; a typed one is allowed only where it cannot belong to anybody (a
// reserved email domain, a documentation or private IP range, a fictional
// phone range, a published test card).
//
// The safety rules are structural, written without the detectors, so that
// passing or failing this check tells the author nothing about what the
// detectors would find. Problems name a case, a line and a rule, never the
// text.

import { PUBLISHED_TEST_CARDS } from '../test/fixtures/published-test-cards.js';
import type { Problem, RawCase, RawMessage } from './format.js';
import { maskMarks, MODIFIERS, parseSegments, TYPE_SPECS, type Slot } from './slots.js';
import type { TruthType } from './types.js';

/** A typed stretch of digits may be at most this long. */
export const MAX_TYPED_DIGITS = 8;

// Digits in any script, joined by up to three of: space, dot, hyphen and
// dash, brackets, plus. The same stretch a reader would see as one number.
const DIGIT_STRETCH = /\p{Nd}+(?:[ .\-\u2010-\u2015\u2212()+]{1,3}\p{Nd}+)*/gu;
const PAN_SHAPE = /(?<![\p{L}\p{N}_])[A-Za-z]{5}[0-9]{4}[A-Za-z](?![\p{L}\p{N}_])/u;
const ADDRESS = /[^\s@]@[^\s@]/u;
// The start of a provider key, a JWT or a private-key block.
const SECRET_SHAPE =
  /(?<![A-Za-z0-9])(?:sk-[A-Za-z0-9]|[spr]k_(?:live|test)_|rzp_(?:live|test)_|gh[pousr]_|github_pat_|AKIA[0-9A-Z]|xox[baprs]-|AIza[0-9A-Za-z]|eyJ[A-Za-z0-9])|-----BEGIN/u;

// Reserved for documentation and testing (RFC 2606, RFC 6761): the label
// "example", or a name ending in .test, .invalid or .localhost.
const RESERVED_DOMAIN =
  /(?<![\p{L}\p{N}])example(?![\p{L}\p{N}])|\.(?:test|invalid|localhost)(?![\p{L}\p{N}])/iu;

const PUBLISHED_CARDS: ReadonlySet<string> = new Set(PUBLISHED_TEST_CARDS.map((c) => c.number));

// Ranges reserved for fiction: NANP 555-0100 to 555-0199, Ofcom's drama
// ranges (mobile 07700 900xxx, London 020 7946 0xxx, Leeds 0113 496 0xxx)
// and ACMA's 0491 570 xxx. Matched on the digits alone.
const FICTIONAL_PHONES = [
  /^1?[2-9][0-9]{2}55501[0-9]{2}$/,
  /^(?:44|0)7700900[0-9]{3}$/,
  /^(?:44|0)2079460[0-9]{3}$/,
  /^(?:44|0)1134960[0-9]{3}$/,
  /^(?:61|0)491570[0-9]{3}$/,
];

const digitsOf = (text: string): string => text.replace(/[^0-9]/g, '');
// A letter, or a digit that is not ASCII: a typed number has neither (other
// scripts are written with a modifier, so the check can read the digits).
const NOT_PLAIN_NUMBER = /\p{L}|[^\P{Nd}0-9]/u;

/**
 * True for an IP address nobody can be found at: the documentation ranges
 * (RFC 5737, RFC 3849), private, loopback and link-local ones, and those no
 * single host owns (0/8, multicast and reserved 224-255.x with every
 * netmask, `::`, ff00::/8; ADR-026). An IPv4 address written as IPv6
 * (`::ffff:a.b.c.d`, or after the NAT64 prefix 64:ff9b) is judged by its
 * IPv4 part.
 */
export function isSafeIp(text: string): boolean {
  const v4 = /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    if ([a, b, c, d].some((octet) => octet > 255)) return false;
    return (
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a === 0 ||
      a >= 224
    );
  }
  const v6 = text.toLowerCase();
  const embedded = /^(?:::ffff|64:ff9b:):([0-9.]+)$/.exec(v6);
  if (embedded) return isSafeIp(embedded[1]!);
  if (!/^[0-9a-f:]+$/.test(v6) || v6.split(':').length < 3) return false;
  return (
    v6 === '::1' || v6 === '::' || /^(?:2001:db8:|fe80:|f[cd][0-9a-f]{2}:|ff[0-9a-f]{2}:)/.test(v6)
  );
}

/** Why a literal of this type may not be typed, or undefined if it may. */
function literalProblem(
  type: TruthType,
  literal: string,
): [rule: string, detail: string] | undefined {
  const text = literal.trim();
  switch (type) {
    case 'CARD':
      return PUBLISHED_CARDS.has(digitsOf(text)) && !NOT_PLAIN_NUMBER.test(text)
        ? undefined
        : [
            'card-not-published',
            'a typed card number must be one of the published test cards (test/fixtures); use a mask to generate one',
          ];
    case 'PHONE':
      return FICTIONAL_PHONES.some((range) => range.test(digitsOf(text))) &&
        !NOT_PLAIN_NUMBER.test(text)
        ? undefined
        : [
            'phone-not-fictional',
            'a typed phone number must be in a range reserved for fiction; use a mask to generate an Indian mobile',
          ];
    case 'IP':
      return isSafeIp(text)
        ? undefined
        : [
            'ip-not-reserved',
            'a typed IP address must be in a documentation, private, loopback or link-local range, or be one no single host owns (0.x, 224-255.x, multicast)',
          ];
    case 'EMAIL':
      return RESERVED_DOMAIN.test(text)
        ? undefined
        : [
            'email-not-reserved',
            'a typed email address must use a reserved domain (example.com, example.org, .test, .invalid…)',
          ];
    case 'PERSON':
      return /\p{Nd}|@/u.test(text) ? ['bad-name', 'a name has no digits and no @'] : undefined;
    default:
      return undefined;
  }
}

// Literals checked by their own rule instead of the typed-text rules.
const OWN_RULE: ReadonlySet<TruthType> = new Set(['CARD', 'PHONE', 'IP']);

// Stands in for a slot, or for a generated character, in the text the
// typed-text rules read: not a digit, not a letter, not a separator.
const GENERATED = '\u0001';

function lintMessage(caseId: string, message: RawMessage, values: Map<string, Pending>): Problem[] {
  const problems: Problem[] = [];
  const lineAt = (offset: number): number =>
    message.lines[message.text.slice(0, offset).split('\n').length - 1]!;
  const add = (offset: number, rule: string, detail: string): void => {
    problems.push({ caseId, line: lineAt(offset), rule, detail });
  };

  // What the author typed, with everything generated blanked out, and the
  // offset in the message each character of it came from.
  let typed = '';
  const origin: number[] = [];
  const addTyped = (text: string, offset: number): void => {
    typed += text;
    for (let i = 0; i < text.length; i++) origin.push(offset);
  };

  for (const segment of parseSegments(message.text)) {
    if (segment.kind === 'text') {
      const address = ADDRESS.exec(segment.text);
      if (address) {
        add(
          segment.offset + address.index,
          'address-outside-slot',
          'an email address or UPI ID outside a slot; use {{EMAIL=…}}, {{UPI}} or {{NOT=…}}',
        );
      }
      for (let i = 0; i < segment.text.length; i++) addTyped(segment.text[i]!, segment.offset + i);
      continue;
    }
    if (segment.kind === 'broken') {
      add(segment.offset, 'bad-slot', 'not a slot: check the type name and the {{…}} brackets');
      addTyped(GENERATED, segment.offset);
      continue;
    }
    const before = problems.length;
    const literal = lintSlot(segment.slot, values, (rule, detail) => {
      add(segment.offset, rule, detail);
    });
    // A slot with a problem of its own is not read as typed text as well.
    addTyped(problems.length > before ? GENERATED : literal, segment.offset);
  }

  for (const stretch of typed.matchAll(DIGIT_STRETCH)) {
    if ([...stretch[0].matchAll(/\p{Nd}/gu)].length > MAX_TYPED_DIGITS) {
      add(
        origin[stretch.index]!,
        'typed-digits',
        `more than ${MAX_TYPED_DIGITS} typed digits in a row; write the number as a slot with # (generated) or break it up with #`,
      );
    }
  }
  const pan = PAN_SHAPE.exec(typed);
  if (pan) {
    add(
      origin[pan.index]!,
      'typed-pan',
      'a typed PAN-shaped code; use {{PAN}} or {{NOT:?????####?}}',
    );
  }
  const key = SECRET_SHAPE.exec(typed);
  if (key) {
    add(
      origin[key.index]!,
      'typed-secret',
      'a typed string shaped like a key or token; use {{SECRET.kind}} so it is generated',
    );
  }
  return problems;
}

/** A named value whose characters are not all placed yet. */
interface Pending {
  readonly type: TruthType;
  /** Characters still to place; undefined when the type has no fixed length. */
  remaining: number | undefined;
}

/**
 * Checks one slot. Returns what the typed-text rules should read in its
 * place: its literal or the fixed part of its mask.
 */
function lintSlot(
  slot: Slot,
  values: Map<string, Pending>,
  add: (rule: string, detail: string) => void,
): string {
  const count = (mask: string, type: TruthType): number =>
    [...mask.matchAll(maskMarks(type))].length;
  const fixedPart = (mask: string, type: TruthType): string =>
    mask.replace(maskMarks(type), GENERATED);

  if (slot.type === undefined) {
    const pending = values.get(slot.name!);
    if (!pending) {
      add('unknown-name', 'a continuation of a value that no earlier slot in this case named');
      return GENERATED;
    }
    if (slot.mask === undefined || slot.modifiers.length > 0) {
      add('bad-continuation', 'a continuation is a name and a mask, nothing else: {{@name:####}}');
      return GENERATED;
    }
    const marks = count(slot.mask, pending.type);
    if (marks === 0) add('empty-mask', 'a mask needs at least one # to place');
    if (pending.remaining !== undefined) {
      if (marks > pending.remaining) {
        add('too-many-marks', 'more # than the value has characters left');
      }
      pending.remaining = Math.max(0, pending.remaining - marks);
    }
    return fixedPart(slot.mask, pending.type);
  }

  const { type } = slot;
  const spec = TYPE_SPECS[type];
  if (
    slot.variant !== undefined &&
    spec.variants !== 'any' &&
    !spec.variants.includes(slot.variant)
  ) {
    add('unknown-variant', `${type} has no such variant`);
  }
  if (slot.variant === undefined && spec.variantRequired) {
    add('variant-required', `${type} needs a kind: {{${type}.kind}}`);
  }
  if (slot.typo && (!spec.typo || slot.variant !== undefined || slot.literal !== undefined)) {
    add('typo-not-supported', `"!" works on a generated AADHAAR, CARD or PAN without a variant`);
  }
  if (slot.modifiers.some((m) => !MODIFIERS.has(m))) {
    add('unknown-modifier', 'unknown modifier after "|"');
  }
  if (slot.name !== undefined) {
    if (!spec.named || slot.literal !== undefined) {
      add('name-not-supported', `${type} cannot be continued with @name here`);
    } else if (values.has(slot.name)) {
      add('duplicate-name', 'this @name was already used in this case');
    }
  }

  if (slot.literal !== undefined) {
    if (!spec.literal) {
      add('literal-not-allowed', `${type} is always generated: it cannot be typed with "="`);
      return GENERATED;
    }
    if (slot.literal.trim() === '') {
      add('empty-literal', 'nothing after "="');
      return GENERATED;
    }
    const problem = literalProblem(type, slot.literal);
    if (problem) add(...problem);
    if (type !== 'EMAIL' && /@/.test(slot.literal) && !RESERVED_DOMAIN.test(slot.literal)) {
      add('address-not-reserved', 'a typed address must use a reserved domain (example.com…)');
    }
    return OWN_RULE.has(type) || (type === 'NOT' && isSafeIp(slot.literal.trim()))
      ? GENERATED
      : slot.literal;
  }

  if (!spec.generated) {
    add('literal-required', `${type} must be typed: {{${type}=…}}`);
    return GENERATED;
  }
  if (slot.mask === undefined) {
    if (spec.generated.mask === 'required') {
      add('mask-required', `${type} needs a mask: {{${type}:####}}`);
    }
    if (slot.name !== undefined) values.set(slot.name, { type, remaining: 0 });
    return GENERATED;
  }
  if (spec.generated.mask === 'never') {
    add('mask-not-allowed', `${type} is generated whole: it takes no mask`);
    return GENERATED;
  }
  if (/@/.test(slot.mask)) add('address-in-mask', 'a mask cannot contain @');

  const marks = count(slot.mask, type);
  const length = spec.length?.(slot.variant);
  if (marks === 0) add('empty-mask', 'a mask needs at least one # to place');
  if (length !== undefined) {
    if (marks > length) add('too-many-marks', `more # than a ${type} has characters (${length})`);
    else if (marks < length && slot.name === undefined) {
      add(
        'too-few-marks',
        `a ${type} has ${length} characters; place them all, or name the value (@a) and continue it`,
      );
    }
  }
  if (slot.name !== undefined && spec.named) {
    values.set(slot.name, {
      type,
      remaining: length === undefined ? undefined : Math.max(0, length - marks),
    });
  }
  return fixedPart(slot.mask, type);
}

/** Every problem in the cases, in file order. An empty list means they can be rendered. */
export function lintCases(cases: readonly RawCase[]): Problem[] {
  const problems: Problem[] = [];
  for (const raw of cases) {
    const values = new Map<string, Pending>();
    for (const message of raw.messages) problems.push(...lintMessage(raw.id, message, values));
    for (const pending of values.values()) {
      if (pending.remaining) {
        problems.push({
          caseId: raw.id,
          line: raw.line,
          rule: 'unfinished-value',
          detail: 'a named value has characters left that no continuation places',
        });
      }
    }
  }
  return problems;
}

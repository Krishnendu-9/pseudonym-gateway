// The ADR-039 check for a change to the detection path: nothing the code
// redacted before the change is sent after it, judged on fuzzed text rather
// than on the generated set.
//
// "Before" is a copy of the repository at the commit before the change, made
// as the testing guide describes ("The before-copy for the ADR-039 fuzz
// check"); "after" is this working tree. Both redact the same fuzzed texts,
// and every character of a planted value that the before-code covered and
// the after-code sends is classified (ADR-039 amendment):
//
//  - PLACEHOLDER-DERIVED: every detection that covered it before contained
//    characters of placeholder-shaped text (a literal, ADR-002), and the
//    before-code no longer covers it when exactly those characters are
//    taken out of its reach, by one of two witnesses: filled (each becomes
//    INERT, below) or deleted. The value only passed a rule because
//    placeholder characters were counted as part of it (ADR-039 amendment:
//    never a detection). Keywords outside those detections, including the rest of
//    a placeholder, stay readable to both, so a keyword inside a
//    placeholder that the after-code fails to honour is NOT explained away.
//  - REAL REGRESSION: anything else. One fails the check (exit code 1).
//
// Every run prints how many values each witness explained. If one explains
// none, the rule has collapsed into the other, and the run says so.
// The negative control: run against the code before ADR-038's way-1 fix
// (bug-log 63), and way 1 must fail the check.
//
// Output: counts, seeds, text indices, value types, offsets and the kinds of
// the pieces a text was built from, never text (ADR-009; bug-log 29).
//
// Usage: npx tsx scripts/fuzz-detection-change.ts [--seed N] [--texts N]
//        [--names on|off] [--before <dir>] [--after <dir>] [--show i,j]
// --after defaults to this working tree; the negative control passes a copy
// of the code before the change under test.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Span } from '../src/detection/normalise.js';
import type { NameSpans } from '../src/redaction/redact.js';
import type { PlaceholderMapping } from '../src/redaction/mapping.js';
import type { PlaceholderNamespace } from '../src/redaction/placeholder.js';
import {
  aadhaarWithTypo,
  cardWithTypo,
  dateOfBirth,
  ifsc,
  ipAddress,
  panWithTypo,
  passportNumber,
  personName,
  secret,
  SECRET_KINDS,
  upiId,
  voterId,
} from '../src/synthetic/identifiers.js';
import { INVISIBLES, obfuscate } from '../src/synthetic/obfuscate.js';
import { createRng, type Rng } from '../src/synthetic/rng.js';
import {
  aadhaar,
  cardNumber,
  email,
  groupDigits,
  indianMobile,
  pan,
} from '../src/synthetic/values.js';

// ---------------------------------------------------------------------------
// Arguments

function option(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1]! : fallback;
}
const SEED = Number(option('seed', '39'));
const TEXTS = Number(option('texts', '100000'));
const NAMES_ON = option('names', 'off') === 'on';
const BEFORE_DIR = resolve(option('before', '.head-worktree'));
const AFTER_DIR = resolve(option('after', '.'));
// Texts whose build and spans to print: piece kinds and the fixed pieces
// (separators, keywords, placeholder-shaped text), values as type and offsets.
const SHOW = new Set(option('show', '').split(',').filter(Boolean).map(Number));
// How many real regressions to list, one line per value.
const REAL_LIMIT = Number(option('real-limit', '30'));
// --list: one line for every value whose coverage differs, either way.
const LIST = process.argv.includes('--list');
const listed: string[] = [];

// ---------------------------------------------------------------------------
// The two versions

interface Covered extends Span {
  readonly namespace: string;
}

type Redact = (text: string, mapping: PlaceholderMapping, names?: NameSpans) => string;
type MappingClass = new () => PlaceholderMapping;

// Every getOrAssign call returns a private-use sentinel, so the output says
// exactly which original positions each replaced span held. Spans are
// chosen before the first call, so this changes none of them.
const SENTINEL_BASE = 0xf0000;

// What the filled witness puts in place of a placeholder character: U+2591,
// a symbol no detector reads as part of a value, a keyword or a token, not
// blank, not invisible and unchanged by normalisation (chosen for ADR-038's
// masking, since reversed).
const INERT = String.fromCharCode(0x2591);

function spansOf(
  redact: Redact,
  Mapping: MappingClass,
  text: string,
  names?: readonly Span[],
): Covered[] {
  const calls: { value: string; namespace: string }[] = [];
  class Recording extends Mapping {
    override getOrAssign(namespace: PlaceholderNamespace, key: string, value: string): string {
      super.getOrAssign(namespace, key, value);
      calls.push({ value, namespace });
      return String.fromCodePoint(SENTINEL_BASE + calls.length - 1);
    }
  }
  const out = redact(text, new Recording(), names && { text, spans: names });
  const spans: Covered[] = [];
  let at = 0;
  for (const ch of out) {
    const call = calls[ch.codePointAt(0)! - SENTINEL_BASE];
    const piece = call ? call.value : ch;
    if (text.slice(at, at + piece.length) !== piece) throw new Error('output not aligned');
    if (call) spans.push({ start: at, end: at + piece.length, namespace: call.namespace });
    at += piece.length;
  }
  if (at !== text.length) throw new Error('output not aligned at the end');
  return spans;
}

const load = async (dir: string, rel: string): Promise<Record<string, unknown>> =>
  (await import(pathToFileURL(resolve(dir, rel)).href)) as Record<string, unknown>;
const version = async (dir: string) => ({
  redact: (await load(dir, 'src/redaction/redact.ts')).redactMessage as Redact,
  Mapping: (await load(dir, 'src/redaction/mapping.ts')).PlaceholderMapping as MappingClass,
  detect: (await load(dir, 'src/detection/detect.ts')).detect as (
    text: string,
    names?: readonly Span[],
  ) => Span[],
});
const before = await version(BEFORE_DIR);
const after = await version(AFTER_DIR);

// ---------------------------------------------------------------------------
// Fuzzed text: values, keywords, placeholder-shaped text, separators,
// joiners, combining marks, invisible characters and characters that
// normalisation expands or merges (ADR-039).

const cp = (...codes: number[]): string => String.fromCodePoint(...codes);

function grouped(rng: Rng, digits: string): string {
  const sizes =
    digits.length === 10
      ? rng.pick([[5, 5], [3, 3, 4], [10]])
      : digits.length === 12
        ? [4, 4, 4]
        : digits.length === 16
          ? [4, 4, 4, 4]
          : [digits.length];
  return groupDigits(digits, sizes, rng.pick([' ', '-', '']));
}

// "!" fails its check, "?" is at an unknown bank or handle: found only with a keyword.
const VALUES: readonly (readonly [string, (rng: Rng) => string])[] = [
  ['AADHAAR', (r) => grouped(r, aadhaar(r))],
  ['AADHAAR!', (r) => grouped(r, aadhaarWithTypo(r))],
  ['CARD', (r) => grouped(r, cardNumber(r))],
  ['CARD!', (r) => grouped(r, cardWithTypo(r))],
  ['PAN', (r) => pan(r)],
  ['PAN!', (r) => panWithTypo(r)],
  ['EMAIL', (r) => email(r)],
  ['PHONE', (r) => grouped(r, indianMobile(r).replace(/\D/g, '').slice(-10))],
  ['PHONE+', (r) => indianMobile(r)],
  ['IFSC', (r) => ifsc(r, true)],
  ['IFSC?', (r) => ifsc(r, false)],
  ['UPI', (r) => upiId(r, r.pick(['name', 'mobile', 'mobile-name'] as const))],
  ['UPI?', (r) => upiId(r, 'unknown')],
  ['IP', (r) => ipAddress(r, r.pick(['v4', 'v6', 'private'] as const))],
  ['SECRET', (r) => secret(r, r.pick(SECRET_KINDS))],
  ['PASSPORT', (r) => passportNumber(r)],
  ['VOTER', (r) => voterId(r)],
  ['DOB', (r) => dateOfBirth(r)],
  ['PERSON', (r) => personName(r, r.chance(0.2) ? 'devanagari' : 'latin')],
];

const KEYWORDS = [
  'aadhaar',
  'Aadhaar no',
  'UID',
  'card',
  'card no',
  'a/c',
  'pan',
  'PAN',
  'ifsc',
  'IFSC code',
  'neft',
  'upi',
  'vpa',
  'gpay',
  'phone',
  'mobile',
  'mob',
  'call',
  'ip',
  'IPv6',
  'passport',
  'voter',
  'epic',
  'dob',
  'D.O.B',
  'born',
  'password',
  'password:',
  'token',
  'token:',
  'api_key=',
  'API_KEY =',
  'secret',
  'otp',
  'pin',
  'cvv',
  'DB_PASSWORD=',
  'email',
  'version',
  'build',
  'v',
  cp(0x906, 0x927, 0x93e, 0x930),
  cp(0x92a, 0x93e, 0x938, 0x92a, 0x94b, 0x930, 0x94d, 0x91f),
];

const NAMESPACES = [
  'AADHAAR',
  'CARD',
  'PAN',
  'IFSC',
  'PHONE',
  'UPI',
  'EMAIL',
  'IP',
  'SECRET',
  'PASSPORT',
  'VOTER',
  'DOB',
  'PERSON',
  'NUMBER',
  'LITERAL',
];
const LONG_S = cp(0x17f);

const spelled = (rng: Rng, word: string): string =>
  rng.pick([word, word.toLowerCase(), word[0] + word.slice(1).toLowerCase()]);

const LITERALS: readonly ((rng: Rng) => string)[] = [
  (r) => `[${spelled(r, r.pick(NAMESPACES))}_${r.int(1, 12)}]`,
  (r) => `[${spelled(r, r.pick(NAMESPACES))} ${r.int(1, 12)}]`,
  (r) => `${spelled(r, r.pick(NAMESPACES))}_${r.int(1, 12)}`,
  (r) => `${spelled(r, r.pick(NAMESPACES))} ${r.int(1, 12)}`,
  (r) => `[LITERAL_${r.int(1, 3)}]`,
  (r) => `[${r.pick(NAMESPACES)}_${r.pick(['01', '10000', '0'])}]`,
  (r) => `[${r.pick(NAMESPACES)}_${r.int(1, 9)}`,
  (r) => `${r.pick(NAMESPACES)}_${r.int(1, 9)}]`,
  // The long s, which case-insensitive matching lets stand for "s" (ADR-038).
  (r) =>
    `[${r.pick(['PASSPORT', 'SECRET', 'IFSC', 'PERSON']).replaceAll('S', LONG_S)}_${r.int(1, 9)}]`,
];

const MARKS = [cp(0x301), cp(0x300), cp(0x93c), cp(0x94d), cp(0x308)];
const EXPANDING = [
  cp(0xfb01), // fi ligature
  LONG_S,
  cp(0xff11), // full-width 1
  cp(0x2460), // circled 1
  cp(0x2163), // roman numeral four
  cp(0x2122), // trade mark sign
  cp(0xbd), // vulgar fraction one half
  cp(0x1100, 0x1161), // Hangul jamo that compose
  cp(0x967), // Devanagari 1
  cp(0x1d7ce), // mathematical bold 0
  cp(0xff3b), // full-width [
  cp(0xff3d), // full-width ]
];
const SEPARATORS = [
  ' ',
  ' ',
  ' ',
  '',
  '-',
  '.',
  ':',
  '=',
  '\n',
  ', ',
  ' - ',
  '/',
  '@',
  '_',
  '(',
  ')',
  '\r\n',
  '  ',
];
const WORDS = [
  'please',
  'update',
  'with',
  'the',
  'is',
  'now',
  'was',
  'and',
  'ref',
  'x',
  'Q1',
  '24x7',
  'no.',
];

interface Planted extends Span {
  readonly type: string;
}
interface Fuzzed {
  readonly text: string;
  readonly values: readonly Planted[];
  readonly kinds: readonly string[];
  readonly trace: readonly string[];
  readonly names?: readonly Span[];
}

// A table: rows of cells split by spaces, most rows in one column layout,
// so that the spaced-mobile check compares columns across lines (ADR-027).
// Cells: a spaced 5 + 5 mobile (a planted value), a 5-digit amount, a
// placeholder (whose index digits were a column before masking, ADR-038),
// a short number, a word. Planted values are added to `values`, offset by
// `at`, where the table starts in the text.
const CELLS = ['mobile', 'amount', 'placeholder', 'short', 'word'] as const;

// `cells` gets one entry per row, for --show: a mobile as M@offset, an
// amount as A5, a short number as S and its length, a placeholder or word
// as written.
function table(rng: Rng, at: number, values: Planted[], cells: string[] = []): string {
  const layout = Array.from({ length: rng.int(2, 4) }, () => rng.pick(CELLS));
  const rows = rng.int(2, 4);
  let out = rng.chance(0.3) ? `${rng.pick(['mobile', 'phone', 'amount', 'name'])} list\n` : '';
  for (let r = 0; r < rows; r++) {
    if (r > 0) out += '\n';
    const row: string[] = [];
    for (const [c, planned] of layout.entries()) {
      if (c > 0) out += rng.pick([' ', ' ', '  ']);
      const cell = rng.chance(0.25) ? rng.pick(CELLS) : planned;
      let written: string;
      if (cell === 'mobile') {
        const digits = indianMobile(rng).replace(/\D/g, '').slice(-10);
        written = `${digits.slice(0, 5)} ${digits.slice(5)}`;
        values.push({
          type: 'PHONE',
          start: at + out.length,
          end: at + out.length + written.length,
        });
        row.push(`M@${at + out.length}`);
      } else if (cell === 'amount') {
        written = rng.digits(5);
        row.push('A5');
      } else if (cell === 'short') {
        written = rng.digits(rng.int(1, 4));
        row.push(`S${written.length}`);
      } else {
        written = cell === 'placeholder' ? rng.pick(LITERALS)(rng) : rng.pick(WORDS);
        row.push(JSON.stringify(written));
      }
      out += written;
    }
    cells.push(row.join(' '));
  }
  return out;
}

function fuzzed(rng: Rng): Fuzzed {
  let text = '';
  const values: Planted[] = [];
  const kinds: string[] = [];
  const trace: string[] = [];
  const pieces = rng.int(2, 10);
  for (let i = 0; i < pieces; i++) {
    if (i > 0) {
      const separator = rng.pick(SEPARATORS);
      text += separator;
      trace.push(JSON.stringify(separator));
      if (rng.chance(0.1)) {
        const invisible = rng.pick(INVISIBLES);
        text += invisible;
        trace.push(`U+${invisible.codePointAt(0)!.toString(16)}`);
      }
    }
    const roll = rng.int(0, 104);
    let piece: string;
    let kind: string;
    const cells: string[] = [];
    if (roll >= 100) {
      [kind, piece] = ['TABLE', table(rng, text.length, values, cells)];
    } else if (roll < 34) {
      const [type, make] = rng.pick(VALUES);
      piece = make(rng);
      if (rng.chance(0.08)) piece = obfuscate(piece, rng, 0.15);
      values.push({ type, start: text.length, end: text.length + piece.length });
      kind = `V:${type}`;
    } else if (roll < 50) [kind, piece] = ['KW', rng.pick(KEYWORDS)];
    else if (roll < 70) [kind, piece] = ['LIT', rng.pick(LITERALS)(rng)];
    else if (roll < 76) [kind, piece] = ['MARK', rng.pick(MARKS)];
    else if (roll < 82) [kind, piece] = ['NFKC', rng.pick(EXPANDING)];
    else if (roll < 88) [kind, piece] = ['INV', rng.pick(INVISIBLES)];
    else if (roll < 94) [kind, piece] = ['DIG', rng.digits(rng.int(1, 6))];
    else [kind, piece] = ['W', rng.pick(WORDS)];
    kinds.push(kind);
    trace.push(
      kind.startsWith('V:')
        ? `${kind}@${text.length}-${text.length + piece.length}`
        : ['KW', 'LIT', 'W'].includes(kind)
          ? JSON.stringify(piece)
          : kind === 'DIG'
            ? `DIG${piece.length}`
            : kind === 'TABLE'
              ? `TABLE[${cells.join(' / ')}]`
              : [...piece].map((c) => `U+${c.codePointAt(0)!.toString(16)}`).join('+'),
    );
    text += piece;
  }
  if (!NAMES_ON) return { text, values, kinds, trace };
  // A fake name model, the same for both versions: every planted PERSON,
  // and sometimes a random span, which may cross a literal or a value.
  const names: Span[] = values
    .filter((v) => v.type === 'PERSON')
    .map(({ start, end }) => ({ start, end }));
  if (text.length > 1 && rng.chance(0.3)) {
    const start = rng.int(0, text.length - 1);
    names.push({ start, end: rng.int(start + 1, Math.min(text.length, start + 25)) });
  }
  return { text, values, kinds, trace, names: names.sort((a, b) => a.start - b.start) };
}

// ---------------------------------------------------------------------------
// The check

const SIGNIFICANT = /[\p{L}\p{N}]/u;
const covers = (spans: readonly Span[], at: number): boolean =>
  spans.some((s) => s.start <= at && at < s.end);
const overlaps = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;

// Name spans as redactMessage hands them to detect(): never inside a literal.
function outside(spans: readonly Span[], literals: readonly Span[]): Span[] {
  const pieces: Span[] = [];
  for (const span of spans) {
    let start = span.start;
    for (const literal of literals.filter((l) => overlaps(l, span))) {
      if (literal.start > start) pieces.push({ start, end: literal.start });
      start = Math.max(start, literal.end);
    }
    if (start < span.end) pieces.push({ start, end: span.end });
  }
  return pieces;
}

/** What the two witnesses say about one character the after-code sends. */
interface Verdict {
  /** Filling the placeholder characters with the filler removes the coverage. */
  readonly filled: boolean;
  /** Deleting them removes the coverage. */
  readonly deleted: boolean;
}

/**
 * Why the before-code covered `at`, which the after-code sends; undefined
 * when no witness applies (a real regression). Both witnesses only ever
 * change the placeholder characters inside the detections that covered
 * `at`, so a keyword outside them, the rest of a placeholder included,
 * stays readable to the before-code.
 */
function classify(f: Fuzzed, beforeSpans: readonly Covered[], at: number): Verdict | undefined {
  const literals = beforeSpans.filter((s) => s.namespace === 'LITERAL');
  const names = f.names && outside(f.names, literals);
  const covering = before.detect(f.text, names).filter((d) => d.start <= at && at < d.end);
  if (covering.length === 0) return undefined;
  if (!covering.every((d) => literals.some((l) => overlaps(l, d)))) return undefined;
  const inside = (unit: Span): boolean =>
    covering.some((d) => overlaps(d, unit)) && literals.some((l) => overlaps(l, unit));

  // Witness 1, filled: those characters become the filler, which no rule
  // reads as part of a value, a keyword or a joiner (way 3: a placeholder's
  // digit joined into a number). The before-code still counts the filler
  // towards a secret's length, so this alone misses way 2.
  let filled = '';
  // Witness 2, deleted: those characters are taken out, so they count
  // towards nothing (way 2: a secret long enough only with a placeholder's
  // tail in it). Deleting puts their neighbours side by side, so this alone
  // misses some of way 3.
  let deleted = '';
  const moved: number[] = [];
  for (let i = 0; i < f.text.length;) {
    const ch = String.fromCodePoint(f.text.codePointAt(i)!);
    const unit = { start: i, end: i + ch.length };
    for (let k = unit.start; k < unit.end; k++) moved[k] = deleted.length + (k - unit.start);
    if (inside(unit)) {
      filled += INERT.repeat(ch.length);
    } else {
      filled += ch;
      deleted += ch;
    }
    i = unit.end;
  }
  moved[f.text.length] = deleted.length;
  const movedNames = f.names
    ?.map((n) => ({ start: moved[n.start]!, end: moved[n.end]! }))
    .filter((n) => n.start < n.end);
  const verdict = {
    filled: !covers(spansOf(before.redact, before.Mapping, filled, f.names), at),
    deleted: !covers(spansOf(before.redact, before.Mapping, deleted, movedNames), moved[at]!),
  };
  return verdict.filled || verdict.deleted ? verdict : undefined;
}

const rng = createRng(SEED);
const texts = {
  spansDiffer: 0,
  differ: 0,
  sentNow: 0,
  redactedNow: 0,
  placeholderDerived: 0,
  real: 0,
};
// Values sent now, by what explained every character of them that was sent.
const values = { sentNow: 0, real: 0, byFilled: 0, byDeleted: 0, onlyFilled: 0, onlyDeleted: 0 };
const byType: Record<string, { sentNow: number; redactedNow: number; real: number }> = {};
const realCases: string[] = [];
let planted = 0;

for (let i = 0; i < TEXTS; i++) {
  const f = fuzzed(rng);
  planted += f.values.length;
  const was = spansOf(before.redact, before.Mapping, f.text, f.names);
  const now = spansOf(after.redact, after.Mapping, f.text, f.names);
  const key = (spans: readonly Covered[]): string =>
    spans.map((s) => `${s.namespace}@${s.start}-${s.end}`).join(' ');
  if (key(was) !== key(now)) texts.spansDiffer++;
  if (SHOW.has(i)) {
    const at = (spans: readonly Covered[]): string =>
      spans.map((s) => `${s.namespace}@${s.start}-${s.end}`).join(' ');
    const literals = was.filter((s) => s.namespace === 'LITERAL');
    const raw = before.detect(f.text, f.names && outside(f.names, literals)) as (Span & {
      type: string;
    })[];
    console.log(`--- text ${i}, length ${f.text.length}`);
    console.log(`  built:      ${f.trace.join(' | ')}`);
    console.log(`  before:     ${at(was)}`);
    console.log(`  before raw: ${raw.map((d) => `${d.type}@${d.start}-${d.end}`).join(' ')}`);
    console.log(`  after:      ${at(now)}`);
  }
  let differs = false;
  let sentNow = false;
  let redactedNow = false;
  let realHere = false;
  for (const value of f.values) {
    const row = (byType[value.type] ??= { sentNow: 0, redactedNow: 0, real: 0 });
    let sent = false;
    let redacted = false;
    let real = false;
    let filled = true;
    let deleted = true;
    for (let at = value.start; at < value.end && !real; at++) {
      if (!SIGNIFICANT.test(f.text[at]!)) continue;
      const a = covers(was, at);
      const b = covers(now, at);
      if (a === b) continue;
      differs = true;
      if (b) {
        redacted = true;
        continue;
      }
      sent = true;
      const verdict = classify(f, was, at);
      if (!verdict) {
        real = true;
        if (realCases.length < REAL_LIMIT) {
          realCases.push(
            `text ${i}: ${value.type} at ${value.start}-${value.end}, offset ${at}; pieces ${f.kinds.join(' ')}`,
          );
        }
        continue;
      }
      filled &&= verdict.filled;
      deleted &&= verdict.deleted;
    }
    if (redacted) row.redactedNow++;
    if (LIST && (sent || redacted)) {
      const direction = sent ? (real ? 'sent now, REAL' : 'sent now, placeholder-derived') : '';
      const both = sent && redacted ? '; ' : '';
      listed.push(
        `text ${i}: ${value.type} at ${value.start}-${value.end}: ${direction}${both}${redacted ? 'redacted now' : ''}`,
      );
    }
    if (sent) {
      row.sentNow++;
      values.sentNow++;
      if (real) {
        row.real++;
        values.real++;
      } else {
        if (filled) values.byFilled++;
        if (deleted) values.byDeleted++;
        if (filled && !deleted) values.onlyFilled++;
        if (deleted && !filled) values.onlyDeleted++;
      }
    }
    sentNow ||= sent;
    redactedNow ||= redacted;
    realHere ||= real;
  }
  if (differs) texts.differ++;
  if (redactedNow) texts.redactedNow++;
  if (sentNow) {
    texts.sentNow++;
    if (realHere) texts.real++;
    else texts.placeholderDerived++;
  }
}

const derived = values.sentNow - values.real;
const both = values.byFilled - values.onlyFilled;
// A value whose characters needed different witnesses.
const mixed = derived - (values.byFilled + values.byDeleted - both);
console.log(
  `seed ${SEED}, ${TEXTS} texts, names ${NAMES_ON ? 'on' : 'off'}, ${planted} values planted`,
);
console.log(`texts whose replaced spans differ at all (position or type): ${texts.spansDiffer}`);
console.log(`texts where a value character's coverage differs: ${texts.differ}`);
console.log(`texts with a value character redacted before and sent now: ${texts.sentNow}`);
console.log(`  every such character placeholder-derived: ${texts.placeholderDerived}`);
console.log(`  with a real regression: ${texts.real}`);
console.log(`texts with a value character sent before and redacted now: ${texts.redactedNow}`);
console.log(
  `values sent now: ${values.sentNow}; placeholder-derived ${derived}, real ${values.real}`,
);
console.log(
  `  explained by the filled witness: ${values.byFilled} (only by it: ${values.onlyFilled})`,
);
console.log(
  `  explained by the deleted witness: ${values.byDeleted} (only by it: ${values.onlyDeleted})`,
);
console.log(
  `  explained by both: ${both}; by one witness for some characters, the other for the rest: ${mixed}`,
);
if (derived > 0 && (values.byFilled === 0 || values.byDeleted === 0)) {
  console.log('WARNING: one witness explained nothing; the rule has collapsed into the other');
}
console.log('values by type (sent now / real regressions / redacted now):');
for (const [type, row] of Object.entries(byType).sort()) {
  if (row.sentNow + row.redactedNow > 0) {
    console.log(`  ${type}: ${row.sentNow} / ${row.real} / ${row.redactedNow}`);
  }
}
for (const line of realCases) console.log(`REAL ${line}`);
for (const line of listed) console.log(`DIFF ${line}`);
console.log(texts.real === 0 ? 'CHECK PASSED' : 'CHECK FAILED: real regressions');
process.exitCode = texts.real === 0 ? 0 : 1;

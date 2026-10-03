// Person names through redaction (ADR-037), with a stub finder: the spans
// are given, in the original text's offsets, as the name finder hands them
// over. Option 3: the finder saw the original; toNormalised brings its
// spans into detect()'s space; toOriginal maps them back.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { detect } from '../../../src/detection/detect.js';
import { digitRuns } from '../../../src/detection/digit-runs.js';
import { normalise, type Span } from '../../../src/detection/normalise.js';
import { PlaceholderMapping } from '../../../src/redaction/mapping.js';
import { NameTextMismatchError, redactMessage } from '../../../src/redaction/redact.js';
import { restore } from '../../../src/redaction/restore.js';
import { assertPropertyQuietly } from '../../support/quiet-property.js';

/** `before + name + after`, with the name's span. */
const textWith = (before: string, name: string, after: string): { text: string; span: Span } => ({
  text: before + name + after,
  span: { start: before.length, end: before.length + name.length },
});

/** Redacts `text` with `spans` as its names; checks the round trip too. */
function redactNames(text: string, spans: readonly Span[]): string {
  const mapping = new PlaceholderMapping();
  const redacted = redactMessage(text, mapping, { text, spans });
  expect(restore(redacted, mapping)).toBe(text);
  return redacted;
}

/** The redacted text must be exactly `before[PERSON_1]after`. */
function expectExact(before: string, name: string, after: string, span?: Span): void {
  const { text, span: nameSpan } = textWith(before, name, after);
  expect(redactNames(text, [span ?? nameSpan])).toBe(`${before}[PERSON_1]${after}`);
}

describe('exact output: offsets that normalisation moves (item 6)', () => {
  it('a Devanagari name after a precomposed nukta letter (NFKC makes it two code points)', () => {
    expectExact('\u095Bरा रुकिए, ', 'आशा राव', ' आ रही हैं।');
    expectExact('\u095B ', 'आशा राव', ' है।');
  });

  it('a Devanagari name that holds a precomposed nukta letter itself', () => {
    expectExact('मिलिए ', '\u095Eरहा \u095Bैदी', ' से।');
  });

  it('a full-width name', () => {
    expectExact('Contact ', 'Ｒａｖｉ　Ｋｕｍａｒ', ' today.');
  });

  it('a zero-width space, zero-width joiner, soft hyphen and word joiner inside a name', () => {
    for (const invisible of ['\u200B', '\u200D', '\u00AD', '\u2060']) {
      expectExact('Ask ', `As${invisible}ha Rao`, ' now.');
      expectExact('Ask ', `Asha${invisible} Rao`, ' now.');
      expectExact('Ask ', `Asha ${invisible}Rao`, ' now.');
    }
    expectExact('Ask ', 'A\u200Bs\u200Dh\u00ADa\u2060 Rao', ' now.');
  });

  it('an invisible character at a name edge stays outside, whether the span includes it or not', () => {
    for (const invisible of ['\u200B', '\u200D', '\u00AD', '\u2060', '\uFEFF']) {
      const before = `Ask ${invisible}`;
      const after = `${invisible} now.`;
      expectExact(before, 'Asha Rao', after);
      // The same text, with the span over the invisible characters too.
      expectExact(before, 'Asha Rao', after, {
        start: before.length - 1,
        end: before.length + 'Asha Rao'.length + 1,
      });
    }
  });

  it('a U+FDFA, a ½, a Hangul jamo group, and full-width and Devanagari digits before the name', () => {
    for (const before of ['\uFDFA ', '½ ', 'ㅎㅏ ', '１２３ ', '४५६ ', '\uFDFA½ㅎㅏ１２３४५६ — ']) {
      expectExact(before, 'Asha Rao', ' replied.');
      expectExact(before, 'आशा राव', ' ने कहा।');
    }
  });

  it('all of them at once, before and inside the name', () => {
    expectExact('\uFDFA ½ ㅎㅏ １２ ४५ \u095B ', 'Ａｓｈ\u00ADａ आ\u200Bशा', ' \uFDFA ½.');
  });

  it('two names, one written twice, keep their order and one placeholder each', () => {
    const text = 'Asha Rao met Ravi Iyer; ASHA  RAO left.';
    const spans = [
      { start: 0, end: 8 },
      { start: 13, end: 22 },
      { start: 24, end: 33 },
    ];
    const mapping = new PlaceholderMapping();
    const redacted = redactMessage(text, mapping, { text, spans });
    expect(redacted).toBe('[PERSON_1] met [PERSON_2]; [PERSON_1] left.');
    // One value, so it comes back as first written (ADR-013).
    expect(restore(redacted, mapping)).toBe('Asha Rao met Ravi Iyer; Asha Rao left.');
  });

  it('a part of a name and the whole are two values (Phase 6 decision)', () => {
    const text = 'Asha Rao said Asha would come.';
    const spans = [
      { start: 0, end: 8 },
      { start: 14, end: 18 },
    ];
    expect(redactNames(text, spans)).toBe('[PERSON_1] said [PERSON_2] would come.');
  });
});

describe('names and the other detectors', () => {
  it('a name next to an email: both redacted, each its own type', () => {
    const text = 'Asha Rao <asha@example.com>';
    expect(redactNames(text, [{ start: 0, end: 8 }])).toBe('[PERSON_1] <[EMAIL_1]>');
  });

  it('a name and an email that share U+FDFA once rounded: each keeps its own part (bug-log 59)', () => {
    // U+FDFA becomes 18 letters and spaces. The name, widened to its word,
    // ends in the first of them; the email's local part starts in the last.
    // Both round out to U+FDFA itself, and before the fix the name was
    // dropped whole.
    const text = 'Ashaㅎㅏ\uFDFAasha@example.com';
    expect(detect(text, [{ start: 0, end: 4 }]).map((d) => [d.type, d.start, d.end])).toEqual([
      ['PERSON', 0, 6],
      ['EMAIL', 6, 23],
    ]);
    expect(redactNames(text, [{ start: 0, end: 4 }])).toBe('[PERSON_1][EMAIL_1]');
  });

  it('two other values that share a "½" once rounded: the loser keeps its part, names on or off (bug-log 59)', () => {
    // A published test card, then an email whose local part is the "2" of "½".
    // Names off sent "@example.com" before the fix.
    const text = '4111 1111 1111 1111-½@example.com';
    expect(redactNames(text, [])).toBe('[CARD_1][EMAIL_1]');
    const mapping = new PlaceholderMapping();
    const redacted = redactMessage(text, mapping);
    expect(redacted).toBe('[CARD_1][EMAIL_1]');
    expect(restore(redacted, mapping)).toBe(text);
  });

  it('a name span inside an email loses to the email (PERSON is after EMAIL)', () => {
    const text = 'Write to asha.rao@example.com today.';
    expect(redactNames(text, [{ start: 9, end: 13 }])).toBe('Write to [EMAIL_1] today.');
  });

  it('a name span that reaches into a validated card stops at it: the card keeps its type, whole', () => {
    // A published test card: validated, so the widening does not enter it
    // and the resolver gives the card its own digits.
    const text = 'Asha 4111 1111 1111 1111 now';
    expect(redactNames(text, [{ start: 0, end: 7 }])).toBe('[PERSON_1] [CARD_1] now');
  });

  it('a name span that reaches into an unvalidated number takes the whole number, never part of it', () => {
    // Twelve digits that fail the Aadhaar check: the safety net's, not validated.
    const text = 'Asha 1234 5678 9012 now';
    expect(redactNames(text, [{ start: 0, end: 7 }])).toBe('[PERSON_1] now');
  });

  it('a name next to a validated value it does not touch: each its own type', () => {
    const text = 'Asha Rao 4111 1111 1111 1111';
    expect(redactNames(text, [{ start: 0, end: 8 }])).toBe('[PERSON_1] [CARD_1]');
  });

  it('widening stops at a validated value: a span reaching into a known-format key leaves it a key', () => {
    // Assembled at run time: an AWS-format key, which the secret detector validates.
    const key = 'AK' + 'IA' + 'QWERTYUI23456789';
    const text = `Asha ${key} ok`;
    expect(detect(text, [{ start: 0, end: 7 }]).map((d) => [d.type, d.start, d.end])).toEqual([
      ['PERSON', 0, 4],
      ['SECRET', 5, 25],
    ]);
    expect(redactNames(text, [{ start: 0, end: 7 }])).toBe('[PERSON_1] [SECRET_1] ok');
  });

  it('an unvalidated value is still taken into the name: an IFSC at an unknown bank, accepted by its keyword', () => {
    // Redacted either way; only its type is lost (ADR-037 amendment).
    const text = 'IFSC Asha QQQQ0123456 ok';
    expect(detect(text, [{ start: 5, end: 12 }]).map((d) => [d.type, d.start, d.end])).toEqual([
      ['PERSON', 5, 21],
    ]);
  });

  it('digits glued after letters the model calls a name go with them (bug-log 60)', () => {
    // A passport-shaped value with no keyword: no detector takes it, and a
    // name on its letter alone would leave the seven digits visible.
    const text = 'ID Z1234567 here';
    expect(detect(text).length).toBe(0);
    expect(redactNames(text, [{ start: 3, end: 4 }])).toBe('ID [PERSON_1] here');
  });

  it('a span on part of a word, or on a digit glued to a word, takes the whole token', () => {
    expect(redactNames('Please ask Asharani now.', [{ start: 13, end: 15 }])).toBe(
      'Please ask [PERSON_1] now.',
    );
    expect(redactNames('user asha_rao92 here', [{ start: 14, end: 15 }])).toBe(
      'user [PERSON_1] here',
    );
  });

  it('a name span that contains every value it touches replaces them (ADR-029 containing span)', () => {
    // Nothing is sent either way; the values are typed as the container.
    const card = 'Asha 4111 1111 1111 1111 Rao';
    expect(redactNames(card, [{ start: 0, end: card.length }])).toBe('[PERSON_1]');
    const email = 'Asha Rao-asha@example.com';
    expect(redactNames(email, [{ start: 0, end: email.length }])).toBe('[PERSON_1]');
  });
});

describe('names and literals (ADR-002)', () => {
  it('a name span over a literal is cut around it: the literal keeps its text, the rest is redacted', () => {
    const text = 'Asha [PAN_1] Rao';
    expect(redactNames(text, [{ start: 0, end: text.length }])).toBe(
      '[PERSON_1] [LITERAL_1] [PERSON_2]',
    );
  });

  it('a span over several literals, and one starting or ending inside a literal', () => {
    const text = 'x [PAN_1] Asha, [CARD_2] Rao [AADHAAR_3] y';
    expect(redactNames(text, [{ start: 0, end: text.length }])).toBe(
      // The comma at the cut stays text (ADR-028).
      '[PERSON_1] [LITERAL_1] [PERSON_2], [LITERAL_2] [PERSON_3] [LITERAL_3] [PERSON_4]',
    );
    // A bracketed literal has no glue rule: "[PAN_1]" here is one, and a
    // span starting inside it keeps only the name after it.
    const inside = 'See [PAN_1]Asha';
    expect(redactNames(inside, [{ start: 6, end: inside.length }])).toBe(
      'See [LITERAL_1][PERSON_1]',
    );
    const spaced = 'See [PAN_1] Asha Rao';
    expect(redactNames(spaced, [{ start: 6, end: spaced.length }])).toBe(
      'See [LITERAL_1] [PERSON_1]',
    );
    expect(redactNames(spaced, [{ start: 4, end: 9 }])).toBe('See [LITERAL_1] Asha Rao');
  });

  it('a name typed as a placeholder by the user is a literal, and a real name never takes its index', () => {
    const text = 'I wrote [PERSON_1] and Person_2 for Asha Rao.';
    const mapping = new PlaceholderMapping();
    const redacted = redactMessage(text, mapping, { text, spans: [{ start: 36, end: 44 }] });
    expect(redacted).toBe('I wrote [LITERAL_1] and Person_2 for [PERSON_1].');
    expect(restore('[LITERAL_1] and [PERSON_1]', mapping)).toBe('[PERSON_1] and Asha Rao');
    // "Person_2" reserved index 2: the next real name skips it.
    const next = 'Ravi Iyer';
    expect(redactMessage(next, mapping, { text: next, spans: [{ start: 0, end: 9 }] })).toBe(
      '[PERSON_3]',
    );
  });
});

describe('names off, and the text-identity check', () => {
  it('without names, a [PERSON_N] typed by the user is a literal and comes back byte for byte (option A, ADR-037)', () => {
    const text = 'See [PERSON_1] and [person 2].';
    const mapping = new PlaceholderMapping();
    const redacted = redactMessage(text, mapping);
    expect(redacted).toBe('See [LITERAL_1] and [LITERAL_2].');
    expect(restore(redacted, mapping)).toBe(text);
  });

  it('without names, no name is redacted, and empty name spans change nothing', () => {
    const text = 'Asha Rao wrote to asha@example.com.';
    expect(redactMessage(text, new PlaceholderMapping())).toBe('Asha Rao wrote to [EMAIL_1].');
    expect(redactMessage(text, new PlaceholderMapping(), { text, spans: [] })).toBe(
      'Asha Rao wrote to [EMAIL_1].',
    );
  });

  it('refuses names found in another text, even one that differs only in normalisation', () => {
    const text = 'Asha Rao';
    for (const other of ['Asha Rao ', 'Ａｓｈａ Rao', 'Asha\u200B Rao', '']) {
      expect(() =>
        redactMessage(text, new PlaceholderMapping(), { text: other, spans: [] }),
      ).toThrow(NameTextMismatchError);
    }
  });

  it('a name span of invisible characters only has nothing to hide and is dropped', () => {
    const text = 'a\u200B\u00ADb';
    expect(redactNames(text, [{ start: 1, end: 3 }])).toBe(text);
  });
});

describe('one name written several ways: which form comes back (ADR-013)', () => {
  // Forms of one name that share its value key: case, spacing, full width,
  // a soft hyphen.
  const FORMS: readonly ((name: string) => string)[] = [
    (n) => n,
    (n) => n.toUpperCase(),
    (n) => n.toLowerCase(),
    (n) => n.replace(' ', '  '),
    (n) => n.replace(/[A-Za-z]/gu, (c) => String.fromCodePoint(c.codePointAt(0)! + 0xfee0)),
    (n) => `${n.slice(0, 2)}\u00AD${n.slice(2)}`,
  ];
  const NAMES = ['Asha Rao', 'Ravi Iyer', 'Meena Das'];
  const mention = fc.record({ name: fc.nat(NAMES.length - 1), form: fc.nat(FORMS.length - 1) });
  const request = fc.array(fc.array(mention, { minLength: 1, maxLength: 4 }), {
    minLength: 1,
    maxLength: 4,
  });

  it('every placeholder restores the first form written, a verbatim slice of the request, in every later place', () => {
    assertPropertyQuietly(
      fc.property(request, (texts) => {
        const mapping = new PlaceholderMapping();
        const firstForm = new Map<number, string>();
        const built = texts.map((mentions) => {
          let text = 'Note:';
          const spans: Span[] = [];
          const written: { name: number; start: number; end: number }[] = [];
          for (const m of mentions) {
            text += ' ';
            const form = FORMS[m.form]!(NAMES[m.name]!);
            if (!firstForm.has(m.name)) firstForm.set(m.name, form);
            spans.push({ start: text.length, end: text.length + form.length });
            written.push({ name: m.name, start: text.length, end: text.length + form.length });
            text += form;
          }
          return { text: `${text}.`, spans, written };
        });
        const redacted = built.map(({ text, spans }) =>
          redactMessage(text, mapping, { text, spans }),
        );
        // Each name is one placeholder, numbered by first appearance, and
        // restores to its first form, which is in the request as written.
        const order = [...firstForm.keys()];
        for (const [index, name] of order.entries()) {
          const entry = mapping.lookup('PERSON', index + 1);
          if (entry === undefined || entry.value !== firstForm.get(name)) return false;
          if (!built.some(({ text }) => text.includes(entry.value))) return false;
        }
        if (mapping.lookup('PERSON', order.length + 1) !== undefined) return false;
        // The round trip: every mention comes back in its name's first form.
        return built.every(({ text, written }, i) => {
          let expected = '';
          let cursor = 0;
          for (const w of written) {
            expected += text.slice(cursor, w.start) + firstForm.get(w.name)!;
            cursor = w.end;
          }
          expected += text.slice(cursor);
          return restore(redacted[i]!, mapping) === expected;
        });
      }),
      { numRuns: 500 },
    );
  });
});

describe('bug-log 58, fixed: a value glued to a typed placeholder is cut around it, never dropped', () => {
  // Before the fix each of these was sent with the value in it. Digits are
  // kept short of anything a detector would call a real value.
  it.each([
    ['password: [PAN_1]xyz789!', 'password: [LITERAL_1][SECRET_1]'],
    ['api_key=abc[PAN_1]def123', 'api_key=[SECRET_1][LITERAL_1][SECRET_2]'],
    ['[PAN_1]123456789012', '[LITERAL_1][NUMBER_1]'],
    ['[PAN_1]\u0301asha@example.com', '[LITERAL_1]\u0301[EMAIL_1]'],
  ])('names off: %#', (text, sent) => {
    const mapping = new PlaceholderMapping();
    const redacted = redactMessage(text, mapping);
    expect(redacted).toBe(sent);
    expect(restore(redacted, mapping)).toBe(text);
  });

  it('a name inside such a value is redacted with it; a name next to a literal stays a name', () => {
    const glued = 'password=Asha[PAN_1]x';
    expect(redactNames(glued, [{ start: 9, end: 13 }])).toBe(
      'password=[SECRET_1][LITERAL_1][SECRET_2]',
    );
    const apart = 'Asha[PAN_1] said';
    expect(redactNames(apart, [{ start: 0, end: 4 }])).toBe('[PERSON_1][LITERAL_1] said');
    const marked = '[PAN_1]\u0301Asha Rao';
    expect(redactNames(marked, [{ start: 7, end: marked.length }])).toBe(
      '[LITERAL_1]\u0301[PERSON_1]',
    );
  });
});

// The properties draw text from pieces that move offsets, values other
// detectors claim, and names; the span is anywhere.
const PIECES = [
  'Asha',
  'Rao',
  ' ',
  ', ',
  '-',
  '.',
  '@example.com',
  'aadhaar ',
  '2345',
  ' 6789',
  '4111 1111 1111 1111',
  'आशा',
  '\u095B',
  'ा',
  '\u0301',
  '½',
  '\uFDFA',
  'ㅎㅏ',
  'Ｒａ',
  '１２',
  '४५',
  '😀',
  '\u200B',
  '\u200D',
  '\u00AD',
  '\u2060',
  '\uFEFF',
];

const textAndSpan = fc
  .array(fc.constantFrom(...PIECES), { minLength: 1, maxLength: 24 })
  .map((pieces) => pieces.join(''))
  .chain((text) =>
    fc
      .tuple(fc.nat(text.length - 1), fc.nat(text.length - 1))
      .map(([a, b]) => ({ text, span: { start: Math.min(a, b), end: Math.max(a, b) + 1 } })),
  );

const INVISIBLE = /^\p{Default_Ignorable_Code_Point}$/u;
const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;
const SPACE = /^\p{White_Space}$/u;
const MARK = /^\p{M}$/u;

/** Each code unit's character, a surrogate pair whole. */
function charsAt(text: string): string[] {
  const out: string[] = [];
  for (const ch of text) for (let k = 0; k < ch.length; k++) out.push(ch);
  return out;
}

/**
 * True for a letter or digit, and for a mark on one (its base, skipping
 * other marks and invisible characters): what a value is made of. A mark on
 * an emoji or a bracket is judged with its base, as resolve.ts trims it.
 */
function significantAt(chars: readonly string[], i: number): boolean {
  if (LETTER_OR_DIGIT.test(chars[i]!)) return true;
  if (!MARK.test(chars[i]!)) return false;
  let base = i - 1;
  while (base >= 0 && (MARK.test(chars[base]!) || INVISIBLE.test(chars[base]!))) base--;
  return base >= 0 && LETTER_OR_DIGIT.test(chars[base]!);
}

function covered(text: string, spans: readonly Span[]): boolean[] {
  const marks = new Array<boolean>(text.length).fill(false);
  for (const s of spans) for (let i = s.start; i < s.end; i++) marks[i] = true;
  return marks;
}

/**
 * How far a name's effect may reach: the span grown over every character
 * that is not whitespace on either side, and over the digit runs it then
 * touches (widening, ADR-010; the safety net's joined digits and glued
 * tokens, ADR-011, ADR-029), until nothing more is added.
 */
function reach(text: string, span: Span): Span {
  const n = normalise(text);
  const runs = digitRuns(n.text).map((run) => n.toOriginal(run));
  let { start, end } = span;
  for (let grown = true; grown;) {
    grown = false;
    // Unicode's White_Space, not \s: \s also matches U+FEFF, an invisible
    // character that can sit inside a word.
    while (start > 0 && !SPACE.test(text[start - 1]!)) {
      start--;
      grown = true;
    }
    while (end < text.length && !SPACE.test(text[end]!)) {
      end++;
      grown = true;
    }
    for (const run of runs) {
      if (run.start < end && start < run.end && (run.start < start || run.end > end)) {
        start = Math.min(start, run.start);
        end = Math.max(end, run.end);
        grown = true;
      }
    }
    // Out to whole clusters, by the offset map itself (tested on its own in
    // to-normalised.test.ts): a space followed by a mark is one cluster.
    const inner = n.toNormalised({ start, end });
    const whole = inner && n.toOriginal(inner);
    if (whole && (whole.start < start || whole.end > end)) {
      start = Math.min(start, whole.start);
      end = Math.max(end, whole.end);
      grown = true;
    }
  }
  return { start, end };
}

describe('properties: a stub name span in random mixed text (item 7)', () => {
  it('every visible letter, digit and mark of the span lands inside a detection', () => {
    assertPropertyQuietly(
      fc.property(textAndSpan, ({ text, span }) => {
        const marks = covered(text, detect(text, [span]));
        const chars = charsAt(text);
        for (let i = span.start; i < span.end; i++) {
          if (significantAt(chars, i) && !marks[i]) return false;
        }
        return true;
      }),
      { numRuns: 3_000 },
    );
  });

  it('when no other detection is near, every visible character of the span is inside the one name', () => {
    assertPropertyQuietly(
      fc.property(textAndSpan, ({ text, span }) => {
        const near = reach(text, span);
        const others = detect(text);
        if (others.some((d) => d.start < near.end && near.start < d.end)) return true;
        const found = detect(text, [span]);
        const chars = charsAt(text);
        const visible = [];
        for (let i = span.start; i < span.end; i++) if (!INVISIBLE.test(chars[i]!)) visible.push(i);
        // A span of invisible characters only is P3's: it may still fall
        // inside a cluster, which it then takes whole.
        if (visible.length === 0) return true;
        const names = found.filter((d) => d.type === 'PERSON');
        return (
          names.length === 1 &&
          visible.every((i) => names[0]!.start <= i && i < names[0]!.end) &&
          found.length === others.length + 1
        );
      }),
      { numRuns: 3_000 },
    );
  });

  it('nothing outside its reach changes, and nothing another detector claimed is uncovered', () => {
    assertPropertyQuietly(
      fc.property(textAndSpan, ({ text, span }) => {
        const before = detect(text);
        const after = detect(text, [span]);
        const was = covered(text, before);
        const now = covered(text, after);
        const near = reach(text, span);
        const chars = charsAt(text);
        for (let i = 0; i < text.length; i++) {
          const outside = i < near.start || i >= near.end;
          if (outside && was[i] !== now[i]) return false;
          // Only a separator at a cut between two values may become text (ADR-028).
          if (was[i] && !now[i] && significantAt(chars, i)) return false;
        }
        // Detections outside the reach are exactly as they were.
        const key = (d: { type: string; start: number; end: number }): string =>
          `${d.type}:${d.start}:${d.end}`;
        const far = (d: Span): boolean => d.end <= near.start || d.start >= near.end;
        const farBefore = before.filter(far).map(key);
        const farAfter = after.filter(far).map(key);
        return JSON.stringify(farBefore) === JSON.stringify(farAfter);
      }),
      { numRuns: 3_000 },
    );
  });

  it('through redactMessage, no letter of the span outside a literal reaches the output', () => {
    // The span's own letters are Greek, which nothing else in the text uses.
    const GREEK = /[Ͱ-Ͽ]/u;
    const greekName = fc
      .array(fc.constantFrom('α', 'β', 'γ', ' ', '\u00AD', '[PAN_1]', ' [CARD_2] ', '-'), {
        minLength: 1,
        maxLength: 10,
      })
      .map((p) => p.join(''));
    // Literals glued to values on both sides of the name, and inside it
    // (bug-log 58: such a value is cut around the literal).
    const parts = fc.tuple(
      fc.array(fc.constantFrom(...PIECES, '[PAN_1]', '[LITERAL_1]'), { maxLength: 8 }),
      greekName,
      fc.array(fc.constantFrom(...PIECES, '[PAN_1]'), { maxLength: 8 }),
    );
    assertPropertyQuietly(
      fc.property(parts, ([left, name, right]) => {
        const before = left.join('');
        const after = right.join('');
        const { text, span } = textWith(before, name, after);
        const out = redactMessage(text, new PlaceholderMapping(), { text, spans: [span] });
        return !GREEK.test(out);
      }),
      { numRuns: 3_000 },
    );
  });
});

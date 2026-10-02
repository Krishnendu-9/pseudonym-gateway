import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalise, type NormalisedText, type Span } from '../../../src/detection/normalise.js';
import { INVISIBLES, obfuscate } from '../../../src/synthetic/obfuscate.js';
import { createRng } from '../../../src/synthetic/rng.js';
import { aadhaar, cardNumber, groupDigits } from '../../../src/synthetic/values.js';
import {
  allDecimalDigits,
  decimalDigitValue,
  newerUnicodeBlocks,
} from '../../support/decimal-digits.js';
import { assertPropertyQuietly, seedArb } from '../../support/quiet-property.js';

// The oracle: what normalise(s).text must equal. Whole-string NFKC is easy to
// trust; normalise() works cluster by cluster so it can keep an offset map.
// Digit values come from walking the Unicode data, not from the generated table.
// The one exception: on a Node older than the table, a block this Node has
// never heard of (all ten code points unassigned, checked in
// decimal-digit-zeros.test.ts) is mapped by normalise(), so it is here too.
const digitValue = (d: string): string => {
  const cp = d.codePointAt(0)!;
  if (/\p{Nd}/u.test(d)) return String(decimalDigitValue(cp));
  const zero = newerUnicodeBlocks().find((z) => z <= cp && cp <= z + 9);
  return zero === undefined ? d : String(cp - zero);
};
const reference = (s: string): string =>
  s
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .normalize('NFKC')
    .replace(/\p{Nd}|\p{Cn}/gu, digitValue);

const codePoints = (min: number, max: number) =>
  fc.integer({ min, max }).map((c) => String.fromCodePoint(c));

// Characters that stress normalisation: invisibles, combining marks, Hangul
// jamo (which compose across clusters), compatibility forms that expand,
// Devanagari, every decimal digit in Unicode, emoji sequences, CR LF.
const trickyString = fc.string({
  unit: fc.oneof(
    fc.constantFrom(
      ...INVISIBLES,
      ...['\r', '\n', ' ', ' ', '　', 'a', 'e', '5', '-', '@', '.'],
      ...['́', '̣', '̇', 'ﬁ', '①', '½', 'ﷺ', '؀'],
      ...['\u{1F44D}', '\u{1F3FD}', '\u{1F1EE}', '\u{1F1F3}', '️'],
    ),
    codePoints(0x3131, 0x318e), // Hangul compatibility jamo
    codePoints(0x1100, 0x11ff), // Hangul conjoining jamo
    codePoints(0xffa0, 0xffdc), // half-width Hangul
    codePoints(0x0900, 0x097f), // Devanagari, including digits and vowel signs
    codePoints(0xff10, 0xff5a), // full-width digits and letters
    codePoints(0x1d7ce, 0x1d7ff), // mathematical digits
    fc.constantFrom(...allDecimalDigits()).map((c) => String.fromCodePoint(c)),
  ),
  maxLength: 30,
});

const anyString = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 30 }),
  fc.string({ unit: 'grapheme', maxLength: 30 }),
  fc.string({ unit: 'grapheme-composite', maxLength: 30 }),
  trickyString,
);

const RUNS = { numRuns: 3000 };

/** Consecutive normalised code units that share one source range. */
function groups(n: NormalisedText): { text: string; source: Span }[] {
  const out: { text: string; source: Span }[] = [];
  for (let i = 0; i < n.text.length; i++) {
    const source = n.toOriginal({ start: i, end: i + 1 });
    const last = out.at(-1);
    if (last && last.source.start === source.start && last.source.end === source.end) {
      last.text += n.text[i];
    } else {
      out.push({ text: n.text[i]!, source });
    }
  }
  return out;
}

const onlyInvisible = (s: string): boolean => /^\p{Default_Ignorable_Code_Point}*$/u.test(s);

describe('normalise: properties', () => {
  it('equals whole-string NFKC of the visible text, with every decimal digit as ASCII', () => {
    assertPropertyQuietly(
      fc.property(anyString, (s) => normalise(s).text === reference(s)),
      RUNS,
    );
  });

  it('is idempotent', () => {
    assertPropertyQuietly(
      fc.property(anyString, (s) => {
        const once = normalise(s).text;
        return normalise(once).text === once;
      }),
      RUNS,
    );
  });

  it('maps every character to an ordered, honest source range', () => {
    // Source ranges are in order and do not overlap; anything between them is
    // invisible; and each source range, normalised alone, gives exactly the
    // text that claims to come from it.
    assertPropertyQuietly(
      fc.property(anyString, (s) => {
        let cursor = 0;
        for (const g of groups(normalise(s))) {
          if (g.source.start < cursor || g.source.end <= g.source.start) return false;
          if (!onlyInvisible(s.slice(cursor, g.source.start))) return false;
          if (normalise(s.slice(g.source.start, g.source.end)).text !== g.text) return false;
          cursor = g.source.end;
        }
        return cursor <= s.length && onlyInvisible(s.slice(cursor));
      }),
      RUNS,
    );
  });

  it('finds a disguised Aadhaar or card number and maps it back to the whole disguised span', () => {
    // The value is written with mixed digit styles and invisible characters
    // between its characters. After normalisation it reads as plain ASCII,
    // and replacing the mapped-back span removes every trace of it.
    assertPropertyQuietly(
      fc.property(
        seedArb,
        fc.string({ unit: 'grapheme', maxLength: 20 }),
        fc.string({ unit: 'grapheme', maxLength: 20 }),
        (seed, prefix, suffix) => {
          const rng = createRng(seed);
          const value = rng.chance(0.5)
            ? groupDigits(aadhaar(rng), [4, 4, 4], rng.pick([' ', '-', '']))
            : cardNumber(rng);
          const original = `${prefix} ${obfuscate(value, rng)} ${suffix}`;

          const n = normalise(original);
          const at = normalise(`${prefix} `).text.length;
          if (n.text.slice(at, at + value.length) !== value) return false;

          const span = n.toOriginal({ start: at, end: at + value.length });
          const replaced = original.slice(0, span.start) + '[VALUE_1]' + original.slice(span.end);
          return replaced === `${prefix} [VALUE_1] ${suffix}`;
        },
      ),
      RUNS,
    );
  });
});

describe('normalise: examples', () => {
  // Card numbers here are published test cards (see test/fixtures).
  it('leaves ASCII text unchanged, with an identity map', () => {
    const n = normalise('card 4111 1111 1111 1111.');
    expect(n.text).toBe('card 4111 1111 1111 1111.');
    expect(n.toOriginal({ start: 5, end: 24 })).toEqual({ start: 5, end: 24 });
  });

  it('turns full-width digits into ASCII', () => {
    const original = 'card ４１１１ １１１１ １１１１ １１１１';
    const n = normalise(original);
    expect(n.text).toBe('card 4111 1111 1111 1111');
    expect(n.toOriginal({ start: 5, end: 24 })).toEqual({ start: 5, end: original.length });
  });

  it('turns an ideographic space and a no-break space into plain spaces', () => {
    expect(normalise('4111　1111 1111 1111').text).toBe('4111 1111 1111 1111');
  });

  it('turns Devanagari digits into ASCII', () => {
    expect(normalise('कार्ड ४१११ १११११').text).toBe('कार्ड 4111 11111');
  });

  it.each([
    ['Bengali', 0x09e6],
    ['Gurmukhi', 0x0a66],
    ['Gujarati', 0x0ae6],
    ['Odia', 0x0b66],
    ['Tamil', 0x0be6],
    ['Telugu', 0x0c66],
    ['Kannada', 0x0ce6],
    ['Malayalam', 0x0d66],
    ['Arabic-Indic', 0x0660],
    ['Extended Arabic-Indic (Urdu)', 0x06f0],
    ['Thai', 0x0e50],
    // Unicode 17.0 (Node 22.22.1 and later): mapped on older Nodes too, from
    // the table (bug-log 44).
    ['Tolong Siki (Kurukh)', 0x11de0],
  ])('turns %s digits into ASCII', (_script, zero) => {
    const digits = String.fromCodePoint(...Array.from({ length: 10 }, (_, d) => zero + d));
    expect(normalise(`no. ${digits}.`).text).toBe('no. 0123456789.');
  });

  it('maps a decimal digit outside the BMP (two UTF-16 units) to one ASCII digit', () => {
    // U+104A4 OSMANYA DIGIT FOUR: NFKC leaves it alone; only the digit table maps it.
    const n = normalise('x\u{104A4}1');
    expect(n.text).toBe('x41');
    expect(n.toOriginal({ start: 1, end: 2 })).toEqual({ start: 1, end: 3 });
    expect(n.toOriginal({ start: 2, end: 3 })).toEqual({ start: 3, end: 4 });
  });

  it('maps both sides of two blocks that touch (U+116D9 is a 9, U+116DA a 0)', () => {
    expect(normalise('\u{116D9}\u{116DA}').text).toBe('90');
  });

  it('leaves number characters that are not decimal digits alone', () => {
    // Tamil ௰ (ten) is No, not Nd, and NFKC keeps it; Roman numeral Ⅻ is spelled out.
    expect(normalise('Ⅻ ௰').text).toBe('XII ௰');
  });

  it('turns mathematical digits (two UTF-16 units each) into ASCII and maps both units', () => {
    const n = normalise('x\u{1D7D2}\u{1D7D3}');
    expect(n.text).toBe('x45');
    expect(n.toOriginal({ start: 1, end: 2 })).toEqual({ start: 1, end: 3 });
    expect(n.toOriginal({ start: 2, end: 3 })).toEqual({ start: 3, end: 5 });
  });

  it('removes zero-width characters, and the mapped span covers the ones inside the value', () => {
    const original = '4111​1111‌1111‍1111⁠!';
    const n = normalise(original);
    expect(n.text).toBe('4111111111111111!');
    // Ends after the last digit: the word joiner after the value is not part of it.
    expect(n.toOriginal({ start: 0, end: 16 })).toEqual({ start: 0, end: original.indexOf('⁠') });
  });

  it.each([
    ['soft hyphen', '­'],
    ['byte order mark', '﻿'],
    ['left-to-right mark', '‎'],
    ['right-to-left override', '‮'],
    ['first strong isolate', '⁨'],
    ['variation selector 16', '️'],
    ['tag character', '\u{E0041}'],
  ])('removes a %s', (_name, invisible) => {
    expect(normalise(`41${invisible}11`).text).toBe('4111');
  });

  it('removes a string of nothing but invisible characters entirely', () => {
    expect(normalise('​﻿­').text).toBe('');
  });

  it('maps every unit of an expansion back to the one source character', () => {
    // U+00BD VULGAR FRACTION ONE HALF becomes "1", FRACTION SLASH, "2".
    const n = normalise('a½b');
    expect(n.text).toBe('a1⁄2b');
    for (let i = 1; i <= 3; i++) {
      expect(n.toOriginal({ start: i, end: i + 1 })).toEqual({ start: 1, end: 2 });
    }
  });

  it('widens a span over part of an expansion to the whole original character', () => {
    // U+3231 PARENTHESIZED IDEOGRAPH STOCK becomes "(株)": three units from one character.
    const n = normalise('a㈱b');
    expect(n.text).toBe('a(株)b');
    expect(n.toOriginal({ start: 2, end: 3 })).toEqual({ start: 1, end: 2 }); // "株" alone
    expect(n.toOriginal({ start: 0, end: 2 })).toEqual({ start: 0, end: 2 }); // "a("
    expect(n.toOriginal({ start: 3, end: 5 })).toEqual({ start: 1, end: 3 }); // ")b"
  });

  it('keeps offsets right next to emoji, and never splits a surrogate pair', () => {
    const original = '\u{1F600}4111 1111 1111 1111\u{1F44D}\u{1F3FD}'; // 😀 … 👍🏽
    const n = normalise(original);
    expect(n.text).toBe(original);
    expect(n.toOriginal({ start: 2, end: 21 })).toEqual({ start: 2, end: 21 });
    // A span covering only the high surrogate of 😀 widens to both halves.
    expect(n.toOriginal({ start: 0, end: 1 })).toEqual({ start: 0, end: 2 });
    // A span covering only part of 👍🏽 widens to the whole four-unit cluster.
    expect(n.toOriginal({ start: 22, end: 23 })).toEqual({ start: 21, end: 25 });
  });

  it('maps a digit outside the BMP that becomes one ASCII digit (𝟙 -> 1)', () => {
    const n = normalise('x\u{1D7D9}4111'); // U+1D7D9 MATHEMATICAL DOUBLE-STRUCK DIGIT ONE
    expect(n.text).toBe('x14111');
    expect(n.toOriginal({ start: 1, end: 2 })).toEqual({ start: 1, end: 3 });
    expect(n.toOriginal({ start: 2, end: 6 })).toEqual({ start: 3, end: 7 });
  });

  it('keeps offsets right after an emoji ZWJ sequence, whose joiners are removed', () => {
    const original = '\u{1F468}‍\u{1F469}‍\u{1F467} 4111'; // 👨‍👩‍👧
    const n = normalise(original);
    expect(n.text).toBe('\u{1F468}\u{1F469}\u{1F467} 4111');
    expect(n.toOriginal({ start: 7, end: 11 })).toEqual({ start: 9, end: 13 });
  });

  it('leaves invisible characters at the edges of a value outside its span', () => {
    // Only invisibles between the first and last character are inside. Ones
    // just before or after carry nothing, and leaving them out means two
    // values separated only by an invisible character never claim it twice.
    const original = 'id:​⁠4111​1111­﻿.';
    const n = normalise(original);
    expect(n.text).toBe('id:41111111.');
    expect(n.toOriginal({ start: 3, end: 11 })).toEqual({
      start: original.indexOf('4'),
      end: original.indexOf('­'),
    });
  });

  it('composes a letter and a combining accent, even with a zero-width space between them', () => {
    const n = normalise('Re​́n');
    expect(n.text).toBe('Rén');
    expect(n.toOriginal({ start: 1, end: 2 })).toEqual({ start: 1, end: 4 });
  });

  it('rounds outwards to whole clusters: a digit with a combining mark stays together', () => {
    const n = normalise('45́ ');
    expect(n.toOriginal({ start: 0, end: 2 })).toEqual({ start: 0, end: 3 });
  });

  // Regression guard for bug-log entry 1.
  it('composes Hangul compatibility jamo that sit in separate clusters', () => {
    const n = normalise('ㄱㅏ'); // ㄱ + ㅏ
    expect(n.text).toBe('가'); // 가
    expect(n.toOriginal({ start: 0, end: 1 })).toEqual({ start: 0, end: 2 });
  });

  it('handles the empty string', () => {
    expect(normalise('').text).toBe('');
  });
});

describe('normalise: toOriginal input checks', () => {
  const n = normalise('4111 1111 1111 1111');

  it.each([
    { start: 0, end: 0 },
    { start: 5, end: 4 },
    { start: -1, end: 3 },
    { start: 0, end: 20 },
    { start: 0.5, end: 2 },
  ])('rejects $start..$end', (span) => {
    expect(() => n.toOriginal(span)).toThrow(RangeError);
  });

  it('never puts the text in the error message', () => {
    expect(() => n.toOriginal({ start: 0, end: 99 })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('4111') }),
    );
  });
});

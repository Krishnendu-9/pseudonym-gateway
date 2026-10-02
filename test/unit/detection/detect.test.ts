// End-to-end detection: normalisation, all detectors, context, overlap, and
// offsets mapped back to the original text. Generated values stay in memory
// and assertions compare offsets or booleans (ADR-009).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { detect } from '../../../src/detection/detect.js';
import { isLuhnValid } from '../../../src/detection/luhn.js';
import type { DetectionType } from '../../../src/detection/types.js';
import {
  dateOfBirth,
  ifsc,
  ipAddress,
  passportNumber,
  secret,
  upiId,
  voterId,
} from '../../../src/synthetic/identifiers.js';
import { obfuscate, styleDigits } from '../../../src/synthetic/obfuscate.js';
import { createRng, type Rng } from '../../../src/synthetic/rng.js';
import {
  aadhaar,
  cardNumber,
  email,
  groupDigits,
  indianMobile,
  pan,
} from '../../../src/synthetic/values.js';
import { compose } from '../../support/compose.js';
import { assertPropertyQuietly, seedArb } from '../../support/quiet-property.js';

const rng = createRng(1729);
const spacedAadhaar = (r: Rng): string => groupDigits(aadhaar(r), [4, 4, 4], ' ');

/** Rewrites every ASCII digit with the digit of another script (zero = its code point). */
const inScript = (s: string, zero: number): string =>
  s.replace(/[0-9]/g, (d) => String.fromCodePoint(zero + Number(d)));

describe('detect: mixed messages', () => {
  it('finds every type in one support ticket, in text order', () => {
    const { text, spans } =
      compose`Hi, I'm updating my KYC. Aadhaar ${spacedAadhaar(rng)}, PAN ${pan(rng)}.
Card ${'4111 1111 1111 1111'} was charged twice. Call me on ${`+91 ${indianMobile(rng)}`}
or mail ${'priya.sharma@example.com'}.`;
    expect(detect(text)).toEqual([
      { type: 'AADHAAR', ...spans[0]!, validated: true, context: true },
      { type: 'PAN', ...spans[1]!, validated: true, context: true },
      { type: 'CARD', ...spans[2]!, validated: true, context: true },
      { type: 'PHONE', ...spans[3]!, validated: true, context: true },
      { type: 'EMAIL', ...spans[4]!, validated: false, context: false },
    ]);
  });

  it('handles a mixed Hindi/English message with Devanagari digits', () => {
    const { text, spans } =
      compose`नमस्ते, मेरा आधार ${styleDigits(spacedAadhaar(rng), 'devanagari')} है और मोबाइल ${styleDigits(indianMobile(rng), 'devanagari')} है।`;
    expect(detect(text)).toEqual([
      { type: 'AADHAAR', ...spans[0]!, validated: true, context: true },
      { type: 'PHONE', ...spans[1]!, validated: true, context: true },
    ]);
  });

  it('returns nothing for text without personal data', () => {
    expect(
      detect('The meeting moved to 3 pm on 12 March; bring 2 copies of the Q3 report.'),
    ).toEqual([]);
    expect(detect('')).toEqual([]);
  });

  it('never puts a value in a detection: only type, offsets and two flags', () => {
    const found = detect(`Aadhaar ${spacedAadhaar(rng)} and card 4111111111111111`);
    expect(found).toHaveLength(2);
    for (const d of found) {
      expect(Object.keys(d).sort()).toEqual(['context', 'end', 'start', 'type', 'validated']);
    }
    expect(JSON.stringify(found)).not.toContain('4111');
  });
});

describe('detect: Unicode disguises, mapped back to the original text', () => {
  it.each([
    ['Devanagari', 0x0966],
    ['Bengali', 0x09e6],
    ['Tamil', 0x0be6],
    ['Gujarati', 0x0ae6],
    ['full-width', 0xff10],
    ['Extended Arabic-Indic (Urdu)', 0x06f0],
  ])('finds an Aadhaar written in %s digits', (_script, zero) => {
    const { text, spans } = compose`Ref ${inScript(spacedAadhaar(rng), zero)} ok`;
    expect(detect(text)).toEqual([
      { type: 'AADHAAR', ...spans[0]!, validated: true, context: false },
    ]);
  });

  it('finds a card split by zero-width characters, and the span covers all of them', () => {
    const disguised = '4111​1111‌1111‍1111';
    const { text, spans } = compose`Card: ${disguised}!`;
    expect(detect(text)).toEqual([{ type: 'CARD', ...spans[0]!, validated: true, context: true }]);
  });

  it('finds a card with soft hyphens and bidi marks inside its groups', () => {
    const disguised = '42­42 4242‎ 42‮42 4242';
    const { text, spans } = compose`Paid ${disguised} ok`;
    expect(detect(text)).toEqual([{ type: 'CARD', ...spans[0]!, validated: true, context: false }]);
  });

  it('finds a full-width email and PAN', () => {
    const fullWidth = (s: string): string =>
      s.replace(/[!-~]/g, (ch) => String.fromCodePoint(ch.codePointAt(0)! - 0x21 + 0xff01));
    const { text, spans } =
      compose`Mail ${fullWidth('priya@example.com')}, id ${fullWidth(pan(rng))}`;
    expect(detect(text)).toEqual([
      { type: 'EMAIL', ...spans[0]!, validated: false, context: false },
      { type: 'PAN', ...spans[1]!, validated: true, context: false },
    ]);
  });

  it('finds a phone number with a full-width plus sign and mathematical digits', () => {
    const number = `＋91 ${styleDigits(indianMobile(rng), 'mathBold')}`;
    const { text, spans } = compose`Tel ${number}`;
    expect(detect(text)).toEqual([{ type: 'PHONE', ...spans[0]!, validated: true, context: true }]);
  });

  it('finds a value right after an emoji and before a flag sequence', () => {
    const { text, spans } = compose`\u{1F600} ${'4111 1111 1111 1111'}\u{1F1EE}\u{1F1F3}`;
    expect(detect(text)).toEqual([{ type: 'CARD', ...spans[0]!, validated: true, context: false }]);
  });

  // The strongest Unicode test: any generated value, disguised with random
  // digit scripts and invisible characters between its characters, sitting
  // among ordinary words. detect() must find it with the right type and map
  // it back to exactly the disguised stretch of the original text.
  const GENERATORS: readonly [DetectionType, (r: Rng) => string][] = [
    ['AADHAAR', spacedAadhaar],
    ['CARD', (r) => cardNumber(r)],
    ['PAN', pan],
    ['PHONE', (r) => `+91 ${indianMobile(r)}`],
    ['EMAIL', email],
  ];
  const WORDS = [
    'hello',
    'please',
    'update',
    'my',
    'details',
    'नमस्ते',
    'धन्यवाद',
    'ok',
    '—',
    '👍',
  ];

  it('finds every generated, disguised value exactly where it is', () => {
    assertPropertyQuietly(
      fc.property(seedArb, fc.constantFrom(...GENERATORS), (seed, [type, generate]) => {
        const r = createRng(seed);
        const words = (): string =>
          Array.from({ length: r.int(0, 4) }, () => r.pick(WORDS)).join(' ');
        const { text, spans } = compose`${words()} ${obfuscate(generate(r), r)} ${words()}`;
        const found = detect(text);
        return (
          found.length === 1 &&
          found[0]!.type === type &&
          found[0]!.start === spans[1]!.start &&
          found[0]!.end === spans[1]!.end
        );
      }),
      { numRuns: 2000 },
    );
  });
});

// A 16-digit number that fails the card checks (a card with a typo) and has
// no keyword is not a card. But a valid phone number or Aadhaar can hide
// inside it. Whatever is found there must take the whole number with it:
// redacting a piece and leaving the rest visible would leak part of it.
describe('detect: fails closed inside longer numbers', () => {
  it('never redacts only part of a 16-digit number, even when a valid mobile hides inside it', () => {
    const r = createRng(11);
    let partial = 0;
    let whole = 0;
    let nothing = 0;
    for (let i = 0; i < 2000; i++) {
      // Six random digits around a valid Indian mobile, then break the Luhn check.
      const pad = r.digits(6);
      const cut = r.int(0, 6);
      let digits = pad.slice(0, cut) + indianMobile(r) + pad.slice(cut);
      if (isLuhnValid(digits)) digits = digits.slice(0, 15) + String((Number(digits[15]) + 1) % 10);
      for (const separator of [' ', '-', '']) {
        const number = separator ? groupDigits(digits, [4, 4, 4, 4], separator) : digits;
        const { text, spans } = compose`Ref ${number} ok`;
        const found = detect(text);
        if (found.length === 0) nothing++;
        else if (
          found.length === 1 &&
          found[0]!.start === spans[0]!.start &&
          found[0]!.end === spans[0]!.end
        )
          whole++;
        else partial++;
      }
    }
    expect(partial).toBe(0);
    // Not vacuous: some of these numbers really do contain a detectable value.
    expect(whole).toBeGreaterThan(100);
    expect(nothing).toBeGreaterThan(0);
  });

  it('widens a phone number that libphonenumber finds inside a longer run', () => {
    // libphonenumber reports only "202-555-0143" here, a piece of the run
    // "1 202-555-0143 7". Widening covers the whole run (the "+" carries
    // no digits and stays outside).
    const { text, spans } = compose`Ref +${'1 202-555-0143 7'} ok`;
    expect(detect(text)).toEqual([
      { type: 'PHONE', ...spans[0]!, validated: true, context: false },
    ]);
    const dashed = compose`Ref ${'+44 20 7946 0123 - 45'} ok`;
    expect(detect(dashed.text)).toEqual([
      { type: 'PHONE', ...dashed.spans[0]!, validated: true, context: false },
    ]);
  });

  it('does not widen across a comma or a word', () => {
    const { text, spans } =
      compose`Cards ${'4111 1111 1111 1111'}, 12 and ${'4242 4242 4242 4242'} 7`;
    expect(detect(text)).toEqual([
      { type: 'CARD', ...spans[0]!, validated: true, context: true },
      {
        type: 'CARD',
        start: spans[1]!.start,
        end: spans[1]!.end + 2,
        validated: true,
        context: true,
      },
    ]);
  });
});

/** Booleans for a pair: each value covered whole, and no detection touching both. */
// `keywordA` and `keywordB` go in front of each value, outside its span:
// the keyword-only types (ADR-031) are personal only after one.
const pairResult = (
  a: string,
  separator: string,
  b: string,
  keywordA = '',
  keywordB = '',
): [boolean, boolean, boolean] => {
  const composed = compose`Value ${keywordA}${a}${separator}${keywordB}${b} ok.`;
  const { text } = composed;
  const spans = [composed.spans[1]!, composed.spans[4]!];
  const found = detect(text);
  const covered = (s: { start: number; end: number }): boolean =>
    [...text.slice(s.start, s.end)].every(
      (ch, i) =>
        !/[\p{L}\p{N}]/u.test(ch) ||
        found.some((d) => d.start <= s.start + i && s.start + i < d.end),
    );
  const touches = (d: { start: number; end: number }, s: { start: number; end: number }) =>
    d.start < s.end && s.start < d.end;
  const shared = found.some((d) => touches(d, spans[0]!) && touches(d, spans[1]!));
  return [covered(spans[0]!), covered(spans[1]!), !shared];
};

describe('detect: widening stops at the neighbouring detection (ADR-028)', () => {
  it('keeps two values in one digit run as two detections, the separator between them as text', () => {
    const { text, spans } =
      compose`Numbers ${groupDigits(indianMobile(rng), [5, 5], ' ')} ${spacedAadhaar(rng)} ok`;
    expect(detect(text).map((d) => [d.type, d.start, d.end])).toEqual([
      ['PHONE', spans[0]!.start, spans[0]!.end],
      ['AADHAAR', spans[1]!.start, spans[1]!.end],
    ]);
  });

  it('gives the digits between two values to the first, so none is left visible', () => {
    const { text, spans } =
      compose`Numbers ${groupDigits(indianMobile(rng), [5, 5], ' ')} 7 ${spacedAadhaar(rng)} ok`;
    expect(detect(text).map((d) => [d.type, d.start, d.end])).toEqual([
      ['PHONE', spans[0]!.start, spans[0]!.end + 2],
      ['AADHAAR', spans[1]!.start, spans[1]!.end],
    ]);
  });

  it('trims separators only at a cut between values, never off a value itself', () => {
    // A password may start or end with a hyphen or a dot; it is part of
    // the value.
    for (const password of ['ab12-cd34-', '-ab12-cd34', '.x9.k2']) {
      const { text, spans } = compose`password: ${password} ok`;
      expect([password, detect(text).map((d) => [d.type, d.start, d.end])]).toEqual([
        password,
        [['SECRET', spans[0]!.start, spans[0]!.end]],
      ]);
    }
  });

  // Pairs that widening used to merge, dropping one of them (bug-log 35):
  // each value now whole and in its own detection. Hyphen-joined pairs
  // where one value's pattern can take the hyphen are item 3's.
  const r = createRng(3535);
  const makers: Record<string, () => string> = {
    IFSC: () => ifsc(r),
    'IP v4': () => ipAddress(r, 'v4'),
    'IP v6': () => ipAddress(r, 'v6'),
    'UPI mobile': () => upiId(r, 'mobile'),
    'UPI name': () => upiId(r, 'name'),
    'SECRET github': () => secret(r, 'github'),
    'SECRET aws': () => secret(r, 'aws'),
  };
  it.each([
    ['IFSC', 'IP v6', [' ', ' - ', '. ', '-']],
    ['IFSC', 'IP v4', [' ', ' - ', '. ', '-']],
    ['IFSC', 'UPI mobile', [' ', ' - ', '. ']],
    ['IP v4', 'IP v4', [' ', ' - ', '. ', '-']],
    ['IP v6', 'IP v6', [' ', ' - ', '. ', '-']],
    ['IP v4', 'UPI mobile', [' ', ' - ', '. ']],
    ['IP v6', 'UPI name', [' ', ' - ', '. ']],
    ['SECRET github', 'IP v4', [' ', ' - ', '. ']],
    ['SECRET aws', 'IP v6', [' ', ' - ', '. ']],
    ['SECRET github', 'UPI mobile', [' ', ' - ', '. ']],
  ] as const)('%s then %s: both whole, in two detections', (first, second, separators) => {
    const results = new Set<string>();
    for (let i = 0; i < 40; i++) {
      for (const separator of separators) {
        results.add(JSON.stringify(pairResult(makers[first]!(), separator, makers[second]!())));
      }
    }
    expect([...results]).toEqual([JSON.stringify([true, true, true])]);
  });
});

describe('detect: the overlap rule after ADR-029', () => {
  it('two spaced mobiles with " - " or ". " between them stay two detections (size counts digits)', () => {
    for (const separator of [' - ', '. ', ' ']) {
      const a = groupDigits(indianMobile(rng), [5, 5], ' ');
      const b = groupDigits(indianMobile(rng), [5, 5], ' ');
      const { text, spans } = compose`Numbers ${a}${separator}${b} ok`;
      expect([separator, detect(text).map((d) => [d.type, d.start, d.end])]).toEqual([
        separator,
        [
          ['PHONE', spans[0]!.start, spans[0]!.end],
          ['PHONE', spans[2]!.start, spans[2]!.end],
        ],
      ]);
    }
  });

  it('a keyword secret that contains a mobile is one secret (containing span)', () => {
    const { text, spans } = compose`token: ${`abc-${indianMobile(rng)}`} ok`;
    expect(detect(text).map((d) => [d.type, d.start, d.end])).toEqual([
      ['SECRET', spans[0]!.start, spans[0]!.end],
    ]);
  });

  it('digits joined to a mobile by "(" or "+" are taken, the joiner stays text', () => {
    for (const [joiner, tail] of [
      ['(', '12345'],
      ['+', '123'],
    ] as const) {
      const { text, spans } = compose`Call ${indianMobile(rng)}${joiner}${tail} now`;
      expect([joiner, detect(text).map((d) => [d.type, d.start, d.end])]).toEqual([
        joiner,
        [
          ['PHONE', spans[0]!.start, spans[0]!.end],
          ['NUMBER', spans[2]!.start, spans[2]!.end],
        ],
      ]);
    }
  });
});

// Bug-log 35, closed by ADR-029: every type next to every type, with each
// of the four separators the no-leak test uses, leaves no letter or digit
// of either value visible. Some pairs become one detection (two keys
// joined by a hyphen, two unbroken numbers joined by one); none leaks.
describe('detect: any two values side by side are both covered (bug-log 35, ADR-029)', () => {
  const r = createRng(3536);
  const kinds = [
    'openai',
    'anthropic',
    'github',
    'aws',
    'stripe',
    'razorpay',
    'slack',
    'google',
    'jwt',
  ] as const;
  const makers: Record<string, () => string> = {
    AADHAAR: () => spacedAadhaar(r),
    CARD: () => cardNumber(r),
    PAN: () => pan(r),
    EMAIL: () => email(r),
    PHONE: () => groupDigits(indianMobile(r), [5, 5], ' '),
    NUMBER: () => String(r.int(1, 9)) + r.digits(r.int(8, 15)),
    SECRET: () => secret(r, r.pick(kinds)),
    UPI: () => upiId(r, r.pick(['name', 'mobile'] as const)),
    IP: () => ipAddress(r, r.pick(['v4', 'v6'] as const)),
    IFSC: () => ifsc(r),
    PASSPORT: () => passportNumber(r),
    VOTER: () => voterId(r),
    DOB: () => dateOfBirth(r),
  };
  const KEYWORDS: Record<string, string> = {
    PASSPORT: 'Passport no: ',
    VOTER: 'Voter ID: ',
    DOB: 'DOB: ',
  };
  const types = Object.keys(makers);
  it.each(types)('%s then every type, with " ", " - ", ". " and "-"', (first) => {
    const results = new Map<string, number>();
    for (const second of types) {
      for (const separator of [' ', ' - ', '. ', '-']) {
        for (let i = 0; i < 6; i++) {
          const [a, b] = pairResult(
            makers[first]!(),
            separator,
            makers[second]!(),
            KEYWORDS[first],
            KEYWORDS[second],
          );
          if (!a || !b) {
            const key = `${second} "${separator}" ${a ? '' : 'first'}${b ? '' : 'second'}`;
            results.set(key, (results.get(key) ?? 0) + 1);
          }
        }
      }
    }
    expect([...results]).toEqual([]);
  });
});

// How often do ordinary numbers get mistaken for personal data? These rates
// are properties of the checks themselves (Luhn and Verhoeff each pass about
// 1 in 10 random numbers), measured on a fixed seed so they are exact and
// reproducible. The policy of ADR-010 (a validated match is redacted even
// without context) accepts them. Phase 5 measures real text.
describe('detect: false-positive rates on random numbers (ADR-010)', () => {
  const SAMPLES = 5000;
  const rate = (make: (r: Rng) => string, type: DetectionType): number => {
    const r = createRng(1);
    let hits = 0;
    for (let i = 0; i < SAMPLES; i++) {
      if (detect(`Reference ${make(r)} noted.`).some((d) => d.type === type)) hits++;
    }
    return hits / SAMPLES;
  };

  it('about 8% of random bare 12-digit numbers look like an Aadhaar (0.8 x 0.1)', () => {
    const r = rate((x) => x.digits(12), 'AADHAAR');
    expect(r).toBeGreaterThan(0.065);
    expect(r).toBeLessThan(0.095);
  });

  it('under 4% of random bare 16-digit numbers look like a card', () => {
    const r = rate((x) => x.digits(16), 'CARD');
    expect(r).toBeGreaterThan(0.02);
    expect(r).toBeLessThan(0.04);
  });

  it('most random 10-digit numbers starting 6-9 look like a phone (they are valid Indian mobiles)', () => {
    expect(rate((x) => String(x.int(6, 9)) + x.digits(9), 'PHONE')).toBeGreaterThan(0.99);
  });

  it('no random 12-digit number is an Aadhaar once one digit is glued to a letter', () => {
    expect(rate((x) => `x${x.digits(12)}`, 'AADHAAR')).toBe(0);
  });
});

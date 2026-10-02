// IFSC (ADR-025): validated by a known bank code, otherwise only with a
// keyword; never taking part of an address; how it sits next to PAN,
// NUMBER, SECRET, UPI and email.
//
// An IFSC names a bank branch, not a person, and branch codes are public
// (RBI publishes them), so a few are typed here for readability. Generated
// ones are used wherever a property runs over many.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { detect } from '../../../src/detection/detect.js';
import { IFSC_BANK_CODES, ifscCandidates } from '../../../src/detection/ifsc.js';
import { panCandidates } from '../../../src/detection/pan.js';
import { UPI_HANDLES } from '../../../src/detection/upi.js';
import { IFSC_BANK_CODES as GENERATOR_CODES, ifsc } from '../../../src/synthetic/identifiers.js';
import { createRng } from '../../../src/synthetic/rng.js';
import { pan } from '../../../src/synthetic/values.js';
import { compose } from '../../support/compose.js';
import { growthRatio, MAX_GROWTH_RATIO } from '../../support/linear-time.js';
import { assertPropertyQuietly, seedArb } from '../../support/quiet-property.js';

const rng = createRng(20261001);

const ifscAt = (span: { start: number; end: number }, validated = true, context = false) => ({
  type: 'IFSC',
  ...span,
  validated,
  context,
});

/** A known bank code with a branch; an unknown one (no bank code starts with ZZ). */
const KNOWN = 'SBIN0001234';
const UNKNOWN = 'ZZQX0123456';

/** Full-width forms of printable ASCII (U+FF01 to U+FF5E). */
const fullWidth = (s: string): string =>
  s.replace(/[!-~]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0));

describe('the bank-code list', () => {
  it('has 260 codes, each four capital letters', () => {
    expect(IFSC_BANK_CODES.size).toBe(260);
    expect([...IFSC_BANK_CODES].every((code) => /^[A-Z]{4}$/.test(code))).toBe(true);
  });

  it('holds every large bank the generator uses (the generator keeps its own list, ADR-008)', () => {
    expect(GENERATOR_CODES.filter((code) => !IFSC_BANK_CODES.has(code))).toEqual([]);
  });

  it('holds no code starting with ZZ or XX, which the tests and the generator use for unknown banks', () => {
    expect([...IFSC_BANK_CODES].filter((code) => /^(ZZ|XX)/.test(code))).toEqual([]);
  });
});

describe('IFSCs with a known bank code: validated, no keyword needed', () => {
  it('finds every generated IFSC, exactly where it is', () => {
    assertPropertyQuietly(
      fc.property(seedArb, (seed) => {
        const { text, spans } = compose`Send it to ${ifsc(createRng(seed))} please`;
        const found = detect(text);
        return (
          found.length === 1 &&
          found[0]!.type === 'IFSC' &&
          found[0]!.validated &&
          found[0]!.start === spans[0]!.start &&
          found[0]!.end === spans[0]!.end
        );
      }),
      { numRuns: 1000 },
    );
  });

  it('finds one in any case: the code is the same (ADR-025)', () => {
    for (const code of [KNOWN, KNOWN.toLowerCase(), 'Sbin0001234', 'sbIN0abC123']) {
      const { text, spans } = compose`Details ${code} here`;
      expect(detect(text)).toEqual([ifscAt(spans[0]!)]);
    }
  });

  it('takes letters in the branch part', () => {
    const { text, spans } = compose`Details ${'HDFC0CAGSBK'} here`;
    expect(detect(text)).toEqual([ifscAt(spans[0]!)]);
  });

  it('records context next to "IFSC"', () => {
    const { text, spans } = compose`IFSC: ${KNOWN}`;
    expect(detect(text)).toEqual([ifscAt(spans[0]!, true, true)]);
  });

  it('finds one in brackets, quotes, a URL path or at the end of a sentence', () => {
    for (const [open, close] of [
      ['(', ')'],
      ['"', '"'],
      ['https://bank.example/branch/', '/view'],
      ['Branch ', '.'],
    ]) {
      const { text, spans } = compose`${open!}${KNOWN}${close!}`;
      expect(detect(text).map((d) => [d.type, d.start, d.end])).toEqual([
        ['IFSC', spans[1]!.start, spans[1]!.end],
      ]);
    }
  });
});

describe('IFSCs with an unknown bank code: only with a keyword', () => {
  it('are not found with no keyword (a product code can have the same shape)', () => {
    expect(detect(`Item ${UNKNOWN} is out of stock`)).toEqual([]);
    expect(detect(`Item ${ifsc(rng, false)} is out of stock`)).toEqual([]);
  });

  it.each([
    ['IFSC', (v: string) => `IFSC ${v}`],
    ['ifsc code', (v: string) => `ifsc code: ${v}`],
    ['IFS code', (v: string) => `IFS code ${v}`],
    ['NEFT', (v: string) => `Send it by NEFT to ${v}`],
    ['RTGS', (v: string) => `RTGS details: ${v}`],
    ['IMPS', (v: string) => `IMPS to ${v}`],
    ['branch', (v: string) => `The branch is ${v}.`],
    ['आईएफएससी', (v: string) => `आईएफएससी ${v} है।`],
    ['शाखा', (v: string) => `शाखा ${v} है।`],
  ])('are found, unvalidated, near "%s"', (_word, sentence) => {
    const text = sentence(UNKNOWN);
    const start = text.indexOf(UNKNOWN);
    expect(detect(text)).toEqual([ifscAt({ start, end: start + 11 }, false, true)]);
  });

  it('a keyword further than 40 characters away does not count', () => {
    expect(detect(`IFSC${' '.repeat(41)}${UNKNOWN}`)).toEqual([]);
  });

  it('"bank" alone is not a keyword: it names neither the code nor a transfer that needs one', () => {
    expect(detect(`Bank reference ${UNKNOWN}`)).toEqual([]);
  });
});

describe('what is not an IFSC', () => {
  it.each([
    ['a fifth character other than zero', 'SBIN1001234'],
    ['three letters first', 'SBI00001234'],
    ['five letters first', 'SBINA001234'],
    ['a branch part of five', 'SBIN000123'],
    ['a branch part of seven', 'SBIN00012345'],
    ['a non-ASCII letter', 'SBÏN0001234'],
  ])('%s (%s)', (_name, code) => {
    expect([...ifscCandidates(`IFSC ${code}`)]).toEqual([]);
  });

  it('ignores one glued to a letter, digit, mark or underscore', () => {
    for (const text of [`X${KNOWN}`, `${KNOWN}9`, `key_${KNOWN}`, `${KNOWN}́`, `9${KNOWN}`]) {
      expect([...ifscCandidates(text)]).toEqual([]);
    }
  });

  it('a letter O for the zero is not matched (known limit, ADR-025)', () => {
    expect(detect('IFSC: SBINO001234')).toEqual([]);
  });

  it('a space or hyphen after the bank code is not matched (known limit, ADR-025)', () => {
    expect(detect('IFSC: SBIN 0001234')).toEqual([]);
    expect(detect('IFSC: SBIN-0001234')).toEqual([]);
  });
});

describe('Unicode', () => {
  it('finds a full-width IFSC and covers it in the original text', () => {
    const { text, spans } = compose`IFSC ${fullWidth(KNOWN)} ok`;
    expect(detect(text)).toEqual([ifscAt(spans[0]!, true, true)]);
  });

  it('finds an IFSC split by invisible characters and covers every one of them', () => {
    const hidden = 'SB​IN0­001⁠234';
    const { text, spans } = compose`Code ${hidden} ok`;
    expect(detect(text)).toEqual([ifscAt(spans[0]!)]);
  });

  it('finds one with Devanagari digits in the branch part', () => {
    const { text, spans } = compose`Code ${'SBIN०००१२३४'} ok`;
    expect(detect(text)).toEqual([ifscAt(spans[0]!)]);
  });
});

// Point 3 of the brief: where IFSC's shape meets the other types, and which
// one wins (ADR-025 lists these with the reasons).
describe('IFSC next to the other types', () => {
  // The keyword-only types (ADR-031) sit between IFSC and PHONE.
  it('priority: IFSC sits right after PAN, before PHONE', async () => {
    const { DETECTION_TYPES } = await import('../../../src/detection/types.js');
    expect(DETECTION_TYPES.indexOf('IFSC')).toBe(DETECTION_TYPES.indexOf('PAN') + 1);
    expect(DETECTION_TYPES.indexOf('IFSC')).toBeLessThan(DETECTION_TYPES.indexOf('PHONE'));
  });

  it('PAN: no text is both shapes (a PAN has a letter where an IFSC has its zero)', () => {
    assertPropertyQuietly(
      fc.property(seedArb, (seed) => {
        const r = createRng(seed);
        const p = pan(r);
        const i = ifsc(r);
        return (
          [...ifscCandidates(`x ${p} y`)].length === 0 &&
          [...panCandidates(`x ${i} y`)].length === 0 &&
          detect(`PAN ${p} IFSC ${i}`)
            .map((d) => d.type)
            .join() === 'PAN,IFSC'
        );
      }),
    );
  });

  it('NUMBER: an IFSC has 7 digits, below the safety net, so nothing else claims it', () => {
    expect(detect(`Branch ${KNOWN}`).map((d) => d.type)).toEqual(['IFSC']);
  });

  it('NUMBER: an account number after a slash or comma is its own detection', () => {
    for (const glue of ['/', ', A/c ']) {
      const text = `${KNOWN}${glue}123456789012`;
      expect(detect(text).map((d) => [d.type, d.start, d.end])).toEqual([
        ['IFSC', 0, 11],
        ['NUMBER', text.length - 12, text.length],
      ]);
    }
  });

  it('NUMBER: digits joined by a space or dot are taken into the IFSC (over-redaction, ADR-010 widening)', () => {
    for (const glue of [' ', '.']) {
      const text = `${KNOWN}${glue}1234 5678 9012`;
      expect(detect(text).map((d) => [d.type, d.start, d.end])).toEqual([['IFSC', 0, text.length]]);
    }
  });

  it('SECRET: an IFSC written after "password:" is typed IFSC and covered whole', () => {
    const { text, spans } = compose`password: ${KNOWN}`;
    expect(detect(text)).toEqual([ifscAt(spans[0]!)]);
  });

  it('SECRET: an unknown-bank IFSC after "password:" is the secret, whole', () => {
    const { text, spans } = compose`password: ${UNKNOWN}`;
    expect(detect(text).map((d) => [d.type, d.start, d.end])).toEqual([
      ['SECRET', spans[0]!.start, spans[0]!.end],
    ]);
  });

  it('SECRET: a secret made of an IFSC, a hyphen and more is one secret (ADR-029 containing span)', () => {
    const text = `api_key=${KNOWN}-x7`;
    expect(detect(text).map((d) => [d.type, d.start, d.end])).toEqual([['SECRET', 8, 22]]);
  });

  it('UPI: an IFSC-shaped name at a known handle is one UPI ID', () => {
    const id = `${KNOWN.toLowerCase()}@${[...UPI_HANDLES][0]!}`;
    expect(detect(`pay ${id} now`).map((d) => [d.type, d.start, d.end])).toEqual([
      ['UPI', 4, 4 + id.length],
    ]);
  });

  it('UPI: an IFSC-shaped handle is never an IFSC; with a UPI keyword the ID is one UPI ID', () => {
    const id = `name@${KNOWN.toLowerCase()}`;
    expect(detect(`pay ${id} now`)).toEqual([]);
    expect(detect(`UPI ${id}`).map((d) => [d.type, d.start, d.end])).toEqual([
      ['UPI', 4, 4 + id.length],
    ]);
  });

  it('EMAIL: an IFSC glued to "@" is part of the address, covered whole', () => {
    for (const address of [`${KNOWN}@example.com`, `x.${KNOWN}@example.com`]) {
      expect(detect(`mail ${address} now`).map((d) => [d.type, d.start, d.end])).toEqual([
        ['EMAIL', 5, 5 + address.length],
      ]);
    }
  });

  it('EMAIL: an IFSC, a dot and more before the "@" is part of the email (ADR-029 containing span)', () => {
    expect(detect(`mail ${KNOWN}.x@example.com now`).map((d) => [d.type, d.start, d.end])).toEqual([
      ['EMAIL', 5, 30],
    ]);
  });

  it('two IFSCs side by side are two detections', () => {
    const text = `${KNOWN} ${'HDFC0001234'}`;
    expect(detect(text).map((d) => [d.type, d.start, d.end])).toEqual([
      ['IFSC', 0, 11],
      ['IFSC', 12, 23],
    ]);
  });
});

// Each case makes the input 4 times longer and checks the time grows about
// 4 times, not 16 (test/support/linear-time.ts). Sizes are chosen so one
// run takes a few milliseconds: "SBIN0" repeated costs the phone detector
// several times more per character than the others (bug-log 28).
describe('IFSC: linear time', () => {
  it.each([
    ['a long run of letters', 25_000, (n: number) => 'A'.repeat(n)],
    ['letters and zeros', 2_000, (n: number) => 'SBIN0'.repeat(n / 5)],
    ['IFSC-shaped codes glued together', 25_000, (n: number) => 'SBIN0001234'.repeat(n / 11)],
    ['IFSC-shaped codes after keywords', 25_000, (n: number) => 'IFSC ZZQX0123456 '.repeat(n / 17)],
  ])('scans %s in linear time', (_name, size, make) => {
    expect(growthRatio(make, size, detect)).toBeLessThan(MAX_GROWTH_RATIO);
  });
});

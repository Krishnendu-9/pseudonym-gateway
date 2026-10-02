// Dates of birth (ADR-031): common date forms, a real calendar date,
// keyword only. A date alone is never enough: invoices, orders, tickets and
// logs are full of dates.
//
// A date with no birth word near it belongs to nobody, so the shape tests
// type theirs. Every test that puts a date next to a keyword generates it at
// run time and compares offsets only (ADR-009).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { detect } from '../../../src/detection/detect.js';
import { dobCandidates, isRealDate } from '../../../src/detection/dob.js';
import { dateOfBirth } from '../../../src/synthetic/identifiers.js';
import { phoneCandidates } from '../../../src/detection/phone.js';
import { obfuscate } from '../../../src/synthetic/obfuscate.js';
import { createRng } from '../../../src/synthetic/rng.js';
import { aadhaar, indianMobile } from '../../../src/synthetic/values.js';
import { compose } from '../../support/compose.js';
import { assertPropertyQuietly, seedArb } from '../../support/quiet-property.js';

const rng = createRng(20_261_004);

const spansOf = (text: string): [string, number, number, boolean][] =>
  detect(text).map((d) => [d.type, d.start, d.end, d.validated]);

/** The span of the one candidate found in "on <form> ok", or the count found. */
const candidateIn = (form: string): [number, number] | number => {
  const found = [...dobCandidates(`on ${form} ok`)];
  return found.length === 1 ? [found[0]!.start - 3, found[0]!.end - 3] : found.length;
};

describe('isRealDate', () => {
  it('knows the length of every month, and leap years', () => {
    expect(isRealDate(31, 1, '1991')).toBe(true);
    expect(isRealDate(31, 4, '1991')).toBe(false);
    expect(isRealDate(30, 4, '1991')).toBe(true);
    expect(isRealDate(29, 2, '1992')).toBe(true);
    expect(isRealDate(29, 2, '1991')).toBe(false);
    expect(isRealDate(29, 2, '2000')).toBe(true);
    expect(isRealDate(29, 2, '1900')).toBe(false);
    expect(isRealDate(28, 2, '1991')).toBe(true);
  });

  it('rejects day 0, month 0 and month 13', () => {
    expect(isRealDate(0, 3, '1991')).toBe(false);
    expect(isRealDate(7, 0, '1991')).toBe(false);
    expect(isRealDate(7, 13, '1991')).toBe(false);
  });

  it('takes four-digit years from 1900 to 2099 only', () => {
    expect(isRealDate(1, 1, '1900')).toBe(true);
    expect(isRealDate(31, 12, '2099')).toBe(true);
    expect(isRealDate(31, 12, '1899')).toBe(false);
    expect(isRealDate(1, 1, '2100')).toBe(false);
  });

  it('takes any two-digit year; 29 February in a year divisible by 4', () => {
    expect(isRealDate(7, 3, '91')).toBe(true);
    expect(isRealDate(29, 2, '00')).toBe(true);
    expect(isRealDate(29, 2, '92')).toBe(true);
    expect(isRealDate(29, 2, '91')).toBe(false);
  });
});

describe('date candidates: the forms', () => {
  it.each([
    '07/03/1991',
    '07-03-1991',
    '7.3.1991',
    '07/03/91',
    '03/25/1991',
    '1991-03-07',
    '1991/03/07',
    '1991.3.7',
    '7 March 1991',
    '07-Mar-1991',
    '7-Mar-91',
    '7th March, 1991',
    '7 MAR 1991',
    '07Mar1991',
    '7 Sept 1991',
    '1 May 1991',
    'March 7, 1991',
    'Mar 7 1991',
    'Mar. 7, 1991',
    // Months told apart by their third letter: June and July, March and May.
    '31 July 1991',
    'Jul 31, 1991',
    '31 March 1991',
    '29 Feb 1992',
    'December 31st, 1999',
    // Any number of spaces around a month name (bug-log 42).
    '7  March  1991',
    'March  7,  1991',
  ])('finds %s whole, never validated', (form) => {
    expect(candidateIn(form)).toEqual([0, form.length]);
    expect([...dobCandidates(form)].every((c) => c.type === 'DOB' && !c.validated)).toBe(true);
  });

  it.each([
    ['mixed separators', '07/03-1991'],
    ['30 February', '30/02/1991'],
    ['month 13 either way round', '25/13/1991'],
    ['day 0', '00/03/1991'],
    ['a year before 1900', '07/03/1899'],
    ['a year after 2099', '07/03/2100'],
    ['month 13, year first', '1991-13-07'],
    ['30 February by name', '30 February 1991'],
    ['30 February, month first', 'February 30, 1991'],
    ['a month name inside a word', '7 Marching 1991'],
    ['a month name at the end of a word', 'dismay 7, 1991'],
    ['no year', '7 March'],
    ['31 June', '31 June 1991'],
    ['31 May is fine, 31 Sept is not', '31 Sept 1991'],
    ['31 April, month first', 'Apr 31, 1991'],
    ['three digits before the year', '107/03/1991'],
  ])('finds nothing in %s', (_name, form) => {
    expect(candidateIn(form)).toBe(0);
  });

  it.each([
    ['a letter before', 'x07/03/1991'],
    ['a letter after', '07/03/1991x'],
    ['an underscore after', '07/03/1991_'],
    ['a dotted number before', '2.7.3.1991'],
    ['a slashed number before', '12/07/03/1991'],
    ['a dotted number after', '07/03/1991.5'],
  ])('finds nothing part of a longer token: %s', (_name, form) => {
    expect(candidateIn(form)).toBe(0);
  });

  // Two readings of the same text, both unvalidated (ADR-031): DOB ranks
  // above PHONE, a real calendar date beside a birth word being the
  // likelier reading.
  it('a dashed date near both a birth word and a phone word is a date of birth', () => {
    const r = createRng(11);
    let value = dateOfBirth(r);
    while (!/^[0-9]{2}-[0-9]{2}-[0-9]{4}$/.test(value)) value = dateOfBirth(r);
    const { text, spans } = compose`Phone and DOB: ${value} ok`;
    // The phone detector reads the same text as a possible number.
    expect([...phoneCandidates(text)].map((c) => [c.start, c.end, c.validated])).toEqual([
      [spans[0]!.start, spans[0]!.end, false],
    ]);
    expect(spansOf(text)).toEqual([['DOB', spans[0]!.start, spans[0]!.end, false]]);
  });

  it('a date at the end of a sentence or in brackets is found', () => {
    expect(candidateIn('(07/03/1991)')).toEqual([1, 11]);
    expect(candidateIn('07/03/1991.')).toEqual([0, 10]);
  });

  // A hyphen is how two values are written side by side; the digits joined
  // on are widening's and the safety net's (ADR-031).
  it('a hyphen and a digit next to a date do not stop it', () => {
    expect(candidateIn('07/03/1991-2')).toEqual([0, 10]);
    expect(candidateIn('5-1991-03-07')).toEqual([2, 12]);
  });
});

describe('dates of birth in text: only with a keyword', () => {
  const SENTENCES = [
    (v: string) => compose`DOB: ${v}`,
    (v: string) => compose`D.O.B. ${v}`,
    (v: string) => compose`My date of birth is ${v}.`,
    (v: string) => compose`Birth date ${v}`,
    (v: string) => compose`I was born on ${v}.`,
    (v: string) => compose`Birthday: ${v}`,
    (v: string) => compose`${v} is my date of birth.`,
    (v: string) => compose`Meri janm tithi ${v} hai.`,
    (v: string) => compose`Janam tithi: ${v}`,
    (v: string) => compose`जन्म तिथि: ${v}`,
    (v: string) => compose`जन्मतिथि ${v}`,
  ];

  it('is redacted whole next to each birth word, in every generated form', () => {
    assertPropertyQuietly(
      fc.property(seedArb, (seed) => {
        const value = dateOfBirth(createRng(seed));
        return SENTENCES.every((sentence) => {
          const { text, spans } = sentence(value);
          return (
            JSON.stringify(spansOf(text)) ===
            JSON.stringify([['DOB', spans[0]!.start, spans[0]!.end, false]])
          );
        });
      }),
    );
  });

  it('is redacted whole when written in other digits or with invisible characters', () => {
    assertPropertyQuietly(
      fc.property(seedArb, (seed) => {
        const r = createRng(seed);
        const { text, spans } = compose`DOB: ${obfuscate(dateOfBirth(r), r, 0.3)} ok`;
        return (
          JSON.stringify(spansOf(text)) ===
          JSON.stringify([['DOB', spans[0]!.start, spans[0]!.end, false]])
        );
      }),
    );
  });

  it('is not redacted with no keyword: an order date, an invoice date, a log line', () => {
    for (const text of [
      'I ordered it on 12/03/2026 at 14:35.',
      'Invoice dated 2026-03-12, due 7 April 2026.',
      '2026-03-12 10:45 INFO job finished',
      'The age proof says 07/03/1991.',
    ]) {
      expect(detect(text)).toEqual([]);
    }
  });

  // ADR-031: before the hyphen rule above, a numeric date followed by "-"
  // and a number (two values side by side) was not found, and its day and
  // month were sent (about 40% of such layouts in a probe). Covered, not
  // necessarily as a date of birth: `7.3.1991-1234` is also a valid mobile,
  // and a validated reading wins (ADR-003; bug-log 43).
  it('every digit of a date of birth stays covered with another value after "-", " - ", ". " or " "', () => {
    assertPropertyQuietly(
      fc.property(seedArb, fc.constantFrom('-', ' - ', '. ', ' '), (seed, separator) => {
        const r = createRng(seed);
        const value = dateOfBirth(r);
        const other = r.pick([aadhaar(r), indianMobile(r), String(r.int(10, 99999))]);
        const { text, spans } = compose`DOB: ${value}${separator}${other} ok`;
        const found = detect(text);
        for (let i = spans[0]!.start; i < spans[0]!.end; i++) {
          if (/[0-9]/.test(text[i]!) && !found.some((d) => d.start <= i && i < d.end)) return false;
        }
        return true;
      }),
    );
  });

  // The costs (ADR-031, README): any real date within 40 characters of a
  // birth word is redacted too.
  it('a joining date right after a date of birth is redacted too (the cost)', () => {
    const { text, spans } = compose`DOB: ${dateOfBirth(rng)} Joined: ${'01/04/2015'}`;
    expect(spansOf(text)).toEqual([
      ['DOB', spans[0]!.start, spans[0]!.end, false],
      ['DOB', spans[1]!.start, spans[1]!.end, false],
    ]);
  });

  it('"born" in ordinary prose makes a nearby date a date of birth (the cost)', () => {
    const { text, spans } = compose`Our brand was born in Pune. Offer valid till ${'31/12/2026'}.`;
    expect(spansOf(text)).toEqual([['DOB', spans[0]!.start, spans[0]!.end, false]]);
  });

  // Known limits (ADR-031), each a date of birth that is sent as written.
  it.each([
    ['without its year', (v: string) => v.replace(/[ ./-]*(?:19|20)[0-9]{2}$/, '')],
    ['with spaces around its separators', (v: string) => v.replace(/([/.-])/g, ' $1 ')],
    ['with a time glued to it', (v: string) => `${v}T10:00`],
  ])('is a known gap when written %s', (_name, change) => {
    const r = createRng(5);
    let value = dateOfBirth(r);
    while (!/^[0-9]{2}\/[0-9]{2}\/[0-9]{4}$/.test(value)) value = dateOfBirth(r);
    expect(detect(`DOB: ${value}`)).toHaveLength(1);
    expect(detect(`DOB: ${change(value)}`)).toEqual([]);
  });
});

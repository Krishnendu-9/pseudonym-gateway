// Dates of birth. Keyword only (ADR-031): a date is a date of birth only
// because of what the text says about it, and invoices, orders, tickets and
// logs are full of dates, so a candidate is never validated and is accepted
// only with "DOB", "birth", "born", जन्म or "janm" nearby (context.ts,
// ADR-010).
//
// The forms people write a full date in:
//   07/03/1991  07-03-1991  7.3.1991  07/03/91     day, month, year (or
//                                                  month, day, year)
//   1991-03-07  1991/03/07                         year first
//   7 March 1991  07-Mar-1991  7th March, 1991     day and month name
//   March 7, 1991  Mar 7 1991                      month name and day
// One separator throughout a numeric date. Month names in English, full or
// three letters ("Sept" too), in any case. A candidate must be a real
// calendar date (30 February is not one), read either way round when both
// first numbers could be the month; a four-digit year must be 1900 to 2099.
//
// Not glued to a letter, digit, mark or underscore, and not part of a longer
// dotted or slashed number: `2.7.3.1991` and `12/07/03/1991` hold no date.
// A hyphen and a digit next to a date do not stop it: a hyphen is how two
// values are written side by side (`<date>-<Aadhaar>`), and the digits
// joined on are widening's and the safety net's (ADR-028, ADR-029 J1).
//
// This runs on normalised text: digits in any script arrive here as ASCII.
//
// Known limits (ADR-031): a date without its year, a date with a time glued
// to it (`1991-03-07T10:00`), month names in other languages, and spaces
// around the separators of a numeric date.

import type { Candidate } from './types.js';

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
// Full names, three-letter forms and "sept". Their order does not matter:
// if "Mar" is followed by "ch", the pattern backtracks and tries "March".
const MONTH_WORDS = [...new Set([...MONTHS, ...MONTHS.map((m) => m.slice(0, 3)), 'sept'])];
const MONTH = `(${MONTH_WORDS.join('|')})`;
const monthNumber = (word: string): number =>
  MONTHS.findIndex((m) => m.startsWith(word.slice(0, 3).toLowerCase())) + 1;

const BEFORE = String.raw`(?<![\p{L}\p{N}\p{M}_]|\p{N}[./])`;
const AFTER = String.raw`(?![\p{L}\p{N}\p{M}_]|[./]\p{N})`;
const ORDINAL = '(?:st|nd|rd|th)?';
// Between a month name and a number: any number of spaces (bug-log 42), or
// one hyphen.
const GAP = '(?: +|-)';

const DAY_MONTH_YEAR = new RegExp(
  String.raw`${BEFORE}(\d{1,2})([./-])(\d{1,2})\2(\d{4}|\d{2})${AFTER}`,
  'gu',
);
const YEAR_MONTH_DAY = new RegExp(
  String.raw`${BEFORE}(\d{4})([./-])(\d{1,2})\2(\d{1,2})${AFTER}`,
  'gu',
);
const DAY_NAMED_MONTH = new RegExp(
  String.raw`${BEFORE}(\d{1,2})${ORDINAL}${GAP}?${MONTH}\.?,?${GAP}?(\d{4}|\d{2})${AFTER}`,
  'giu',
);
const NAMED_MONTH_DAY = new RegExp(
  String.raw`${BEFORE}${MONTH}\.?${GAP}(\d{1,2})${ORDINAL},?${GAP}(\d{4})${AFTER}`,
  'giu',
);

const isLeap = (year: string): boolean => {
  const y = Number(year);
  // A two-digit year could be either century; 00 is 2000 or 1900.
  if (year.length === 2) return y % 4 === 0;
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
};

/** True if day, month and year (4 or 2 digits) are a real calendar date. */
export function isRealDate(day: number, month: number, year: string): boolean {
  if (year.length === 4 && (Number(year) < 1900 || Number(year) > 2099)) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  const days = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

export function* dobCandidates(text: string): Generator<Candidate> {
  const dob = (m: RegExpMatchArray): Candidate => ({
    type: 'DOB',
    start: m.index!,
    end: m.index! + m[0].length,
    validated: false,
  });
  for (const m of text.matchAll(DAY_MONTH_YEAR)) {
    const [a, b] = [Number(m[1]), Number(m[3])];
    if (isRealDate(a, b, m[4]!) || isRealDate(b, a, m[4]!)) yield dob(m);
  }
  for (const m of text.matchAll(YEAR_MONTH_DAY)) {
    if (isRealDate(Number(m[4]), Number(m[3]), m[1]!)) yield dob(m);
  }
  for (const m of text.matchAll(DAY_NAMED_MONTH)) {
    if (isRealDate(Number(m[1]), monthNumber(m[2]!), m[3]!)) yield dob(m);
  }
  for (const m of text.matchAll(NAMED_MONTH_DAY)) {
    if (isRealDate(Number(m[2]), monthNumber(m[1]!), m[3]!)) yield dob(m);
  }
}

import { describe, expect, it } from 'vitest';
import { CONTEXT_WINDOW, hasContext } from '../../../src/detection/context.js';
import { normalise } from '../../../src/detection/normalise.js';
import type { DetectionType } from '../../../src/detection/types.js';

// The value itself does not matter to hasContext, only where it sits, so
// these tests use a neutral stand-in: VALUE.
function contextFor(before: string, after: string, type: DetectionType): boolean {
  const text = normalise(`${before}VALUE${after}`).text;
  const start = normalise(before).text.length;
  return hasContext(text, { start, end: start + 5 }, type);
}

describe('hasContext', () => {
  it.each([
    ['AADHAAR', 'My Aadhaar: '],
    ['AADHAAR', 'UID '],
    ['AADHAAR', 'aadhar no. '],
    ['CARD', 'Credit card '],
    ['CARD', 'RuPay debit '],
    ['PAN', 'PAN: '],
    ['PAN', 'Permanent Account Number '],
    ['PHONE', 'Call me on '],
    ['PHONE', 'Mob: '],
    ['PHONE', 'WhatsApp '],
    // The keyword-only types (ADR-031).
    ['PASSPORT', 'Passport no: '],
    ['PASSPORT', 'Passports: '],
    ['PASSPORT', 'पासपोर्ट '],
    ['VOTER', 'Voter ID: '],
    ['VOTER', 'EPIC no. '],
    ['VOTER', 'मतदाता पहचान पत्र '],
    ['VOTER', 'वोटर कार्ड '],
    ['DOB', 'DOB: '],
    ['DOB', 'D.O.B. '],
    ['DOB', 'Date of birth: '],
    ['DOB', 'Birth date '],
    ['DOB', 'Birthdate: '],
    ['DOB', 'I was born on '],
    ['DOB', 'Birthday: '],
    ['DOB', 'Janm tithi '],
    ['DOB', 'janam tithi '],
    ['DOB', 'जन्म तिथि '],
    ['DOB', 'जन्मतिथि '],
  ] as const)('%s: finds a keyword before the value (%j)', (type, before) => {
    expect(contextFor(before, '', type)).toBe(true);
  });

  it('finds a keyword after the value', () => {
    expect(contextFor('It is ', ', my aadhaar.', 'AADHAAR')).toBe(true);
  });

  it('ignores case', () => {
    expect(contextFor('AADHAAR ', '', 'AADHAAR')).toBe(true);
    expect(contextFor('pHoNe ', '', 'PHONE')).toBe(true);
  });

  it('only counts keywords for the right type', () => {
    expect(contextFor('Card ', '', 'AADHAAR')).toBe(false);
    expect(contextFor('Aadhaar ', '', 'CARD')).toBe(false);
  });

  // "age proof" names a document that shows a date of birth, but "age" is
  // in too many sentences with a date in them; "ID card" names any card.
  it.each([
    ['DOB', 'Age proof: '],
    ['DOB', 'Date: '],
    ['VOTER', 'ID card '],
    ['PASSPORT', 'Visa '],
  ] as const)('%s: a nearby word that is not its keyword (%j)', (type, before) => {
    expect(contextFor(before, '', type)).toBe(false);
  });

  it('has no keywords for email (its pattern is evidence enough)', () => {
    expect(contextFor('email ', '', 'EMAIL')).toBe(false);
  });

  it('matches whole words only', () => {
    expect(contextFor('discard ', '', 'CARD')).toBe(false);
    expect(contextFor('cardamom ', '', 'CARD')).toBe(false);
    expect(contextFor('recall ', '', 'PHONE')).toBe(false);
    expect(contextFor('panel ', '', 'PAN')).toBe(false);
    expect(contextFor('cards: ', '', 'CARD')).toBe(true);
    expect(contextFor('card-holder ', '', 'CARD')).toBe(true);
  });

  it('matches a keyword that touches the value', () => {
    expect(contextFor('PAN:', '', 'PAN')).toBe(true);
  });

  it('lets a space inside a keyword match any whitespace', () => {
    expect(contextFor('permanent\naccount   number ', '', 'PAN')).toBe(true);
  });

  it('finds Hindi keywords (आधार, कार्ड, पैन, मोबाइल)', () => {
    expect(contextFor('मेरा आधार नंबर ', '', 'AADHAAR')).toBe(true);
    expect(contextFor('कार्ड ', '', 'CARD')).toBe(true);
    expect(contextFor('पैन ', '', 'PAN')).toBe(true);
    expect(contextFor('मोबाइल ', '', 'PHONE')).toBe(true);
  });

  it('finds फ़ोन whether the nukta is precomposed or a separate mark', () => {
    // U+095E is precomposed; NFKC splits it into फ + ़, the same as the second form.
    expect(contextFor('फ़ोन ', '', 'PHONE')).toBe(true);
    expect(contextFor('फ़ोन ', '', 'PHONE')).toBe(true);
  });

  it('does not treat a Devanagari word that merely starts with a keyword as the keyword', () => {
    // "आधारित" (based on) starts with आधार but is a different word.
    expect(contextFor('आधारित ', '', 'AADHAAR')).toBe(false);
  });

  it(`looks at most ${CONTEXT_WINDOW} characters away on each side`, () => {
    const gap = (n: number): string => ' '.repeat(n);
    expect(contextFor(`card${gap(CONTEXT_WINDOW - 4)}`, '', 'CARD')).toBe(true);
    expect(contextFor(`card${gap(CONTEXT_WINDOW - 3)}`, '', 'CARD')).toBe(false);
    expect(contextFor('', `${gap(CONTEXT_WINDOW - 4)}card`, 'CARD')).toBe(true);
    expect(contextFor('', `${gap(CONTEXT_WINDOW - 3)}card`, 'CARD')).toBe(false);
  });

  it('judges a keyword at the window edge by its real neighbours', () => {
    // The window starts exactly at "card" inside "discard": the letters just
    // outside the window still make it a different word.
    const before = `discard${' '.repeat(CONTEXT_WINDOW - 4)}`;
    expect(contextFor(before, '', 'CARD')).toBe(false);
    // And a keyword whose end is cut off by the window edge does not count.
    expect(contextFor('', `${' '.repeat(CONTEXT_WINDOW - 3)}card`, 'CARD')).toBe(false);
  });

  it('sees keywords at the very start and end of the text', () => {
    expect(contextFor('card ', '', 'CARD')).toBe(true);
    expect(contextFor('', ' card', 'CARD')).toBe(true);
  });
});

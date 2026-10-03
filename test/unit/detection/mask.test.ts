// Detection never reads a value in placeholder-shaped text, but still reads
// its keyword (ADR-038, bug-log 61). The masked copy is one character for
// one character, checked, and aligned with the original after normalisation.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkMasked, detect, MASK_FILLER, maskSpans } from '../../../src/detection/detect.js';
import { checkAligned, normalise } from '../../../src/detection/normalise.js';
import { PlaceholderMapping } from '../../../src/redaction/mapping.js';
import { redactMessage } from '../../../src/redaction/redact.js';
import { restore } from '../../../src/redaction/restore.js';
import { ALL_NAMESPACES, bracketPattern } from '../../../src/redaction/variants.js';
import { assertPropertyQuietly } from '../../support/quiet-property.js';

const LITERALS = bracketPattern(ALL_NAMESPACES);
const PASSPORT = 'Z' + '1234567';
const VOTER = 'ABC' + '1234567';
const literalSpans = (text: string) =>
  [...text.matchAll(LITERALS)].map((m) => ({ start: m.index, end: m.index + m[0].length }));

/** Redacts names off, and checks the round trip. */
function sent(text: string): string {
  const mapping = new PlaceholderMapping();
  const out = redactMessage(text, mapping);
  expect(restore(out, mapping)).toBe(text);
  return out;
}

describe('maskSpans and checkMasked', () => {
  it('replaces each code unit of each span with the filler, and nothing else', () => {
    expect(MASK_FILLER).toBe('░');
    const text = 'ab[PAN_1]cd[x]e';
    const masked = maskSpans(text, [
      { start: 2, end: 9 },
      { start: 11, end: 14 },
    ]);
    expect(masked).toBe(`ab${MASK_FILLER.repeat(7)}cd${MASK_FILLER.repeat(3)}e`);
    expect(maskSpans(text, [])).toBe(text);
  });

  it('refuses a copy of another length, a change outside a span, and a change that is not the filler', () => {
    expect(() => checkMasked('abc', 'ab', [])).toThrow('the length changed');
    expect(() => checkMasked('abc', 'aXc', [])).toThrow('a change outside a span');
    expect(() => checkMasked('abc', `${MASK_FILLER}bc`, [{ start: 1, end: 2 }])).toThrow(
      'a change outside a span',
    );
    expect(() => checkMasked('abc', 'aXc', [{ start: 1, end: 2 }])).toThrow(
      'a change outside a span',
    );
    expect(() => checkMasked('abc', `a${MASK_FILLER}c`, [{ start: 1, end: 2 }])).not.toThrow();
  });

  it('checkAligned refuses two normalisations whose offset maps differ', () => {
    expect(() => checkAligned(normalise('ab'), normalise('abc'))).toThrow('lengths differ');
    // "½" becomes three units from one; "1/2" three from three.
    expect(() => checkAligned(normalise('x½'), normalise('x1/2'))).toThrow('offsets differ');
    expect(() =>
      checkAligned(normalise('a[b]'), normalise(`a${MASK_FILLER.repeat(3)}`)),
    ).not.toThrow();
  });

  it('every placeholder-shaped text in random text masks to an aligned copy (long s included)', () => {
    const pieces = fc.constantFrom(
      '[PAN_1]',
      '[pan 1]',
      '[PERſON_2]',
      '[LITERAL_3]',
      ' ',
      'Asha',
      '1234',
      '\u0301',
      '½',
      '\u00AD',
      '\uFDFA',
      '@x.org',
    );
    assertPropertyQuietly(
      fc.property(fc.array(pieces, { maxLength: 20 }), (parts) => {
        const text = parts.join('');
        const spans = literalSpans(text);
        const masked = maskSpans(text, spans);
        checkMasked(text, masked, spans);
        checkAligned(normalise(masked), normalise(text));
        detect(text, undefined, spans);
        return masked.length === text.length;
      }),
      { numRuns: 1_000 },
    );
  });
});

describe('detect with hidden spans: values are not read there, keywords are', () => {
  it('a value is not read in a hidden span', () => {
    // A 12-digit run inside the span is not a value once hidden.
    const text = 'x [CARD 123456789012] y';
    const span = { start: 2, end: 21 };
    expect(detect(text).length).toBeGreaterThan(0);
    expect(detect(text, undefined, [span])).toEqual([]);
  });

  it('bug-log 61: a credential word, a placeholder with a space, then the value: the value is found', () => {
    expect(sent('password: [pan 1]Abcde@12')).toBe('password: [LITERAL_1][SECRET_1]');
    expect(sent('token: [Aadhaar 2]Qwerty#987 ok')).toBe('token: [LITERAL_1][SECRET_1] ok');
  });

  it('intended: a type word inside a placeholder is a keyword for a value near it (over-redaction, the safe direction)', () => {
    // Each value here is found only with a keyword nearby: an Aadhaar that
    // fails its check, a passport, a voter ID, an IFSC at an unknown bank, a
    // UPI ID at an unknown handle, a date of birth.
    expect(sent('replace [AADHAAR_1] with 2345 6789 0123')).toBe(
      'replace [LITERAL_1] with [AADHAAR_1]',
    );
    // Built at run time: no passport or voter shape is typed next to its
    // keyword in a file (repo-hygiene).
    expect(sent(`[PASSPORT_1] ${PASSPORT}`)).toBe('[LITERAL_1] [PASSPORT_1]');
    expect(sent(`[VOTER_1] -> ${VOTER}`)).toBe('[LITERAL_1] -> [VOTER_1]');
    expect(sent('not [IFSC_1] but QQQQ0123456')).toBe('not [LITERAL_1] but [IFSC_1]');
    expect(sent('[UPI_1] is asha@qqbank')).toBe('[LITERAL_1] is [UPI_1]');
    expect(sent('[dob 1] = 07/03/1991')).toBe('[LITERAL_1] = [DOB_1]');
  });

  it('the same values with no keyword anywhere are not found (the keyword is what found them)', () => {
    expect(sent('replace it with 2345 6789 0123')).toBe('replace it with 2345 6789 0123');
    expect(sent(`see ${PASSPORT}`)).toBe(`see ${PASSPORT}`);
  });
});

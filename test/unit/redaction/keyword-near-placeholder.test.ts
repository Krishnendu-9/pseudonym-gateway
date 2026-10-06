// Values next to placeholder-shaped text the user typed (ADR-002): a
// credential word followed by a placeholder, then the value (bug-log 61, a
// known limitation), and a type word inside a placeholder acting as the
// keyword for a value near it (over-redaction, the safe direction).

import { describe, expect, it } from 'vitest';
import { PlaceholderMapping } from '../../../src/redaction/mapping.js';
import { redactMessage } from '../../../src/redaction/redact.js';
import { restore } from '../../../src/redaction/restore.js';

// Built at run time: no passport or voter shape is typed next to its
// keyword in a file (repo-hygiene).
const PASSPORT = 'Z' + '1234567';
const VOTER = 'ABC' + '1234567';

/** Redacts names off, and checks the round trip. */
function sent(text: string): string {
  const mapping = new PlaceholderMapping();
  const out = redactMessage(text, mapping);
  expect(restore(out, mapping)).toBe(text);
  return out;
}

describe('bug-log 61, a known limitation: a credential word, a placeholder, then the value', () => {
  it('after a placeholder with a space in it, the value is sent as written', () => {
    // The keyword's value is read from inside the placeholder and ends at
    // its space; the value after the placeholder is never read (ADR-038,
    // final amendment: left unfixed after two fixes did worse).
    expect(sent('password: [pan 1]Abcde@12')).toBe('password: [LITERAL_1]Abcde@12');
    expect(sent('token: [Aadhaar 2]Qwerty#987 ok')).toBe('token: [LITERAL_1]Qwerty#987 ok');
  });

  it('after a placeholder with no space in it, the value is found (cut around it, bug-log 58)', () => {
    expect(sent('password: [PAN_1]Abcde@12')).toBe('password: [LITERAL_1][SECRET_1]');
  });
});

describe('a type word inside a placeholder is a keyword for a value near it', () => {
  it('values found only with a keyword nearby are found with one inside a placeholder', () => {
    // An Aadhaar that fails its check, a passport, a voter ID, an IFSC at an
    // unknown bank, a UPI ID at an unknown handle, a date of birth.
    expect(sent('replace [AADHAAR_1] with 2345 6789 0123')).toBe(
      'replace [LITERAL_1] with [AADHAAR_1]',
    );
    expect(sent(`[PASSPORT_1] ${PASSPORT}`)).toBe('[LITERAL_1] [PASSPORT_1]');
    expect(sent(`[VOTER_1] -> ${VOTER}`)).toBe('[LITERAL_1] -> [VOTER_1]');
    expect(sent('not [IFSC_1] but QQQQ0123456')).toBe('not [LITERAL_1] but [IFSC_1]');
    expect(sent('[UPI_1] is asha@qqbank')).toBe('[LITERAL_1] is [UPI_1]');
    expect(sent('[dob 1] = 07/03/1991')).toBe('[LITERAL_1] = [DOB_1]');
  });

  it('the same values with no keyword anywhere are not found', () => {
    expect(sent('replace it with 2345 6789 0123')).toBe('replace it with 2345 6789 0123');
    expect(sent(`see ${PASSPORT}`)).toBe(`see ${PASSPORT}`);
  });
});

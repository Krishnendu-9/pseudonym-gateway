// Two facts about libphonenumber-js's metadata that the spaced-mobile
// detector's design rests on, and that make mutations S4 and S6 equivalent
// (testing guide, "Every mutant called equivalent or unreachable,
// re-examined"). The package is pinned exactly (ADR-036, next to the
// runtime pin), and a bump must pass this file: if either fact stops
// holding, S4 or S6 becomes a real mutant no other test catches.

import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { describe, expect, it } from 'vitest';
import { createRng } from '../../../src/synthetic/rng.js';

const validInIndia = (digits: string): boolean =>
  parsePhoneNumberFromString(digits, 'IN')?.isValid() === true;

describe('libphonenumber-js metadata, as spaced-mobile.ts relies on it', () => {
  it('S6: every 10-digit number starting 6 to 9 is a valid Indian number (each 5-digit prefix, two endings)', () => {
    let invalid = 0;
    for (let prefix = 60_000; prefix <= 99_999; prefix++) {
      for (const ending of ['00000', '99999']) {
        if (!validInIndia(`${prefix}${ending}`)) invalid++;
      }
    }
    expect(invalid).toBe(0);
  });

  it('S4: no number of 6 to 9 digits starting 6 to 9 is a valid Indian number (40,000 random)', () => {
    const rng = createRng(20_261_003);
    let valid = 0;
    for (let i = 0; i < 40_000; i++) {
      let digits = String(rng.int(6, 9));
      for (let k = rng.int(6, 9) - 1; k > 0; k--) digits += String(rng.int(0, 9));
      if (validInIndia(digits)) valid++;
    }
    expect(valid).toBe(0);
  });
});

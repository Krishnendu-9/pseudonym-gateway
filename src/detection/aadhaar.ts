// Aadhaar: 12 digits, usually written 4-4-4. Validated (ADR-003) when the
// first digit is 2-9 and the last digit is a Verhoeff check digit over the
// first 11. Any other 12-digit number is an unvalidated candidate, accepted
// only with a keyword such as "aadhaar" nearby (ADR-010).
//
// The 16-digit Aadhaar Virtual ID is not detected yet.

import { digitWindows, standsAlone } from './digit-runs.js';
import type { Candidate } from './types.js';
import { isVerhoeffValid } from './verhoeff.js';

const AADHAAR_LAYOUTS = [[4, 4, 4]] as const;
const FIRST_DIGIT = /^[2-9]/;

export function isValidAadhaar(digits: string): boolean {
  return digits.length === 12 && FIRST_DIGIT.test(digits) && isVerhoeffValid(digits);
}

export function* aadhaarCandidates(text: string): Generator<Candidate> {
  for (const w of digitWindows(text, 12, 12)) {
    if (!standsAlone(w, AADHAAR_LAYOUTS)) continue;
    yield { type: 'AADHAAR', start: w.start, end: w.end, validated: isValidAadhaar(w.digits) };
  }
}

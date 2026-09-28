// Verhoeff check digit, used by Aadhaar (the 12th digit is a Verhoeff check
// digit over the first 11). Unlike Luhn it catches every single-digit error and
// every swap of two adjacent digits, because it multiplies in the dihedral
// group D5, which is not commutative.
//
// Reference: https://en.wikipedia.org/wiki/Verhoeff_algorithm
// Test vectors: https://rosettacode.org/wiki/Verhoeff_algorithm

// Multiplication table of D5.
const D: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

// Position-dependent permutation: row i is applied to the digit at position
// i (mod 8), counting from the right. Row i is row 1 applied i times.
const P: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

// Multiplicative inverse of each element of D5.
const INV: readonly number[] = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

const ASCII_DIGITS = /^[0-9]+$/;

/** Runs the Verhoeff checksum from the right; `offset` is 1 when the check digit is not yet present. */
function checksum(digits: string, offset: number): number {
  let c = 0;
  for (let i = 0; i < digits.length; i++) {
    const digit = digits.charCodeAt(digits.length - 1 - i) - 48;
    c = D[c]![P[(i + offset) % 8]![digit]!]!;
  }
  return c;
}

/**
 * Returns the Verhoeff check digit for `payload` as a one-character string.
 * Throws if `payload` is not a non-empty string of ASCII digits. The error
 * message never includes the input, since it may be a personal value.
 */
export function verhoeffCheckDigit(payload: string): string {
  if (!ASCII_DIGITS.test(payload)) {
    throw new TypeError('verhoeffCheckDigit: expected a non-empty string of ASCII digits');
  }
  return String(INV[checksum(payload, 1)]);
}

/**
 * True if `digits` (payload followed by its check digit) passes the Verhoeff
 * check. Returns false for anything that is not at least two ASCII digits.
 */
export function isVerhoeffValid(digits: string): boolean {
  return digits.length >= 2 && ASCII_DIGITS.test(digits) && checksum(digits, 0) === 0;
}

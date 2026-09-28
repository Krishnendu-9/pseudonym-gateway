// Luhn (mod 10) check digit, used by payment card numbers. It catches every
// single-digit error and most adjacent swaps, but not 09 <-> 90, and about 1
// in 10 random digit strings pass it. A Luhn pass alone is weak evidence.
//
// Reference: https://en.wikipedia.org/wiki/Luhn_algorithm

const ASCII_DIGITS = /^[0-9]+$/;

/** Luhn sum from the right; digits at odd positions (counting from `firstDoubled`) are doubled. */
function luhnSum(digits: string, firstDoubled: 0 | 1): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === firstDoubled) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum;
}

/**
 * Returns the Luhn check digit for `payload` as a one-character string.
 * Throws if `payload` is not a non-empty string of ASCII digits. The error
 * message never includes the input, since it may be a personal value.
 */
export function luhnCheckDigit(payload: string): string {
  if (!ASCII_DIGITS.test(payload)) {
    throw new TypeError('luhnCheckDigit: expected a non-empty string of ASCII digits');
  }
  return String((10 - (luhnSum(payload, 0) % 10)) % 10);
}

/**
 * True if `digits` (payload followed by its check digit) passes the Luhn
 * check. Returns false for anything that is not at least two ASCII digits.
 */
export function isLuhnValid(digits: string): boolean {
  return digits.length >= 2 && ASCII_DIGITS.test(digits) && luhnSum(digits, 1) % 10 === 0;
}

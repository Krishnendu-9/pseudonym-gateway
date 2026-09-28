// Decimal digits (\p{Nd}) worked out from the running Node's Unicode data,
// independently of the generated table in src/detection/decimal-digit-zeros.ts.
// Tests use these as the oracle the table and normalise() are checked against.

const DECIMAL_DIGIT = /^\p{Nd}$/u;
const MAX_CODE_POINT = 0x10ffff;

export const isDecimalDigit = (cp: number): boolean => DECIMAL_DIGIT.test(String.fromCodePoint(cp));

/** Start of the contiguous run of decimal digits that contains cp. */
export function runStart(cp: number): number {
  let start = cp;
  while (start > 0 && isDecimalDigit(start - 1)) start--;
  return start;
}

/**
 * Value 0-9 of a decimal digit. Unicode assigns decimal digits in runs of
 * 0-9 in ascending order, so the value is the offset into the run, mod 10.
 */
export const decimalDigitValue = (cp: number): number => (cp - runStart(cp)) % 10;

let all: number[] | undefined;

/** Every decimal digit code point, ascending. Computed once (about 0.1 s). */
export function allDecimalDigits(): readonly number[] {
  if (!all) {
    all = [];
    for (let cp = 0; cp <= MAX_CODE_POINT; cp++) if (isDecimalDigit(cp)) all.push(cp);
  }
  return all;
}

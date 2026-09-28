import { describe, expect, it } from 'vitest';
import { DECIMAL_DIGIT_ZEROS } from '../../../src/detection/decimal-digit-zeros.js';
import { allDecimalDigits, isDecimalDigit, runStart } from '../../support/decimal-digits.js';

// The table is generated, and it must match this Node's Unicode data exactly.
// If a Node upgrade adds digit blocks, these fail: run `npm run gen:digits`.
const REGENERATE = 'decimal-digit table is out of date for this Node: run `npm run gen:digits`';

describe('DECIMAL_DIGIT_ZEROS', () => {
  it('is strictly ascending, with blocks that never overlap', () => {
    for (let i = 1; i < DECIMAL_DIGIT_ZEROS.length; i++) {
      expect(DECIMAL_DIGIT_ZEROS[i]! - DECIMAL_DIGIT_ZEROS[i - 1]!).toBeGreaterThanOrEqual(10);
    }
  });

  it('lists only whole blocks of ten decimal digits', () => {
    const broken = DECIMAL_DIGIT_ZEROS.filter((zero) => {
      for (let d = 0; d < 10; d++) if (!isDecimalDigit(zero + d)) return true;
      return false;
    });
    expect(broken, REGENERATE).toEqual([]);
  });

  it('starts every block at digit zero, not part-way through a run', () => {
    // A run can hold several blocks back to back (the five sets of
    // mathematical digits at U+1D7CE-U+1D7FF), so zero sits a multiple of
    // ten into its run.
    const misaligned = DECIMAL_DIGIT_ZEROS.filter((zero) => (zero - runStart(zero)) % 10 !== 0);
    expect(misaligned, REGENERATE).toEqual([]);
  });

  it('covers every decimal digit this Node knows about', () => {
    // With whole, non-overlapping blocks, equal counts mean equal sets.
    expect(DECIMAL_DIGIT_ZEROS.length * 10, REGENERATE).toBe(allDecimalDigits().length);
  });

  it('includes the ASCII, Devanagari and other Indian-script blocks', () => {
    // ASCII, Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam
    for (const zero of [0x30, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66]) {
      expect(DECIMAL_DIGIT_ZEROS).toContain(zero);
    }
  });
});

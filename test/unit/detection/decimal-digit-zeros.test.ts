import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DECIMAL_DIGIT_UNICODE,
  DECIMAL_DIGIT_ZEROS,
} from '../../../src/detection/decimal-digit-zeros.js';
import {
  allDecimalDigits,
  isDecimalDigit,
  newerUnicodeBlocks,
  runStart,
} from '../../support/decimal-digits.js';

// The table is generated on the Node in .nvmrc, but `engines` allows Nodes
// with other Unicode versions (bug-log 44). So the rules are:
// - every Node: each block is ten digits this Node knows, or a block from a
//   newer Unicode that this Node has not assigned at all (mapping those is
//   harmless and fails closed); and every digit this Node knows is covered,
//   since one it knows but the table lacks reaches the detectors unmapped;
// - a Node with the table's Unicode version: the table matches it exactly;
// - the Node in .nvmrc, which CI runs: it has the table's Unicode version.
const REGENERATE = 'this Node knows decimal digits the table lacks: run `npm run gen:digits`';
const WRONG = 'the table holds a block that is not ten decimal digits: run `npm run gen:digits`';
const NVMRC = readFileSync(new URL('../../../.nvmrc', import.meta.url), 'utf8').trim();

const knownZeros = (): number[] =>
  DECIMAL_DIGIT_ZEROS.filter((zero) => !newerUnicodeBlocks().includes(zero));

describe('DECIMAL_DIGIT_ZEROS', () => {
  it('is strictly ascending, with blocks that never overlap', () => {
    for (let i = 1; i < DECIMAL_DIGIT_ZEROS.length; i++) {
      expect(DECIMAL_DIGIT_ZEROS[i]! - DECIMAL_DIGIT_ZEROS[i - 1]!).toBeGreaterThanOrEqual(10);
    }
  });

  it('lists only whole blocks of ten decimal digits, or blocks this Node has not assigned', () => {
    const broken = knownZeros().filter((zero) => {
      for (let d = 0; d < 10; d++) if (!isDecimalDigit(zero + d)) return true;
      return false;
    });
    expect(broken, WRONG).toEqual([]);
  });

  it('starts every block at digit zero, not part-way through a run', () => {
    // A run can hold several blocks back to back (the five sets of
    // mathematical digits at U+1D7CE-U+1D7FF), so zero sits a multiple of
    // ten into its run.
    const misaligned = knownZeros().filter((zero) => (zero - runStart(zero)) % 10 !== 0);
    expect(misaligned, WRONG).toEqual([]);
  });

  it('covers every decimal digit this Node knows about', () => {
    // With whole, non-overlapping blocks, equal counts mean equal sets.
    expect(knownZeros().length * 10, REGENERATE).toBe(allDecimalDigits().length);
  });

  it.runIf(process.versions.unicode === DECIMAL_DIGIT_UNICODE)(
    'matches this Node exactly, since it has the Unicode the table was made from',
    () => {
      // With the coverage test, no block from a newer Unicode means equal sets.
      expect(newerUnicodeBlocks()).toEqual([]);
    },
  );

  it.runIf(process.version === `v${NVMRC}`)(
    'was generated from the Unicode of the Node in .nvmrc',
    () => {
      expect(DECIMAL_DIGIT_UNICODE, 'run `npm run gen:digits` on the Node in .nvmrc').toBe(
        process.versions.unicode,
      );
    },
  );

  it('includes the ASCII, Devanagari and other Indian-script blocks', () => {
    // ASCII, Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu,
    // Kannada, Malayalam, and Tolong Siki (Kurukh; new in Unicode 17.0)
    for (const zero of [
      0x30, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0x11de0,
    ]) {
      expect(DECIMAL_DIGIT_ZEROS).toContain(zero);
    }
  });
});

// Ways real text disguises a value without changing what a reader sees:
// digits from other scripts or compatibility forms, and invisible characters
// between them. Used to test that normalisation undoes each of them.

import type { Rng } from './rng.js';

export type DigitStyle = 'ascii' | 'fullWidth' | 'devanagari' | 'mathBold';

// Code point of the digit zero in each style; the other digits follow it.
const ZERO: Record<DigitStyle, number> = {
  ascii: 0x30,
  fullWidth: 0xff10, // FULLWIDTH DIGIT ZERO
  devanagari: 0x0966, // DEVANAGARI DIGIT ZERO
  mathBold: 0x1d7ce, // MATHEMATICAL BOLD DIGIT ZERO (outside the BMP: two UTF-16 units)
};

export const DIGIT_STYLES = Object.keys(ZERO) as readonly DigitStyle[];

/** Rewrites every ASCII digit in `s` in the given style; other characters are unchanged. */
export function styleDigits(s: string, style: DigitStyle): string {
  return s.replace(/[0-9]/g, (d) => String.fromCodePoint(ZERO[style] + Number(d)));
}

// Invisible characters seen in pasted text. All are Default_Ignorable_Code_Point.
export const INVISIBLES = [
  '​', // zero width space
  '‌', // zero width non-joiner
  '‍', // zero width joiner
  '⁠', // word joiner
  '﻿', // zero width no-break space (BOM)
  '­', // soft hyphen
  '‎', // left-to-right mark
  '‏', // right-to-left mark
  '⁦', // left-to-right isolate
  '⁩', // pop directional isolate
] as const;

/**
 * Disguises `s` the way pasted or deliberately obscured text might: each
 * ASCII digit gets a random style, and random invisible characters are
 * inserted between (never before or after) the code points of `s`.
 */
export function obfuscate(s: string, rng: Rng, invisibleProbability = 0.3): string {
  if (!(invisibleProbability >= 0 && invisibleProbability < 1)) {
    throw new RangeError('obfuscate: invisibleProbability must be in [0, 1)');
  }
  const chars = [...s];
  let out = '';
  chars.forEach((ch, i) => {
    if (i > 0) {
      while (rng.chance(invisibleProbability)) out += rng.pick(INVISIBLES);
    }
    out += styleDigits(ch, rng.pick(DIGIT_STYLES));
  });
  return out;
}

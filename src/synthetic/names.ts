// Person names for the Phase 6 names dataset (ADR-035), written the ways
// people write them: a full name, a given name alone, three parts,
// initials, with an honorific, all lower case, all capitals; in Latin
// script or Devanagari.
//
// The parts come from the `eval` half of the Wikidata lists, paired at
// random in memory. A pair can coincide with a real person's name; ADR-035
// says why that is accepted. Like every generated value (ADR-009), a
// written name is never stored or printed.

import type { Rng } from './rng.js';
import { WIKIDATA_NAMES, type NamePart, type NameRegion } from './wikidata-names.js';

export const NAME_FORMS = [
  'full',
  'given',
  'three-part',
  'initials',
  'honorific',
  'lower',
  'upper',
] as const;
export type NameForm = (typeof NAME_FORMS)[number];

/** The forms Devanagari has: it has no initials and no letter case. */
export const DEVANAGARI_FORMS: readonly NameForm[] = ['full', 'given', 'three-part', 'honorific'];

export type NameScript = 'latin' | 'devanagari';

/**
 * A name as written in a message: the name itself, and an honorific
 * before or after it ("Mr ", " ji"), which is not part of the name.
 */
export interface WrittenName {
  readonly before: string;
  readonly name: string;
  readonly after: string;
}

const HONORIFICS_BEFORE: Readonly<Record<NameScript, readonly string[]>> = {
  latin: ['Mr ', 'Mrs ', 'Ms ', 'Dr ', 'Shri ', 'Smt '],
  devanagari: ['श्री ', 'श्रीमती ', 'डॉ. '],
};
const HONORIFICS_AFTER: Readonly<Record<NameScript, readonly string[]>> = {
  latin: [' ji', ' bhai', ' sir', ' madam'],
  devanagari: [' जी'],
};
const UPPER = 'ABCDEFGHIJKLMNOPRSTUVY';

/**
 * A name from `region` in `script` and `form`. Throws for a form
 * Devanagari does not have. Every region's `eval` half has at least two
 * Devanagari spellings of each kind (tested), so every form can be written.
 */
export function writtenName(
  rng: Rng,
  region: NameRegion,
  script: NameScript,
  form: NameForm,
): WrittenName {
  if (script === 'devanagari' && !DEVANAGARI_FORMS.includes(form)) {
    throw new RangeError(`writtenName: Devanagari has no ${form} form`);
  }
  const spell = (part: NamePart): string | undefined => (script === 'latin' ? part[0] : part[1]);
  const pool = (parts: readonly NamePart[]): string[] =>
    parts.map(spell).filter((s): s is string => s !== undefined);
  const given = pool(WIKIDATA_NAMES[region].evalGiven);
  const family = pool(WIKIDATA_NAMES[region].evalFamily);

  const g = rng.pick(given);
  const f = rng.pick(family);
  const full = `${g} ${f}`;
  const plain = (name: string): WrittenName => ({ before: '', name, after: '' });
  const initial = (): string => UPPER[rng.int(0, UPPER.length - 1)]!;
  switch (form) {
    case 'full':
      return plain(full);
    case 'given':
      return plain(g);
    case 'three-part': {
      const others = given.filter((name) => name !== g);
      return plain(`${g} ${rng.pick(others)} ${f}`);
    }
    case 'initials':
      // Never a trailing initial: its full stop would end the name.
      return plain(
        rng.pick([
          `${initial()}. ${g}`,
          `${initial()}. ${initial()}. ${g}`,
          `${initial()} ${g}`,
          `${initial()}. ${f}`,
        ]),
      );
    case 'honorific':
      return rng.chance(0.5)
        ? { before: rng.pick(HONORIFICS_BEFORE[script]), name: rng.pick([full, f]), after: '' }
        : { before: '', name: g, after: rng.pick(HONORIFICS_AFTER[script]) };
    case 'lower':
      return plain(full.toLowerCase());
    case 'upper':
      return plain(full.toUpperCase());
  }
}

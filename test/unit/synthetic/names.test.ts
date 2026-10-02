// Names written for the Phase 6 names dataset (ADR-035). A written name may
// coincide with a real person's, so it is treated like every generated
// value (ADR-009): checks return booleans inside assertPropertyQuietly and
// a failure reports a seed, never a name.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEVANAGARI_FORMS,
  NAME_FORMS,
  writtenName,
  type NameForm,
  type NameScript,
} from '../../../src/synthetic/names.js';
import { createRng } from '../../../src/synthetic/rng.js';
import {
  NAME_REGIONS,
  WIKIDATA_NAMES,
  type NamePart,
  type NameRegion,
} from '../../../src/synthetic/wikidata-names.js';
import { assertPropertyQuietly, seedArb } from '../../support/quiet-property.js';

const spellings = (parts: readonly NamePart[], script: NameScript): Set<string> =>
  new Set(parts.flatMap((p) => (script === 'latin' ? [p[0]] : p[1] === undefined ? [] : [p[1]])));

const regionArb = fc.constantFrom(...NAME_REGIONS);
const holds = (
  check: (seed: number, region: NameRegion, form: NameForm) => boolean,
  forms: readonly NameForm[] = NAME_FORMS,
): void => {
  assertPropertyQuietly(fc.property(seedArb, regionArb, fc.constantFrom(...forms), check), {
    numRuns: 500,
  });
};

const DEVANAGARI_WORD = /^[ऀ-ॿ]+$/u;
const LATIN_WORD = /^(?:[A-Z]'|Mc|Mac)?[A-Z][a-z]+(?:-[A-Z][a-z]+)?$/;

describe('the Wikidata name lists', () => {
  it('have two halves per region that share no spelling, across all regions', () => {
    const half = (which: 'eval' | 'gazetteer'): string[] =>
      Object.values(WIKIDATA_NAMES).flatMap((r) =>
        [...r[`${which}Given`], ...r[`${which}Family`]].map((p) => p[0].toLowerCase()),
      );
    const gazetteer = new Set(half('gazetteer'));
    expect(half('eval').filter((n) => gazetteer.has(n))).toEqual([]);
  });

  it('hold well-formed spellings only, and enough of them in every region', () => {
    const parts = Object.values(WIKIDATA_NAMES).flatMap((r) => Object.values(r).flat());
    expect(parts.every((p) => LATIN_WORD.test(p[0]))).toBe(true);
    expect(parts.every((p) => p[1] === undefined || DEVANAGARI_WORD.test(p[1]))).toBe(true);
    for (const region of NAME_REGIONS) {
      const r = WIKIDATA_NAMES[region];
      const counts = [r.evalGiven.length, r.evalFamily.length].map((n) => n >= 30);
      const devanagari = [r.evalGiven, r.evalFamily].map(
        (p) => spellings(p, 'devanagari').size >= 2,
      );
      expect([region, ...counts, ...devanagari]).toEqual([region, true, true, true, true]);
    }
  });
});

describe('writtenName', () => {
  it('writes every form from the eval half of the region, in Latin script', () => {
    holds((seed, region, form) => {
      const written = writtenName(createRng(seed), region, 'latin', form);
      const given = spellings(WIKIDATA_NAMES[region].evalGiven, 'latin');
      const family = spellings(WIKIDATA_NAMES[region].evalFamily, 'latin');
      const words = written.name.split(' ');
      const known = (w: string, from: Set<string>): boolean =>
        from.has(w) || [...from].some((n) => n.toLowerCase() === w.toLowerCase());
      switch (form) {
        case 'full':
          return words.length === 2 && given.has(words[0]!) && family.has(words[1]!);
        case 'given':
          return words.length === 1 && given.has(words[0]!);
        case 'three-part':
          return (
            words.length === 3 &&
            given.has(words[0]!) &&
            given.has(words[1]!) &&
            words[0] !== words[1] &&
            family.has(words[2]!)
          );
        case 'initials':
          // One or two initials, then a given or a family name; never an initial last.
          return (
            /^(?:[A-Z]\.? ){1}(?:[A-Z]\. )?\S+$/.test(written.name) &&
            (given.has(words.at(-1)!) || family.has(words.at(-1)!))
          );
        case 'honorific':
          return (
            (written.before !== '') !== (written.after !== '') &&
            words.every((w) => known(w, given) || known(w, family))
          );
        case 'lower':
          return (
            words.length === 2 &&
            written.name === written.name.toLowerCase() &&
            words.every((w) => known(w, given) || known(w, family))
          );
        case 'upper':
          return (
            words.length === 2 &&
            written.name === written.name.toUpperCase() &&
            words.every((w) => known(w, given) || known(w, family))
          );
      }
    });
  });

  it('writes Devanagari names in Devanagari only, with Devanagari honorifics', () => {
    holds((seed, region, form) => {
      const written = writtenName(createRng(seed), region, 'devanagari', form);
      const text = `${written.before}${written.name}${written.after}`;
      return text
        .split(/[ .]+/)
        .filter(Boolean)
        .every((w) => DEVANAGARI_WORD.test(w));
    }, DEVANAGARI_FORMS);
  });

  it('has no Devanagari initials, lower case or capitals', () => {
    const rng = createRng(1);
    const missing = NAME_FORMS.filter((f) => !DEVANAGARI_FORMS.includes(f));
    expect(missing).toEqual(['initials', 'lower', 'upper']);
    for (const form of missing) {
      expect(() => writtenName(rng, 'north', 'devanagari', form)).toThrow(RangeError);
    }
  });

  it('puts honorifics before and after the name, never inside it', () => {
    const sides = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      const w = writtenName(createRng(seed), 'south', 'latin', 'honorific');
      sides.add(
        w.before !== '' ? `before:${w.before.endsWith(' ')}` : `after:${w.after.startsWith(' ')}`,
      );
    }
    expect([...sides].sort()).toEqual(['after:true', 'before:true']);
  });

  it('is the same for the same seed', () => {
    const a = writtenName(createRng(7), 'east', 'latin', 'full');
    const b = writtenName(createRng(7), 'east', 'latin', 'full');
    expect(a.name === b.name).toBe(true);
  });
});

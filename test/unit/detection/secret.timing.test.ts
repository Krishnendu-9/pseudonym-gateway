// Linear-time checks moved from secret.test.ts, names unchanged.
// They run in the `timing` project, after every other test and at most
// three files at a time, because load from other tests makes a growth
// ratio unreliable (vitest.config.ts, ADR-032).

import { describe, it } from 'vitest';
import { detect } from '../../../src/detection/detect.js';
import { secretCandidates } from '../../../src/detection/secret.js';
import { expectLinearTime } from '../../support/linear-time.js';

/** `n` characters of filler: letters in both cases and digits, no long digit stretch. */
const filler = (n: number, alphabet = 'aB3dE5fGh'): string =>
  alphabet.repeat(Math.ceil(n / alphabet.length)).slice(0, n);

const PEM_BEGIN = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');

// Each case makes the input 4 times longer and checks the time grows about
// 4 times, not 16 (test/support/linear-time.ts).
describe('secrets: linear time', () => {
  it.each([
    ['keywords chained by colons', (n: number) => `${'pin:'.repeat(n / 4)} x`],
    ['keywords chained by colons, with quotes', (n: number) => `${'pin:a"'.repeat(n / 6)} x`],
    ['keywords with no value', (n: number) => 'pin '.repeat(n / 4)],
    ['keywords in prose', (n: number) => 'password is wrong '.repeat(n / 18)],
    ['keywords chained by underscores', (n: number) => `${'pin_'.repeat(n / 4)} x`],
    [
      'keywords chained by underscores, then a line end',
      (n: number) => `${'pin_'.repeat(n / 4)}\n`,
    ],
    ['keywords chained by equals signs', (n: number) => `${'pin='.repeat(n / 4)} x`],
    ['a keyword and a long value without evidence', (n: number) => `token ${'a'.repeat(n)} x`],
    ['a keyword and a long run of blanks', (n: number) => `token${' '.repeat(n)}\nx`],
    ['sk- chains', (n: number) => 'sk-'.repeat(n / 3)],
    ['GitHub prefixes', (n: number) => 'ghp_'.repeat(n / 4)],
    ['Google prefixes joined by hyphens', (n: number) => 'AIza-'.repeat(n / 5)],
    ['JWT starts with no dot', (n: number) => 'eyJaaaaaaaa-'.repeat(n / 12)],
    ['JWT starts with dots', (n: number) => 'eyJaaaaaaaa.'.repeat(n / 12)],
    ['PEM BEGIN lines with no END', (n: number) => `${PEM_BEGIN}\n`.repeat(n / 32)],
    ['BEGIN with no label', (n: number) => '-----BEGIN A '.repeat(n / 13)],
  ])('scans %s in linear time', (_name, make) => {
    expectLinearTime(make, 25_000, detect);
  });
});

describe('secrets glued to other text', () => {
  it('the secret detector alone reads a chain of keys whose alphabet has no hyphen in linear time', () => {
    // Each key takes the rest of the token, the whole chain; the search must
    // then go on after it, not find every next key again. Timed on the
    // detector alone (the other detectors would hide a quadratic one), ten
    // scans per measurement, as one takes about a millisecond.
    const unit = ['gh', 'p_', filler(36), '-'].join('');
    const make = (n: number): string => unit.repeat(Math.ceil(n / unit.length));
    const work = (text: string): number => {
      let found = 0;
      for (let i = 0; i < 10; i++) found += [...secretCandidates(text)].length;
      return found;
    };
    expectLinearTime(make, 100_000, work);
  });

  it.each([
    ['a dotless chain of JWT headers', 'eyJabcdefghij-'],
    ['a chain of JWT header and payload parts', 'eyJabcdefghij.eyJabcdefghij-'],
    ['a chain of keys', 'sk-Abc123456789012345678-'],
  ])('reads %s in linear time', (_name, unit) => {
    const make = (n: number): string => unit.repeat(Math.ceil(n / unit.length));
    expectLinearTime(make, 25_000, detect);
  });
});

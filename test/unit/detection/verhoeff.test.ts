import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isVerhoeffValid, verhoeffCheckDigit } from '../../../src/detection/verhoeff.js';
import { assertPropertyQuietly } from '../../support/quiet-property.js';

const digitString = (minLength: number, maxLength: number) =>
  fc.string({ unit: fc.constantFrom(...'0123456789'), minLength, maxLength });

const withCheckDigit = (payload: string): string => payload + verhoeffCheckDigit(payload);

describe('Verhoeff: published reference vectors', () => {
  // https://rosettacode.org/wiki/Verhoeff_algorithm: "calculate check digits
  // for the integers 236, 12345 and 123456789012 and then validate them. Also
  // attempt to validate the same integers if the check digits in all cases
  // were 9". 236 -> 3 is also the worked example on Wikipedia.
  it.each([
    ['236', '3'],
    ['12345', '1'],
    ['123456789012', '0'],
  ])('%s has check digit %s', (payload, check) => {
    expect(verhoeffCheckDigit(payload)).toBe(check);
    expect(isVerhoeffValid(payload + check)).toBe(true);
    expect(isVerhoeffValid(payload + '9')).toBe(false);
  });
});

describe('Verhoeff: properties', () => {
  it('a payload followed by its check digit is valid', () => {
    assertPropertyQuietly(
      fc.property(digitString(1, 30), (p) => isVerhoeffValid(withCheckDigit(p))),
    );
  });

  it('exactly one of the ten possible check digits is valid', () => {
    assertPropertyQuietly(
      fc.property(digitString(1, 30), (p) => {
        const valid = [...'0123456789'].filter((c) => isVerhoeffValid(p + c));
        return valid.length === 1;
      }),
    );
  });

  it('detects every single-digit error', () => {
    assertPropertyQuietly(
      fc.property(digitString(1, 30), fc.nat(), fc.integer({ min: 1, max: 9 }), (p, at, delta) => {
        const digits = [...withCheckDigit(p)];
        const i = at % digits.length;
        digits[i] = String((Number(digits[i]) + delta) % 10);
        return !isVerhoeffValid(digits.join(''));
      }),
    );
  });

  it('detects every swap of two different adjacent digits', () => {
    assertPropertyQuietly(
      fc.property(digitString(1, 30), fc.nat(), (p, at) => {
        const digits = [...withCheckDigit(p)];
        const i = at % (digits.length - 1);
        const [a, b] = [digits[i]!, digits[i + 1]!];
        if (a === b) return true;
        digits[i] = b;
        digits[i + 1] = a;
        return !isVerhoeffValid(digits.join(''));
      }),
    );
  });

  // Regression guard for bug-log entry 2. Whether a swap is caught depends
  // only on the two digits and their position mod 8, so this checks every
  // case, including a swap with the check digit itself.
  it('detects every adjacent swap, exhaustively: all 8 positions x 90 digit pairs', () => {
    const missed: string[] = [];
    // Positions are counted from the right; the check digit is position 0.
    // Swapping positions p and p+1 for p = 1..8 covers every class mod 8.
    for (let p = 1; p <= 8; p++) {
      for (let a = 0; a <= 9; a++) {
        for (let b = 0; b <= 9; b++) {
          if (a === b) continue;
          const full = withCheckDigit(`${a}${b}${'0'.repeat(p - 1)}`);
          if (isVerhoeffValid(`${b}${a}${full.slice(2)}`)) missed.push(`p=${p} ${a}${b}`);
        }
      }
    }
    // Swapping the check digit with the digit before it.
    for (let a = 0; a <= 9; a++) {
      const [x, c] = [...withCheckDigit(`${a}`)] as [string, string];
      if (x !== c && isVerhoeffValid(`${c}${x}`)) missed.push(`check digit after ${a}`);
    }
    expect(missed).toEqual([]);
  });
});

// An independent reference, built without typing any table, so the
// implementation's hand-typed tables are checked against something that
// cannot share their typos:
// - D5 is computed from its definition: the 10 symmetries of a regular
//   pentagon acting on Z5. j < 5 is the rotation x -> x + j; j >= 5 is the
//   reflection x -> (j - 5) - x; d(j, k) is the symmetry "j after k".
// - P is computed from the permutation published on Wikipedia
//   (https://en.wikipedia.org/wiki/Verhoeff_algorithm): the cycle
//   (1 5 8 9 4 2 7 0)(3 6), applied i times for position i mod 8.
// - inv is found by search.
// The reference must reproduce the published Rosetta Code vectors, which
// shows its numbering and composition order match the real algorithm.
describe('Verhoeff: agrees with a reference derived from first principles', () => {
  const mod5 = (x: number): number => ((x % 5) + 5) % 5;
  const act = (j: number, x: number): number => (j < 5 ? mod5(j + x) : mod5(j - 5 - x));
  // A pentagon symmetry is fixed by where it sends 0 and 1.
  const d = (j: number, k: number): number => {
    const target = [0, 1].map((x) => act(j, act(k, x)));
    const m = [...Array(10).keys()].find((m) => act(m, 0) === target[0] && act(m, 1) === target[1]);
    if (m === undefined) throw new Error('not closed under composition');
    return m;
  };
  const inv = (j: number): number => [...Array(10).keys()].find((k) => d(j, k) === 0)!;

  const base = new Array<number>(10);
  for (const cycle of [
    [1, 5, 8, 9, 4, 2, 7, 0],
    [3, 6],
  ]) {
    cycle.forEach((x, i) => (base[x] = cycle[(i + 1) % cycle.length]!));
  }
  const p = (position: number, digit: number): number => {
    let x = digit;
    for (let i = 0; i < position % 8; i++) x = base[x]!;
    return x;
  };

  const referenceCheckDigit = (payload: string): string => {
    let c = 0;
    [...payload].reverse().forEach((ch, i) => (c = d(c, p(i + 1, Number(ch)))));
    return String(inv(c));
  };

  it('the reference reproduces the published vectors', () => {
    expect(referenceCheckDigit('236')).toBe('3');
    expect(referenceCheckDigit('12345')).toBe('1');
    expect(referenceCheckDigit('123456789012')).toBe('0');
  });

  // Exhaustive, so slow: 0.7 s alone, but 5.2 s (over Vitest's 5 s default)
  // when the whole suite runs in parallel, and 7.3 s under coverage
  // (bug-log entry 4).
  const EXHAUSTIVE_TIMEOUT_MS = 60_000;

  it(
    'matches the reference for every payload of 1 to 5 digits (111,110 payloads)',
    { timeout: EXHAUSTIVE_TIMEOUT_MS },
    () => {
      let mismatches = 0;
      for (let length = 1; length <= 5; length++) {
        for (let n = 0; n < 10 ** length; n++) {
          const payload = String(n).padStart(length, '0');
          const check = referenceCheckDigit(payload);
          const wrong = String((Number(check) + 1) % 10);
          if (
            verhoeffCheckDigit(payload) !== check ||
            !isVerhoeffValid(payload + check) ||
            isVerhoeffValid(payload + wrong)
          ) {
            mismatches++;
          }
        }
      }
      expect(mismatches).toBe(0);
    },
  );

  it('matches the reference for random payloads of 6 to 30 digits (reaches rows 6 and 7 of P)', () => {
    assertPropertyQuietly(
      fc.property(digitString(6, 30), (payload) => {
        return verhoeffCheckDigit(payload) === referenceCheckDigit(payload);
      }),
      { numRuns: 5000 },
    );
  });
});

describe('Verhoeff: input handling', () => {
  it.each(['', '0', 'abc', '2363 ', '23 63', '२३६३', '２３６３', '-2363'])(
    'isVerhoeffValid(%j) is false',
    (input) => {
      expect(isVerhoeffValid(input)).toBe(false);
    },
  );

  it.each(['', '23x', '२३६', ' 236'])('verhoeffCheckDigit(%j) throws', (input) => {
    expect(() => verhoeffCheckDigit(input)).toThrow(TypeError);
  });

  it('never puts the input in the error message', () => {
    const input = '98765x43210';
    expect(() => verhoeffCheckDigit(input)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('98765') }),
    );
  });
});

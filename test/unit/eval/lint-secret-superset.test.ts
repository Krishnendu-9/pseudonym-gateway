// The held-out lint's own key rule (`typed-secret`, eval/lint.ts) flags a
// key in every format the secret detector validates (ADR-021 item 3 note).
// The lint never imports the detector, so that passing or failing it tells
// the held-out author nothing about the detectors; this test is what keeps
// the two lists from drifting apart instead. The lint may flag more, never
// less.
//
// Keys are built at run time from the detector's own format list
// (KEY_FORMATS): each format is read (its literal prefixes, its alphabet and
// its minimum length), and for every prefix a key is built with each
// character of the alphabet in the first place after the prefix, where a
// lint prefix rule could be too narrow. A format this reader cannot read
// fails the test, so a new kind of format is looked at rather than skipped.
// JWTs and PEM blocks are found by the detector outside KEY_FORMATS and are
// built here too. Nothing key-shaped is typed in this file (ADR-022).
//
// Every key is first checked to be validated by the detector, so a key the
// reader built wrongly cannot pass for a lint gap. Failures name the format's
// index, the prefix and the character, never the key.

import { describe, expect, it } from 'vitest';
import { parseCases } from '../../../eval/format.js';
import { lintCases } from '../../../eval/lint.js';
import { KEY_FORMATS, secretCandidates } from '../../../src/detection/secret.js';
import { createRng, type Rng } from '../../../src/synthetic/rng.js';

/** The characters a class body such as `A-Za-z0-9_-` stands for. */
function classChars(body: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '\\') throw new Error('escape in a class');
    if (body[i + 1] === '-' && i + 2 < body.length) {
      const end = body.charCodeAt(i + 2);
      for (let code = body.charCodeAt(i); code <= end; code++) out.push(String.fromCharCode(code));
      i += 2;
    } else out.push(c);
  }
  return out;
}

/** Every literal string a prefix such as `gh[pousr]_` or `(?:AKIA|ASIA)` stands for. */
function prefixes(pattern: string): string[] {
  let found = [''];
  for (let i = 0; i < pattern.length;) {
    let choices: string[];
    if (pattern.startsWith('(?:', i)) {
      const close = pattern.indexOf(')', i);
      choices = pattern.slice(i + 3, close).split('|');
      i = close + 1;
    } else if (pattern[i] === '[') {
      const close = pattern.indexOf(']', i);
      choices = classChars(pattern.slice(i + 1, close));
      i = close + 1;
    } else if (/[A-Za-z0-9_-]/.test(pattern[i]!)) {
      choices = [pattern[i]!];
      i += 1;
    } else throw new Error('a prefix construct this reader does not know');
    if (choices.some((choice) => !/^[A-Za-z0-9_-]+$/.test(choice))) {
      throw new Error('a prefix choice that is not literal');
    }
    found = found.flatMap((head) => choices.map((choice) => head + choice));
  }
  return found;
}

interface Format {
  readonly prefixes: readonly string[];
  readonly alphabet: readonly string[];
  readonly min: number;
}

/** Reads one KEY_FORMATS entry: an optional named group around prefix, `[class]{min,}`. */
function readFormat(source: string): Format {
  const inner = /^\(\?<[a-z]+>(.*)\)$/.exec(source)?.[1] ?? source;
  const tail = /^(.*)\[([^\]]+)\]\{(\d+),\}$/.exec(inner);
  if (!tail) throw new Error('a format this reader does not know');
  return {
    prefixes: prefixes(tail[1]!),
    alphabet: classChars(tail[2]!),
    min: Number(tail[3]),
  };
}

const pick = (rng: Rng, alphabet: readonly string[], n: number): string =>
  Array.from({ length: n }, () => rng.pick(alphabet)).join('');

const ALNUM = classChars('A-Za-z0-9');
const BASE64URL = classChars('A-Za-z0-9_-');

/**
 * A key: the prefix, then `first`, then filler from the alphabet ending in
 * a capital and a digit (OpenAI-style `sk-` keys need one or the other).
 */
const keyOf = (rng: Rng, prefix: string, first: string, format: Format): string =>
  prefix + first + pick(rng, format.alphabet, Math.max(0, format.min - 3)) + 'Z9';

const flaggedByLint = (key: string): boolean =>
  lintCases(parseCases(`=== T | t\n@user\nthe key is ${key} ok`).cases).some(
    (problem) => problem.rule === 'typed-secret',
  );

const validatedByDetector = (key: string): boolean => {
  const text = `the key is ${key} ok`;
  const start = text.indexOf(key);
  return [...secretCandidates(text)].some(
    (candidate) => candidate.validated && candidate.start === start,
  );
};

describe('the held-out lint flags every key format the secret detector validates', () => {
  it('reads every detector format (a new kind of format fails here, not silently)', () => {
    expect(KEY_FORMATS.length).toBeGreaterThan(0);
    const unread: number[] = [];
    for (const [index, source] of KEY_FORMATS.entries()) {
      try {
        const format = readFormat(source);
        if (format.prefixes.length === 0 || format.alphabet.length === 0) unread.push(index);
      } catch {
        unread.push(index);
      }
    }
    expect(unread).toEqual([]);
  });

  it.each(KEY_FORMATS.map((source, index) => [index, source] as const))(
    'format %i: every prefix, with every alphabet character first',
    (index) => {
      const format = readFormat(KEY_FORMATS[index]!);
      const rng = createRng(index + 1);
      const notValidated: string[] = [];
      const missed: string[] = [];
      for (const prefix of format.prefixes) {
        for (const first of format.alphabet) {
          const key = keyOf(rng, prefix, first, format);
          if (!validatedByDetector(key)) notValidated.push(`${prefix} + ${first}`);
          else if (!flaggedByLint(key)) missed.push(`${prefix} + ${first}`);
        }
      }
      expect({ index, notValidated }).toEqual({ index, notValidated: [] });
      expect({ index, missed }).toEqual({ index, missed: [] });
    },
  );

  it('JWTs: every base64url character after "eyJ", in the header and the payload alike', () => {
    // Both parts get the same character: with an ordinary payload, the lint
    // would match the payload's "eyJ" and hide a narrow header rule.
    const rng = createRng(100);
    const missed: string[] = [];
    for (const first of BASE64URL) {
      const header = 'eyJ' + first + pick(rng, ALNUM, 9);
      const payload = 'eyJ' + first + pick(rng, ALNUM, 20);
      const key = [header, payload, pick(rng, BASE64URL, 43)].join('.');
      expect([first, validatedByDetector(key)]).toEqual([first, true]);
      if (!flaggedByLint(key)) missed.push(first);
    }
    expect(missed).toEqual([]);
  });

  it('a PEM private-key BEGIN line', () => {
    const pem = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
    expect(validatedByDetector(pem)).toBe(true);
    expect(flaggedByLint(pem)).toBe(true);
  });
});

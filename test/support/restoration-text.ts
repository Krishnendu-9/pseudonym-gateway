// Generators for restoration property tests (ADR-018): model answers built
// from the pieces restoration cares about, and ways to cut them into
// streamed chunks, biased towards cutting inside those pieces.
//
// No personal data: values are opaque strings, and none of the generated
// text looks like a real number.

import fc from 'fast-check';
import { PlaceholderMapping } from '../../src/redaction/mapping.js';
import { ALL_NAMESPACES, titleCase } from '../../src/redaction/variants.js';

/** Indices assigned in every namespace of `testMapping()`. */
export const ASSIGNED = 12;

/** Every namespace gets values at indices 1..ASSIGNED; index 2 is exact-only. */
export function testMapping(): PlaceholderMapping {
  const mapping = new PlaceholderMapping();
  for (const namespace of ALL_NAMESPACES) {
    for (let i = 1; i <= ASSIGNED; i++) {
      mapping.getOrAssign(namespace, `${namespace}:${i}`, `«${namespace.toLowerCase()}-${i}»`);
    }
    mapping.reserve(namespace, 2);
  }
  return mapping;
}

const caseOf = (tag: string, style: number): string => {
  switch (style) {
    case 0:
      return tag;
    case 1:
      return titleCase(tag);
    case 2:
      return tag.toLowerCase();
    default:
      return [...tag].map((ch, i) => (i % 2 ? ch.toLowerCase() : ch)).join('');
  }
};

const placeholderArb: fc.Arbitrary<string> = fc
  .record({
    tag: fc.constantFrom<string>(...ALL_NAMESPACES, 'PERSON', 'CAR'),
    index: fc.constantFrom('1', '2', '10', '12', '99', '1234', '9999', '10000', '0', '01'),
    style: fc.integer({ min: 0, max: 3 }),
    separator: fc.constantFrom('_', ' '),
    bracketed: fc.boolean(),
  })
  .map(({ tag, index, style, separator, bracketed }) => {
    const body = `${caseOf(tag, style)}${separator}${index}`;
    return bracketed ? `[${body}]` : body;
  });

/** Link, URL and HTML syntax, including every piece of the bug-13/14 forms. */
export const SYNTAX: readonly string[] = [
  '](',
  '](<',
  '![x](',
  '[x](',
  '![x][ref]',
  '[ref]:',
  '[ref]: ',
  '[',
  ']',
  ']:',
  '(',
  ')',
  '(1)',
  '<',
  '>',
  '\\',
  '> ',
  'https://',
  'http://attacker.example/',
  'mailto:',
  'x://',
  'a.example/',
  'attacker.example',
  '203.0.113.9/',
  '/?d=',
  '?d=',
  '=',
  '="',
  '= "',
  "='",
  "= '",
  '=\t"',
  "\t=\t'",
  '=\n"',
  '"',
  "'",
  '<img src=',
  '<img src = "',
  '<a href="',
  'x-',
  '.',
  '-',
  '.a',
  '-a',
  '.-',
  '..',
  '_',
  ':',
  '//',
  '://',
];

const WHITESPACE = [' ', ' ', '\n', '\t', '\r', '\u00a0', '\u2028'];
// Glue for the "not part of a longer token" check: letters (one astral,
// split across two code units), a digit, a combining mark, an underscore,
// and lone surrogate halves.
const GLUE = ['a', 'Z', 'é', '9', '\u0301', '_', '\u{1D400}', '\uD835', '\uDC00'];
const WORDS = ['Your ', 'value ', 'is ', 'Email ', 'Card ', 'Aadhaar', 'A', 'Literal'];

const tokenArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 5, arbitrary: placeholderArb },
  { weight: 5, arbitrary: fc.constantFrom(...SYNTAX) },
  { weight: 2, arbitrary: fc.constantFrom(...WHITESPACE) },
  { weight: 2, arbitrary: fc.constantFrom(...GLUE) },
  { weight: 2, arbitrary: fc.constantFrom(...WORDS) },
  { weight: 1, arbitrary: fc.string({ maxLength: 3 }) },
);

/** A piece of text, and whether to cut inside it and after it. */
interface Piece {
  readonly token: string;
  readonly cutInside: number | null;
  readonly cutAfter: boolean;
}

const pieceArb: fc.Arbitrary<Piece> = fc.record({
  token: tokenArb,
  cutInside: fc.option(fc.nat(), { freq: 2 }),
  cutAfter: fc.boolean(),
});

/**
 * An answer and one way of streaming it: `chunks.join('')` is the answer.
 * About half the pieces are cut somewhere inside, so cuts fall inside
 * placeholders and link syntax far more often than chance would place them.
 */
export const streamedAnswerArb: fc.Arbitrary<{ text: string; chunks: string[] }> = fc
  .array(pieceArb, { maxLength: 24 })
  .map((pieces) => {
    const chunks: string[] = [];
    let current = '';
    for (const { token, cutInside, cutAfter } of pieces) {
      if (cutInside === null) current += token;
      else {
        const at = cutInside % (token.length + 1);
        chunks.push(current + token.slice(0, at));
        current = token.slice(at);
      }
      if (cutAfter) {
        chunks.push(current);
        current = '';
      }
    }
    chunks.push(current);
    return { text: chunks.join(''), chunks };
  });

/** Restores `chunks` through a StreamRestorer-like object, piece by piece. */
export function streamThrough(
  restorer: { push(piece: string): string; end(): string; readonly heldBack: number },
  chunks: readonly string[],
  maxHeld: number,
): string | undefined {
  let out = '';
  for (const chunk of chunks) {
    out += restorer.push(chunk);
    if (restorer.heldBack > maxHeld) return undefined;
  }
  return out + restorer.end();
}

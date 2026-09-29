// The shared grammar (ADR-002, ADR-013) that LITERAL detection, reservation
// and tolerant restoration all build their patterns from.
//
// A fresh RegExp is built inside every case, not hoisted and reused: these
// patterns carry the "g" flag, so a shared instance's `lastIndex` would leak
// between `.exec()` calls across cases.

import { describe, expect, it } from 'vitest';
import { DETECTION_TYPES } from '../../../src/detection/types.js';
import type { PlaceholderNamespace } from '../../../src/redaction/placeholder.js';
import {
  ALL_NAMESPACES,
  BARE_SPACE_NAMESPACES,
  barePattern,
  bracketPattern,
  MAX_HELD_BACK,
  titleCase,
  undecidedFrom,
} from '../../../src/redaction/variants.js';

const ALL: readonly PlaceholderNamespace[] = [...DETECTION_TYPES, 'LITERAL'];

describe('ALL_NAMESPACES', () => {
  it('is every detection type, then LITERAL', () => {
    expect(ALL_NAMESPACES).toEqual(ALL);
  });
});

describe('titleCase', () => {
  it('capitalises only the first letter', () => {
    expect(titleCase('CARD')).toBe('Card');
    expect(titleCase('AADHAAR')).toBe('Aadhaar');
    expect(titleCase('LITERAL')).toBe('Literal');
  });
});

describe('BARE_SPACE_NAMESPACES', () => {
  it('is exactly AADHAAR and LITERAL (2026-09-29 decision)', () => {
    expect([...BARE_SPACE_NAMESPACES].sort()).toEqual(['AADHAAR', 'LITERAL']);
  });
});

describe('bracketPattern', () => {
  it.each(['[CARD_1]', '[card_1]', '[Card_1]', '[CARD 1]', '[Card 1]'])('matches %s', (text) => {
    const match = bracketPattern(ALL).exec(text);
    expect(match?.[0]).toBe(text);
    expect(match?.[2]).toBe('1');
  });

  it('matches an index up to 4 digits', () => {
    expect(bracketPattern(ALL).exec('[PAN_9999]')?.[2]).toBe('9999');
  });

  it.each(['[PAN_0]', '[PAN_01]', '[PAN_10000]', '[NOTATYPE_1]', '[PAN1]', 'PAN_1'])(
    'does not match %s',
    (text) => {
      expect(bracketPattern(ALL).exec(text)).toBeNull();
    },
  );
});

describe('barePattern', () => {
  it('matches UPPERCASE and Title Case, never all-lowercase', () => {
    expect(barePattern(ALL, '_').exec('CARD_1')?.[0]).toBe('CARD_1');
    expect(barePattern(ALL, '_').exec('Card_1')?.[0]).toBe('Card_1');
    expect(barePattern(ALL, '_').exec('card_1')).toBeNull();
  });

  it('does not match across a word boundary', () => {
    expect(barePattern(ALL, '_').exec('MYCARD_1')).toBeNull();
    expect(barePattern(ALL, '_').exec('CARD_10')?.[2]).toBe('10');
    expect(barePattern(ALL, '_').exec('CARD_1X')).toBeNull();
  });

  it('the space pattern only covers the given namespaces', () => {
    expect(barePattern([...BARE_SPACE_NAMESPACES], ' ').exec('AADHAAR 1')?.[0]).toBe('AADHAAR 1');
    expect(barePattern([...BARE_SPACE_NAMESPACES], ' ').exec('LITERAL 1')?.[0]).toBe('LITERAL 1');
    expect(barePattern(['CARD'], ' ').exec('CARD 1')?.[0]).toBe('CARD 1');
  });

  it('an index over 4 digits or with a leading zero is not matched', () => {
    expect(barePattern(ALL, '_').exec('CARD_10000')).toBeNull();
    expect(barePattern(ALL, '_').exec('CARD_01')).toBeNull();
  });
});

// Streaming restoration (ADR-018): how much of the end of a text is still
// undecided.
describe('undecidedFrom', () => {
  it.each([
    ['plain text', 'Hello there', 11],
    ['a lone "["', 'See [', 4],
    ['a tag prefix, any case in brackets', 'See [car', 4],
    ['a full bracket, waiting for "."', 'See [CARD_1]', 4],
    ['a bracket and ".", waiting for the next character', 'See [CARD_1].', 4],
    ['a bracket and ". "', 'See [CARD_1]. ', 14],
    ['a bare prefix', 'See Aadh', 4],
    ['a Title Case word that is a tag', 'See Email', 4],
    ['a lowercase word is not a bare prefix', 'See email', 9],
    ['a bare prefix glued to a letter', 'See xAadh', 9],
    ['a bare form, waiting for the next character', 'See CARD_1', 4],
    ['a bare form and "-"', 'See CARD_1-', 4],
    ['a bare space form only for AADHAAR and LITERAL', 'See Card 1', 10],
    ['a bare space form', 'See Aadhaar 1', 4],
    ['a 4-digit index still waits', 'See CARD_1234', 4],
    ['a 5-digit index is decided', 'See CARD_12345', 14],
    ['a lone high surrogate', 'See \uD835', 4],
    ['a bare form and a high surrogate', 'See CARD_1\uD835', 4],
  ])('%s', (_name, text, expected) => {
    expect(undecidedFrom('', text)).toBe(expected);
  });

  it('uses the text before for the "not glued" check, but never starts inside it', () => {
    expect(undecidedFrom('x', 'Aadh')).toBe(4); // glued to "x"
    expect(undecidedFrom(' ', 'Aadh')).toBe(0);
    expect(undecidedFrom('0A', 'a')).toBe(1); // bug-log 18
  });

  it('holds every proper prefix of every placeholder form, and no more than MAX_HELD_BACK', () => {
    const forms = ALL.flatMap((namespace) => [
      `[${namespace}_9999]`,
      `[${namespace.toLowerCase()} 9999]`,
      `${namespace}_9999`,
      `${titleCase(namespace)}_9999`,
      ...(BARE_SPACE_NAMESPACES.has(namespace) ? [`${titleCase(namespace)} 9999`] : []),
    ]);
    const notHeld: string[] = [];
    for (const form of forms) {
      for (let i = 1; i < form.length; i++) {
        const prefix = form.slice(0, i);
        if (undecidedFrom('', `x ${prefix}`) !== 2) notHeld.push(prefix);
      }
    }
    expect(notHeld).toEqual([]);
    expect(MAX_HELD_BACK).toBe(15);
    expect(`x [${'AADHAAR'}_9999].`.length - undecidedFrom('', 'x [AADHAAR_9999].')).toBe(
      MAX_HELD_BACK,
    );
  });
});

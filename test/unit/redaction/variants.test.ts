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
  BARE_SPACE_NAMESPACES,
  barePattern,
  bracketPattern,
  titleCase,
} from '../../../src/redaction/variants.js';

const ALL: readonly PlaceholderNamespace[] = [...DETECTION_TYPES, 'LITERAL'];

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

import { describe, expect, it } from 'vitest';
import {
  MAX_PLACEHOLDER_INDEX,
  PlaceholderLimitError,
} from '../../../src/redaction/placeholder.js';
import { PlaceholderMapping } from '../../../src/redaction/mapping.js';

describe('PlaceholderMapping: assignment', () => {
  it('assigns indices by order of first appearance, starting at 1', () => {
    const mapping = new PlaceholderMapping();
    expect(mapping.getOrAssign('PAN', 'ABCPE1234F', 'abcpe1234f')).toBe('[PAN_1]');
    expect(mapping.getOrAssign('PAN', 'XYZPE5678G', 'xyzpe5678g')).toBe('[PAN_2]');
  });

  it('returns the same placeholder for a key seen again, keeping the first surface form', () => {
    const mapping = new PlaceholderMapping();
    expect(mapping.getOrAssign('EMAIL', 'priya@example.com', 'Priya@Example.com')).toBe(
      '[EMAIL_1]',
    );
    expect(mapping.getOrAssign('EMAIL', 'priya@example.com', 'priya@example.com')).toBe(
      '[EMAIL_1]',
    );
    expect(mapping.lookup('EMAIL', 1)?.value).toBe('Priya@Example.com');
  });

  it('gives every namespace its own counter', () => {
    const mapping = new PlaceholderMapping();
    expect(mapping.getOrAssign('AADHAAR', 'a', 'a')).toBe('[AADHAAR_1]');
    expect(mapping.getOrAssign('CARD', 'c', 'c')).toBe('[CARD_1]');
    expect(mapping.getOrAssign('LITERAL', 'l', 'l')).toBe('[LITERAL_1]');
    expect(mapping.getOrAssign('AADHAAR', 'a2', 'a2')).toBe('[AADHAAR_2]');
  });

  it('throws PlaceholderLimitError, naming the namespace, once a namespace is full', () => {
    const mapping = new PlaceholderMapping();
    for (let i = 0; i < MAX_PLACEHOLDER_INDEX; i++) mapping.getOrAssign('CARD', `key-${i}`, 'x');
    expect(() => mapping.getOrAssign('CARD', 'one-too-many', 'x')).toThrow(PlaceholderLimitError);
    try {
      mapping.getOrAssign('CARD', 'one-too-many-2', 'x');
      throw new Error('expected getOrAssign to throw');
    } catch (e) {
      expect((e as PlaceholderLimitError).namespace).toBe('CARD');
    }
    // A full CARD namespace does not affect a different one.
    expect(mapping.getOrAssign('PAN', 'p', 'p')).toBe('[PAN_1]');
  });
});

describe('PlaceholderMapping: reservation (ADR-002, ADR-013)', () => {
  it('skips an index reserved before any real value claims it', () => {
    const mapping = new PlaceholderMapping();
    mapping.reserve('CARD', 1);
    expect(mapping.getOrAssign('CARD', 'real-card', '4111111111111111')).toBe('[CARD_2]');
  });

  it('leaves an already-assigned index unrenumbered and marks it exact-only instead', () => {
    const mapping = new PlaceholderMapping();
    mapping.getOrAssign('PAN', 'ABCPE1234F', 'ABCPE1234F');
    expect(mapping.lookup('PAN', 1)?.exactOnly).toBe(false);
    mapping.reserve('PAN', 1);
    expect(mapping.lookup('PAN', 1)?.exactOnly).toBe(true);
    // The index itself never changes: the redacted prefix stays byte-stable.
    expect(mapping.getOrAssign('PAN', 'ABCPE1234F', 'ABCPE1234F')).toBe('[PAN_1]');
  });

  it('a reservation for an index nothing has claimed yet, and nothing claims later, has no effect', () => {
    const mapping = new PlaceholderMapping();
    mapping.reserve('NUMBER', 5);
    expect(mapping.lookup('NUMBER', 5)).toBeUndefined();
  });
});

describe('PlaceholderMapping: lookup', () => {
  it('returns undefined for a namespace or index never assigned', () => {
    const mapping = new PlaceholderMapping();
    expect(mapping.lookup('AADHAAR', 1)).toBeUndefined();
    mapping.getOrAssign('AADHAAR', 'a', 'a');
    expect(mapping.lookup('AADHAAR', 2)).toBeUndefined();
    expect(mapping.lookup('CARD', 1)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { assertTextEqualQuietly } from '../../support/quiet-text.js';

describe('assertTextEqualQuietly', () => {
  it('does not throw when the strings are equal', () => {
    expect(() => assertTextEqualQuietly('same', 'same')).not.toThrow();
    expect(() => assertTextEqualQuietly('', '')).not.toThrow();
  });

  it('throws on mismatch without printing either string', () => {
    // Planted values a failure message must not reach.
    const actual = 'Aadhaar is 234567890123, sorry';
    const expected = 'Aadhaar is [AADHAAR_1], sorry';
    let message = '';
    try {
      assertTextEqualQuietly(actual, expected);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(actual);
    expect(message).not.toContain(expected);
    expect(message).not.toContain('234567890123');
    expect(message).toContain('index 11');
    expect(message).toContain(`actual length ${actual.length}`);
    expect(message).toContain(`expected length ${expected.length}`);
  });

  it('reports the length of the shorter string as the mismatch index when one is a prefix of the other', () => {
    let message = '';
    try {
      assertTextEqualQuietly('abc', 'abcdef');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('index 3');
  });
});

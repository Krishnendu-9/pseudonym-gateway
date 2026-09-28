import { describe, expect, it } from 'vitest';
import {
  formatPlaceholder,
  MAX_PLACEHOLDER_INDEX,
  PlaceholderLimitError,
} from '../../../src/redaction/placeholder.js';

describe('formatPlaceholder', () => {
  it('formats TYPE_N with no leading zeros', () => {
    expect(formatPlaceholder('AADHAAR', 1)).toBe('[AADHAAR_1]');
    expect(formatPlaceholder('CARD', 42)).toBe('[CARD_42]');
    expect(formatPlaceholder('LITERAL', 7)).toBe('[LITERAL_7]');
  });

  it('accepts the boundary indices 1 and MAX_PLACEHOLDER_INDEX', () => {
    expect(formatPlaceholder('PAN', 1)).toBe('[PAN_1]');
    expect(formatPlaceholder('PAN', MAX_PLACEHOLDER_INDEX)).toBe(`[PAN_${MAX_PLACEHOLDER_INDEX}]`);
  });

  it.each([0, -1, 1.5, MAX_PLACEHOLDER_INDEX + 1, NaN, Infinity])(
    'throws PlaceholderLimitError for index %j',
    (index) => {
      expect(() => formatPlaceholder('EMAIL', index)).toThrow(PlaceholderLimitError);
    },
  );

  it('names the namespace on the error, not any value', () => {
    const error = (() => {
      try {
        formatPlaceholder('PHONE', 0);
      } catch (e) {
        return e as PlaceholderLimitError;
      }
      throw new Error('expected formatPlaceholder to throw');
    })();
    expect(error.namespace).toBe('PHONE');
    expect(error.name).toBe('PlaceholderLimitError');
    expect(error.message).toContain('PHONE');
    expect(error.message).toContain(String(MAX_PLACEHOLDER_INDEX));
  });
});

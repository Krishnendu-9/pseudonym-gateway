import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { assertPropertyQuietly } from '../../support/quiet-property.js';

describe('assertPropertyQuietly', () => {
  it('passes when the property holds', () => {
    expect(() => assertPropertyQuietly(fc.property(fc.nat(), (n) => n >= 0))).not.toThrow();
  });

  it('fails without printing the counterexample, but with a seed and path to replay', () => {
    // A planted value the property rejects; it must not reach the message.
    const planted = '4111111111111111';
    const property = fc.property(fc.constant(planted), (v) => v !== planted);
    let message = '';
    try {
      assertPropertyQuietly(property, { seed: 1234 });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('counterexample hidden');
    expect(message).toContain('seed: 1234');
    expect(message).toMatch(/path: "\d+(:\d+)*"/);
    expect(message).not.toContain(planted);
  });

  it('also hides values from an exception thrown inside the predicate', () => {
    const planted = '4242424242424242';
    const property = fc.property(fc.constant(planted), (v) => {
      throw new Error(`boom ${v}`);
    });
    expect(() => assertPropertyQuietly(property)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(planted) }),
    );
  });
});

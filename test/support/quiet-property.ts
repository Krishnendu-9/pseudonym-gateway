import fc from 'fast-check';

/**
 * Runs a fast-check property and fails the test without printing the
 * counterexample. fast-check's own `fc.assert` puts the failing input in the
 * error message, and here that input may be a generated Aadhaar or card
 * number that happens to be real (ADR-009). Predicates should return booleans
 * rather than call `expect`, whose messages would print the values too.
 *
 * To debug a failure, rerun the property with the printed seed and path
 * (`fc.check(property, { seed, path })`) and inspect `counterexample` in a
 * debugger.
 */
export function assertPropertyQuietly<Ts>(
  property: fc.IProperty<Ts>,
  params: fc.Parameters<Ts> = {},
): void {
  const details = fc.check(property, params);
  if (details.failed) {
    throw new Error(
      `Property failed after ${details.numRuns} run(s); counterexample hidden on purpose. ` +
        `Replay with { seed: ${details.seed}, path: "${details.counterexamplePath ?? ''}" }.`,
    );
  }
}

/** A 32-bit seed for building an Rng inside a property. */
export const seedArb = fc.integer({ min: 0, max: 2 ** 32 - 1 });

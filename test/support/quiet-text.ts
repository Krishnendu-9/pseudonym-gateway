/**
 * Asserts two strings are equal without ever putting either one in a failure
 * message (ADR-009). Unlike `detect()`'s results (offsets only, safe to
 * compare directly), `redactMessage()` and, later, `restore()` return full
 * text that still contains a generated, personal-looking value whenever the
 * code under test is wrong — exactly the case a failing assertion needs to
 * report. On mismatch this throws only the first differing index and each
 * string's length, the same spirit as `assertPropertyQuietly`.
 */
export function assertTextEqualQuietly(actual: string, expected: string): void {
  if (actual === expected) return;
  const max = Math.min(actual.length, expected.length);
  let at = 0;
  while (at < max && actual[at] === expected[at]) at++;
  throw new Error(
    `Text mismatch at index ${at} (actual length ${actual.length}, expected length ` +
      `${expected.length}); contents hidden on purpose (ADR-009).`,
  );
}

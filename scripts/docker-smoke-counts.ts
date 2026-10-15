// How many checks scripts/docker-smoke.ts makes (ADR-046 amendment H). The
// script fails a run that makes a different number, and a test fails while
// the testing guide states a different one, so a check added or removed
// cannot leave the documented count behind. Kept apart from the script,
// which runs Docker as soon as it is imported.

/** Checks in a plain run: contents 12, configuration 6, refusals 5, serving with names off 8. */
export const SMOKE_CHECKS = 31;

/** Checks `--models` adds: serving with names on, 8, and that it does not print the telemetry line. */
export const SMOKE_CHECKS_WITH_MODELS = 9;

export function expectedChecks(withModels: boolean): number {
  return SMOKE_CHECKS + (withModels ? SMOKE_CHECKS_WITH_MODELS : 0);
}

/**
 * The script's last line, with the number of checks it made: the counter no
 * unit test can reach (it lives in the script, which runs Docker), shown in
 * the log so that a wrong or missing count can be read there.
 */
export function summaryLine(made: number, failed: number): string {
  return failed === 0
    ? `docker smoke: all ${made} checks passed`
    : `docker smoke: ${failed} failed (${made} checks made)`;
}

/** Why a run's count is wrong, or undefined when it is the expected one. */
export function countProblem(ran: number, withModels: boolean): string | undefined {
  const expected = expectedChecks(withModels);
  return ran === expected
    ? undefined
    : `made ${ran} checks, expected ${expected} (scripts/docker-smoke-counts.ts)`;
}

// Mutations of the Docker smoke test's check count (ADR-046 amendment H),
// for scripts/mutate.ts:
//
//   npx tsx scripts/mutate.ts --out <dir outside the repo> scripts/mutations/smoke-count.ts
//
// Written with the change they check. K1 to K5 change the counts module;
// G1 and G2 change the count the testing guide states. P1 to P3 (added
// the same day) change the last line the script prints. Not here: the
// counting inside docker-smoke.ts itself, which no unit test imports
// (importing it runs Docker); only a run against an image checks it, and
// the printed number is what makes that run's count readable.

import type { Mutation } from '../mutate.js';

const COUNTS = 'scripts/docker-smoke-counts.ts';
const GUIDE = 'docs/testing-guide.md';
const TESTS = ['test/unit/scripts/docker-smoke-counts.test.ts'];

const mutation = (
  id: string,
  what: string,
  file: string,
  find: string,
  replace: string,
): Mutation => ({ id, what, file, tests: TESTS, find, replace });

export const MUTATIONS: readonly Mutation[] = [
  mutation(
    'K1',
    'a plain run expects 32 checks',
    COUNTS,
    'SMOKE_CHECKS = 31;',
    'SMOKE_CHECKS = 32;',
  ),
  mutation(
    'K2',
    '--models adds 10 checks',
    COUNTS,
    'SMOKE_CHECKS_WITH_MODELS = 9;',
    'SMOKE_CHECKS_WITH_MODELS = 10;',
  ),
  mutation(
    'K3',
    '--models adds nothing to the expected count',
    COUNTS,
    'return SMOKE_CHECKS + (withModels ? SMOKE_CHECKS_WITH_MODELS : 0);',
    'return SMOKE_CHECKS;',
  ),
  mutation('K4', 'every count is accepted', COUNTS, 'return ran === expected', 'return true'),
  mutation(
    'K5',
    'more checks than expected are accepted',
    COUNTS,
    'return ran === expected',
    'return ran >= expected',
  ),
  mutation(
    'G1',
    'the testing guide says 30 checks in a plain run',
    GUIDE,
    'It runs 31 checks, plus 9 more',
    'It runs 30 checks, plus 9 more',
  ),
  mutation(
    'G2',
    'the testing guide says 41 in all',
    GUIDE,
    '(40 in all), in four',
    '(41 in all), in four',
  ),
  mutation(
    'P1',
    'the last line prints the expected count, not the one made',
    COUNTS,
    '`docker smoke: all ${made} checks passed`',
    '`docker smoke: all ${expectedChecks(true)} checks passed`',
  ),
  mutation(
    'P2',
    'the last line drops the number',
    COUNTS,
    '`docker smoke: all ${made} checks passed`',
    '`docker smoke: all checks passed`',
  ),
  mutation(
    'P3',
    'a failing run drops the number',
    COUNTS,
    '`docker smoke: ${failed} failed (${made} checks made)`',
    '`docker smoke: ${failed} failed`',
  ),
];

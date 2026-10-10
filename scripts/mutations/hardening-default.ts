// Mutations of the start-up guard's on-unless-named-off rule (ADR-047), for
// scripts/mutate.ts:
//
//   npx tsx scripts/mutate.ts --out <dir outside the repo> scripts/mutations/hardening-default.ts
//
// Written with the change they check, on 2026-10-10. G1 puts back the rule
// ADR-047 replaced (the guard ran only with NODE_ENV=production), which a
// .env built from .env.example turned off.

import type { Mutation } from '../mutate.js';

const HARDENING = 'src/hardening.ts';
const ENV = 'src/config/env.ts';
const TESTS = ['test/unit/hardening.test.ts', 'test/unit/config/env.test.ts'];
const DECISION =
  'return env.PSEUDONYM_DISABLE_HARDENING ? undefined : checkProductionHardening(input);';

export const MUTATIONS: readonly Mutation[] = [
  {
    id: 'G1',
    what: 'the guard runs only with NODE_ENV=production again (the old rule)',
    file: HARDENING,
    tests: TESTS,
    find: DECISION,
    replace:
      "return (env as { NODE_ENV?: string }).NODE_ENV === 'production' ? checkProductionHardening(input) : undefined;",
  },
  {
    id: 'G2',
    what: 'the guard never runs',
    file: HARDENING,
    tests: TESTS,
    find: DECISION,
    replace: 'return undefined;',
  },
  {
    id: 'G3',
    what: 'the named flag is ignored: the guard always runs',
    file: HARDENING,
    tests: TESTS,
    find: DECISION,
    replace: 'return checkProductionHardening(input);',
  },
  {
    id: 'G4',
    what: 'the flag defaults to off: unset means no guard',
    file: ENV,
    tests: TESTS,
    find: "PSEUDONYM_DISABLE_HARDENING: booleanFlag('false'),",
    replace: "PSEUDONYM_DISABLE_HARDENING: booleanFlag('true'),",
  },
];

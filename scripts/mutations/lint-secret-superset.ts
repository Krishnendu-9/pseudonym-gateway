// Mutations of the held-out lint's key rule against the detector's formats
// (ADR-021 item 3 note, 2026-10-11), for scripts/mutate.ts:
//
//   npx tsx scripts/mutate.ts --out <dir outside the repo> scripts/mutations/lint-secret-superset.ts
//
// Written with the change they check. L1 to L13 narrow the lint (the nine
// prefixes added, and the four first-character rules widened); D1 gives the
// detector a format the lint does not know, which is the drift the test
// exists to catch.

import type { Mutation } from '../mutate.js';

const LINT = 'eval/lint.ts';
const SECRET = 'src/detection/secret.ts';
const TESTS = ['test/unit/eval/lint-secret-superset.test.ts'];

const dropped = (id: string, entry: string): Mutation => ({
  id,
  what: `the lint loses ${entry}`,
  file: LINT,
  tests: TESTS,
  find: `      '${entry}',\n`,
  replace: '',
});

export const MUTATIONS: readonly Mutation[] = [
  dropped('L1', 'glpat-'),
  dropped('L2', 'ASIA[A-Za-z0-9]{16}'),
  dropped('L3', 'whsec_'),
  dropped('L4', 'xapp-'),
  dropped('L5', 'npm_[A-Za-z0-9]{36}'),
  dropped('L6', 'hf_[A-Za-z0-9]{30}'),
  {
    id: 'L7',
    what: 'the lint loses sk_prod_ (Stripe)',
    file: LINT,
    tests: TESTS,
    find: "'[spr]k_(?:live|test|prod)_',",
    replace: "'[spr]k_(?:live|test)_',",
  },
  {
    id: 'L8',
    what: 'the lint loses the Slack xoxe- and xoxo- tokens',
    file: LINT,
    tests: TESTS,
    find: "'xox[abeoprs]-',",
    replace: "'xox[baprs]-',",
  },
  {
    id: 'L9',
    what: 'the lint misses sk- followed by "_" or "-"',
    file: LINT,
    tests: TESTS,
    find: "'sk-[A-Za-z0-9_-]',",
    replace: "'sk-[A-Za-z0-9]',",
  },
  {
    id: 'L10',
    what: 'the lint misses AKIA followed by a lower-case letter',
    file: LINT,
    tests: TESTS,
    find: "'AKIA[A-Za-z0-9]',",
    replace: "'AKIA[0-9A-Z]',",
  },
  {
    id: 'L11',
    what: 'the lint misses AIza followed by "_" or "-"',
    file: LINT,
    tests: TESTS,
    find: "'AIza[A-Za-z0-9_-]',",
    replace: "'AIza[0-9A-Za-z]',",
  },
  {
    id: 'L12',
    what: 'the lint misses a JWT whose parts continue "eyJ_" or "eyJ-"',
    file: LINT,
    tests: TESTS,
    find: "'eyJ[A-Za-z0-9_-]',",
    replace: "'eyJ[A-Za-z0-9]',",
  },
  {
    id: 'L13',
    what: 'the lint loses the PEM BEGIN line',
    file: LINT,
    tests: TESTS,
    find: "')|-----BEGIN',",
    replace: "')',",
  },
  {
    id: 'D1',
    what: 'the detector gains a key format the lint does not know',
    file: SECRET,
    tests: TESTS,
    find: '  `hf_[${ALNUM}]{30,}`,\n',
    replace: '  `hf_[${ALNUM}]{30,}`,\n  `zzk_[${ALNUM}]{10,}`,\n',
  },
];

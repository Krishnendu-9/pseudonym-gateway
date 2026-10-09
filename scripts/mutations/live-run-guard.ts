// Mutations of the live-run guard (ADR-041 section 11), for scripts/mutate.ts:
//
//   npx tsx scripts/mutate.ts --out <dir outside the repo> scripts/mutations/live-run-guard.ts
//
// The list run on 2026-10-08 was not kept (ADR-043). This one was rebuilt
// from ADR-041's description on 2026-10-10 and is not the same list: its
// ids are new so that none names a different mutation than before. Which
// tests catch each is in the testing guide.

import type { Mutation } from '../mutate.js';

const GUARD = 'scripts/live-run-guard.ts';
const SCRIPT = 'scripts/measure-gemini.ts';
const TESTS = ['test/unit/scripts/live-run-guard.test.ts'];

export const MUTATIONS: readonly Mutation[] = [
  {
    id: 'T1',
    what: 'a dirty tree never refuses',
    file: GUARD,
    tests: TESTS,
    find: 'if (paths.length > 0) {',
    replace: 'if (false) {',
  },
  {
    id: 'T2',
    what: 'untracked files are not reported',
    file: GUARD,
    tests: TESTS,
    find: "'--untracked-files=all'",
    replace: "'--untracked-files=no'",
  },
  {
    id: 'T3',
    what: 'the plan file is never named',
    file: GUARD,
    tests: TESTS,
    find: 'paths.includes(PLAN_FILE)',
    replace: 'false',
  },
  {
    id: 'T4',
    what: 'a rename source is not skipped',
    file: GUARD,
    tests: TESTS,
    find: 'if (/[RC]/.test(entry.slice(0, 2))) i++;',
    replace: '',
  },
  {
    id: 'T5',
    what: 'paths keep the status separator',
    file: GUARD,
    tests: TESTS,
    find: 'paths.push(entry.slice(3));',
    replace: 'paths.push(entry.slice(2));',
  },
  {
    id: 'T6',
    what: 'a git status failure is read as a clean tree',
    file: GUARD,
    tests: TESTS,
    find: "return refused('git could not report the working tree (is this a git repository?).');",
    replace: "porcelain = '';",
  },
  {
    id: 'T7',
    what: 'a repository with no commit lets the run start',
    file: GUARD,
    tests: TESTS,
    find: "return refused('there is no commit to run from.');",
    replace: "return { ok: true, head: '' };",
  },
  {
    id: 'T8',
    what: 'HEAD is not checked to be a commit id',
    file: GUARD,
    tests: TESTS,
    find: 'if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head)) {',
    replace: 'if (false) {',
  },
  {
    id: 'T9',
    what: 'no uncommitted path is listed',
    file: GUARD,
    tests: TESTS,
    find: 'paths.slice(0, MAX_LISTED)',
    replace: 'paths.slice(0, 0)',
  },
  {
    id: 'S1',
    what: 'the script never calls the guard',
    file: SCRIPT,
    tests: TESTS,
    find: "if (mode !== 'headers') {",
    replace: 'if (false) {',
  },
  {
    id: 'S2',
    what: 'the script does not exit on a refusal',
    file: SCRIPT,
    tests: TESTS,
    find: '    console.error(tree.reason);\n    process.exit(1);',
    replace: '    console.error(tree.reason);',
  },
];

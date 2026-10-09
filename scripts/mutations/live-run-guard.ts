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
    find: 'if (!isCommitId(head)) {',
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
  // The push requirement (amendment 2026-10-10).
  {
    id: 'P1',
    what: 'the ancestry question is never asked',
    file: GUARD,
    tests: TESTS,
    find: "    git(['merge-base', '--is-ancestor', head, remote]);",
    replace: '',
  },
  {
    id: 'P2',
    what: 'the ancestry question is asked the wrong way round',
    file: GUARD,
    tests: TESTS,
    find: "'--is-ancestor', head, remote]",
    replace: "'--is-ancestor', remote, head]",
  },
  {
    id: 'P3',
    what: 'the local main branch is read instead of origin/main',
    file: GUARD,
    tests: TESTS,
    find: "export const REMOTE_REF = 'refs/remotes/origin/main';",
    replace: "export const REMOTE_REF = 'refs/heads/main';",
  },
  {
    id: 'P4',
    what: 'a missing origin/main is read as HEAD itself',
    file: GUARD,
    tests: TESTS,
    find: '  } catch {\n    return refused(\n      `there is no ${REMOTE_REF} here',
    replace:
      '  } catch {\n    remote = head;\n    void refused(\n      `there is no ${REMOTE_REF} here',
  },
  {
    id: 'P5',
    what: 'the two ancestry failures swap their reasons',
    file: GUARD,
    tests: TESTS,
    find: 'exitStatus(error) === 1',
    replace: 'exitStatus(error) !== 1',
  },
  {
    id: 'P6',
    what: 'origin/main is not checked to be a commit id',
    file: GUARD,
    tests: TESTS,
    find: 'if (!isCommitId(remote)) {',
    replace: 'if (false) {',
  },
  {
    id: 'P7',
    what: 'the result names HEAD as the origin/main compared with',
    file: GUARD,
    tests: TESTS,
    find: 'return { ok: true, head, remote };',
    replace: 'return { ok: true, head, remote: head };',
  },
  {
    // Survived its first run (2026-10-10): only the script's success path
    // reaches this line, and no test reached it then. A real-git script test
    // now does (ADR-044); results in the testing guide.
    id: 'P8',
    what: 'the script does not record the origin/main it was compared with',
    file: SCRIPT,
    tests: TESTS,
    find: '  originMain = tree.remote;',
    replace: '',
  },
  // Added with the real-git tests (2026-10-10, ADR-044).
  {
    // The fake git puts the exit code in `status`; real execFileSync must too.
    id: 'P9',
    what: 'the exit code is read from the wrong field of the error',
    file: GUARD,
    tests: TESTS,
    find: "'status' in error ? error.status : undefined",
    replace: "'code' in error ? error.code : undefined",
  },
  {
    // P8's companion: the same success path, recording HEAD.
    id: 'S3',
    what: 'the script does not record the commit it ran from',
    file: SCRIPT,
    tests: TESTS,
    find: '  head = tree.head;',
    replace: '',
  },
];

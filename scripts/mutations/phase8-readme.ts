// Mutations of the checks added for Phase 8's README (ADR-049), for
// scripts/mutate.ts:
//
//   npx tsx scripts/mutate.ts --out <dir outside the repo> scripts/mutations/phase8-readme.ts
//
// Written with the change they check. S1 to S4: the status box's two
// safety sentences, deleted or moved out of the box (rewritten, and S4
// added, when Phase 8 was ruled done and the box changed, 2026-10-16). C1: the README's
// count of main cases. G1 to G3: the shared list of restoration-safety gaps
// and the threat model that names them. H1 and H2: the code changes so a
// documented claim stops being true (the brief's old example is no longer
// held; the fourth gap closes). P1 to P4 (added the same day, ADR-049's
// second round): the timing tests' growth limit and CI's coverage
// threshold, each changed in the README and at its source.

import type { Mutation } from '../mutate.js';

const README_TESTS = ['test/unit/readme-facts.test.ts'];

// The status box as ruled on 2026-10-16 (Phase 8 done), whole, so that S3
// and S4 can move one sentence out of it.
const BOX_START = '> **Status: Phase 8 of 8 done (2026-10-16). Not ready for production use:\n';
const BOX_REST =
  "> every figure here is measured on synthetic data.** Detection, the\n> gateway, streaming, the evaluation, person names (off by default), a\n> second provider (Gemini's OpenAI-compatible endpoint) and a Docker image\n> are built. CI runs the checks, tests and evaluation, and checks what the\n> image contains and that it serves.";
const GAP_TESTS = ['test/unit/redaction/unsafe-regions.test.ts'];

export const MUTATIONS: readonly Mutation[] = [
  {
    id: 'S1',
    what: 'the status box no longer says "Not ready for production use"',
    file: 'README.md',
    tests: README_TESTS,
    find: 'Not ready for production use:\n> every figure',
    replace: 'Ready to try:\n> every figure',
  },
  {
    id: 'S2',
    what: 'the status box no longer says every figure is measured on synthetic data',
    file: 'README.md',
    tests: README_TESTS,
    find: 'Not ready for production use:\n> every figure here is measured on synthetic data.**',
    replace: 'Not ready for production use.**',
  },
  {
    id: 'S3',
    what: 'the synthetic-data sentence moves out of the status box, still in the README',
    file: 'README.md',
    tests: README_TESTS,
    find: `${BOX_START}${BOX_REST}`,
    replace: `> **Status: Phase 8 of 8 done (2026-10-16). Not ready for production use.**${BOX_REST.slice(BOX_REST.indexOf(' Detection'))}\n\nEvery figure here is measured on synthetic data.`,
  },
  {
    id: 'S4',
    what: '"Not ready for production use" moves out of the status box, still in the README',
    file: 'README.md',
    tests: README_TESTS,
    find: `${BOX_START}${BOX_REST}`,
    replace: `> **Status: Phase 8 of 8 done (2026-10-16). Every figure here is measured\n> on synthetic data.**${BOX_REST.slice(BOX_REST.indexOf(' Detection'))}\n\nNot ready for production use.`,
  },
  {
    id: 'C1',
    what: 'the README says 501 main cases',
    file: 'README.md',
    tests: README_TESTS,
    find: 'headline table is its **500 main cases**',
    replace: 'headline table is its **501 main cases**',
  },
  {
    id: 'G1',
    what: 'the threat model renames a gap',
    file: 'docs/threat-model.md',
    tests: GAP_TESTS,
    find: '- **a bare IP address with no scheme:**',
    replace: '- **a bare IP address without a scheme:**',
  },
  {
    id: 'G2',
    what: 'the shared list loses the fourth gap',
    file: 'test/support/restoration-safety-gaps.ts',
    tests: GAP_TESTS,
    find: "  {\n    name: \"a value glued to the end of a bare host's last label\",\n    text: 'Visit a.example-[AADHAAR_1]/p now',\n  },\n",
    replace: '',
  },
  {
    id: 'G3',
    what: "the threat model drops the line saying the brief's old example is not a gap",
    file: 'docs/threat-model.md',
    tests: GAP_TESTS,
    find: 'label is held back by the host rule, so `x-[AADHAAR_1].example/p` is not\n  a gap.',
    replace: 'label is held back by the host rule.',
  },
  {
    id: 'H1',
    what: 'the host rule stops holding a bracketed placeholder before "."',
    file: 'src/redaction/unsafe-regions.ts',
    tests: GAP_TESTS,
    find: 'return label && (first === DOT || (!bracketed && first === HYPHEN));',
    replace: 'return label && !bracketed && (first === DOT || first === HYPHEN);',
  },
  {
    id: 'H2',
    what: 'the fourth gap closes: a placeholder before "/" counts as a host',
    file: 'src/redaction/unsafe-regions.ts',
    tests: GAP_TESTS,
    find: 'return label && (first === DOT || (!bracketed && first === HYPHEN));',
    replace:
      'return (label && (first === DOT || (!bracketed && first === HYPHEN))) || first === SLASH;',
  },
  {
    id: 'P1',
    what: 'the README says the timing tests fail at a growth of 9',
    file: 'README.md',
    tests: README_TESTS,
    find: 'fails if the time grows 8 times or more',
    replace: 'fails if the time grows 9 times or more',
  },
  {
    id: 'P2',
    what: 'the growth limit becomes 9, the README still says 8',
    file: 'test/support/linear-time.ts',
    tests: README_TESTS,
    find: 'export const MAX_GROWTH_RATIO = 8;',
    replace: 'export const MAX_GROWTH_RATIO = 9;',
  },
  {
    id: 'P3',
    what: 'the README says coverage fails below 99%',
    file: 'README.md',
    tests: README_TESTS,
    find: 'the run fails below\n100% of lines',
    replace: 'the run fails below\n99% of lines',
  },
  {
    id: 'P4',
    what: 'the coverage threshold becomes 99%, the README still says 100%',
    file: 'vitest.config.ts',
    tests: README_TESTS,
    find: 'thresholds: { 100: true },',
    replace: 'thresholds: { lines: 99, branches: 99, functions: 99, statements: 99 },',
  },
];

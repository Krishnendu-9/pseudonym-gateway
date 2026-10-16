// Mutations of the README figures tied to the code and to the names
// baseline (README part 2, chunk 1, 2026-10-11), for scripts/mutate.ts:
//
//   npx tsx scripts/mutate.ts --out <dir outside the repo> scripts/mutations/readme-facts.ts
//
// Written with the change they check. R1 to R9 change a number in the
// README, the drift these checks exist for; B1 changes the stored baseline
// instead, so the README no longer matches what eval:names compares with.
// R10 to R13 and E1 to E3 (added 2026-10-13) do the same for the
// threat model's free-tier figures and eval/baseline.json. R14, R15 and M1
// (added 2026-10-15) for the name model's download and file sizes: R14 is
// the error the manual had, the model file's size given as the download's.
// R16 (added 2026-10-16, ADR-049): sizes are costs and round up, so the
// download is 181.5 MB; R16 writes the nearest-rounded 181.4 back.

import type { Mutation } from '../mutate.js';

const README = 'README.md';
const TESTS = ['test/unit/readme-facts.test.ts'];

const readme = (id: string, what: string, find: string, replace: string): Mutation => ({
  id,
  what,
  file: README,
  tests: TESTS,
  find,
  replace,
});

export const MUTATIONS: readonly Mutation[] = [
  readme('R1', 'the README says Retry-After 31', '`Retry-After: 30`', '`Retry-After: 31`'),
  readme(
    'R2',
    'the README says the safety net needs 10 digits',
    '| Any other number of 9+ digits ',
    '| Any other number of 10+ digits',
  ),
  readme(
    'R3',
    'the README says the keyword window is 41 characters',
    'naming them within 40 characters, before or after',
    'naming them within 41 characters, before or after',
  ),
  readme(
    'R4',
    "the README says the names timeout's default is 203 s",
    "The timeout's default, 202 s, is",
    "The timeout's default, 203 s, is",
  ),
  readme(
    'R5',
    'the README says 502 of 612 names on the generated set',
    '| **501/612 (81.8%)** |',
    '| **502/612 (82.0%)** |',
  ),
  readme(
    'R6',
    'the README says 5.84 false positives per 1,000 words',
    'about 5.85 words in 1,000',
    'about 5.84 words in 1,000',
  ),
  readme(
    'R7',
    'the README says 4 of 59 lower-case names were found',
    '(3 of 59 found, 2026-10-03)',
    '(4 of 59 found, 2026-10-03)',
  ),
  readme(
    'R8',
    'the README says 146 of 153 names in the main cases',
    '| Main cases, PERSON              | 145/153             |',
    '| Main cases, PERSON              | 146/153             |',
  ),
  readme(
    'R9',
    'the status box says one detection in 934',
    'differs by one detection in 933, one',
    'differs by one detection in 934, one',
  ),
  {
    id: 'B1',
    what: 'the stored baseline says 500 names found',
    file: 'eval/names-baseline.json',
    tests: TESTS,
    find: '"recall": {\n      "hit": 501,',
    replace: '"recall": {\n      "hit": 500,',
  },
  readme(
    'R10',
    'the README says 199 of 1,683 values are sent',
    'names off, the default, 198 of 1,683',
    'names off, the default, 199 of 1,683',
  ),
  readme(
    'R11',
    'the README says all 152 person names are sent',
    'all 153 person names, and',
    'all 152 person names, and',
  ),
  readme(
    'R12',
    'the README says 46 of the other values are sent',
    '45 of the other 1,530 values',
    '46 of the other 1,530 values',
  ),
  readme(
    'R13',
    'the README dates the results block a day later',
    '(the results block above, 2026-10-06)',
    '(the results block above, 2026-10-07)',
  ),
  {
    id: 'E1',
    what: 'the stored baseline says 199 main values sent',
    file: 'eval/baseline.json',
    tests: TESTS,
    find: '"values": 1683,\n        "sent": 198',
    replace: '"values": 1683,\n        "sent": 199',
  },
  {
    id: 'E2',
    what: 'the stored baseline says one person name was found',
    file: 'eval/baseline.json',
    tests: TESTS,
    find: '"partial": 0,\n        "missed": 153,\n        "detections": 0,',
    replace: '"partial": 0,\n        "missed": 152,\n        "detections": 0,',
  },
  {
    id: 'E3',
    what: 'the stored baseline says one more card was redacted',
    file: 'eval/baseline.json',
    tests: TESTS,
    find: '"CARD": {\n        "values": 153,\n        "redacted": 150,',
    replace: '"CARD": {\n        "values": 153,\n        "redacted": 151,',
  },
  readme(
    'R14',
    "the README gives the model file's size as the download's",
    '181.5 MB, of which the model file is 178.5 MB)',
    '178.5 MB, of which the model file is 178.5 MB)',
  ),
  readme(
    'R15',
    "the README gives the download's size as the model file's",
    '181.5 MB, of which the model file is 178.5 MB)',
    '181.5 MB, of which the model file is 181.5 MB)',
  ),
  readme(
    'R16',
    'the README rounds the download to the nearest (181.4), not up (ADR-049)',
    '181.5 MB, of which the model file is 178.5 MB)',
    '181.4 MB, of which the model file is 178.5 MB)',
  ),
  {
    id: 'M1',
    what: 'the pinned tokenizer.json is 2 MB smaller',
    file: 'src/gateway/name-model.ts',
    tests: TESTS,
    find: '      bytes: 2_919_362,',
    replace: '      bytes: 919_362,',
  },
];

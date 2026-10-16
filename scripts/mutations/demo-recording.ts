// Mutations of the check behind the demo recording's caption (2026-10-16),
// for scripts/mutate.ts:
//
//   npx tsx scripts/mutate.ts --out <dir outside the repo> scripts/mutations/demo-recording.ts
//
// Written with the change they check. D1 lets the fixture drift from the
// recorded request while redacting to the same text (one example.com
// address for another), so only the messages comparison can catch it. D2
// rewords the caption, so the claim could change without the check. D3
// turns the placeholder instruction on by default, so `npm run dev` would
// send a system message the recording does not have. D4 sends a message
// unredacted, the failure the caption most needs to rule out.

import type { Mutation } from '../mutate.js';

const TESTS = ['test/unit/readme-facts.test.ts'];

export const MUTATIONS: readonly Mutation[] = [
  {
    id: 'D1',
    what: 'the demo request carries a different email address from the recording',
    file: 'test/fixtures/demo-request.json',
    tests: TESTS,
    find: 'the receipt went to billing.desk@example.com,',
    replace: 'the receipt went to billing.team@example.com,',
  },
  {
    id: 'D2',
    what: 'the caption no longer says byte for byte',
    file: 'README.md',
    tests: TESTS,
    find: "today's code redacts the same message to the same text, byte for byte.",
    replace: "today's code redacts the same message to much the same text.",
  },
  {
    id: 'D3',
    what: 'the placeholder instruction is on by default',
    file: 'src/config/env.ts',
    tests: TESTS,
    find: "    PSEUDONYM_PLACEHOLDER_INSTRUCTION: booleanFlag('false'),",
    replace: "    PSEUDONYM_PLACEHOLDER_INSTRUCTION: booleanFlag('true'),",
  },
  {
    id: 'D4',
    what: 'each message is sent as the client wrote it',
    file: 'src/gateway/redact-request.ts',
    tests: TESTS,
    find: '    content: redacted[i]!,',
    replace: '    content: texts[i]! as RedactedText,',
  },
];

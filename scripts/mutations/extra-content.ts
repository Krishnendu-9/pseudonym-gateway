// Mutations of the extra_content strip and its count (ADR-041 section 15,
// decision 3, 3a + 3c), for scripts/mutate.ts:
//
//   npx tsx scripts/mutate.ts --out <dir outside the repo> scripts/mutations/extra-content.ts
//
// Written with the change they check, on 2026-10-10. SG1 and SG2 are the
// refactors the ruling guards against: the strip is the field-by-field
// construction, so a leak needs something spread through; both put one in.
// SG8 writes the signature itself where its length goes, to show the
// log check can fail. SG10 is bug-log 71.

import type { Mutation } from '../mutate.js';

const ADAPTER = 'src/providers/openai-compatible.ts';
const SERVER = 'src/gateway/server.ts';
const TESTS = [
  'test/integration/gemini-recordings.test.ts',
  'test/unit/providers/ollama.test.ts',
  'test/integration/strict-provider.test.ts',
];

export const MUTATIONS: readonly Mutation[] = [
  {
    id: 'SG1',
    what: 'the non-streamed result spreads the parsed message (extra_content included)',
    file: ADAPTER,
    tests: TESTS,
    find: "content: refusal && content === '' ? null : content,",
    replace: "...choice!.message,\n        content: refusal && content === '' ? null : content,",
  },
  {
    id: 'SG2',
    what: 'a content event spreads the parsed delta (extra_content included)',
    file: ADAPTER,
    tests: TESTS,
    find: "if (choice?.delta.content) yield { type: 'content', text: choice.delta.content };",
    replace:
      "if (choice?.delta.content) yield { ...choice.delta, type: 'content', text: choice.delta.content };",
  },
  {
    id: 'SG3',
    what: 'extra_content is never counted',
    file: ADAPTER,
    tests: TESTS,
    find: 'into.extraContent++;',
    replace: '// SG3',
  },
  {
    id: 'SG4',
    what: "the signature's length is never recorded",
    file: ADAPTER,
    tests: TESTS,
    find: "if (typeof signature === 'string') into.thoughtSignatureLengths.push(signature.length);",
    replace: '// SG4',
  },
  {
    id: 'SG5',
    what: 'a streamed chunk is not counted',
    file: ADAPTER,
    tests: TESTS,
    find: 'tally(dropped, chunk.choices[0]?.delta.extra_content);',
    replace: '// SG5',
  },
  {
    id: 'SG6',
    what: 'a non-streamed answer is not counted',
    file: ADAPTER,
    tests: TESTS,
    find: 'tally(dropped, choice!.message.extra_content);',
    replace: '// SG6',
  },
  {
    id: 'SG7',
    what: 'no log line for a non-streamed answer',
    file: SERVER,
    tests: TESTS,
    find: 'logDropped(request.log, result.dropped);',
    replace: '// SG7',
  },
  {
    id: 'SG8',
    what: 'the signature itself is recorded where its length goes',
    file: ADAPTER,
    tests: TESTS,
    find: 'into.thoughtSignatureLengths.push(signature.length);',
    replace: 'into.thoughtSignatureLengths.push(signature as unknown as number);',
  },
  {
    id: 'SG9',
    what: 'no log line for a streamed answer',
    file: SERVER,
    tests: TESTS,
    find: 'logDropped(request.log, stream.dropped?.())',
    replace: 'undefined',
  },
  {
    id: 'SG11',
    what: 'a null extra_content is counted',
    file: ADAPTER,
    tests: TESTS,
    find: 'if (extra === undefined || extra === null) return;',
    replace: 'if (extra === undefined) return;',
  },
  {
    id: 'SG12',
    what: 'a signature that is not a string is measured',
    file: ADAPTER,
    tests: TESTS,
    find: "if (typeof signature === 'string') into",
    replace: 'if (signature !== undefined) into',
  },
  {
    id: 'SG10',
    what: 'extra_content declared as required, so every answer without it is rejected (bug-log 71)',
    file: ADAPTER,
    tests: TESTS,
    find: 'extra_content: z.unknown().optional(),\n        }),\n        finish_reason: finishReason,',
    replace: 'extra_content: z.unknown(),\n        }),\n        finish_reason: finishReason,',
  },
];

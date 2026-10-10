// Mutations of refusal handling (ADR-041 section 15, decision 1; bug-log 70),
// for scripts/mutate.ts:
//
//   npx tsx scripts/mutate.ts --out <dir outside the repo> scripts/mutations/refusals.ts
//
// Written with the change they check, on 2026-10-10. RF1, RF3 and RF10 each
// put back one way a refusal reached the client as an empty answer.

import type { Mutation } from '../mutate.js';

const ADAPTER = 'src/providers/openai-compatible.ts';
const SERVER = 'src/gateway/server.ts';
const STREAM = 'src/gateway/stream.ts';
const TESTS = [
  'test/integration/strict-provider.test.ts',
  'test/unit/providers/ollama.test.ts',
  'test/unit/gateway/stream.test.ts',
];

export const MUTATIONS: readonly Mutation[] = [
  {
    id: 'RF1',
    what: 'a streamed refusal piece is dropped (bug 70 itself)',
    file: ADAPTER,
    tests: TESTS,
    find: "if (choice?.delta.refusal) yield { type: 'refusal', text: choice.delta.refusal };",
    replace: '// RF1',
  },
  {
    id: 'RF2',
    what: 'a non-streamed refusal is not passed on',
    file: ADAPTER,
    tests: TESTS,
    find: '...(refusal ? { refusal } : {}),',
    replace: '...{},',
  },
  {
    id: 'RF3',
    what: 'content "" beside a refusal stays "" instead of null',
    file: ADAPTER,
    tests: TESTS,
    find: "content: refusal && content === '' ? null : content,",
    replace: 'content,',
  },
  {
    id: 'RF4',
    what: 'content null with a refusal is still bad_response (the old 502)',
    file: ADAPTER,
    tests: TESTS,
    find: 'if (content === null && !refusal) throw',
    replace: 'if (content === null) throw',
  },
  {
    id: 'RF5',
    what: 'content null with no refusal named passes as an answer',
    file: ADAPTER,
    tests: TESTS,
    find: 'if (content === null && !refusal) throw',
    replace: 'if (false) throw',
  },
  {
    id: 'RF6',
    what: 'a non-streamed refusal is not restored',
    file: SERVER,
    tests: TESTS,
    find: 'restore(result.refusal, mapping, restoreOptions)',
    replace: 'result.refusal',
  },
  {
    id: 'RF7',
    what: 'a non-streamed refusal is restored without restoration safety',
    file: SERVER,
    tests: TESTS,
    find: 'restore(result.refusal, mapping, restoreOptions)',
    replace: 'restore(result.refusal, mapping, { restoreInUnsafeRegions: true })',
  },
  {
    id: 'RF8',
    what: 'refusal pieces go through the content restorer (one shared text)',
    file: STREAM,
    tests: TESTS,
    find: 'const text = refusalRestorer.push(next.text);',
    replace: 'const text = restorer.push(next.text);',
  },
  {
    id: 'RF9',
    what: 'a streamed refusal is sent as content',
    file: STREAM,
    tests: TESTS,
    find: "if (text !== '') yield refusal(text);",
    replace: "if (text !== '') yield content(text);",
  },
  {
    id: 'RF10',
    what: 'the held-back refusal is never sent',
    file: STREAM,
    tests: TESTS,
    find: "if (refusalRest !== '') yield refusal(refusalRest);",
    replace: '// RF10',
  },
];

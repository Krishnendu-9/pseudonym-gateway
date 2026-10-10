// Mutations of streamed usage handling (bug-log 75; ADR-041 section 16, the
// amendment on part 1's open items, item 1), for scripts/mutate.ts:
//
//   npx tsx scripts/mutate.ts --out <dir outside the repo> scripts/mutations/streaming-usage.ts
//
// Written with the change they check, on 2026-10-11. SU1 and SU2 put back
// the two halves of bug 75 (usage before the finish, and usage more than
// once, each a bad_response); SU4 puts back the 502 the ruling forbids over
// counts that go down. The same day the warn line gained the names of the
// counts that went down: SU4, SU8 to SU13 and SU15 to SU17 got new `find`
// texts then (the code they mutate was rewritten), each still naming the
// same mutation as before, and SU18 to SU21 were added for the names.

import type { Mutation } from '../mutate.js';

const ADAPTER = 'src/providers/openai-compatible.ts';
const SERVER = 'src/gateway/server.ts';
const TESTS = [
  'test/unit/providers/ollama.test.ts',
  'test/integration/gemini-recordings.test.ts',
  'test/integration/chat-completions.test.ts',
  'test/integration/strict-provider.test.ts',
];

const DECREASE_CHECK =
  'if (usage !== undefined) noteDecreases(usageSeen.decreased, usage, event.usage);';
const COMPARE = 'if (next[field] < previous[field]) into.add(name);';
const WARN = "log.warn({ provider, decreased }, 'provider usage counts decreased');";

export const MUTATIONS: readonly Mutation[] = [
  {
    id: 'SU1',
    what: 'usage before the finish is out of order again (bug 75 itself)',
    file: ADAPTER,
    tests: TESTS,
    find: DECREASE_CHECK,
    replace: `if (!finished) throw new ProviderError('bad_response');\n          ${DECREASE_CHECK}`,
  },
  {
    id: 'SU2',
    what: 'a second usage is out of order again',
    file: ADAPTER,
    tests: TESTS,
    find: DECREASE_CHECK,
    replace: `if (usage !== undefined) throw new ProviderError('bad_response');\n          ${DECREASE_CHECK}`,
  },
  {
    id: 'SU3',
    what: 'the first usage is kept instead of the last',
    file: ADAPTER,
    tests: TESTS,
    find: 'usage = event.usage;',
    replace: 'usage ??= event.usage;',
  },
  {
    id: 'SU4',
    what: 'counts that go down fail the stream (the 502 the ruling forbids)',
    file: ADAPTER,
    tests: TESTS,
    find: COMPARE,
    replace: "if (next[field] < previous[field]) throw new ProviderError('bad_response');",
  },
  {
    id: 'SU5',
    what: 'every usage is passed on as it arrives, not held for the end',
    file: ADAPTER,
    tests: TESTS,
    find: '          continue;',
    replace: '          yield event;\n          continue;',
  },
  {
    id: 'SU6',
    what: 'the held usage is passed on before the missing-finish check',
    file: ADAPTER,
    tests: TESTS,
    find: "    if (!finished) throw new ProviderError('bad_response');\n    if (usage !== undefined) yield { type: 'usage', usage };",
    replace:
      "    if (usage !== undefined) yield { type: 'usage', usage };\n    if (!finished) throw new ProviderError('bad_response');",
  },
  {
    id: 'SU7',
    what: 'the held usage is never passed on',
    file: ADAPTER,
    tests: TESTS,
    find: "if (usage !== undefined) yield { type: 'usage', usage };",
    replace: '// SU7',
  },
  {
    id: 'SU8',
    what: 'equal counts count as a decrease',
    file: ADAPTER,
    tests: TESTS,
    find: COMPARE,
    replace: 'if (next[field] <= previous[field]) into.add(name);',
  },
  {
    id: 'SU9',
    what: 'prompt_tokens going down is not noticed',
    file: ADAPTER,
    tests: TESTS,
    find: "  ['prompt', 'prompt_tokens'],\n",
    replace: '',
  },
  {
    id: 'SU10',
    what: 'completion_tokens going down is not noticed',
    file: ADAPTER,
    tests: TESTS,
    find: "  ['completion', 'completion_tokens'],\n",
    replace: '',
  },
  {
    id: 'SU11',
    what: 'total_tokens going down is not noticed',
    file: ADAPTER,
    tests: TESTS,
    find: "  ['total', 'total_tokens'],\n",
    replace: '',
  },
  {
    id: 'SU12',
    what: 'a later rise clears an earlier decrease',
    file: ADAPTER,
    tests: TESTS,
    find: DECREASE_CHECK,
    replace:
      'if (usage !== undefined) {\n            usageSeen.decreased.clear();\n            noteDecreases(usageSeen.decreased, usage, event.usage);\n          }',
  },
  {
    id: 'SU13',
    what: 'the stream reports no decrease, whatever the counts did',
    file: ADAPTER,
    tests: TESTS,
    find: 'usageDecreased: () => decreasedNames(usageSeen),',
    replace: 'usageDecreased: () => [],',
  },
  {
    id: 'SU14',
    what: 'the gateway never logs the decrease',
    file: SERVER,
    tests: TESTS,
    find: 'logUsageDecreased(request.log, config.providerName, stream.usageDecreased?.());',
    replace: '// SU14',
  },
  {
    id: 'SU15',
    what: 'the warn line is written for every stream',
    file: SERVER,
    tests: TESTS,
    find: 'if (decreased !== undefined && decreased.length > 0) {',
    replace: 'if (decreased !== undefined) {',
  },
  {
    id: 'SU16',
    what: 'logged at info, not warn',
    file: SERVER,
    tests: TESTS,
    find: WARN,
    replace: "log.info({ provider, decreased }, 'provider usage counts decreased');",
  },
  {
    id: 'SU17',
    what: "the warn line leaves out the provider's name",
    file: SERVER,
    tests: TESTS,
    find: WARN,
    replace: "log.warn({ decreased }, 'provider usage counts decreased');",
  },
  {
    id: 'SU18',
    what: 'the warn line leaves out which counts went down',
    file: SERVER,
    tests: TESTS,
    find: WARN,
    replace: "log.warn({ provider }, 'provider usage counts decreased');",
  },
  {
    id: 'SU19',
    what: 'a count is reported under the wrong name',
    file: ADAPTER,
    tests: TESTS,
    find: "  ['completion', 'completion_tokens'],\n",
    replace: "  ['total', 'completion_tokens'],\n",
  },
  {
    id: 'SU20',
    what: 'the names come in the order they were seen, not prompt, completion, total',
    file: ADAPTER,
    tests: TESTS,
    find: 'USAGE_COUNTS.map(([name]) => name).filter((name) => seen.decreased.has(name));',
    replace: '[...seen.decreased];',
  },
  {
    id: 'SU21',
    what: 'the value is recorded instead of the name',
    file: ADAPTER,
    tests: TESTS,
    find: COMPARE,
    replace: 'if (next[field] < previous[field]) into.add(String(next[field]) as UsageCount);',
  },
];

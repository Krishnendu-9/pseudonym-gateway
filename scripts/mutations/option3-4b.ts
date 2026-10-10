// Mutations of option 3 and 4b (ADR-041 sections 13, 15 and 16), for
// scripts/mutate.ts:
//
//   npx tsx scripts/mutate.ts --out <dir outside the repo> scripts/mutations/option3-4b.ts
//
// Written with the change they check, on 2026-10-11. O2 and O3 move the
// option 3 check later in the request (after name detection, then after
// redaction); each replaces one contiguous block, since the runner makes a
// single replacement. RA6 in rate-limit.ts still guards the 429 branch from
// the other side: 4b's branch comes after it, so a 429 branch widened to
// every 4xx would still turn a 400 into a 503.

import type { Mutation } from '../mutate.js';

const SERVER = 'src/gateway/server.ts';
const REFUSALS = 'src/gateway/refusals.ts';
const ERRORS = 'src/gateway/errors.ts';
const WIRING = 'src/config/wiring.ts';
const PROFILE = 'src/providers/gemini.ts';
const FIELDS = 'src/providers/openai-compatible.ts';

const OPTION3_TESTS = [
  'test/integration/refused-parameters.test.ts',
  'test/unit/gateway/refusals.test.ts',
];
const WIRING_TESTS = ['test/unit/config/wiring.test.ts'];
const FOURB_TESTS = [
  'test/integration/chat-completions.test.ts',
  'test/integration/strict-provider.test.ts',
  'test/unit/gateway/errors.test.ts',
];
const PROFILE_TESTS = [
  'test/unit/providers/gemini-profile.test.ts',
  'test/integration/refused-parameters.test.ts',
];

const CHECK = [
  '    const refused = refusedParameter(chat, config.refusals);',
  '    if (refused !== undefined) throw refused;',
];
const UP_TO_NAMES = [
  '',
  '    // A client that disconnects should not keep a provider call running, nor',
  '    // a place in the name queue.',
  '    const controller = new AbortController();',
  "    reply.raw.on('close', () => {",
  '      if (!reply.raw.writableFinished) controller.abort();',
  '    });',
  '',
  '    // Names first, on exactly the texts that will be redacted. A failure',
  '    // here is a 503 before the provider is ever called.',
  '    const names = config.names && (await config.names.find(requestTexts(chat), controller.signal));',
];
const REDACTION = [
  '',
  '    const mapping = new PlaceholderMapping();',
  '    const outbound = redactRequest(chat, mapping, {',
  '      placeholderInstruction: config.placeholderInstruction,',
  '      ...(names === undefined ? {} : { names }),',
  '    });',
];

export const MUTATIONS: readonly Mutation[] = [
  {
    id: 'O1',
    what: 'option 3 never refuses: a refused field is sent',
    file: SERVER,
    tests: OPTION3_TESTS,
    find: CHECK[1]!,
    replace: '',
  },
  {
    id: 'O2',
    what: 'option 3 runs after name detection',
    file: SERVER,
    tests: OPTION3_TESTS,
    find: [...CHECK, ...UP_TO_NAMES].join('\n'),
    replace: [...UP_TO_NAMES.slice(1), ...CHECK].join('\n'),
  },
  {
    id: 'O3',
    what: 'option 3 runs after redaction (still before the provider)',
    file: SERVER,
    tests: OPTION3_TESTS,
    find: [...CHECK, ...UP_TO_NAMES, ...REDACTION].join('\n'),
    replace: [...UP_TO_NAMES.slice(1), ...REDACTION, ...CHECK].join('\n'),
  },
  {
    id: 'R1',
    what: 'the any kind refuses nothing',
    file: REFUSALS,
    tests: OPTION3_TESTS,
    find: "    case 'any':\n      return true;",
    replace: "    case 'any':\n      return false;",
  },
  {
    id: 'R2',
    what: 'nonzero treats -0 as not zero (Object.is)',
    file: REFUSALS,
    tests: OPTION3_TESTS,
    find: 'return value !== 0;',
    replace: 'return !Object.is(value, 0);',
  },
  {
    id: 'R3',
    what: 'nonzero refuses nothing',
    file: REFUSALS,
    tests: OPTION3_TESTS,
    find: 'return value !== 0;',
    replace: 'return false;',
  },
  {
    id: 'R4',
    what: 'values refuses every value, listed or not',
    file: REFUSALS,
    tests: OPTION3_TESTS,
    find: 'return rule.values.includes(value);',
    replace: 'return true;',
  },
  {
    id: 'R5',
    what: 'a field set to null is checked as a value',
    file: REFUSALS,
    tests: OPTION3_TESTS,
    find: 'value === undefined || value === null',
    replace: 'value === undefined',
  },
  {
    id: 'R6',
    what: 'the any kind answers unsupported_value',
    file: REFUSALS,
    tests: OPTION3_TESTS,
    find: "        'unsupported_parameter',",
    replace: "        'unsupported_value',",
  },
  {
    id: 'R7',
    what: 'the refused field is not put in param',
    file: ERRORS,
    tests: OPTION3_TESTS,
    find: 'this.param = param;',
    replace: 'this.param = null;',
  },
  {
    id: 'R8',
    what: 'fields are checked in another order (frequency_penalty before seed)',
    file: FIELDS,
    tests: OPTION3_TESTS,
    find: "  'seed',\n  'frequency_penalty',",
    replace: "  'frequency_penalty',\n  'seed',",
  },
  {
    id: 'R9',
    what: 'the values message lists the allowed values',
    file: REFUSALS,
    tests: OPTION3_TESTS,
    find: '`${field} does not support this value ${SCOPE}`',
    replace: '`${field} must be one of minimal, low, medium, high ${SCOPE}`',
  },
  {
    id: 'K1',
    what: 'a model name that is a built-in property is taken as an entry',
    file: WIRING,
    tests: WIRING_TESTS,
    find: 'refusals !== undefined && Object.hasOwn(refusals, env.PSEUDONYM_MODEL)',
    replace: 'refusals !== undefined && env.PSEUDONYM_MODEL in refusals',
  },
  {
    id: 'K2',
    what: 'the model match ignores a leading models/',
    file: WIRING,
    tests: WIRING_TESTS,
    find: 'Object.hasOwn(refusals, env.PSEUDONYM_MODEL)\n    ? refusals[env.PSEUDONYM_MODEL]',
    replace:
      'Object.hasOwn(refusals, withoutPrefix(env.PSEUDONYM_MODEL))\n    ? refusals[withoutPrefix(env.PSEUDONYM_MODEL)]',
  },
  {
    id: 'K3',
    what: 'the server is never given the refusals',
    file: WIRING,
    tests: WIRING_TESTS,
    find: '...(refusals === undefined ? {} : { refusals }),',
    replace: '',
  },
  {
    id: 'W1',
    what: 'the models/ warning never fires',
    file: WIRING,
    tests: WIRING_TESTS,
    find: 'if (near === undefined) return undefined;',
    replace: 'return undefined;',
  },
  {
    id: 'W2',
    what: 'the models/ warning compares the names as written',
    file: WIRING,
    tests: WIRING_TESTS,
    find: 'withoutPrefix(known) === withoutPrefix(model)',
    replace: 'known === model',
  },
  {
    id: 'B1',
    what: 'a provider 400 is a 502 provider_error again',
    file: ERRORS,
    tests: FOURB_TESTS,
    find: 'if (error.status === 400) {',
    replace: 'if (false) {',
  },
  {
    id: 'B2',
    what: '4b takes every provider 4xx (a 401 or 404 becomes a 400)',
    file: ERRORS,
    tests: FOURB_TESTS,
    find: 'if (error.status === 400) {',
    replace: 'if (error.status !== undefined && error.status < 500) {',
  },
  {
    id: 'B3',
    what: '4b answers 502 under its own code',
    file: ERRORS,
    tests: FOURB_TESTS,
    find: "          400,\n          'provider_rejected_request',",
    replace: "          502,\n          'provider_rejected_request',",
  },
  {
    id: 'B4',
    what: 'a provider 400 is logged at info, not warn',
    file: SERVER,
    tests: FOURB_TESTS,
    find: '      request.log.warn(\n        { ...details, provider: config.providerName },',
    replace: '      request.log.info(\n        { ...details, provider: config.providerName },',
  },
  {
    id: 'B5',
    what: "the warn line leaves out the provider's name",
    file: SERVER,
    tests: FOURB_TESTS,
    find: '{ ...details, provider: config.providerName }',
    replace: 'details',
  },
  {
    id: 'B6',
    what: 'every provider HTTP failure counts as a rejection for the warn log',
    file: ERRORS,
    tests: FOURB_TESTS,
    find: "error.failure === 'http' && error.status === 400;",
    replace: "error.failure === 'http';",
  },
  {
    id: 'P1',
    what: 'presence_penalty is refused at every value, 0 included',
    file: PROFILE,
    tests: PROFILE_TESTS,
    find: "presence_penalty: { kind: 'nonzero',",
    replace: "presence_penalty: { kind: 'any',",
  },
  {
    id: 'P2',
    what: 'reasoning_effort none is put on the list (decision D)',
    file: PROFILE,
    tests: PROFILE_TESTS,
    find: "values: ['xhigh', 'max'],",
    replace: "values: ['xhigh', 'max', 'none'],",
  },
  {
    id: 'P3',
    what: 'an entry cites a probe that measured another field',
    file: PROFILE,
    tests: PROFILE_TESTS,
    find: "'attempt-6/p18'",
    replace: "'attempt-6/p17'",
  },
];

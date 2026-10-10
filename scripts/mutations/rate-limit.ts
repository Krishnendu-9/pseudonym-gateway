// Mutations of the provider-429 mapping (ADR-041 section 15, decision 2,
// option 2c with c2), for scripts/mutate.ts:
//
//   npx tsx scripts/mutate.ts --out <dir outside the repo> scripts/mutations/rate-limit.ts
//
// Written with the change they check, on 2026-10-10. RA6 is the boundary
// with section 13's 4b seen from this side: a 429 branch that takes every
// provider 4xx would turn a provider 400 into a 503.

import type { Mutation } from '../mutate.js';

const ERRORS = 'src/gateway/errors.ts';
const SERVER = 'src/gateway/server.ts';
const TESTS = [
  'test/integration/strict-provider.test.ts',
  'test/integration/chat-completions.test.ts',
  'test/unit/gateway/errors.test.ts',
];

export const MUTATIONS: readonly Mutation[] = [
  {
    id: 'RA1',
    what: 'a provider 429 is a 502 provider_error again',
    file: ERRORS,
    tests: TESTS,
    find: 'if (error.status === 429) {',
    replace: 'if (false) {',
  },
  {
    id: 'RA2',
    what: 'a provider 429 is passed through as a 429',
    file: ERRORS,
    tests: TESTS,
    find: "503,\n          'provider_rate_limited',",
    replace: "429,\n          'provider_rate_limited',",
  },
  {
    id: 'RA3',
    what: 'the 503 carries no Retry-After',
    file: ERRORS,
    tests: TESTS,
    find: "{ 'retry-after': String(PROVIDER_RETRY_AFTER_SECONDS) }",
    replace: '{}',
  },
  {
    id: 'RA4',
    what: 'the fixed value is above the 60-second ceiling',
    file: ERRORS,
    tests: TESTS,
    find: 'PROVIDER_RETRY_AFTER_SECONDS = 30;',
    replace: 'PROVIDER_RETRY_AFTER_SECONDS = 90;',
  },
  {
    id: 'RA5',
    what: "the error handler drops an error's headers",
    file: SERVER,
    tests: TESTS,
    find: '.headers(safe.headers)',
    replace: '',
  },
  {
    id: 'RA6',
    what: 'the 429 branch takes every provider 4xx (a 400 becomes a 503)',
    file: ERRORS,
    tests: TESTS,
    find: 'if (error.status === 429) {',
    replace: 'if (error.status !== undefined && error.status >= 400 && error.status < 500) {',
  },
  {
    id: 'RA7',
    what: 'GatewayError keeps no headers',
    file: ERRORS,
    tests: TESTS,
    find: 'this.headers = headers;',
    replace: 'this.headers = {};',
  },
  {
    id: 'RA8',
    what: "the code is OpenAI's own rate-limit code, which tells the client it is the one limited",
    file: ERRORS,
    tests: TESTS,
    find: "'provider_rate_limited',",
    replace: "'rate_limit_exceeded',",
  },
];

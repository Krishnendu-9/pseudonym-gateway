// Mutations of gemini as a product provider (ADR-041 section 16, decision A)
// and of the error body's `param` (decision G), for scripts/mutate.ts:
//
//   npx tsx scripts/mutate.ts --out <dir outside the repo> scripts/mutations/gemini-provider.ts
//
// Written with the change they check, on 2026-10-11. Not here: the type
// change itself (`param: string | null` back to `param: null`). The runner
// runs Vitest, which does not typecheck, so it could not judge it; the
// `expectTypeOf` assertion in errors.test.ts is checked by `npm run
// typecheck` instead, and was shown to reject the old type.

import type { Mutation } from '../mutate.js';

const ENV = 'src/config/env.ts';
const WIRING = 'src/config/wiring.ts';
const GEMINI = 'src/providers/gemini.ts';
const ERRORS = 'src/gateway/errors.ts';
const CONFIG_TESTS = ['test/unit/config/env.test.ts', 'test/unit/config/wiring.test.ts'];

export const MUTATIONS: readonly Mutation[] = [
  {
    id: 'GP1',
    what: 'gemini starts without a key',
    file: ENV,
    tests: CONFIG_TESTS,
    find: "!(env.PSEUDONYM_PROVIDER === 'gemini' && env.PSEUDONYM_PROVIDER_API_KEY === undefined)",
    replace: 'true',
  },
  {
    id: 'GP2',
    what: 'every provider needs a key, ollama included',
    file: ENV,
    tests: CONFIG_TESTS,
    find: "env.PSEUDONYM_PROVIDER === 'gemini' && env.PSEUDONYM_PROVIDER_API_KEY",
    replace: 'env.PSEUDONYM_PROVIDER_API_KEY',
  },
  {
    id: 'GP3',
    what: 'a missing key is hidden while another variable is wrong',
    file: ENV,
    tests: CONFIG_TESTS,
    find: ', when: () => true }',
    replace: ' }',
  },
  {
    id: 'GP4',
    what: "gemini's default base URL is Ollama's",
    file: ENV,
    tests: CONFIG_TESTS,
    find: "gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/',",
    replace: "gemini: 'http://localhost:11434/v1',",
  },
  {
    id: 'GP5',
    what: "the default base URL is always Ollama's, whatever the provider",
    file: ENV,
    tests: CONFIG_TESTS,
    find: 'PROVIDER_BASE_URL_DEFAULTS[env.PSEUDONYM_PROVIDER]',
    replace: 'PROVIDER_BASE_URL_DEFAULTS.ollama',
  },
  {
    id: 'GP6',
    what: 'a base URL that is set is ignored',
    file: ENV,
    tests: CONFIG_TESTS,
    find: 'env.PSEUDONYM_PROVIDER_BASE_URL ?? PROVIDER_BASE_URL_DEFAULTS',
    replace: 'undefined ?? PROVIDER_BASE_URL_DEFAULTS',
  },
  {
    id: 'GP7',
    what: 'gemini is not an accepted provider',
    file: ENV,
    tests: CONFIG_TESTS,
    find: "const PROVIDERS = ['ollama', 'gemini'] as const;",
    replace: "const PROVIDERS = ['ollama'] as const;",
  },
  {
    id: 'GP8',
    what: "gemini gets Ollama's profile",
    file: WIRING,
    tests: CONFIG_TESTS,
    find: 'gemini: GEMINI_PROFILE,',
    replace: 'gemini: OLLAMA_PROFILE,',
  },
  {
    id: 'GP9',
    what: 'the provider is always ollama, whatever is configured',
    file: WIRING,
    tests: CONFIG_TESTS,
    find: 'PROFILES[env.PSEUDONYM_PROVIDER]',
    replace: 'PROFILES.ollama',
  },
  {
    id: 'GP10',
    what: "Gemini's profile carries Ollama's name",
    file: GEMINI,
    tests: CONFIG_TESTS,
    find: "{ name: 'gemini' }",
    replace: "{ name: 'ollama' }",
  },
  {
    id: 'GP11',
    what: 'the key never reaches the adapter',
    file: WIRING,
    tests: CONFIG_TESTS,
    find: 'apiKey: env.PSEUDONYM_PROVIDER_API_KEY,',
    replace: 'apiKey: undefined,',
  },
  {
    id: 'GP12',
    what: 'an error body carries a value in param (its code)',
    file: ERRORS,
    tests: ['test/unit/gateway/errors.test.ts'],
    find: 'param: null, code: this.code',
    replace: 'param: this.code, code: this.code',
  },
];

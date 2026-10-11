// Mutations of the credential-safety step (ADR-041 section 16, amendment
// items 2, 3 and 4), for scripts/mutate.ts:
//
//   npx tsx scripts/mutate.ts --out <dir outside the repo> scripts/mutations/credential-safety.ts
//
// Written with the change they check, on 2026-10-11.
//
// - U: the plain-HTTP base-URL rule (src/config/env.ts).
// - W: its start-up warning (src/config/wiring.ts).
// - K: the provider's key as a canary. The gateway's own code never holds
//   the key; only the adapter does, so each K mutation makes the adapter put
//   it somewhere the canary test looks (a handled error, a response), or
//   stop sending it (the positive control). Run against canary.test.ts
//   alone, to show that test catches each.
// - H: the hygiene test's credential check, mutated in the test itself, to
//   show the "known formats only" line is what keeps it passing.

import type { Mutation } from '../mutate.js';

const ENV = 'src/config/env.ts';
const WIRING = 'src/config/wiring.ts';
const ADAPTER = 'src/providers/openai-compatible.ts';
const HYGIENE = 'test/unit/repo-hygiene.test.ts';
const CONFIG_TESTS = ['test/unit/config/env.test.ts', 'test/unit/config/wiring.test.ts'];
const CANARY = ['test/integration/canary.test.ts'];

export const MUTATIONS: readonly Mutation[] = [
  {
    id: 'U1',
    what: 'a plain-HTTP URL off this machine is accepted with a key',
    file: ENV,
    tests: CONFIG_TESTS,
    find:
      '!(\n' +
      '        env.PSEUDONYM_PROVIDER_API_KEY !== undefined &&\n' +
      '        crossesNetworkInClear(env.PSEUDONYM_PROVIDER_BASE_URL)\n' +
      '      )',
    replace: 'true',
  },
  {
    id: 'U2',
    what: 'the rule is applied with no key too (Ollama without a key refused)',
    file: ENV,
    tests: CONFIG_TESTS,
    find: 'env.PSEUDONYM_PROVIDER_API_KEY !== undefined &&\n',
    replace: '',
  },
  {
    id: 'U3',
    what: 'HTTPS off this machine is refused too',
    file: ENV,
    tests: CONFIG_TESTS,
    find: "return protocol === 'http:' && !isLoopbackHost(hostname);",
    replace: 'return !isLoopbackHost(hostname);',
  },
  {
    id: 'U4',
    what: 'localhost is not loopback',
    file: ENV,
    tests: CONFIG_TESTS,
    find: "hostname === 'localhost' || ",
    replace: '',
  },
  {
    id: 'U5',
    what: '[::1] is not loopback',
    file: ENV,
    tests: CONFIG_TESTS,
    find: "hostname === '[::1]' || ",
    replace: '',
  },
  {
    id: 'U6',
    what: 'any host starting "127." is loopback (127.0.0.1.nip.io accepted)',
    file: ENV,
    tests: CONFIG_TESTS,
    find: String.raw`/^127(?:\.\d{1,3}){3}$/`,
    replace: String.raw`/^127\./`,
  },
  {
    id: 'U7',
    what: 'only 127.0.0.1 is loopback, not the rest of 127.0.0.0/8',
    file: ENV,
    tests: CONFIG_TESTS,
    find: String.raw`/^127(?:\.\d{1,3}){3}$/`,
    replace: String.raw`/^127\.0\.0\.1$/`,
  },
  {
    id: 'U8',
    what: 'an IPv4-mapped loopback address counts as loopback',
    file: ENV,
    tests: CONFIG_TESTS,
    find: "hostname === '[::1]' ||",
    replace: "hostname === '[::1]' || hostname.startsWith('[::ffff:7f') ||",
  },
  {
    id: 'U9',
    what: 'the refusal is hidden while another variable is wrong',
    file: ENV,
    tests: CONFIG_TESTS,
    find: "{ path: ['PSEUDONYM_PROVIDER_BASE_URL'], when: () => true }",
    replace: "{ path: ['PSEUDONYM_PROVIDER_BASE_URL'] }",
  },
  {
    id: 'U10',
    what: 'the refusal names the key, not the base URL',
    file: ENV,
    tests: CONFIG_TESTS,
    find: "{ path: ['PSEUDONYM_PROVIDER_BASE_URL'], when: () => true }",
    replace: "{ path: ['PSEUDONYM_PROVIDER_API_KEY'], when: () => true }",
  },
  {
    id: 'U11',
    what: 'an unparsable URL is parsed anyway (the parser throws, carrying the URL)',
    file: ENV,
    tests: CONFIG_TESTS,
    find: "if (typeof url !== 'string' || !URL.canParse(url)) return false;",
    replace: "if (typeof url !== 'string') return false;",
  },
  {
    id: 'U12',
    what: "Ollama's default becomes a plain-HTTP address off this machine",
    file: ENV,
    tests: CONFIG_TESTS,
    find: "ollama: 'http://localhost:11434/v1',",
    replace: "ollama: 'http://ollama.internal:11434/v1',",
  },
  {
    id: 'W1',
    what: 'the loopback warning never fires',
    file: WIRING,
    tests: CONFIG_TESTS,
    find: 'if (env.PSEUDONYM_PROVIDER_API_KEY === undefined) return undefined;',
    replace: 'return undefined;',
  },
  {
    id: 'W2',
    what: 'the warning fires without a key',
    file: WIRING,
    tests: CONFIG_TESTS,
    find: 'if (env.PSEUDONYM_PROVIDER_API_KEY === undefined) return undefined;',
    replace: '',
  },
  {
    id: 'W3',
    what: 'the warning fires over HTTPS',
    file: WIRING,
    tests: CONFIG_TESTS,
    find: "if (new URL(env.PSEUDONYM_PROVIDER_BASE_URL).protocol !== 'http:') return undefined;",
    replace: '',
  },
  {
    id: 'W4',
    what: 'the warning prints the URL',
    file: WIRING,
    tests: CONFIG_TESTS,
    find: "'Authorization header, to a local address'",
    replace: '`Authorization header, to ${env.PSEUDONYM_PROVIDER_BASE_URL}`',
  },
  {
    id: 'K1',
    what: "the adapter's HTTP-failure error carries the key in its message",
    file: ADAPTER,
    tests: CANARY,
    find: "throw new ProviderError('http', response.status);",
    replace:
      "throw Object.assign(new ProviderError('http', response.status), " +
      '{ message: `refused Bearer ${config.apiKey}` });',
  },
  {
    id: 'K2',
    what: "the adapter's HTTP-failure error carries the key as its cause",
    file: ADAPTER,
    tests: CANARY,
    find: "throw new ProviderError('http', response.status);",
    replace:
      "throw Object.assign(new ProviderError('http', response.status), " +
      '{ cause: config.apiKey });',
  },
  {
    id: 'K3',
    what: "the provider's error body is kept in the error (a provider quoting the key)",
    file: ADAPTER,
    tests: CANARY,
    find:
      'await response.body?.cancel();\n' +
      "      throw new ProviderError('http', response.status);",
    replace:
      'const said = await response.text();\n' +
      "      throw Object.assign(new ProviderError('http', response.status), { message: said });",
  },
  {
    id: 'K4',
    what: 'a successful answer carries the key (in its id)',
    file: ADAPTER,
    tests: CANARY,
    find: 'id: parsed.data.id,',
    replace: 'id: `${parsed.data.id}-${config.apiKey}`,',
  },
  {
    id: 'K5',
    what: 'the key is never sent (the positive control)',
    file: ADAPTER,
    tests: CANARY,
    find: '...(config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` }),',
    replace: '...{},',
  },
  {
    id: 'H1',
    what: 'the credential check flags keyword assignments too, not known formats only',
    file: HYGIENE,
    tests: [HYGIENE],
    find: '[...secretCandidates(line)].some((candidate) => candidate.validated)',
    replace: '[...secretCandidates(line)].length > 0',
  },
];

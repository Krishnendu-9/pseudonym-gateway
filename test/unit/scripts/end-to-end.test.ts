// The end-to-end run script of ADR-041 section 17 (scripts/end-to-end.ts),
// offline: a stub provider on 127.0.0.1, the real gateway, and a stand-in
// name finder for E2 (the real model is the dry run's job). Nothing here
// reaches Google: every gateway is configured with the stub's base URL, and
// the transport refuses any other address.

import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CALLS,
  E1_SENT,
  E1_USER,
  E2_SENT,
  E2_USER,
  HOSTNAME_TOKEN,
  MODEL,
  SPACING_MS,
  SYSTEM,
  gatewayEnv,
  gatewayStarter,
  newAttempt,
  outgoingDifference,
  plantedForms,
  plantedIn,
  runCalls,
  startStubProvider,
  textDifference,
  withoutHostname,
  type Call,
  type StartGateway,
  type StubProvider,
} from '../../../scripts/end-to-end.js';
import type { NameFinder } from '../../../src/gateway/server.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const [E1, E2] = CALLS as [Call, Call];

// --- the registration, as committed --------------------------------------

/** Section 17 of ADR-041, from its heading to the next ADR. */
function section17(): string {
  const text = readFileSync(join(ROOT, 'docs', 'decisions.md'), 'utf8');
  const start = text.indexOf('### 17. Decision H: the end-to-end calls');
  const end = text.indexOf('<a id="adr-042"></a>', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

/** The block quote after the first line containing `marker`, as one paragraph. */
function quoteAfter(section: string, marker: string): string {
  const lines = section.split('\n');
  let i = lines.findIndex((line) => line.includes(marker)) + 1;
  expect(i).toBeGreaterThan(0);
  while (!/^\s*>/.test(lines[i]!)) i++;
  const quoted: string[] = [];
  for (; /^\s*>/.test(lines[i]!); i++) quoted.push(lines[i]!.replace(/^\s*> ?/, ''));
  // Markdown joins a paragraph's wrapped lines with a space.
  return quoted.join(' ');
}

describe('the registered requests (ADR-041 section 17 item 2)', () => {
  const section = section17();

  it('E1 is the registered user message, typed from the registration', () => {
    expect(E1_USER).toBe(quoteAfter(section, '**E1**, user message:'));
  });

  it("E1's outgoing text is the registered prediction", () => {
    expect(E1_SENT).toBe(quoteAfter(section, '**The outgoing text predicted**'));
  });

  it("E2 is the registered sentence, one space, then E1's message; its prediction likewise", () => {
    expect(section).toContain(
      '**E2**, user message: `My name is Meera Iyer.` followed by one space',
    );
    expect(E2_USER).toBe(`My name is Meera Iyer. ${E1_USER}`);
    expect(section).toContain("E2's is `My name is [PERSON_1].`, one space, then the same text.");
    expect(E2_SENT).toBe(`My name is [PERSON_1]. ${E1_SENT}`);
  });

  it('the system message, the model and the spacing are the registered ones', () => {
    expect(section).toContain('System message, both calls: `Be brief.`');
    expect(SYSTEM).toBe('Be brief.');
    expect(section.replace(/\s+/g, ' ')).toContain(`model \`${MODEL}\``);
    expect(section).toContain('E1, then E2, 15 s apart');
    expect(SPACING_MS).toBe(15_000);
  });

  it('E1 runs names off and E2 names on; E2 plants the name as well', () => {
    expect([E1.id, E1.names, E2.id, E2.names]).toEqual(['e1', false, 'e2', true]);
    expect(E1.planted.map((p) => p.label)).toEqual(['card', 'email', 'IP address', 'IFSC']);
    expect(E2.planted.map((p) => p.label)).toEqual(['card', 'email', 'IP address', 'IFSC', 'name']);
    for (const call of CALLS) {
      for (const { value } of call.planted) expect(call.user.includes(value)).toBe(true);
    }
  });
});

// --- the planted-value check ----------------------------------------------

describe('planted values', () => {
  const forms = plantedForms(E2.planted);

  it('are looked for as written and as their digits without separators', () => {
    expect(forms.map((f) => f.label)).toEqual([
      'card as written',
      "card's digits without separators",
      'email as written',
      'IP address as written',
      "IP address's digits without separators",
      'IFSC as written',
      "IFSC's digits without separators",
      'name as written',
    ]);
    expect(forms[1]!.text).toBe('4111111111111111');
  });

  it('are found in any case, and only their labels are returned', () => {
    expect(plantedIn('to meera iyer', forms)).toEqual(['name as written']);
    expect(plantedIn('BILLING.DESK@EXAMPLE.COM', forms)).toEqual(['email as written']);
    expect(plantedIn('x4111111111111111x', forms)).toEqual(["card's digits without separators"]);
    expect(plantedIn(E2_SENT, forms)).toEqual([]);
  });

  it('refuse a value that JSON would escape, which a search of a body could miss', () => {
    expect(() => plantedForms([{ label: 'quoted', value: 'a"b' }])).toThrow(/escaped in JSON/);
  });
});

// --- the dry-run gate -------------------------------------------------------

const registeredBody = (call: Call, user = call.sent): string =>
  JSON.stringify({
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ],
    stream: false,
  });

describe('the outgoing body against the registration', () => {
  it('passes the registered body, with fields the registration does not fix', () => {
    expect(outgoingDifference(registeredBody(E1), E1)).toBeUndefined();
    expect(outgoingDifference(registeredBody(E2), E2)).toBeUndefined();
  });

  it('names where a text differs, by character', () => {
    const changed = E1_SENT.replace('[IP_1]', '[IP_2]');
    expect(outgoingDifference(registeredBody(E1, changed), E1)).toMatch(
      /^message 2 \(user\) differs from character \d+ \(sent (\d+) characters, registered \1\)/,
    );
    expect(textDifference('abcd', 'abXd')).toContain('differs from character 2');
    expect(textDifference('abc', 'abcd')).toContain('differs from character 3');
  });

  it("refuses E1's body for E2 and the other way round", () => {
    expect(outgoingDifference(registeredBody(E1), E2)).toContain('message 2 (user)');
    expect(outgoingDifference(registeredBody(E2), E1)).toContain('message 2 (user)');
  });

  it('checks the model, the message count, roles, fields and content type', () => {
    const body = (patch: Record<string, unknown>): string =>
      JSON.stringify({ ...(JSON.parse(registeredBody(E1)) as object), ...patch });
    const system = { role: 'system', content: SYSTEM };
    const user = { role: 'user', content: E1_SENT };
    expect(outgoingDifference('not json', E1)).toBe('the outgoing body is not JSON');
    expect(outgoingDifference('[]', E1)).toBe('the outgoing body is not a JSON object');
    expect(outgoingDifference(body({ model: 'other' }), E1)).toContain('the outgoing model');
    expect(outgoingDifference(body({ messages: 'x' }), E1)).toContain('no messages array');
    expect(outgoingDifference(body({ messages: [user] }), E1)).toContain('1 messages');
    expect(outgoingDifference(body({ messages: [system, user, user] }), E1)).toContain(
      '3 messages',
    );
    expect(outgoingDifference(body({ messages: [user, system] }), E1)).toContain('the role');
    expect(outgoingDifference(body({ messages: [system, 'x'] }), E1)).toContain('not an object');
    expect(outgoingDifference(body({ messages: [system, { ...user, name: 'x' }] }), E1)).toContain(
      'the fields content, name, role',
    );
    expect(
      outgoingDifference(body({ messages: [system, { ...user, content: [] }] }), E1),
    ).toContain('not text');
    expect(
      outgoingDifference(body({ messages: [{ ...system, content: 'Be brief' }, user] }), E1),
    ).toContain('message 1 (system)');
  });
});

// --- the gateway's environment ---------------------------------------------

describe('the environment of each call', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is set by the script, never read from the process', () => {
    vi.stubEnv('PSEUDONYM_MODEL', 'some-other-model');
    vi.stubEnv('PSEUDONYM_PROVIDER', 'ollama');
    vi.stubEnv('PSEUDONYM_NAMES', 'true');
    vi.stubEnv('PSEUDONYM_PLACEHOLDER_INSTRUCTION', 'true');
    const e1 = gatewayEnv(E1, 'k');
    const e2 = gatewayEnv(E2, 'k');
    expect([e1.PSEUDONYM_PROVIDER, e1.PSEUDONYM_MODEL, e1.PSEUDONYM_NAMES]).toEqual([
      'gemini',
      MODEL,
      'false',
    ]);
    expect(e2.PSEUDONYM_NAMES).toBe('true');
    expect(e1.PSEUDONYM_PLACEHOLDER_INSTRUCTION).toBe(false);
    expect(e1.PSEUDONYM_RESTORE_IN_UNSAFE_REGIONS).toBe(false);
    expect(e1.PSEUDONYM_PROVIDER_API_KEY).toBe('k');
  });

  it("uses the product's default base URL unless the dry run gives its stub's", () => {
    expect(gatewayEnv(E1, 'k').PSEUDONYM_PROVIDER_BASE_URL).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/',
    );
    expect(
      gatewayEnv(E1, 'k', 'http://127.0.0.1:9/v1beta/openai/').PSEUDONYM_PROVIDER_BASE_URL,
    ).toBe('http://127.0.0.1:9/v1beta/openai/');
  });
});

// --- the run ------------------------------------------------------------------

/** A stand-in for the name model: marks every "Meera Iyer" (or nothing). */
const fakeNames = (finds: boolean) => async (): Promise<NameFinder> => ({
  healthy: true,
  find: async (texts) =>
    texts.map((text) => {
      const at = text.indexOf('Meera Iyer');
      return { text, spans: finds && at >= 0 ? [{ start: at, end: at + 10 }] : [] };
    }),
});

interface Harness {
  readonly stub: StubProvider;
  readonly files: Map<string, string | Uint8Array>;
  readonly sleeps: number[];
  readonly lines: string[];
}

let open: StubProvider[] = [];
afterEach(async () => {
  for (const stub of open) await stub.close();
  open = [];
});

async function run(
  options: {
    status?: number;
    names?: boolean;
    startGateway?: (stub: StubProvider) => StartGateway;
    hostname?: string;
  } = {},
): Promise<Harness & { result: Awaited<ReturnType<typeof runCalls>> }> {
  const stub = await startStubProvider(options.status);
  open.push(stub);
  const files = new Map<string, string | Uint8Array>();
  const sleeps: number[] = [];
  const lines: string[] = [];
  const result = await runCalls({
    providerBase: stub.baseUrl,
    startGateway:
      options.startGateway?.(stub) ??
      gatewayStarter('test-key', stub.baseUrl, fakeNames(options.names ?? true), (l) =>
        lines.push(l),
      ),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    write: (name, data) => files.set(name, data),
    say: (l) => lines.push(l),
    ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
  });
  return { stub, files, sleeps, lines, result };
}

const text = (data: string | Uint8Array | undefined): string =>
  typeof data === 'string' ? data : Buffer.from(data ?? new Uint8Array()).toString('utf8');

const summary = (result: Awaited<ReturnType<typeof runCalls>>) =>
  result.outcomes.map((o) => [o.id, o.clientStatus, o.providerStatus, o.sent, o.refused.length]);

describe('the run, through the real gateway', () => {
  it('makes E1 then E2, 15 s apart, and sends exactly the registered bodies', async () => {
    const before = globalThis.fetch;
    const { stub, files, sleeps, result } = await run();
    expect(result.stopped).toBeUndefined();
    expect(summary(result)).toEqual([
      ['e1', 200, 200, 1, 0],
      ['e2', 200, 200, 1, 0],
    ]);
    expect(sleeps).toEqual([SPACING_MS]);
    expect(stub.received).toEqual([
      text(files.get('e1.sent.json')),
      text(files.get('e2.sent.json')),
    ]);
    expect(outgoingDifference(stub.received[0]!, E1)).toBeUndefined();
    expect(outgoingDifference(stub.received[1]!, E2)).toBeUndefined();
    expect(globalThis.fetch).toBe(before);
  });

  it('records what the client sent and received, the provider exchange and the log lines', async () => {
    const { stub, files } = await run();
    expect([...files.keys()].sort()).toEqual(
      [
        'e1.log.txt',
        'e1.meta.json',
        'e1.provider-response.json',
        'e1.request.json',
        'e1.response.json',
        'e1.sent.json',
        'e2.log.txt',
        'e2.meta.json',
        'e2.provider-response.json',
        'e2.request.json',
        'e2.response.json',
        'e2.sent.json',
        'setup.log.txt',
        'setup.meta.json',
      ].sort(),
    );
    const request = JSON.parse(text(files.get('e2.request.json'))) as Record<string, unknown>;
    expect(request).toEqual({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: E2_USER },
      ],
    });
    // The stub echoes the user message, so a full round trip gives it back.
    const answer = JSON.parse(text(files.get('e2.response.json'))) as {
      choices: { message: Record<string, unknown> }[];
    };
    expect(answer.choices[0]!.message.content === E2_USER).toBe(true);
    expect(Object.keys(answer.choices[0]!.message).sort()).toEqual(['content', 'refusal', 'role']);
    expect(text(files.get('e1.log.txt'))).toContain('"msg":"provider extra content dropped"');
    const meta = JSON.parse(text(files.get('e1.meta.json'))) as Record<string, unknown>;
    expect(meta).toMatchObject({
      id: 'e1',
      names: false,
      client: { status: 200 },
      outgoingIsRegistered: true,
      plantedInLogs: [],
      completedLogged: true,
    });
    const provider = (meta.provider as Record<string, unknown>[])[0]!;
    expect(provider).toMatchObject({
      url: `${stub.baseUrl}chat/completions`,
      refused: [],
      status: 200,
    });
    expect(provider.bytes).toBe(files.get('e1.provider-response.json')!.length);
    expect(JSON.stringify(meta)).not.toContain('test-key');
  });

  it("writes the log files with this machine's name replaced, and says so", async () => {
    const { files } = await run();
    const host = hostname().toLowerCase();
    for (const name of ['e1', 'e2', 'setup']) {
      const log = text(files.get(`${name}.log.txt`));
      const meta = JSON.parse(text(files.get(`${name}.meta.json`))) as {
        logFile: { written: string; replaced: number };
      };
      expect(log.toLowerCase().includes(host)).toBe(false);
      expect(meta.logFile.written).toBe(`this machine's name replaced by ${HOSTNAME_TOKEN}`);
      // Pino puts the name on every line.
      expect(meta.logFile.replaced).toBe(log.split('\n').filter((l) => l !== '').length);
      if (name !== 'setup') expect(meta.logFile.replaced).toBeGreaterThanOrEqual(3);
    }
    expect(text(files.get('e1.log.txt'))).toContain(`"hostname":"${HOSTNAME_TOKEN}"`);
  });

  it('refuses before sending when names miss the name in E2, and nothing more is sent', async () => {
    const { stub, files, result } = await run({ names: false });
    expect(stub.received).toHaveLength(1);
    expect(result.stopped).toBe('e2: refused before sending');
    const e2 = result.outcomes[1]!;
    expect([e2.sent, e2.providerStatus]).toEqual([0, undefined]);
    expect(e2.refused).toContain('a planted value in the outgoing body: name as written');
    expect(
      e2.refused.some((r) => r.startsWith('not the registered request: message 2 (user)')),
    ).toBe(true);
    expect(files.has('e2.refused.json')).toBe(true);
    expect(files.has('e2.sent.json')).toBe(false);
    expect(files.has('e2.provider-response.json')).toBe(false);
  });

  it.each([
    [500, 502, 'e1: the provider answered 500'],
    [429, 503, 'e1: the provider answered 429'],
    [400, 400, 'e1: the gateway answered 400, not 200'],
  ])('stops before E2 when the provider answers %i on E1', async (status, client, why) => {
    const { stub, sleeps, result } = await run({ status });
    expect(result.stopped).toBe(why);
    expect(summary(result)).toEqual([['e1', client, status, 1, 0]]);
    expect(stub.received).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
});

// --- the run, against stand-in gateways --------------------------------------

/**
 * A gateway that does `act` for each request, then answers 200 and logs
 * Fastify's completion line, as the real one does.
 */
const standIn =
  (
    act: (
      fetchProvider: typeof fetch,
      base: string,
      call: Call,
      log: (line: string) => void,
    ) => Promise<void>,
  ) =>
  (stub: StubProvider): StartGateway =>
  async (call, log) => {
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        void act(globalThis.fetch, stub.baseUrl, call, (line) => log.write(`${line}\n`))
          .catch(() => undefined)
          .then(() => {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end('{}');
            log.write('{"msg":"request completed"}\n');
          });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  };

const post = (body: NonNullable<RequestInit['body']>): RequestInit => ({ method: 'POST', body });

describe('the transport refuses before anything leaves', () => {
  it('when a log line written before sending holds a planted value', async () => {
    const { stub, result } = await run({
      startGateway: standIn(async (send, base, call, log) => {
        log('{"msg":"card 4111 1111 1111 1111"}');
        await send(`${base}chat/completions`, post(registeredBody(call)));
      }),
    });
    expect(stub.received).toHaveLength(0);
    expect(result.outcomes[0]!.refused).toEqual([
      'a planted value in a log line before sending: card as written',
    ]);
    expect(result.stopped).toBe('e1: refused before sending');
  });

  it('when the body holds a value as bare digits', async () => {
    const { stub, result } = await run({
      startGateway: standIn(async (send, base, call) => {
        await send(
          `${base}chat/completions`,
          post(registeredBody(call, `${call.sent} 4111111111111111`)),
        );
      }),
    });
    expect(stub.received).toHaveLength(0);
    expect(result.outcomes[0]!.refused).toContain(
      "a planted value in the outgoing body: card's digits without separators",
    );
  });

  it("when the request goes anywhere but the provider's base URL", async () => {
    const { stub, result } = await run({
      startGateway: standIn(async (send, base, call) => {
        await send(
          `${base.replace('/v1beta/openai/', '/elsewhere/')}x`,
          post(registeredBody(call)),
        );
      }),
    });
    expect(stub.received).toHaveLength(0);
    expect(result.outcomes[0]!.refused).toEqual([
      "a request to an address other than the provider's base URL",
    ]);
  });

  it('when the body is not text', async () => {
    const { stub, result } = await run({
      startGateway: standIn(async (send, base, call) => {
        await send(`${base}chat/completions`, post(new TextEncoder().encode(registeredBody(call))));
      }),
    });
    expect(stub.received).toHaveLength(0);
    expect(result.outcomes[0]!.refused).toEqual([
      'a body that is not text, so it cannot be checked',
    ]);
  });
});

describe('the run stops on what it can only see afterwards', () => {
  it('a planted value in a log line written after sending stops it before E2', async () => {
    const { stub, result } = await run({
      startGateway: standIn(async (send, base, call, log) => {
        await send(`${base}chat/completions`, post(registeredBody(call)));
        log('{"msg":"to BILLING.DESK@EXAMPLE.COM"}');
      }),
    });
    expect(stub.received).toHaveLength(1);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]!.plantedInLogs).toEqual(['email as written']);
    expect(result.stopped).toBe('e1: a planted value in a log line');
  });

  it('more than one provider request in a call stops it', async () => {
    const { stub, result } = await run({
      startGateway: standIn(async (send, base, call) => {
        await send(`${base}chat/completions`, post(registeredBody(call)));
        await send(`${base}chat/completions`, post(registeredBody(call)));
      }),
    });
    expect(stub.received).toHaveLength(2);
    expect(result.stopped).toBe('e1: 2 provider requests, not one');
  });

  it('a provider request outside any call is refused and stops it', async () => {
    const { stub, result } = await run({
      startGateway: (stub) => async (call, log) => {
        await fetch(`${stub.baseUrl}chat/completions`, post(registeredBody(call))).catch(
          () => undefined,
        );
        return standIn(async () => undefined)(stub)(call, log);
      },
    });
    expect(stub.received).toHaveLength(0);
    expect(result.stray).toBe(2);
    expect(result.stopped).toBe('a provider request outside a call');
  });

  it('a planted value in a start-up log line stops it', async () => {
    const { result } = await run({
      startGateway: (stub) => async (call, log) => {
        log.write('{"msg":"Meera Iyer"}\n');
        return standIn(async () => undefined)(stub)(call, log);
      },
    });
    expect(result.stopped).toBe('a planted value in a start-up log line');
  });

  it('checks the log lines as written, before the name is replaced for the file', async () => {
    // A name that is itself a planted value: replaced in the file, still found by the check.
    const { files, result } = await run({
      hostname: 'billing.desk@example.com',
      startGateway: standIn(async (send, base, call, log) => {
        await send(`${base}chat/completions`, post(registeredBody(call)));
        log('{"msg":"to billing.desk@example.com"}');
      }),
    });
    expect(result.outcomes[0]!.plantedInLogs).toEqual(['email as written']);
    expect(text(files.get('e1.log.txt'))).toContain(`"msg":"to ${HOSTNAME_TOKEN}"`);
  });

  it('a gateway that does not start costs no call', async () => {
    const stub = await startStubProvider();
    open.push(stub);
    const before = globalThis.fetch;
    await expect(
      runCalls({
        providerBase: stub.baseUrl,
        startGateway: async (call) => {
          if (call.id === 'e2') throw new Error('the name model did not load');
          return { url: 'http://127.0.0.1:9', close: async () => undefined };
        },
        sleep: async () => undefined,
        write: () => undefined,
        say: () => undefined,
      }),
    ).rejects.toThrow('the name model did not load');
    expect(stub.received).toHaveLength(0);
    expect(globalThis.fetch).toBe(before);
  });
});

// --- recordings ---------------------------------------------------------------

describe('the attempt folder', () => {
  it('is the next unused attempt-N, with attempt.json', () => {
    const out = mkdtempSync(join(tmpdir(), 'end-to-end-'));
    try {
      const first = newAttempt(out, { mode: 'x' });
      expect(first).toBe(join(out, 'attempt-1'));
      mkdirSync(join(out, 'attempt-7'));
      mkdirSync(join(out, 'not-an-attempt-9'));
      const next = newAttempt(out, { mode: 'y' });
      expect(next).toBe(join(out, 'attempt-8'));
      expect(JSON.parse(readFileSync(join(next, 'attempt.json'), 'utf8'))).toEqual({ mode: 'y' });
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("the machine's name in the written log files", () => {
  it('is replaced in any case, everywhere, and counted', () => {
    const lines =
      '{"hostname":"Box-1.lan","msg":"a"}\n{"hostname":"BOX-1.LAN","msg":"box-1.lan"}\n';
    expect(withoutHostname(lines, 'Box-1.lan')).toEqual({
      text: `{"hostname":"${HOSTNAME_TOKEN}","msg":"a"}\n{"hostname":"${HOSTNAME_TOKEN}","msg":"${HOSTNAME_TOKEN}"}\n`,
      replaced: 3,
    });
  });

  it('is matched literally, not as a pattern', () => {
    expect(withoutHostname('box-1xlan box-1.lan', 'box-1.lan')).toEqual({
      text: `box-1xlan ${HOSTNAME_TOKEN}`,
      replaced: 1,
    });
  });

  it('replaces nothing when there is no name', () => {
    expect(withoutHostname('{"hostname":""}', '')).toEqual({
      text: '{"hostname":""}',
      replaced: 0,
    });
  });
});

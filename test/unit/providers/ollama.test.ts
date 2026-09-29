// The Ollama adapter against a real HTTP mock of Ollama's OpenAI-compatible
// endpoint: the exact bytes it sends, what it keeps from the answer, and
// that every failure becomes a ProviderError naming the kind only.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOllamaProvider, type OllamaConfig } from '../../../src/providers/ollama.js';
import {
  ProviderError,
  type ChatProvider,
  type ProviderChatRequest,
} from '../../../src/providers/provider.js';
import type { RedactedText } from '../../../src/redaction/redact.js';
import {
  completionBody,
  startMockProvider,
  type MockProvider,
  type Responder,
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
  createOllamaProvider({ baseUrl: mock.baseUrl, model: 'qwen3:8b', timeoutMs: 2_000, ...config });

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
    ['null content', completionBody('a').replace('"content":"a"', '"content":null')],
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

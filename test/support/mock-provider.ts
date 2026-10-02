// A stand-in for Ollama's OpenAI-compatible endpoint: a real HTTP server on
// a random loopback port. It records the raw bytes of every request exactly
// as they arrived over the wire, which is what the no-leak test inspects:
// no mocking of fetch, no trusting what the adapter says it sent.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

/** Decides the answer to one request. Default: `okCompletion('Done.')`. */
export type Responder = (
  request: RecordedRequest,
  response: ServerResponse,
) => void | Promise<void>;

export interface MockProvider {
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
  respondWith(responder: Responder): void;
  close(): Promise<void>;
}

/** An OpenAI-shaped completion, as Ollama returns it. */
export function completionBody(content: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1_790_000_000,
    model: 'upstream-model',
    system_fingerprint: 'fp_ollama',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...extra,
  });
}

export const okCompletion =
  (content: string): Responder =>
  (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(completionBody(content));
  };

/** Answers with the last user message's text, as a model repeating it would. */
export const echoLastUserMessage: Responder = (request, response) => {
  const body = JSON.parse(request.body) as { messages: { role: string; content: string }[] };
  const last = body.messages.filter((m) => m.role === 'user').at(-1);
  okCompletion(last?.content ?? '')(request, response);
};

export async function startMockProvider(): Promise<MockProvider> {
  const requests: RecordedRequest[] = [];
  let responder: Responder = okCompletion('Done.');

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      void Promise.resolve(responder(recorded, res)).catch(() => res.destroy());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    respondWith(next) {
      responder = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// Streams, as Ollama writes them (middleware/openai.go, checked 2026-09-29):
// `data: <chunk>` events, the first with `delta.role`, `content` left out
// when empty, a separate finish chunk, with include_usage a `choices: []`
// chunk carrying `usage` and `timings`, then `data: [DONE]`. A real
// recording (ollama-recorded-stream.test.ts) has the same shape, except
// that a thinking model's reasoning chunks send `"content":""`.

/**
 * The timeout for a test that needs something to arrive in time before the
 * failure it checks (a first chunk, then a gap; many short gaps). A local
 * round trip takes milliseconds, but during this machine's slow spells (20x,
 * ADR-032) a 300 ms timeout expired before the first chunk (bug-log 47).
 * Tests that only wait for a timeout to fire keep short ones: load can only
 * make those fire sooner.
 */
export const SUCCESS_DEADLINE_MS = 2_000;

export const STREAM_ID = 'chatcmpl-stream';
export const STREAM_CREATED = 1_790_000_100;

/** One `data:` event with a JSON payload (or a literal such as `[DONE]`). */
export const sseData = (payload: unknown): string =>
  `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;

/** One chunk in Ollama's shape. */
export function streamChunk(
  choices: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: STREAM_ID,
    object: 'chat.completion.chunk',
    created: STREAM_CREATED,
    model: 'upstream-model',
    system_fingerprint: 'fp_ollama',
    choices,
    ...extra,
  };
}

export const STREAM_USAGE = { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 };

/** Every event of a successful stream of `pieces`, in Ollama's order. */
export function ollamaStreamEvents(
  pieces: readonly string[],
  options: { usage?: boolean; finishReason?: string } = {},
): string[] {
  const events = pieces.map((content, i) =>
    sseData(
      streamChunk([
        {
          index: 0,
          delta: { ...(i === 0 ? { role: 'assistant' } : {}), ...(content ? { content } : {}) },
          finish_reason: null,
        },
      ]),
    ),
  );
  if (pieces.length === 0) {
    events.push(
      sseData(streamChunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }])),
    );
  }
  events.push(
    sseData(streamChunk([{ index: 0, delta: {}, finish_reason: options.finishReason ?? 'stop' }])),
  );
  if (options.usage) {
    events.push(sseData(streamChunk([], { usage: STREAM_USAGE, timings: { predicted_n: 7 } })));
  }
  events.push(sseData('[DONE]'));
  return events;
}

/**
 * Writes `parts` (strings or bytes) one write at a time with the SSE
 * headers, then ends the response unless `end` is false. `pauseMs` waits
 * between writes, so they reach the adapter as separate reads.
 */
export const streamed =
  (
    parts: readonly (string | Uint8Array)[],
    options: { end?: boolean; pauseMs?: number; headers?: Record<string, string> } = {},
  ): Responder =>
  async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', ...options.headers });
    for (const part of parts) {
      if (response.destroyed) return;
      response.write(part);
      if (options.pauseMs) await new Promise((resolve) => setTimeout(resolve, options.pauseMs));
    }
    if (options.end !== false) response.end();
  };

/** Streams the last user message back in the pieces `split` cuts it into. */
export const echoLastUserMessageStreamed =
  (split: (text: string) => string[], options: { usage?: boolean } = {}): Responder =>
  (request, response) => {
    const body = JSON.parse(request.body) as { messages: { role: string; content: string }[] };
    const last = body.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
    return streamed(ollamaStreamEvents(split(last), options))(request, response);
  };

/** One content chunk (no role), with optional extra delta fields. */
export const streamPiece = (content: string, extra: Record<string, unknown> = {}): string =>
  sseData(streamChunk([{ index: 0, delta: { content, ...extra }, finish_reason: null }]));

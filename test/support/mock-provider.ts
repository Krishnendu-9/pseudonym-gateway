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

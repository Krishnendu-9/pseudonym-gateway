// Builds the real gateway (real Ollama adapter, real Fastify) against a mock
// provider, with every log line and every error the gateway handled captured
// in memory.

import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildServer, type ServerConfig } from '../../src/gateway/server.js';
import type { ChatProvider } from '../../src/providers/provider.js';
import { createOllamaProvider } from '../../src/providers/ollama.js';
import { startMockProvider, type MockProvider } from './mock-provider.js';

export const TEST_MODEL = 'test-model';

export interface TestGateway {
  readonly app: FastifyInstance;
  readonly provider: MockProvider;
  /** Every log line written so far, raw JSON text. */
  readonly logs: string[];
  /** Every error Fastify's onError hook saw, as thrown (before our handler). */
  readonly errors: unknown[];
  close(): Promise<void>;
}

export async function startTestGateway(
  overrides: Partial<ServerConfig> & {
    timeoutMs?: number;
    maxResponseBytes?: number;
    maxStreamBytes?: number;
    apiKey?: string;
    /** Replaces the Ollama adapter (the mock server still starts, unused). */
    chatProvider?: ChatProvider;
  } = {},
): Promise<TestGateway> {
  const provider = await startMockProvider();
  const logs: string[] = [];
  const errors: unknown[] = [];
  const {
    timeoutMs = 5_000,
    maxResponseBytes = 1_048_576,
    maxStreamBytes = 33_554_432,
    apiKey,
    chatProvider,
    ...config
  } = overrides;
  const app = buildServer(
    {
      model: TEST_MODEL,
      providerName: 'ollama',
      bodyLimit: 262_144,
      restoreInUnsafeRegions: false,
      placeholderInstruction: false,
      logLevel: 'trace',
      logStream: { write: (line: string) => void logs.push(line) },
      ...config,
    },
    chatProvider ??
      createOllamaProvider({
        baseUrl: provider.baseUrl,
        model: TEST_MODEL,
        apiKey,
        timeoutMs,
        maxResponseBytes,
        maxStreamBytes,
      }),
  );
  app.addHook('onError', async (_request, _reply, error) => {
    errors.push(error);
  });
  await app.ready();
  return {
    app,
    provider,
    logs,
    errors,
    close: async () => {
      await app.close();
      await provider.close();
    },
  };
}

/** A minimal valid request body with the given user messages. */
export function chatBody(...userMessages: string[]): Record<string, unknown> {
  return {
    model: TEST_MODEL,
    messages: userMessages.map((content) => ({ role: 'user', content })),
  };
}

export function post(
  gateway: TestGateway,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return gateway.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', ...headers },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** What a streamed (SSE) response from the gateway contained. */
export interface StreamedResponse {
  /** Every `data:` payload in order, parsed; `[DONE]` stays a string. */
  readonly events: unknown[];
  /** The `chat.completion.chunk` payloads. */
  readonly chunks: StreamChunk[];
  /** The `{"error": …}` event, if the stream ended with one. */
  readonly error?: { error: Record<string, unknown> };
  readonly done: boolean;
  /** Every `delta.content`, joined. */
  readonly content: string;
  /** Every `delta.refusal`, joined. */
  readonly refusal: string;
}

export interface StreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    delta: { role?: string; content?: string; refusal?: string };
    finish_reason: string | null;
  }[];
  usage?: unknown;
}

/**
 * Parses the gateway's SSE body. The gateway writes exactly `data: <json>\n\n`
 * per event, so anything else is a test failure, not a format to tolerate.
 */
export function readStreamed(body: string): StreamedResponse {
  if (body !== '' && !body.endsWith('\n\n'))
    throw new Error('stream does not end with a blank line');
  const blocks = body === '' ? [] : body.slice(0, -2).split('\n\n');
  const events = blocks.map((block) => {
    if (!block.startsWith('data: ') || block.includes('\n')) {
      throw new Error('not a single-line data event');
    }
    const data = block.slice('data: '.length);
    return data === '[DONE]' ? data : (JSON.parse(data) as unknown);
  });
  const isError = (e: unknown): e is { error: Record<string, unknown> } =>
    typeof e === 'object' && e !== null && 'error' in e;
  const chunks = events.filter(
    (e): e is StreamChunk => typeof e === 'object' && e !== null && !isError(e),
  );
  const error = events.find(isError);
  return {
    events,
    chunks,
    ...(error === undefined ? {} : { error }),
    done: events.at(-1) === '[DONE]',
    content: chunks.map((c) => c.choices[0]?.delta.content ?? '').join(''),
    refusal: chunks.map((c) => c.choices[0]?.delta.refusal ?? '').join(''),
  };
}

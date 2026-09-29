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
    apiKey?: string;
    /** Replaces the Ollama adapter (the mock server still starts, unused). */
    chatProvider?: ChatProvider;
  } = {},
): Promise<TestGateway> {
  const provider = await startMockProvider();
  const logs: string[] = [];
  const errors: unknown[] = [];
  const { timeoutMs = 5_000, apiKey, chatProvider, ...config } = overrides;
  const app = buildServer(
    {
      model: TEST_MODEL,
      bodyLimit: 262_144,
      restoreInUnsafeRegions: false,
      placeholderInstruction: false,
      logLevel: 'trace',
      logStream: { write: (line: string) => void logs.push(line) },
      ...config,
    },
    chatProvider ??
      createOllamaProvider({ baseUrl: provider.baseUrl, model: TEST_MODEL, apiKey, timeoutMs }),
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

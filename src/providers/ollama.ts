// Ollama adapter, through Ollama's OpenAI-compatible endpoint
// (`POST {base}/chat/completions`; docs.ollama.com/api/openai-compatibility,
// checked 2026-09-29 against release v0.34.4).
//
// The request body is built field by field from the ProviderChatRequest,
// never by spreading what the client sent, and no client header is
// forwarded. The response is read into our own shape; everything else Ollama
// adds (`reasoning` from thinking models, `timings`, `_debug_info`) is
// dropped (ADR-014). Every failure becomes a ProviderError that names the
// kind of failure only.

import { z } from 'zod';
import type {
  ChatProvider,
  ProviderChatRequest,
  ProviderChatResult,
  ProviderFailure,
} from './provider.js';
import { ProviderError } from './provider.js';

export interface OllamaConfig {
  /** Base of the OpenAI-compatible API, e.g. `http://localhost:11434/v1`. */
  readonly baseUrl: string;
  readonly model: string;
  /** Local Ollama ignores it; ollama.com needs one. Sent only when set. */
  readonly apiKey?: string | undefined;
  readonly timeoutMs: number;
}

const responseSchema = z.object({
  id: z.string(),
  created: z.number(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string(),
          tool_calls: z.array(z.unknown()).max(0).nullish(),
        }),
        finish_reason: z.enum(['stop', 'length', 'content_filter']),
      }),
    )
    .length(1),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      total_tokens: z.number(),
    })
    .optional(),
});

function requestBody(model: string, request: ProviderChatRequest): string {
  return JSON.stringify({
    model,
    messages: request.messages.map(({ role, content }) => ({ role, content })),
    stream: false,
    ...request.options,
    ...(request.stop === undefined ? {} : { stop: request.stop }),
  });
}

export function createOllamaProvider(config: OllamaConfig): ChatProvider {
  const url = new URL(
    'chat/completions',
    config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`,
  );

  return {
    async complete(request: ProviderChatRequest, signal: AbortSignal): Promise<ProviderChatResult> {
      const timeout = AbortSignal.timeout(config.timeoutMs);
      const failure = (): ProviderFailure =>
        timeout.aborted ? 'timeout' : signal.aborted ? 'aborted' : 'unavailable';

      let text: string;
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` }),
          },
          body: requestBody(config.model, request),
          signal: AbortSignal.any([signal, timeout]),
        });
        if (!response.ok) {
          // The body can echo the prompt: never read it into anything we keep.
          await response.body?.cancel();
          throw new ProviderError('http', response.status);
        }
        text = await response.text();
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(failure());
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ProviderError('bad_response');
      }
      const parsed = responseSchema.safeParse(json);
      if (!parsed.success) throw new ProviderError('bad_response');

      const [choice] = parsed.data.choices;
      return {
        id: parsed.data.id,
        created: parsed.data.created,
        content: choice!.message.content,
        finishReason: choice!.finish_reason,
        ...(parsed.data.usage === undefined ? {} : { usage: parsed.data.usage }),
      };
    },
  };
}

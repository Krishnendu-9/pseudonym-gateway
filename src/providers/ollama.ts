// Ollama adapter, through Ollama's OpenAI-compatible endpoint
// (`POST {base}/chat/completions`; docs.ollama.com/api/openai-compatibility,
// checked 2026-09-29 against release v0.34.4; the stream format from the
// source, `middleware/openai.go` and `openai/openai.go`, checked the same
// day, since the docs do not show it).
//
// The request body is built field by field from the ProviderChatRequest,
// never by spreading what the client sent, and no client header is
// forwarded. The response is read into our own shape; everything else Ollama
// adds (`reasoning` from thinking models, `timings`, `_debug_info`) is
// dropped (ADR-014). Every failure becomes a ProviderError that names the
// kind of failure only. Both calls read at most `maxResponseBytes`
// (ADR-020).
//
// Timeouts (ADR-019): `complete` has one deadline for the whole call.
// `stream` has one for every wait instead: for the response headers, then
// for each next piece of the body. A stream that keeps arriving may take
// as long as it needs; a stream that stops for longer than the timeout
// fails. Time spent waiting for our own client to read is not counted: the
// clock only runs while a read from the provider is pending.
//
// What a stream looks like (Ollama's source): `data: <chunk>` events, the
// first with `delta.role`; `delta.content` is left out when empty; a
// separate chunk carries `finish_reason`; with `include_usage`, a chunk with
// `choices: []` and `usage` follows; then `data: [DONE]`. An error in the
// middle of a stream is not an event: Ollama has already sent 200, writes
// the error through the chunk writer, and ends without `[DONE]`. So a stream
// that ends before `[DONE]` is a failure, never a short answer. An OpenAI-
// style `data: {"error": …}` event is a failure too.

import { z } from 'zod';
import { CappedReader, rejectDeclaredTooLarge } from './body.js';
import type {
  ChatProvider,
  ProviderChatRequest,
  ProviderChatResult,
  ProviderFailure,
  ProviderStream,
  ProviderStreamEvent,
  StreamOptions,
} from './provider.js';
import { ProviderError } from './provider.js';
import { SseParser } from './sse.js';

export interface OllamaConfig {
  /** Base of the OpenAI-compatible API, e.g. `http://localhost:11434/v1`. */
  readonly baseUrl: string;
  readonly model: string;
  /** Local Ollama ignores it; ollama.com needs one. Sent only when set. */
  readonly apiKey?: string | undefined;
  readonly timeoutMs: number;
  /** The response size cap in bytes, for both calls (ADR-020). */
  readonly maxResponseBytes: number;
}

/** No single streamed event may be larger than this (ADR-020). Ollama's
 * chunks are a few hundred bytes. */
export const MAX_EVENT_BYTES = 65_536;

const finishReason = z.enum(['stop', 'length', 'content_filter']);

const usageSchema = z.object({
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  total_tokens: z.number(),
});

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
        finish_reason: finishReason,
      }),
    )
    .length(1),
  usage: usageSchema.optional(),
});

const chunkSchema = z.object({
  id: z.string(),
  created: z.number(),
  // Empty in the usage chunk.
  choices: z
    .array(
      z.object({
        delta: z.object({
          content: z.string().nullish(),
          tool_calls: z.array(z.unknown()).max(0).nullish(),
        }),
        finish_reason: finishReason.nullish(),
      }),
    )
    .max(1),
  usage: usageSchema.nullish(),
});

type Chunk = z.infer<typeof chunkSchema>;

function requestBody(
  model: string,
  request: ProviderChatRequest,
  stream: StreamOptions | undefined,
): string {
  return JSON.stringify({
    model,
    messages: request.messages.map(({ role, content }) => ({ role, content })),
    stream: stream !== undefined,
    ...(stream?.includeUsage ? { stream_options: { include_usage: true } } : {}),
    ...request.options,
    ...(request.stop === undefined ? {} : { stop: request.stop }),
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseChunk(data: string): Chunk {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    throw new ProviderError('bad_response');
  }
  if (isRecord(json) && Object.hasOwn(json, 'error')) throw new ProviderError('stream_error');
  const parsed = chunkSchema.safeParse(json);
  if (!parsed.success) throw new ProviderError('bad_response');
  return parsed.data;
}

/** What one chunk says, in the order the contract needs. */
function* chunkEvents(chunk: Chunk): Generator<ProviderStreamEvent> {
  const [choice] = chunk.choices;
  if (choice?.delta.content) yield { type: 'content', text: choice.delta.content };
  if (choice?.finish_reason) yield { type: 'finish', reason: choice.finish_reason };
  if (chunk.usage) yield { type: 'usage', usage: chunk.usage };
}

/**
 * The chunks of a stream, up to `[DONE]`. `read` waits for the next bytes
 * (under the per-wait timeout) and turns any failure into a ProviderError.
 * The body is released however the iteration ends.
 */
async function* readChunks(
  reader: CappedReader,
  read: () => Promise<Uint8Array | undefined>,
): AsyncGenerator<Chunk> {
  const parser = new SseParser(MAX_EVENT_BYTES);
  try {
    for (;;) {
      const bytes = await read();
      if (bytes === undefined) throw new ProviderError('bad_response');
      let events;
      try {
        events = parser.push(bytes);
      } catch {
        // The only thing push() throws: SseEventTooLargeError.
        throw new ProviderError('too_large');
      }
      for (const event of events) {
        if (event.data === '[DONE]') return;
        yield parseChunk(event.data);
      }
    }
  } finally {
    await reader.cancel();
  }
}

/** Turns chunks into events, enforcing the order ProviderStream promises. */
async function* streamEvents(
  first: Chunk,
  rest: AsyncGenerator<Chunk>,
): AsyncGenerator<ProviderStreamEvent> {
  let finished = false;
  let usage = false;
  try {
    for (let chunk: Chunk | undefined = first; chunk !== undefined;) {
      for (const event of chunkEvents(chunk)) {
        const outOfOrder = event.type === 'usage' ? !finished || usage : finished;
        if (outOfOrder) throw new ProviderError('bad_response');
        if (event.type === 'finish') finished = true;
        if (event.type === 'usage') usage = true;
        yield event;
      }
      const next = await rest.next();
      chunk = next.done ? undefined : next.value;
    }
    if (!finished) throw new ProviderError('bad_response');
  } finally {
    await rest.return(undefined);
  }
}

export function createOllamaProvider(config: OllamaConfig): ChatProvider {
  const url = new URL(
    'chat/completions',
    config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`,
  );

  async function post(body: string, signal: AbortSignal): Promise<Response> {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` }),
      },
      body,
      signal,
    });
    if (!response.ok) {
      // The body can echo the prompt: never read it into anything we keep.
      await response.body?.cancel();
      throw new ProviderError('http', response.status);
    }
    await rejectDeclaredTooLarge(response, config.maxResponseBytes);
    return response;
  }

  return {
    async complete(request: ProviderChatRequest, signal: AbortSignal): Promise<ProviderChatResult> {
      const timeout = AbortSignal.timeout(config.timeoutMs);
      const failure = (): ProviderFailure =>
        timeout.aborted ? 'timeout' : signal.aborted ? 'aborted' : 'unavailable';

      let text: string;
      let reader: CappedReader | undefined;
      try {
        const response = await post(
          requestBody(config.model, request, undefined),
          AbortSignal.any([signal, timeout]),
        );
        reader = new CappedReader(response.body, config.maxResponseBytes);
        text = await reader.text();
      } catch (error) {
        await reader?.cancel();
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

    async stream(
      request: ProviderChatRequest,
      signal: AbortSignal,
      options: StreamOptions,
    ): Promise<ProviderStream> {
      const timedOut = new AbortController();
      const failure = (): ProviderFailure =>
        timedOut.signal.aborted ? 'timeout' : signal.aborted ? 'aborted' : 'unavailable';
      // One wait under the timeout; any failure that is not already a
      // ProviderError is named by which signal fired.
      const wait = async <T>(pending: () => Promise<T>): Promise<T> => {
        const timer = setTimeout(() => timedOut.abort(), config.timeoutMs);
        try {
          return await pending();
        } catch (error) {
          if (error instanceof ProviderError) throw error;
          throw new ProviderError(failure());
        } finally {
          clearTimeout(timer);
        }
      };

      const response = await wait(() =>
        post(
          requestBody(config.model, request, options),
          AbortSignal.any([signal, timedOut.signal]),
        ),
      );
      if (!/^text\/event-stream\b/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel();
        throw new ProviderError('bad_response');
      }

      const reader = new CappedReader(response.body, config.maxResponseBytes);
      const chunks = readChunks(reader, () => wait(() => reader.next()));
      const first = await chunks.next();
      if (first.done) throw new ProviderError('bad_response');
      return {
        id: first.value.id,
        created: first.value.created,
        events: streamEvents(first.value, chunks),
      };
    },
  };
}

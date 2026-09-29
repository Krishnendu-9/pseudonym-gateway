// The streamed answer (ADR-019): a ProviderStream in, OpenAI's server-sent
// events out, restored as they go.
//
// The events, in OpenAI's `chat.completion.chunk` shape with our model name:
//  1. a first chunk with `delta: {role: "assistant", content: ""}`;
//  2. one chunk per piece of restored text: whatever StreamRestorer says is
//     decided (a piece that decides nothing sends nothing);
//  3. at `finish`: the restorer's held-back text, then a chunk with
//     `delta: {}` and the `finish_reason`;
//  4. with `include_usage`: every chunk above carries `usage: null`, and a
//     last one with `choices: []` carries the usage (OpenAI's documented
//     form);
//  5. `data: [DONE]`.
//
// A failure after the stream has started cannot change the HTTP status any
// more (200 went out with the first byte). What the client has been sent is
// kept, and the ending says it went wrong: the restorer's held-back text is
// restored and sent (it is at most MAX_HELD_BACK characters of what the
// model really wrote, decided as at the end of an answer, exactly as
// restore() would decide it), then one `data: {"error": …}` event in the
// same shape and with the same fixed messages as an HTTP error, and no
// `[DONE]`. OpenAI's SDKs raise an `error` event as an exception; a client
// that only looks for `[DONE]` sees the stream end without it.

import type { ProviderStream, ProviderUsage } from '../providers/provider.js';
import type { StreamRestorer } from '../redaction/restore.js';
import type { GatewayError } from './errors.js';

export interface SseOptions {
  /** Our model name, never the provider's (ADR-014). */
  readonly model: string;
  readonly includeUsage: boolean;
  readonly restorer: StreamRestorer;
  /** A failure after the stream started: logs it and returns what to send. */
  readonly onError: (error: unknown) => GatewayError;
}

interface Choice {
  readonly index: 0;
  readonly delta: { readonly role?: 'assistant'; readonly content?: string };
  readonly finish_reason: string | null;
}

const event = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

export async function* sseEvents(
  stream: ProviderStream,
  options: SseOptions,
): AsyncGenerator<string> {
  const { restorer } = options;
  const chunk = (choices: readonly Choice[], usage: ProviderUsage | null = null): string =>
    event({
      id: stream.id,
      object: 'chat.completion.chunk',
      created: stream.created,
      model: options.model,
      choices,
      ...(options.includeUsage ? { usage } : {}),
    });
  const content = (text: string): string =>
    chunk([{ index: 0, delta: { content: text }, finish_reason: null }]);

  let ended = false;
  try {
    yield chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]);
    for await (const next of stream.events) {
      if (next.type === 'content') {
        const text = restorer.push(next.text);
        if (text !== '') yield content(text);
      } else if (next.type === 'finish') {
        ended = true;
        const rest = restorer.end();
        if (rest !== '') yield content(rest);
        yield chunk([{ index: 0, delta: {}, finish_reason: next.reason }]);
      } else if (options.includeUsage) {
        yield chunk([], next.usage);
      }
    }
    yield 'data: [DONE]\n\n';
  } catch (error) {
    if (!ended) {
      const rest = restorer.end();
      if (rest !== '') yield content(rest);
    }
    yield event(options.onError(error).body());
  }
}

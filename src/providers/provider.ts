// The one interface every provider adapter implements (design doc, "OpenAI-
// compatible API"). The gateway hands an adapter text that has already been
// redacted, and gets back the model's answer, still in placeholders.
//
// Every string the adapter may send is typed RedactedText
// (redaction/redact.ts): an unredacted string does not type-check here.
//
// Two calls: `complete` returns the whole answer; `stream` returns it in
// pieces (ADR-019). Either way every failure is a ProviderError.

import type { RedactedText } from '../redaction/redact.js';

export interface ProviderMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: RedactedText;
}

/** Numeric and enum settings forwarded as they are: none of them carries free text. */
export interface SamplingOptions {
  readonly temperature?: number;
  readonly top_p?: number;
  readonly max_tokens?: number;
  readonly seed?: number;
  readonly frequency_penalty?: number;
  readonly presence_penalty?: number;
  readonly reasoning_effort?: string;
  readonly response_format?: { readonly type: 'text' | 'json_object' };
}

export interface ProviderChatRequest {
  readonly messages: readonly ProviderMessage[];
  readonly stop?: readonly RedactedText[];
  readonly options: SamplingOptions;
}

export interface ProviderUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

export type FinishReason = 'stop' | 'length' | 'content_filter';

/**
 * What an answer carried in `extra_content`, as numbers only (ADR-041
 * section 15, decision 3): never the content, which is dropped. In every
 * recorded Gemini answer it is `{google: {thought_signature}}`.
 */
export interface DroppedExtras {
  /** How many `extra_content` objects the answer carried (message or stream deltas). */
  readonly extraContent: number;
  /** The length in characters of each `extra_content.google.thought_signature` string. */
  readonly thoughtSignatureLengths: readonly number[];
}

/**
 * The answer, still in placeholders; the gateway restores `content` and
 * `refusal`. `refusal` is set only when the provider named a refusal with
 * text (ADR-041 section 15, decision 1), and `content` is then null rather
 * than "" when the refusal came without content. With no refusal, an
 * answer with no text ends `length` or `content_filter` (an empty `stop`
 * is the `empty_response` failure), and its `content` is as sent: "" or
 * null.
 */
export interface ProviderChatResult {
  readonly id: string;
  readonly created: number;
  readonly content: string | null;
  readonly refusal?: string;
  readonly finishReason: FinishReason;
  readonly usage?: ProviderUsage;
  /** Set only when the answer carried `extra_content`. */
  readonly dropped?: DroppedExtras;
}

/** One piece of a streamed answer, still in placeholders. */
export type ProviderStreamEvent =
  | { readonly type: 'content'; readonly text: string }
  | { readonly type: 'refusal'; readonly text: string }
  | { readonly type: 'finish'; readonly reason: FinishReason }
  | { readonly type: 'usage'; readonly usage: ProviderUsage };

/**
 * A streamed answer. `stream()` resolves once the provider has accepted the
 * request and sent its first chunk, which is where `id` and `created` come
 * from. Everything that can go wrong before that is a rejection, which the
 * gateway can still answer with an HTTP error status.
 *
 * `events` then yields, in this order: any number of `content` and
 * `refusal` events (two separate texts, in any interleaving), exactly one
 * `finish`, at most one `usage`. It ends only once the provider
 * has said the answer is complete; anything else (a cut connection, a
 * malformed chunk, a gap longer than the timeout) is a ProviderError thrown
 * from the iteration.
 */
export interface ProviderStream {
  readonly id: string;
  readonly created: number;
  readonly events: AsyncIterable<ProviderStreamEvent>;
  /** What the chunks read so far carried in `extra_content`, as numbers only. */
  readonly dropped?: () => DroppedExtras;
}

export interface StreamOptions {
  /** Ask the provider for token usage at the end of the stream. */
  readonly includeUsage: boolean;
}

export interface ChatProvider {
  complete(request: ProviderChatRequest, signal: AbortSignal): Promise<ProviderChatResult>;
  stream(
    request: ProviderChatRequest,
    signal: AbortSignal,
    options: StreamOptions,
  ): Promise<ProviderStream>;
}

/**
 * - `timeout`: no answer, or no next chunk, within the timeout;
 * - `unavailable`: the connection failed or was cut;
 * - `http`: a status other than 2xx;
 * - `bad_response`: an answer we cannot use (not JSON, the wrong shape, a
 *   tool call, a stream that ended before the provider said it was done);
 * - `too_large`: more bytes than the response size cap (ADR-020);
 * - `stream_error`: the provider sent an error in the middle of a stream;
 * - `empty_response`: the answer finished `stop` with no text and named no
 *   refusal, so it may be a refusal or an empty answer (ADR-041 section 15,
 *   the empty `stop` ruling);
 * - `aborted`: our caller gave up (the client disconnected).
 */
export type ProviderFailure =
  | 'timeout'
  | 'unavailable'
  | 'http'
  | 'bad_response'
  | 'too_large'
  | 'stream_error'
  | 'empty_response'
  | 'aborted';

/**
 * A provider call failed. Carries only what kind of failure it was and, for
 * `http`, the status code: never the provider's response body (it can echo
 * the prompt) and never a lower-level error's message (a JSON.parse
 * SyntaxError quotes its input).
 */
export class ProviderError extends Error {
  readonly failure: ProviderFailure;
  readonly status: number | undefined;

  constructor(failure: ProviderFailure, status?: number) {
    super(status === undefined ? `provider ${failure}` : `provider ${failure} (status ${status})`);
    this.name = 'ProviderError';
    this.failure = failure;
    this.status = status;
  }
}

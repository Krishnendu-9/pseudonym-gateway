// The one interface every provider adapter implements (design doc, "OpenAI-
// compatible API"). The gateway hands an adapter text that has already been
// redacted, and gets back the model's answer, still in placeholders.
//
// Every string the adapter may send is typed RedactedText
// (redaction/redact.ts): an unredacted string does not type-check here.

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

/** The answer, still in placeholders; the gateway restores `content`. */
export interface ProviderChatResult {
  readonly id: string;
  readonly created: number;
  readonly content: string;
  readonly finishReason: 'stop' | 'length' | 'content_filter';
  readonly usage?: ProviderUsage;
}

export interface ChatProvider {
  complete(request: ProviderChatRequest, signal: AbortSignal): Promise<ProviderChatResult>;
}

export type ProviderFailure = 'timeout' | 'unavailable' | 'http' | 'bad_response' | 'aborted';

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

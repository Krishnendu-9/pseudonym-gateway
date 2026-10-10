// Errors the gateway returns, in OpenAI's error shape so that OpenAI SDKs
// parse them: `{"error": {"message", "type", "param", "code"}}`.
//
// The rule (design doc, "Errors and logs"): no personal value ever appears in
// a response, a log line or a thrown error. So every message a client sees
// is fixed text written here; an error's own `message` is never forwarded,
// because a lower layer may have put input into it (V8's JSON.parse quotes
// its input: `Unexpected token 'c', "{"a": c…" is not valid JSON`).

import { PlaceholderLimitError } from '../redaction/placeholder.js';
import { ProviderError } from '../providers/provider.js';

export type ErrorType = 'invalid_request_error' | 'not_found_error' | 'api_error';

export interface ErrorBody {
  readonly error: {
    readonly message: string;
    readonly type: ErrorType;
    readonly param: null;
    readonly code: string;
  };
}

/** An error whose status, code and message are safe to return as they are. */
export class GatewayError extends Error {
  readonly statusCode: number;
  readonly type: ErrorType;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'GatewayError';
    this.statusCode = statusCode;
    this.type =
      statusCode === 404
        ? 'not_found_error'
        : statusCode < 500
          ? 'invalid_request_error'
          : 'api_error';
    this.code = code;
  }

  body(): ErrorBody {
    return { error: { message: this.message, type: this.type, param: null, code: this.code } };
  }
}

/**
 * Why a request's names could not be found (ADR-037). Logged, never
 * returned: the client always sees the same fixed 503.
 */
export type NameFailure = 'timeout' | 'queue_full' | 'crashed' | 'failed' | 'malformed' | 'aborted';

/**
 * With names on, a request whose names could not be found is refused, never
 * sent without them (ADR-036). Defined here rather than with the name
 * detector so that a gateway with names off never loads a names module.
 */
export class NameDetectionUnavailable extends GatewayError {
  readonly reason: NameFailure;

  constructor(reason: NameFailure) {
    super(503, 'name_detection_unavailable', 'name detection is unavailable');
    this.name = 'NameDetectionUnavailable';
    this.reason = reason;
  }
}

/**
 * With names on, the gateway does not start unless the name list matches
 * its pinned hash, every model file is present and matches its pinned hash,
 * and the model loads (ADR-036). `code` says which, and `file` which model
 * file (its path in the pinned list, never anything read from it); the
 * underlying error is not kept, since its message is not ours.
 */
export class NameStartupError extends Error {
  readonly code:
    | 'NAME_LIST_MISMATCH'
    | 'NAME_MODEL_FILE_MISSING'
    | 'NAME_MODEL_FILE_MISMATCH'
    | 'NAME_MODEL_LOAD_FAILED';
  readonly file: string | undefined;

  constructor(code: NameStartupError['code'], file?: string) {
    super('name detection could not start');
    this.name = 'NameStartupError';
    this.code = code;
    this.file = file;
  }
}

// Fastify's own errors, by code. Only these codes are recognised; their
// messages are replaced, not reused.
function fromFastify(code: string, bodyLimit: number): GatewayError | undefined {
  switch (code) {
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
      return new GatewayError(400, 'invalid_json', 'request body is not valid JSON');
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return new GatewayError(
        413,
        'body_too_large',
        `request body is larger than ${bodyLimit} bytes`,
      );
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return new GatewayError(
        415,
        'unsupported_media_type',
        'content type must be application/json',
      );
    default:
      return undefined;
  }
}

function fromProvider(error: ProviderError): GatewayError {
  switch (error.failure) {
    case 'timeout':
      return new GatewayError(504, 'provider_timeout', 'the provider did not answer in time');
    case 'http':
      // Deliberately 502 even for a provider 4xx (ADR-014): the provider's
      // body can echo the prompt, so it is never forwarded; the status
      // number alone is safe.
      return new GatewayError(
        502,
        'provider_error',
        `the provider returned an error (status ${error.status})`,
      );
    case 'bad_response':
      return new GatewayError(
        502,
        'provider_bad_response',
        'the provider returned an unusable response',
      );
    case 'too_large':
      return new GatewayError(
        502,
        'provider_response_too_large',
        'the provider response was larger than the response size limit',
      );
    case 'stream_error':
      return new GatewayError(
        502,
        'provider_error',
        'the provider reported an error during the stream',
      );
    case 'empty_response':
      // A 5xx, not a 4xx: the client's request was not at fault, and the
      // same request may get an answer next time (ADR-041 section 15).
      return new GatewayError(
        502,
        'provider_empty_response',
        'the provider returned no text and no refusal',
      );
    case 'unavailable':
    case 'aborted':
      return new GatewayError(502, 'provider_unavailable', 'the provider could not be reached');
  }
}

/** Maps any thrown value to an error that is safe to return. */
export function toGatewayError(error: unknown, bodyLimit: number): GatewayError {
  if (error instanceof GatewayError) return error;
  if (error instanceof PlaceholderLimitError) {
    return new GatewayError(
      422,
      'too_many_values',
      'too many distinct values of one type in one request',
    );
  }
  if (error instanceof ProviderError) return fromProvider(error);
  const code = (error as { code?: unknown } | null)?.code;
  const fastify = typeof code === 'string' ? fromFastify(code, bodyLimit) : undefined;
  if (fastify) return fastify;
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return new GatewayError(400, 'invalid_request', 'invalid request');
  }
  return new GatewayError(500, 'internal_error', 'internal error');
}

// V8 writes a stack as `${name}: ${message}` followed by one `    at …` line
// per frame. The header is cut off by its exact text, not by looking for
// the first `at` line: a message can span lines and contain input shaped
// like a frame. V8 formats the stack lazily, on first access, from the
// message at that moment; if the stack was read and the message changed
// afterwards, the two no longer match, and no frames are kept at all.
function stackFrames(error: Error): string[] {
  const stack = error.stack ?? '';
  const header = String(error);
  if (!stack.startsWith(header)) return [];
  return stack
    .slice(header.length)
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .map((line) => line.trim());
}

/**
 * What may be logged about an error: its name, a known code, the provider
 * failure kind and status, why names were unavailable, and for unexpected
 * errors the stack frames without the message.
 */
export function safeErrorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: typeof error };
  const details: Record<string, unknown> = { name: error.name };
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)) details.code = code;
  if (error instanceof GatewayError) details.code = error.code;
  if (error instanceof NameDetectionUnavailable) details.reason = error.reason;
  if (error instanceof NameStartupError && error.file !== undefined) details.file = error.file;
  if (error instanceof ProviderError) {
    details.failure = error.failure;
    if (error.status !== undefined) details.status = error.status;
  }
  const known =
    error instanceof GatewayError ||
    error instanceof ProviderError ||
    error instanceof PlaceholderLimitError ||
    details.code !== undefined;
  if (!known) details.frames = stackFrames(error);
  return details;
}

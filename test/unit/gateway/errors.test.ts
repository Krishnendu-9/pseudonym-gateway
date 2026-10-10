// Error mapping and what may be logged about an error: every message a
// client sees is fixed text, and a logged error keeps its name, code and
// stack frames but never its message.

import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  GatewayError,
  isProviderRejection,
  NameDetectionUnavailable,
  PROVIDER_RETRY_AFTER_SECONDS,
  safeErrorDetails,
  toGatewayError,
  type ErrorBody,
} from '../../../src/gateway/errors.js';
import { ProviderError, type ProviderFailure } from '../../../src/providers/provider.js';
import { PlaceholderLimitError } from '../../../src/redaction/placeholder.js';

const LIMIT = 262_144;
const fastifyError = (code: string, statusCode: number): Error =>
  Object.assign(new Error(`message with canary@example.com (${code})`), { code, statusCode });

describe('toGatewayError', () => {
  it('passes a GatewayError through unchanged', () => {
    const error = new GatewayError(400, 'x', 'y');
    expect(toGatewayError(error, LIMIT)).toBe(error);
  });

  it('PlaceholderLimitError → 422, fixed message, no namespace', () => {
    const safe = toGatewayError(new PlaceholderLimitError('EMAIL'), LIMIT);
    expect(safe.body()).toEqual({
      error: {
        message: 'too many distinct values of one type in one request',
        type: 'invalid_request_error',
        param: null,
        code: 'too_many_values',
      },
    });
    expect(safe.statusCode).toBe(422);
  });

  it.each([
    [new ProviderError('timeout'), 504, 'provider_timeout', 'the provider did not answer in time'],
    [
      new ProviderError('http', 503),
      502,
      'provider_error',
      'the provider returned an error (status 503)',
    ],
    [
      new ProviderError('bad_response'),
      502,
      'provider_bad_response',
      'the provider returned an unusable response',
    ],
    [
      new ProviderError('unavailable'),
      502,
      'provider_unavailable',
      'the provider could not be reached',
    ],
    [
      new ProviderError('too_large'),
      502,
      'provider_response_too_large',
      'the provider response was larger than the response size limit',
    ],
    [
      new ProviderError('stream_error'),
      502,
      'provider_error',
      'the provider reported an error during the stream',
    ],
    [
      new ProviderError('aborted'),
      502,
      'provider_unavailable',
      'the provider could not be reached',
    ],
  ])('%s → %i %s', (error, status, code, message) => {
    const safe = toGatewayError(error, LIMIT);
    expect([safe.statusCode, safe.code, safe.message, safe.type]).toEqual([
      status,
      code,
      message,
      'api_error',
    ]);
  });

  it.each([
    ['FST_ERR_CTP_INVALID_JSON_BODY', 400, 400, 'invalid_json', 'request body is not valid JSON'],
    ['FST_ERR_CTP_EMPTY_JSON_BODY', 400, 400, 'invalid_json', 'request body is not valid JSON'],
    [
      'FST_ERR_CTP_BODY_TOO_LARGE',
      413,
      413,
      'body_too_large',
      'request body is larger than 262144 bytes',
    ],
    [
      'FST_ERR_CTP_INVALID_MEDIA_TYPE',
      415,
      415,
      'unsupported_media_type',
      'content type must be application/json',
    ],
    ['FST_ERR_SOMETHING_ELSE', 400, 400, 'invalid_request', 'invalid request'],
    ['FST_ERR_SOMETHING_ELSE', 499, 400, 'invalid_request', 'invalid request'],
    ['FST_ERR_SOMETHING_ELSE', 500, 500, 'internal_error', 'internal error'],
  ])('Fastify %s (%i) → %i %s, message replaced', (code, upstream, status, ourCode, message) => {
    const safe = toGatewayError(fastifyError(code, upstream), LIMIT);
    expect([safe.statusCode, safe.code, safe.message]).toEqual([status, ourCode, message]);
  });

  it.each([
    ['an Error', new Error('boom canary@example.com')],
    ['a string', 'canary@example.com'],
    ['null', null],
    ['an object with a non-string code', { code: 42, statusCode: 'x' }],
  ])('anything else (%s) → 500, fixed message', (_name, error) => {
    const safe = toGatewayError(error, LIMIT);
    expect(safe.body()).toEqual({
      error: { message: 'internal error', type: 'api_error', param: null, code: 'internal_error' },
    });
  });

  // ADR-041 sections 13 and 15, option 4b: moved out of the 502 table above,
  // where a provider 400 was a 502 provider_error like any other status.
  it('a provider 400 → 400 provider_rejected_request, param null, fixed message (4b)', () => {
    const safe = toGatewayError(new ProviderError('http', 400), LIMIT);
    expect([safe.statusCode, safe.headers]).toEqual([400, {}]);
    expect(safe.body()).toEqual({
      error: {
        message: 'the provider rejected the request',
        type: 'invalid_request_error',
        param: null,
        code: 'provider_rejected_request',
      },
    });
  });

  it('only a provider HTTP 400 counts as a provider rejection, for the warn log', () => {
    expect(isProviderRejection(new ProviderError('http', 400))).toBe(true);
    for (const status of [401, 403, 404, 409, 422, 429, 500]) {
      expect([status, isProviderRejection(new ProviderError('http', status))]).toEqual([
        status,
        false,
      ]);
    }
    expect(isProviderRejection(new ProviderError('bad_response'))).toBe(false);
    expect(isProviderRejection(new GatewayError(400, 'invalid_request', 'x'))).toBe(false);
  });

  it('a 404 GatewayError has type not_found_error', () => {
    expect(new GatewayError(404, 'not_found', 'x').type).toBe('not_found_error');
  });
});

// ADR-041 section 16, decision G: `param` may carry a field name, which only
// option 3 will set; every error that exists today still sends null.
describe('param', () => {
  it('is typed string | null (checked by the typecheck, not at run time)', () => {
    expectTypeOf<ErrorBody['error']['param']>().toEqualTypeOf<string | null>();
  });

  // Every failure kind, as a record so that a new kind fails the typecheck
  // until it is listed here.
  const FAILURES = Object.keys({
    timeout: true,
    unavailable: true,
    http: true,
    bad_response: true,
    too_large: true,
    stream_error: true,
    empty_response: true,
    aborted: true,
  } satisfies Record<ProviderFailure, true>) as ProviderFailure[];

  it('is null for every error the gateway produces today', () => {
    const errors: GatewayError[] = [
      new GatewayError(400, 'invalid_request', 'x'),
      new GatewayError(404, 'not_found', 'x'),
      new NameDetectionUnavailable('timeout'),
      toGatewayError(new PlaceholderLimitError('EMAIL'), LIMIT),
      ...FAILURES.map((failure) => toGatewayError(new ProviderError(failure), LIMIT)),
      ...[400, 401, 404, 429, 500, 503].map((status) =>
        toGatewayError(new ProviderError('http', status), LIMIT),
      ),
      ...[
        'FST_ERR_CTP_INVALID_JSON_BODY',
        'FST_ERR_CTP_EMPTY_JSON_BODY',
        'FST_ERR_CTP_BODY_TOO_LARGE',
        'FST_ERR_CTP_INVALID_MEDIA_TYPE',
        'FST_ERR_SOMETHING_ELSE',
      ].map((code) => toGatewayError(fastifyError(code, 400), LIMIT)),
      toGatewayError(new Error('boom'), LIMIT),
    ];
    expect(errors.map((error) => error.body().error.param)).toEqual(errors.map(() => null));
  });
});

// ADR-041 section 15, decision 2: whatever value is chosen, above 60 s
// openai-node ignores Retry-After and falls back to its own fast backoff.
describe('the Retry-After sent with a provider 429', () => {
  it('is a whole number of seconds from 1 to 60', () => {
    expect(Number.isInteger(PROVIDER_RETRY_AFTER_SECONDS)).toBe(true);
    expect(PROVIDER_RETRY_AFTER_SECONDS).toBeGreaterThanOrEqual(1);
    expect(PROVIDER_RETRY_AFTER_SECONDS).toBeLessThanOrEqual(60);
  });

  it('a 429 is a 503 carrying it; no other provider status carries a header', () => {
    const limited = toGatewayError(new ProviderError('http', 429), LIMIT);
    expect([limited.statusCode, limited.code, limited.headers]).toEqual([
      503,
      'provider_rate_limited',
      { 'retry-after': String(PROVIDER_RETRY_AFTER_SECONDS) },
    ]);
    // 400 left this list for 4b (its own test above): a 400 now, still no header.
    for (const status of [401, 403, 404, 408, 409, 422, 500, 502, 503]) {
      const other = toGatewayError(new ProviderError('http', status), LIMIT);
      expect([status, other.statusCode, other.headers]).toEqual([status, 502, {}]);
    }
    expect(toGatewayError(new ProviderError('http', 400), LIMIT).headers).toEqual({});
  });
});

describe('safeErrorDetails', () => {
  it('an unexpected Error: name and stack frames, never the message', () => {
    const error = new Error('failed on canary@example.com');
    const details = safeErrorDetails(error);
    expect(details.name).toBe('Error');
    expect(JSON.stringify(details)).not.toContain('canary');
    expect((details.frames as string[]).length).toBeGreaterThan(0);
    expect((details.frames as string[]).every((f) => f.startsWith('at '))).toBe(true);
  });

  it('a multi-line message shaped like stack frames is still dropped', () => {
    const error = new Error('first line\n    at canary@example.com (4111 1111 1111 1111)');
    const details = safeErrorDetails(error);
    expect(JSON.stringify(details)).not.toContain('canary');
    expect(JSON.stringify(details)).not.toContain('4111');
  });

  it('a message changed after the stack was read: header and message disagree, no frames at all', () => {
    const error = new Error('original');
    void error.stack; // V8 formats the stack on first access
    error.message = 'changed to canary@example.com';
    const details = safeErrorDetails(error);
    expect(details.frames).toEqual([]);
    expect(JSON.stringify(details)).not.toContain('canary');
  });

  it('a message changed before the stack was read: the lazy stack uses the new header, still cut', () => {
    const error = new Error('original');
    error.message = 'changed to canary@example.com';
    const details = safeErrorDetails(error);
    expect((details.frames as string[]).length).toBeGreaterThan(0);
    expect(JSON.stringify(details)).not.toContain('canary');
  });

  it('an error without a stack', () => {
    const error = new Error('x');
    delete error.stack;
    expect(safeErrorDetails(error)).toEqual({ name: 'Error', frames: [] });
  });

  it('known errors: name and code, no frames', () => {
    expect(safeErrorDetails(new GatewayError(400, 'stream_not_supported', 'x'))).toEqual({
      name: 'GatewayError',
      code: 'stream_not_supported',
    });
    expect(safeErrorDetails(new ProviderError('http', 502))).toEqual({
      name: 'ProviderError',
      failure: 'http',
      status: 502,
    });
    expect(safeErrorDetails(new ProviderError('timeout'))).toEqual({
      name: 'ProviderError',
      failure: 'timeout',
    });
    expect(safeErrorDetails(new PlaceholderLimitError('EMAIL'))).toEqual({
      name: 'PlaceholderLimitError',
    });
    expect(safeErrorDetails(fastifyError('FST_ERR_CTP_BODY_TOO_LARGE', 413))).toEqual({
      name: 'Error',
      code: 'FST_ERR_CTP_BODY_TOO_LARGE',
    });
  });

  it('a code that does not look like a code is not logged', () => {
    const error = Object.assign(new Error('x'), { code: 'canary@example.com' });
    expect(JSON.stringify(safeErrorDetails(error))).not.toContain('canary');
  });

  it('a thrown non-Error: only its type', () => {
    expect(safeErrorDetails('canary@example.com')).toEqual({ name: 'string' });
    expect(safeErrorDetails(undefined)).toEqual({ name: 'undefined' });
  });
});

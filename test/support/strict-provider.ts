// A provider that follows the OpenAI chat-completions specification to the
// letter (Phase 7b, ADR-041 section 5). It catches what lenient layers let
// slide: a fault in the gateway that Ollama and Gemini both happen to
// tolerate still fails here. Built from the specification (OpenAI's Node SDK
// types, `src/resources/chat/completions/completions.ts`, read 2026-10-07;
// the API reference page refused automated reads), never from either
// provider's behaviour.
//
// It is a Responder for the mock provider (mock-provider.ts), so the raw
// request bytes are still recorded. On the way in it checks every request
// (`requestViolations`) and answers 400 with the specification's error body
// on any violation; each violation also goes into `violations`, so a test
// asserts there were none. On the way out it sends everything the
// specification allows, which lenient providers mostly leave out.

import type { ServerResponse } from 'node:http';
import type { RecordedRequest, Responder } from './mock-provider.js';

/** Every request field the specification defines (ChatCompletionCreateParamsBase). */
export const SPEC_REQUEST_FIELDS: ReadonlySet<string> = new Set([
  'audio',
  'frequency_penalty',
  'function_call',
  'functions',
  'logit_bias',
  'logprobs',
  'max_completion_tokens',
  'max_tokens',
  'messages',
  'metadata',
  'modalities',
  'model',
  'moderation',
  'n',
  'parallel_tool_calls',
  'prediction',
  'presence_penalty',
  'prompt_cache_key',
  'prompt_cache_options',
  'prompt_cache_retention',
  'reasoning_effort',
  'response_format',
  'safety_identifier',
  'seed',
  'service_tier',
  'stop',
  'store',
  'stream',
  'stream_options',
  'temperature',
  'tool_choice',
  'tools',
  'top_logprobs',
  'top_p',
  'user',
  'verbosity',
  'web_search_options',
]);

/** The specification's `reasoning_effort` values. */
export const SPEC_REASONING_EFFORT: ReadonlySet<string> = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/**
 * Fields the specification allows but this gateway must never forward
 * (ADR-014: dropped, like `user`, or rejected before the provider, like
 * tools). Policy, stricter than the specification, and labelled so.
 */
export const NEVER_FORWARDED: readonly string[] = [
  'audio',
  'function_call',
  'functions',
  'logit_bias',
  'metadata',
  'modalities',
  'moderation',
  'parallel_tool_calls',
  'prediction',
  'prompt_cache_key',
  'prompt_cache_options',
  'prompt_cache_retention',
  'safety_identifier',
  'service_tier',
  'store',
  'tool_choice',
  'tools',
  'top_logprobs',
  'user',
  'verbosity',
  'web_search_options',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const inRange = (value: unknown, low: number, high: number): boolean =>
  typeof value === 'number' && value >= low && value <= high;

/**
 * What is wrong with a request, by the specification ("spec: …") or by this
 * gateway's policy ("policy: …"); empty when nothing is. `sentinelHeaders`
 * are headers the test's own client sent, which must never reach a provider.
 */
export function requestViolations(
  request: Pick<RecordedRequest, 'headers' | 'body'>,
  expectedKey: string,
  sentinelHeaders: readonly string[] = [],
): string[] {
  const out: string[] = [];
  const { headers } = request;
  if (headers['content-type'] !== 'application/json') {
    out.push('spec: content-type must be application/json');
  }
  if (headers.authorization !== `Bearer ${expectedKey}`) {
    out.push('spec: authorization must be exactly "Bearer <key>"');
  }
  for (const name of sentinelHeaders) {
    if (headers[name.toLowerCase()] !== undefined)
      out.push(`policy: client header ${name} forwarded`);
  }

  let body: unknown;
  try {
    body = JSON.parse(request.body);
  } catch {
    return [...out, 'spec: body is not JSON'];
  }
  if (!isRecord(body)) return [...out, 'spec: body is not an object'];

  for (const key of Object.keys(body)) {
    if (!SPEC_REQUEST_FIELDS.has(key)) out.push(`spec: unknown field ${key}`);
  }
  for (const key of NEVER_FORWARDED) {
    if (Object.hasOwn(body, key)) out.push(`policy: ${key} forwarded`);
  }
  if (typeof body.model !== 'string' || body.model === '') out.push('spec: model must be a string');

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    out.push('spec: messages must be a non-empty array');
  } else {
    for (const message of body.messages as unknown[]) {
      if (!isRecord(message)) {
        out.push('spec: a message is not an object');
        continue;
      }
      if (!['system', 'user', 'assistant'].includes(message.role as string)) {
        out.push(`policy: message role ${String(message.role)}`);
      }
      if (typeof message.content !== 'string') out.push('policy: message content is not a string');
      for (const key of Object.keys(message)) {
        if (key !== 'role' && key !== 'content') out.push(`policy: message field ${key}`);
      }
    }
  }

  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    out.push('spec: stream must be a boolean');
  }
  if (body.stream_options !== undefined) {
    if (body.stream !== true) out.push('spec: stream_options set without stream: true');
    if (!isRecord(body.stream_options)) {
      out.push('spec: stream_options must be an object');
    } else {
      for (const key of Object.keys(body.stream_options)) {
        if (key !== 'include_usage' && key !== 'include_obfuscation') {
          out.push(`spec: stream_options.${key}`);
        }
      }
    }
  }
  if (body.stop !== undefined) {
    const stops = typeof body.stop === 'string' ? [body.stop] : body.stop;
    if (!Array.isArray(stops) || stops.some((s) => typeof s !== 'string')) {
      out.push('spec: stop must be a string or an array of strings');
    } else if (stops.length > 4) {
      out.push('spec: more than 4 stop sequences');
    }
  }
  if (
    body.reasoning_effort !== undefined &&
    !SPEC_REASONING_EFFORT.has(body.reasoning_effort as string)
  ) {
    out.push('spec: reasoning_effort outside the specification');
  }
  if (body.response_format !== undefined) {
    const format = body.response_format;
    if (!isRecord(format) || !['text', 'json_object'].includes(format.type as string)) {
      out.push('policy: response_format other than text or json_object');
    }
  }
  if (body.temperature !== undefined && !inRange(body.temperature, 0, 2)) {
    out.push('spec: temperature outside 0..2');
  }
  if (body.top_p !== undefined && !inRange(body.top_p, 0, 1)) out.push('spec: top_p outside 0..1');
  for (const key of ['frequency_penalty', 'presence_penalty'] as const) {
    if (body[key] !== undefined && !inRange(body[key], -2, 2))
      out.push(`spec: ${key} outside -2..2`);
  }
  for (const key of ['max_tokens', 'max_completion_tokens'] as const) {
    const value = body[key];
    if (value !== undefined && !(Number.isInteger(value) && (value as number) > 0)) {
      out.push(`spec: ${key} must be a positive integer`);
    }
  }
  if (body.seed !== undefined && !Number.isInteger(body.seed))
    out.push('spec: seed must be an integer');
  if (body.n !== undefined && body.n !== 1) out.push('policy: n other than 1');
  if (body.logprobs !== undefined && body.logprobs !== false)
    out.push('policy: logprobs requested');
  return out;
}

/** The specification's error body. */
export const errorBody = (message: string, type: string, code: string | null): string =>
  JSON.stringify({ error: { message, type, param: null, code } });

/** A complete chat completion with every field the specification defines. */
export function fullCompletion(
  content: string | null,
  finishReason: string,
  refusal: string | null = null,
): string {
  return JSON.stringify({
    id: 'chatcmpl-strict',
    object: 'chat.completion',
    created: 1_790_000_200,
    model: 'strict-model',
    system_fingerprint: 'fp_strict',
    service_tier: 'default',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, refusal, annotations: [] },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
      prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
      completion_tokens_details: {
        reasoning_tokens: 0,
        audio_tokens: 0,
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
      },
    },
  });
}

/** One streamed chunk as the specification shapes it, with `usage: null` and an obfuscation field. */
function chunk(choices: unknown[], usage: unknown = null): string {
  return JSON.stringify({
    id: 'chatcmpl-strict-stream',
    object: 'chat.completion.chunk',
    created: 1_790_000_300,
    model: 'strict-model',
    system_fingerprint: 'fp_strict',
    service_tier: 'default',
    choices,
    usage,
    obfuscation: 'pAdDiNg',
  });
}

/** The SSE text of a specification-complete stream, with CRLF line ends and keep-alive comments. */
export function fullStream(
  pieces: readonly string[],
  finishReason: string,
  { includeUsage = true, done = true, errorAfter = -1 } = {},
): string {
  const events: string[] = [
    chunk([
      {
        index: 0,
        delta: { role: 'assistant', content: '', refusal: null },
        logprobs: null,
        finish_reason: null,
      },
    ]),
  ];
  pieces.forEach((text, i) => {
    if (i === errorAfter) events.push(errorBody('the server had an error', 'server_error', null));
    events.push(
      chunk([{ index: 0, delta: { content: text }, logprobs: null, finish_reason: null }]),
    );
  });
  events.push(chunk([{ index: 0, delta: {}, logprobs: null, finish_reason: finishReason }]));
  if (includeUsage) {
    events.push(
      chunk([], {
        prompt_tokens: 11,
        completion_tokens: pieces.length,
        total_tokens: 11 + pieces.length,
      }),
    );
  }
  let text = ': keep-alive\r\n\r\n';
  for (const data of events) text += `data: ${data}\r\n\r\n`;
  if (done) text += 'data: [DONE]\r\n\r\n';
  return text;
}

/** What the strict provider answers with, once the request has passed its checks. */
export type StrictAnswer =
  | {
      readonly kind: 'complete';
      readonly content: string | null;
      readonly finishReason?: string;
      readonly refusal?: string | null;
    }
  | {
      readonly kind: 'stream';
      readonly pieces: readonly string[];
      readonly finishReason?: string;
      readonly done?: boolean;
      readonly errorAfter?: number;
    }
  | { readonly kind: 'status'; readonly status: number; readonly retryAfter?: string };

export interface StrictProvider {
  readonly responder: Responder;
  /** Every violation of every request so far, with the request's index. */
  readonly violations: string[];
  /** What the next requests are answered with (until changed). */
  answer: StrictAnswer;
}

/** A strict provider expecting `key`, refusing any request that violates the specification or the gateway's policy. */
export function strictProvider(
  key: string,
  sentinelHeaders: readonly string[] = [],
): StrictProvider {
  let index = 0;
  const provider: StrictProvider = {
    violations: [],
    answer: { kind: 'complete', content: 'Done.' },
    responder: (request: RecordedRequest, response: ServerResponse) => {
      const found = requestViolations(request, key, sentinelHeaders);
      const n = index++;
      if (found.length > 0) {
        provider.violations.push(...found.map((v) => `#${n} ${v}`));
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(errorBody(found.join('; '), 'invalid_request_error', null));
        return;
      }
      const answer = provider.answer;
      if (answer.kind === 'status') {
        response.writeHead(answer.status, {
          'content-type': 'application/json',
          ...(answer.retryAfter === undefined ? {} : { 'retry-after': answer.retryAfter }),
        });
        response.end(errorBody('rate limited or failed', 'requests', 'rate_limit_exceeded'));
        return;
      }
      if (answer.kind === 'complete') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          fullCompletion(answer.content, answer.finishReason ?? 'stop', answer.refusal ?? null),
        );
        return;
      }
      const body = JSON.parse(request.body) as { stream_options?: { include_usage?: boolean } };
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.end(
        fullStream(answer.pieces, answer.finishReason ?? 'stop', {
          includeUsage: body.stream_options?.include_usage === true,
          done: answer.done ?? true,
          errorAfter: answer.errorAfter ?? -1,
        }),
      );
    },
  };
  return provider;
}

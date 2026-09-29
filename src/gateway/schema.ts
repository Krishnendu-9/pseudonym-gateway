// The request allowlist for POST /v1/chat/completions (ADR-014).
//
// Every field has one of four fates: forwarded (numbers and enums, which
// carry no free text), redacted (message text and `stop`), dropped (`user`,
// `safety_identifier`: identifiers whose only purpose is to tell the
// provider who the end user is), or rejected with a 400. Anything this file
// does not name is rejected too, so a field OpenAI adds next year is never
// forwarded unredacted by accident.
//
// Two passes. `unsupportedFeature` first gives a specific message for things
// OpenAI supports and Pseudonym deliberately does not (tools, images,
// audio...). Then a strict Zod schema checks everything else. Neither
// ever puts a received value, or an unknown key's name, into a message: a
// key can itself be personal data (`{"priya@example.com": 1}`). Paths are
// built from known field names and array indices only.

import { z } from 'zod';
import { GatewayError } from './errors.js';

const textPart = z.strictObject({ type: z.literal('text'), text: z.string() });

const message = z.strictObject({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.union([z.string(), z.array(textPart).min(1)]),
});

// OpenAI clients often send `null` for a setting they leave unset.
const requestSchema = z.strictObject({
  model: z.string().min(1),
  messages: z.array(message).min(1),
  stream: z.boolean().nullish(),
  // Only with stream: true (checked below). include_usage is the only option.
  stream_options: z.strictObject({ include_usage: z.boolean().nullish() }).nullish(),
  temperature: z.number().min(0).max(2).nullish(),
  top_p: z.number().min(0).max(1).nullish(),
  max_tokens: z.int().positive().nullish(),
  max_completion_tokens: z.int().positive().nullish(),
  seed: z.int().nullish(),
  frequency_penalty: z.number().min(-2).max(2).nullish(),
  presence_penalty: z.number().min(-2).max(2).nullish(),
  reasoning_effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).nullish(),
  response_format: z
    .discriminatedUnion('type', [
      z.strictObject({ type: z.literal('text') }),
      z.strictObject({ type: z.literal('json_object') }),
    ])
    .nullish(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).nullish(),
  n: z.literal(1).nullish(),
  logprobs: z.literal(false).nullish(),
  // Accepted, then dropped (ADR-014).
  user: z.string().nullish(),
  safety_identifier: z.string().nullish(),
});

export type ChatRequest = z.infer<typeof requestSchema>;
export type ChatMessage = ChatRequest['messages'][number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const unsupported = (message: string): GatewayError =>
  new GatewayError(400, 'unsupported_feature', message);

// Top-level fields OpenAI defines that Pseudonym deliberately does not
// support, with the reason given to the client. Present with any value other
// than null, they are rejected.
const UNSUPPORTED_FIELDS: Readonly<Record<string, string>> = {
  tools: 'tool and function calling is not supported',
  tool_choice: 'tool and function calling is not supported',
  functions: 'tool and function calling is not supported',
  function_call: 'tool and function calling is not supported',
  parallel_tool_calls: 'tool and function calling is not supported',
  audio: 'audio is not supported',
  modalities: 'only text output is supported',
  metadata: 'stored completions (store, metadata) are not supported',
  store: 'stored completions (store, metadata) are not supported',
  top_logprobs: 'logprobs are not supported',
  logit_bias: 'logit_bias is not supported',
  prediction: 'predicted outputs are not supported',
  web_search_options: 'web search is not supported',
};

function unsupportedFeature(body: Record<string, unknown>): GatewayError | undefined {
  if (body.logprobs === true) return unsupported('logprobs are not supported');
  if (typeof body.n === 'number' && body.n !== 1) return unsupported('n must be 1');
  if (isRecord(body.response_format) && body.response_format.type === 'json_schema') {
    return unsupported('response_format json_schema is not supported; use json_object');
  }
  for (const [field, reason] of Object.entries(UNSUPPORTED_FIELDS)) {
    if (Object.hasOwn(body, field) && body[field] !== null) return unsupported(reason);
  }
  if (!Array.isArray(body.messages)) return undefined;
  for (const [i, entry] of body.messages.entries()) {
    if (!isRecord(entry)) continue;
    const at = `messages[${i}]`;
    if (Object.hasOwn(entry, 'name')) {
      return unsupported(`${at}.name is not supported: names cannot be redacted yet`);
    }
    if (entry.role === 'tool' || entry.role === 'function' || Object.hasOwn(entry, 'tool_calls')) {
      return unsupported(`${at}: tool and function calling is not supported`);
    }
    if (entry.role === 'developer') {
      return unsupported(`${at}.role: use system; the developer role is not supported`);
    }
    if (!Array.isArray(entry.content)) continue;
    for (const [j, part] of entry.content.entries()) {
      if (isRecord(part) && part.type !== 'text') {
        return unsupported(`${at}.content[${j}]: only text content parts are supported`);
      }
    }
  }
  return undefined;
}

// Renders a Zod path from known field names and indices only. Zod only
// descends into fields the schema names, so every string segment is one of
// ours; the check below is a second guard, not the mechanism.
export function renderPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else if (typeof segment === 'string' && /^[a-z_]{1,32}$/.test(segment)) {
      out += out === '' ? segment : `.${segment}`;
    } else return out === '' ? 'request' : out;
  }
  return out === '' ? 'request' : out;
}

/** Validates a parsed JSON body; throws a GatewayError (400) if it is not allowed. */
export function parseChatRequest(body: unknown): ChatRequest {
  if (!isRecord(body)) {
    throw new GatewayError(400, 'invalid_request', 'request body must be a JSON object');
  }
  const feature = unsupportedFeature(body);
  if (feature) throw feature;

  // An unsupported field set to null means "unset" and passed the check
  // above; drop it so the strict schema, which does not name it, agrees
  // (bug-log 15).
  const settable = Object.fromEntries(
    Object.entries(body).filter(
      ([key, value]) => !(Object.hasOwn(UNSUPPORTED_FIELDS, key) && value === null),
    ),
  );
  const result = requestSchema.safeParse(settable);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const where = renderPath(issue.path);
    throw new GatewayError(
      400,
      'invalid_request',
      issue.code === 'unrecognized_keys'
        ? `unknown field in ${where}`
        : `invalid value at ${where}`,
    );
  }
  if (result.data.max_tokens != null && result.data.max_completion_tokens != null) {
    throw new GatewayError(
      400,
      'invalid_request',
      'set max_tokens or max_completion_tokens, not both',
    );
  }
  // OpenAI's own rule: stream_options without streaming is a 400.
  if (result.data.stream_options != null && result.data.stream !== true) {
    throw new GatewayError(
      400,
      'invalid_request',
      'stream_options is only allowed when stream is true',
    );
  }
  return result.data;
}

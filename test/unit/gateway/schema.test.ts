// The request allowlist (ADR-014): every field's fate, the messages Pseudonym
// gives for what it deliberately does not support, and that no error ever
// quotes a received value or an unknown key's name.

import { describe, expect, it } from 'vitest';
import { GatewayError } from '../../../src/gateway/errors.js';
import { parseChatRequest, renderPath } from '../../../src/gateway/schema.js';

const base = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

function rejection(body: unknown): { code: string; message: string; status: number } {
  try {
    parseChatRequest(body);
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
    return { code: error.code, message: error.message, status: error.statusCode };
  }
  throw new Error('expected a rejection');
}

describe('parseChatRequest: accepted', () => {
  it('a minimal request', () => {
    expect(parseChatRequest(base)).toEqual(base);
  });

  it('system, user and assistant roles, string content and text-part arrays', () => {
    const body = {
      model: 'm',
      messages: [
        { role: 'system', content: 's' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
        },
        { role: 'assistant', content: '' },
      ],
    };
    expect(parseChatRequest(body)).toEqual(body);
  });

  it('every forwarded setting at its limits', () => {
    const body = {
      ...base,
      stream: false,
      temperature: 2,
      top_p: 0,
      max_tokens: 1,
      seed: -5,
      frequency_penalty: -2,
      presence_penalty: 2,
      reasoning_effort: 'xhigh',
      response_format: { type: 'text' },
      stop: ['a', 'b', 'c', 'd'],
      n: 1,
      logprobs: false,
      user: 'u',
      safety_identifier: 's',
    };
    expect(parseChatRequest(body)).toEqual(body);
  });

  it.each([
    'tools',
    'tool_choice',
    'functions',
    'function_call',
    'parallel_tool_calls',
    'audio',
    'modalities',
    'metadata',
    'store',
    'stream_options',
    'top_logprobs',
    'logit_bias',
    'prediction',
    'web_search_options',
  ])('a null unsupported field counts as unset: %s', (field) => {
    expect(parseChatRequest({ ...base, [field]: null })).toEqual(base);
  });
});

describe('parseChatRequest: unsupported features, each with its own message', () => {
  it.each([
    [{ stream: true }, 'stream_not_supported', 'streaming is not supported yet'],
    [{ tools: [] }, 'unsupported_feature', 'tool and function calling is not supported'],
    [{ tool_choice: 'auto' }, 'unsupported_feature', 'tool and function calling is not supported'],
    [{ functions: [] }, 'unsupported_feature', 'tool and function calling is not supported'],
    [
      { function_call: 'auto' },
      'unsupported_feature',
      'tool and function calling is not supported',
    ],
    [
      { parallel_tool_calls: false },
      'unsupported_feature',
      'tool and function calling is not supported',
    ],
    [{ audio: {} }, 'unsupported_feature', 'audio is not supported'],
    [{ modalities: ['text'] }, 'unsupported_feature', 'only text output is supported'],
    [
      { metadata: {} },
      'unsupported_feature',
      'stored completions (store, metadata) are not supported',
    ],
    [
      { store: false },
      'unsupported_feature',
      'stored completions (store, metadata) are not supported',
    ],
    [
      { stream_options: {} },
      'unsupported_feature',
      'stream_options needs streaming, which is not supported yet',
    ],
    [{ logprobs: true }, 'unsupported_feature', 'logprobs are not supported'],
    [{ top_logprobs: 2 }, 'unsupported_feature', 'logprobs are not supported'],
    [{ logit_bias: {} }, 'unsupported_feature', 'logit_bias is not supported'],
    [{ prediction: {} }, 'unsupported_feature', 'predicted outputs are not supported'],
    [{ web_search_options: {} }, 'unsupported_feature', 'web search is not supported'],
    [{ n: 2 }, 'unsupported_feature', 'n must be 1'],
    [
      { response_format: { type: 'json_schema', json_schema: {} } },
      'unsupported_feature',
      'response_format json_schema is not supported; use json_object',
    ],
  ])('%j → %s', (extra, code, message) => {
    expect(rejection({ ...base, ...extra })).toEqual({ code, message, status: 400 });
  });

  it.each([
    [
      { role: 'user', name: 'x', content: 'hi' },
      'messages[0].name is not supported: names cannot be redacted yet',
    ],
    [
      { role: 'tool', content: 'hi', tool_call_id: 'x' },
      'messages[0]: tool and function calling is not supported',
    ],
    [
      { role: 'function', content: 'hi' },
      'messages[0]: tool and function calling is not supported',
    ],
    [
      { role: 'assistant', content: null, tool_calls: [] },
      'messages[0]: tool and function calling is not supported',
    ],
    [
      { role: 'developer', content: 'hi' },
      'messages[0].role: use system; the developer role is not supported',
    ],
    [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'image_url', image_url: { url: 'x' } },
        ],
      },
      'messages[0].content[1]: only text content parts are supported',
    ],
    [
      { role: 'user', content: [{ type: 'input_audio', input_audio: {} }] },
      'messages[0].content[0]: only text content parts are supported',
    ],
    [
      { role: 'user', content: [{ type: 'file', file: {} }] },
      'messages[0].content[0]: only text content parts are supported',
    ],
  ])('message %j', (message, expected) => {
    expect(rejection({ model: 'm', messages: [message] })).toEqual({
      code: 'unsupported_feature',
      message: expected,
      status: 400,
    });
  });

  it('names the index of the offending message', () => {
    const messages = [
      { role: 'user', content: 'a' },
      { role: 'user', name: 'x', content: 'b' },
    ];
    expect(rejection({ model: 'm', messages }).message).toBe(
      'messages[1].name is not supported: names cannot be redacted yet',
    );
  });
});

describe('parseChatRequest: invalid requests', () => {
  it.each([
    [null, 'request body must be a JSON object'],
    [[], 'request body must be a JSON object'],
    ['text', 'request body must be a JSON object'],
    [{ messages: base.messages }, 'invalid value at model'],
    [{ model: '', messages: base.messages }, 'invalid value at model'],
    [{ model: 'm' }, 'invalid value at messages'],
    [{ model: 'm', messages: [] }, 'invalid value at messages'],
    [{ model: 'm', messages: ['hi'] }, 'invalid value at messages[0]'],
    [{ model: 'm', messages: [{ role: 'user' }] }, 'invalid value at messages[0].content'],
    [
      { model: 'm', messages: [{ role: 'user', content: null }] },
      'invalid value at messages[0].content',
    ],
    [
      { model: 'm', messages: [{ role: 'user', content: [] }] },
      'invalid value at messages[0].content',
    ],
    [
      { model: 'm', messages: [{ role: 'someone', content: 'hi' }] },
      'invalid value at messages[0].role',
    ],
    [{ ...base, temperature: 3 }, 'invalid value at temperature'],
    [{ ...base, temperature: '0.5' }, 'invalid value at temperature'],
    [{ ...base, max_tokens: 1.5 }, 'invalid value at max_tokens'],
    [{ ...base, max_tokens: 0 }, 'invalid value at max_tokens'],
    [{ ...base, reasoning_effort: 'extreme' }, 'invalid value at reasoning_effort'],
    [{ ...base, stop: ['a', 'b', 'c', 'd', 'e'] }, 'invalid value at stop'],
    [{ ...base, stop: 5 }, 'invalid value at stop'],
    [{ ...base, stream: 'yes' }, 'invalid value at stream'],
    [{ ...base, n: 1.5 }, 'n must be 1'],
    [{ ...base, response_format: { type: 'yaml' } }, 'invalid value at response_format.type'],
  ])('%j → %s', (body, message) => {
    expect(rejection(body).message).toBe(message);
  });

  it('max_tokens and max_completion_tokens together', () => {
    expect(rejection({ ...base, max_tokens: 5, max_completion_tokens: 5 })).toEqual({
      code: 'invalid_request',
      message: 'set max_tokens or max_completion_tokens, not both',
      status: 400,
    });
  });

  it('an unknown top-level field is rejected without naming it', () => {
    const { message, code } = rejection({ ...base, 'priya@example.com': 1 });
    expect(code).toBe('invalid_request');
    expect(message).toBe('unknown field in request');
  });

  it('an unknown field inside a message or a part is rejected without naming it', () => {
    expect(
      rejection({ model: 'm', messages: [{ role: 'user', content: 'hi', Priya: 1 }] }).message,
    ).toBe('unknown field in messages[0]');
    expect(
      rejection({
        model: 'm',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'a', Priya: 1 }] }],
      }).message,
    ).toBe('unknown field in messages[0].content[0]');
    expect(rejection({ ...base, response_format: { type: 'text', Priya: 1 } }).message).toBe(
      'unknown field in response_format',
    );
  });

  it('no message ever quotes a received value', () => {
    const value = 'asha.canary@example.org';
    const bodies = [
      { ...base, model: value, temperature: value },
      { model: 'm', messages: [{ role: value, content: value }] },
      { model: 'm', messages: [{ role: 'user', content: [{ type: value, text: value }] }] },
      { ...base, [value]: value },
      { ...base, reasoning_effort: value },
      { ...base, stop: [value, value, value, value, value] },
    ];
    for (const body of bodies) expect(rejection(body).message).not.toContain('canary');
  });
});

describe('renderPath', () => {
  it('renders field names and indices', () => {
    expect(renderPath([])).toBe('request');
    expect(renderPath(['messages', 2, 'content', 0])).toBe('messages[2].content[0]');
  });

  it('stops at a segment that is not one of our field names (second guard)', () => {
    expect(renderPath(['Priya@example.com'])).toBe('request');
    expect(renderPath(['messages', 0, 'Priya'])).toBe('messages[0]');
    expect(renderPath(['messages', Symbol('x')])).toBe('messages');
  });
});

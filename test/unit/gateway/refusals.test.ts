// Option 3's check on its own (ADR-041 sections 13 and 16): the three rule
// kinds, a field left unset or null, the order fields are checked in, and the
// exact error each refusal returns. Through the server: refused-parameters.test.ts.

import { describe, expect, it } from 'vitest';
import { refusedParameter } from '../../../src/gateway/refusals.js';
import { parseChatRequest, type ChatRequest } from '../../../src/gateway/schema.js';
import type { ModelRefusals } from '../../../src/providers/openai-compatible.js';

const BASE = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
const request = (fields: Record<string, unknown>): ChatRequest =>
  parseChatRequest({ ...BASE, ...fields });

const RULES: ModelRefusals = {
  seed: { kind: 'any', probes: ['attempt-5/p03'] },
  frequency_penalty: { kind: 'any', probes: ['attempt-5/p04'] },
  presence_penalty: { kind: 'nonzero', probes: ['attempt-5/p05'] },
  reasoning_effort: { kind: 'values', values: ['xhigh', 'max'], probes: ['attempt-5/p14'] },
};

const body = (fields: Record<string, unknown>, rules: ModelRefusals | undefined = RULES) =>
  refusedParameter(request(fields), rules)?.body();

describe('refusedParameter', () => {
  it('no rules (a model with no entry): nothing is refused', () => {
    expect(
      refusedParameter(request({ seed: 1, reasoning_effort: 'max' }), undefined),
    ).toBeUndefined();
    expect(refusedParameter(request({ seed: 1 }), {})).toBeUndefined();
  });

  it('a request that sets none of the fields is not refused', () => {
    expect(body({ temperature: 0, top_p: 0.5, max_tokens: 16 })).toBeUndefined();
  });

  it('a field left unset or null is never refused, whatever its rule', () => {
    expect(
      body({ seed: null, frequency_penalty: null, presence_penalty: null, reasoning_effort: null }),
    ).toBeUndefined();
  });

  it('any: refused at every value, 0 included; unsupported_parameter, param set', () => {
    for (const seed of [0, 42, -1]) {
      expect(body({ seed })).toEqual({
        error: {
          message: 'seed is not supported by the configured provider and model',
          type: 'invalid_request_error',
          param: 'seed',
          code: 'unsupported_parameter',
        },
      });
    }
    expect(body({ frequency_penalty: 0 })?.error).toMatchObject({
      param: 'frequency_penalty',
      code: 'unsupported_parameter',
    });
  });

  it('nonzero: 0 passes; any other value is refused with unsupported_value, param set', () => {
    expect(body({ presence_penalty: 0 })).toBeUndefined();
    for (const value of [0.5, -0.5, 2, -2, 5e-324]) {
      expect([value, body({ presence_penalty: value })]).toEqual([
        value,
        {
          error: {
            message: 'presence_penalty must be 0 or unset for the configured provider and model',
            type: 'invalid_request_error',
            param: 'presence_penalty',
            code: 'unsupported_value',
          },
        },
      ]);
    }
  });

  it('nonzero: -0 is zero (sent as 0, what p18 measured)', () => {
    expect(refusedParameter({ ...request({}), presence_penalty: -0 }, RULES)).toBeUndefined();
  });

  it('values: the listed values are refused, the rest pass; none is not listed (decision D)', () => {
    for (const effort of ['xhigh', 'max']) {
      expect(body({ reasoning_effort: effort })).toEqual({
        error: {
          message:
            'reasoning_effort does not support this value for the configured provider and model',
          type: 'invalid_request_error',
          param: 'reasoning_effort',
          code: 'unsupported_value',
        },
      });
    }
    for (const effort of ['none', 'minimal', 'low', 'medium', 'high']) {
      expect([effort, body({ reasoning_effort: effort })]).toEqual([effort, undefined]);
    }
  });

  it('no message names the value sent, a model or a provider', () => {
    const messages = [
      body({ seed: 987_654 }),
      body({ presence_penalty: 1.75 }),
      body({ reasoning_effort: 'xhigh' }),
    ].map((b) => b?.error.message ?? '');
    for (const message of messages) {
      expect(message).not.toMatch(/987654|987_654|1\.75|xhigh|gemini|ollama/i);
    }
  });

  it('the values message lists no allowed values', () => {
    const message = body({ reasoning_effort: 'max' })?.error.message ?? '';
    for (const value of ['none', 'minimal', 'low', 'medium', 'high']) {
      expect(message).not.toContain(value);
    }
  });

  it('several refused fields: the first in field order (seed, frequency_penalty, presence_penalty, reasoning_effort)', () => {
    const all = { seed: 1, frequency_penalty: 1, presence_penalty: 1, reasoning_effort: 'max' };
    expect(body(all)?.error.param).toBe('seed');
    expect(body({ ...all, seed: null })?.error.param).toBe('frequency_penalty');
    expect(body({ ...all, seed: null, frequency_penalty: null })?.error.param).toBe(
      'presence_penalty',
    );
    expect(
      body({ ...all, seed: null, frequency_penalty: null, presence_penalty: 0 })?.error.param,
    ).toBe('reasoning_effort');
  });

  it('a refusal is a 400', () => {
    expect(refusedParameter(request({ seed: 1 }), RULES)?.statusCode).toBe(400);
  });
});

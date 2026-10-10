// Option 3 through the real gateway (ADR-041 sections 13 and 16), against a
// mock provider, with Gemini's measured refusals for its measured model.
//
// The ordering is the point: a refused request is refused after the model
// check and before anything else, so the provider receives nothing, the name
// finder is never asked, and redaction never runs. Redaction is shown not to
// run with a body redaction would refuse (10,000 distinct values of one type,
// a 422): refused first, it is a 400.
//
// The zero cases go in as raw JSON text, so that JSON parsing itself is part
// of what is tested (section 16, E).

import { afterEach, describe, expect, it } from 'vitest';
import type { NameFinder } from '../../src/gateway/server.js';
import { GEMINI_PROFILE } from '../../src/providers/gemini.js';
import {
  chatBody,
  post,
  startTestGateway,
  TEST_MODEL,
  type TestGateway,
} from '../support/gateway.js';
import { okCompletion } from '../support/mock-provider.js';

const REFUSALS = GEMINI_PROFILE.refusals!['gemini-3.5-flash-lite']!;

let gateway: TestGateway | undefined;
afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

async function refusing(names?: NameFinder): Promise<TestGateway> {
  gateway = await startTestGateway({
    providerName: 'gemini',
    refusals: REFUSALS,
    ...(names === undefined ? {} : { names }),
  });
  gateway.provider.respondWith(okCompletion('Done.'));
  return gateway;
}

/** A name finder that records every call and finds nothing. */
function countingNames(): NameFinder & { calls: number } {
  const finder = {
    calls: 0,
    healthy: true,
    find(texts: readonly string[]) {
      finder.calls++;
      return Promise.resolve(texts.map((text) => ({ text, spans: [] })));
    },
  };
  return finder;
}

const error = (body: string) => (JSON.parse(body) as { error: Record<string, unknown> }).error;

describe('option 3: the order', () => {
  it('a refused request sends nothing to the provider and never asks the name finder', async () => {
    const names = countingNames();
    const g = await refusing(names);
    const response = await post(g, { ...chatBody('Mail me at someone@example.com'), seed: 7 });
    expect(response.statusCode).toBe(400);
    expect(error(response.body)).toEqual({
      message: 'seed is not supported by the configured provider and model',
      type: 'invalid_request_error',
      param: 'seed',
      code: 'unsupported_parameter',
    });
    expect(g.provider.requests).toHaveLength(0);
    expect(names.calls).toBe(0);
  });

  it('the control: the same request without the refused field asks the names and is sent', async () => {
    const names = countingNames();
    const g = await refusing(names);
    const response = await post(g, chatBody('Mail me at someone@example.com'));
    expect(response.statusCode).toBe(200);
    expect(g.provider.requests).toHaveLength(1);
    expect(names.calls).toBe(1);
  });

  it('redaction never runs: a body redaction would refuse with 422 is a 400 when a field is refused', async () => {
    const many = Array.from({ length: 10_000 }, (_, i) => `u${i}@example.com`).join(' ');
    const g = await refusing();
    const control = await post(g, chatBody(many));
    expect(control.statusCode).toBe(422);
    const refused = await post(g, { ...chatBody(many), presence_penalty: 0.5 });
    expect(refused.statusCode).toBe(400);
    expect(error(refused.body).param).toBe('presence_penalty');
    expect(g.provider.requests).toHaveLength(0);
  });

  it('the model is checked first: a wrong model with a refused field is model_not_found', async () => {
    const g = await refusing();
    const response = await post(g, { ...chatBody('hi'), model: 'other', seed: 1 });
    expect(response.statusCode).toBe(400);
    expect(error(response.body)).toMatchObject({ code: 'model_not_found', param: null });
  });

  it('streamed: the same 400, as JSON, before any event; nothing sent', async () => {
    const g = await refusing();
    const response = await post(g, { ...chatBody('hi'), stream: true, reasoning_effort: 'max' });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(error(response.body)).toMatchObject({
      param: 'reasoning_effort',
      code: 'unsupported_value',
    });
    expect(g.provider.requests).toHaveLength(0);
  });

  it('logged as a rejected request at info, with its code and no value', async () => {
    const g = await refusing();
    await post(g, { ...chatBody('hi'), seed: 987_654_321 });
    const lines = g.logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    const rejected = lines.filter((entry) => entry.msg === 'request rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      level: 30,
      statusCode: 400,
      error: { name: 'GatewayError', code: 'unsupported_parameter' },
    });
    expect(g.logs.join('')).not.toContain('987654321');
  });

  it('a model with no entry refuses nothing (Ollama today): the field is sent', async () => {
    gateway = await startTestGateway();
    gateway.provider.respondWith(okCompletion('Done.'));
    const response = await post(gateway, { ...chatBody('hi'), seed: 1, reasoning_effort: 'max' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(gateway.provider.requests[0]!.body)).toMatchObject({
      seed: 1,
      reasoning_effort: 'max',
    });
  });
});

describe('option 3: presence_penalty and zero, as JSON text (section 16, E)', () => {
  const raw = (value: string): string =>
    `{"model":${JSON.stringify(TEST_MODEL)},"messages":[{"role":"user","content":"hi"}],"presence_penalty":${value}}`;

  it.each(['0', '0.0', '0e0', '-0', '-0.0', '1e-400'])(
    '%s parses to ±0: sent, and sent as 0',
    async (value) => {
      const g = await refusing();
      const response = await post(g, raw(value));
      expect(response.statusCode).toBe(200);
      expect(g.provider.requests).toHaveLength(1);
      // The text sent is exactly 0, never -0 or the client's own spelling.
      expect(g.provider.requests[0]!.body).toMatch(/"presence_penalty":0[,}]/);
    },
  );

  it('5e-324 is not 0: refused', async () => {
    const g = await refusing();
    const response = await post(g, raw('5e-324'));
    expect(response.statusCode).toBe(400);
    expect(error(response.body)).toMatchObject({
      param: 'presence_penalty',
      code: 'unsupported_value',
    });
  });

  it('the string "0" is refused by the schema before option 3, as it always was', async () => {
    const g = await refusing();
    const response = await post(g, raw('"0"'));
    expect(response.statusCode).toBe(400);
    expect(error(response.body)).toEqual({
      message: 'invalid value at presence_penalty',
      type: 'invalid_request_error',
      param: null,
      code: 'invalid_request',
    });
    expect(g.provider.requests).toHaveLength(0);
  });

  it('null is unset: sent without the field', async () => {
    const g = await refusing();
    const response = await post(g, raw('null'));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(g.provider.requests[0]!.body)).not.toHaveProperty('presence_penalty');
  });
});

describe('option 3: the other Gemini entries', () => {
  it.each([
    ['seed', 0, 'unsupported_parameter'],
    ['frequency_penalty', 0, 'unsupported_parameter'],
    ['frequency_penalty', 0.5, 'unsupported_parameter'],
    ['reasoning_effort', 'xhigh', 'unsupported_value'],
  ] as const)('%s %s → 400 %s, nothing sent', async (field, value, code) => {
    const g = await refusing();
    const response = await post(g, { ...chatBody('hi'), [field]: value });
    expect(response.statusCode).toBe(400);
    expect(error(response.body)).toMatchObject({ param: field, code });
    expect(g.provider.requests).toHaveLength(0);
  });

  it.each(['none', 'minimal', 'low', 'medium', 'high'])(
    'reasoning_effort %s is sent (none stays with 4b until the s1/p09 pair, decision D)',
    async (effort) => {
      const g = await refusing();
      const response = await post(g, { ...chatBody('hi'), reasoning_effort: effort });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(g.provider.requests[0]!.body).reasoning_effort).toBe(effort);
    },
  );
});

// Logger settings: the serializers keep only what may be logged.

import { describe, expect, it } from 'vitest';
import { loggerOptions } from '../../../src/gateway/logging.js';

interface Options {
  level: string;
  stream?: unknown;
  serializers: Record<string, (value: unknown) => unknown>;
}

describe('loggerOptions', () => {
  it('writes to stdout unless a stream is given', () => {
    expect(loggerOptions('info')).not.toHaveProperty('stream');
    const stream = { write: () => undefined };
    expect((loggerOptions('info', stream) as Options).stream).toBe(stream);
  });

  it('keeps method and route pattern from a request, nothing else', () => {
    const { serializers } = loggerOptions('info') as Options;
    const request = {
      method: 'POST',
      url: '/v1/chat/completions?d=secret',
      headers: { authorization: 'Bearer secret' },
      body: { messages: ['secret'] },
      routeOptions: { url: '/v1/chat/completions' },
    };
    expect(serializers.req!(request)).toEqual({ method: 'POST', route: '/v1/chat/completions' });
    expect(serializers.req!({ method: 'GET' })).toEqual({ method: 'GET', route: 'unmatched' });
    expect(serializers.req!({ method: 'GET', routeOptions: {} })).toEqual({
      method: 'GET',
      route: 'unmatched',
    });
  });

  it('keeps the status code from a reply, and safe details from an error', () => {
    const { serializers } = loggerOptions('info') as Options;
    expect(serializers.res!({ statusCode: 200, body: 'secret' })).toEqual({ statusCode: 200 });
    expect(JSON.stringify(serializers.err!(new Error('secret')))).not.toContain('secret');
  });
});

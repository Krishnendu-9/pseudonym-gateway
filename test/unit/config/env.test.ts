import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../../src/config/env.js';

describe('loadEnv', () => {
  it('applies defaults when nothing is set', () => {
    const env = loadEnv({});
    expect(env).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
    });
  });

  it('parses and coerces explicit values', () => {
    const env = loadEnv({ NODE_ENV: 'production', PORT: '8080', LOG_LEVEL: 'debug' });
    expect(env).toEqual({
      NODE_ENV: 'production',
      PORT: 8080,
      LOG_LEVEL: 'debug',
    });
  });

  it('rejects an invalid NODE_ENV', () => {
    expect(() => loadEnv({ NODE_ENV: 'staging' })).toThrow();
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => loadEnv({ PORT: 'not-a-number' })).toThrow();
  });

  it('rejects a negative PORT', () => {
    expect(() => loadEnv({ PORT: '-1' })).toThrow();
  });
});

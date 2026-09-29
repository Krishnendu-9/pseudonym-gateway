import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../../src/config/env.js';

const REQUIRED = { PSEUDONYM_MODEL: 'qwen3:8b' };

describe('loadEnv', () => {
  it('applies defaults when only the model is set', () => {
    expect(loadEnv(REQUIRED)).toEqual({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: 3000,
      LOG_LEVEL: 'info',
      PSEUDONYM_PROVIDER: 'ollama',
      PSEUDONYM_MODEL: 'qwen3:8b',
      PSEUDONYM_PROVIDER_BASE_URL: 'http://localhost:11434/v1',
      PSEUDONYM_PROVIDER_TIMEOUT_MS: 120_000,
      PSEUDONYM_MAX_BODY_BYTES: 262_144,
      PSEUDONYM_MAX_RESPONSE_BYTES: 1_048_576,
      PSEUDONYM_RESTORE_IN_UNSAFE_REGIONS: false,
      PSEUDONYM_PLACEHOLDER_INSTRUCTION: true,
    });
  });

  it('parses and coerces explicit values', () => {
    const env = loadEnv({
      ...REQUIRED,
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      PORT: '8080',
      LOG_LEVEL: 'debug',
      PSEUDONYM_PROVIDER_BASE_URL: 'https://ollama.example/v1',
      PSEUDONYM_PROVIDER_API_KEY: 'key',
      PSEUDONYM_PROVIDER_TIMEOUT_MS: '5000',
      PSEUDONYM_MAX_BODY_BYTES: '1024',
      PSEUDONYM_MAX_RESPONSE_BYTES: '2048',
      PSEUDONYM_RESTORE_IN_UNSAFE_REGIONS: 'true',
      PSEUDONYM_PLACEHOLDER_INSTRUCTION: 'false',
    });
    expect(env).toMatchObject({
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      PORT: 8080,
      LOG_LEVEL: 'debug',
      PSEUDONYM_PROVIDER_BASE_URL: 'https://ollama.example/v1',
      PSEUDONYM_PROVIDER_API_KEY: 'key',
      PSEUDONYM_PROVIDER_TIMEOUT_MS: 5000,
      PSEUDONYM_MAX_BODY_BYTES: 1024,
      PSEUDONYM_MAX_RESPONSE_BYTES: 2048,
      PSEUDONYM_RESTORE_IN_UNSAFE_REGIONS: true,
      PSEUDONYM_PLACEHOLDER_INSTRUCTION: false,
    });
  });

  it('requires PSEUDONYM_MODEL', () => {
    expect(() => loadEnv({})).toThrow('Invalid environment variables: PSEUDONYM_MODEL');
  });

  it.each([
    ['NODE_ENV', 'staging'],
    ['PORT', 'not-a-number'],
    ['PORT', '-1'],
    ['PSEUDONYM_PROVIDER', 'openai'],
    ['PSEUDONYM_PROVIDER_BASE_URL', 'not a url'],
    ['PSEUDONYM_PROVIDER_BASE_URL', 'file:///etc/passwd'],
    ['PSEUDONYM_PROVIDER_TIMEOUT_MS', '0'],
    ['PSEUDONYM_MAX_BODY_BYTES', '1.5'],
    ['PSEUDONYM_MAX_RESPONSE_BYTES', '0'],
    ['PSEUDONYM_MAX_RESPONSE_BYTES', '1MB'],
    ['PSEUDONYM_RESTORE_IN_UNSAFE_REGIONS', 'yes'],
    ['PSEUDONYM_PLACEHOLDER_INSTRUCTION', '0'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => loadEnv({ ...REQUIRED, [name]: value })).toThrow(
      `Invalid environment variables: ${name}`,
    );
  });

  it('never puts a value in the error, only the variable names', () => {
    const secret = 'sk-canary-should-not-appear';
    expect(() =>
      loadEnv({
        PSEUDONYM_PROVIDER_BASE_URL: secret,
        PSEUDONYM_PROVIDER_API_KEY: '',
        PORT: secret,
      }),
    ).toThrow(
      'Invalid environment variables: PORT, PSEUDONYM_MODEL, PSEUDONYM_PROVIDER_BASE_URL, PSEUDONYM_PROVIDER_API_KEY',
    );
  });
});

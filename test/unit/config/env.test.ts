import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../../src/config/env.js';

const REQUIRED = { PSEUDONYM_MODEL: 'qwen3:8b' };

describe('loadEnv', () => {
  it('applies defaults when only the model is set', () => {
    expect(loadEnv(REQUIRED)).toEqual({
      NODE_ENV: 'development',
      PSEUDONYM_DISABLE_HARDENING: false,
      HOST: '127.0.0.1',
      PORT: 3000,
      LOG_LEVEL: 'info',
      PSEUDONYM_PROVIDER: 'ollama',
      PSEUDONYM_MODEL: 'qwen3:8b',
      PSEUDONYM_PROVIDER_BASE_URL: 'http://localhost:11434/v1',
      PSEUDONYM_PROVIDER_TIMEOUT_MS: 120_000,
      PSEUDONYM_MAX_BODY_BYTES: 262_144,
      PSEUDONYM_MAX_RESPONSE_BYTES: 1_048_576,
      PSEUDONYM_MAX_STREAM_BYTES: 33_554_432,
      PSEUDONYM_RESTORE_IN_UNSAFE_REGIONS: false,
      PSEUDONYM_PLACEHOLDER_INSTRUCTION: false,
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
      PSEUDONYM_MAX_STREAM_BYTES: '4096',
      PSEUDONYM_RESTORE_IN_UNSAFE_REGIONS: 'true',
      PSEUDONYM_PLACEHOLDER_INSTRUCTION: 'true',
      PSEUDONYM_DISABLE_HARDENING: 'true',
    });
    expect(env).toMatchObject({
      NODE_ENV: 'production',
      PSEUDONYM_DISABLE_HARDENING: true,
      HOST: '0.0.0.0',
      PORT: 8080,
      LOG_LEVEL: 'debug',
      PSEUDONYM_PROVIDER_BASE_URL: 'https://ollama.example/v1',
      PSEUDONYM_PROVIDER_API_KEY: 'key',
      PSEUDONYM_PROVIDER_TIMEOUT_MS: 5000,
      PSEUDONYM_MAX_BODY_BYTES: 1024,
      PSEUDONYM_MAX_RESPONSE_BYTES: 2048,
      PSEUDONYM_MAX_STREAM_BYTES: 4096,
      PSEUDONYM_RESTORE_IN_UNSAFE_REGIONS: true,
      PSEUDONYM_PLACEHOLDER_INSTRUCTION: true,
    });
  });

  describe('gemini (ADR-041 section 16, decision A)', () => {
    const GEMINI = { ...REQUIRED, PSEUDONYM_PROVIDER: 'gemini', PSEUDONYM_PROVIDER_API_KEY: 'key' };

    it("is accepted, with Gemini's own base URL by default", () => {
      expect(loadEnv(GEMINI)).toMatchObject({
        PSEUDONYM_PROVIDER: 'gemini',
        PSEUDONYM_PROVIDER_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        PSEUDONYM_PROVIDER_API_KEY: 'key',
      });
    });

    it('keeps a base URL that is set', () => {
      const env = loadEnv({ ...GEMINI, PSEUDONYM_PROVIDER_BASE_URL: 'https://proxy.example/v1' });
      expect(env.PSEUDONYM_PROVIDER_BASE_URL).toBe('https://proxy.example/v1');
    });

    it('refuses to start without a key, naming only the variable', () => {
      expect(() =>
        loadEnv({
          PSEUDONYM_PROVIDER: 'gemini',
          PSEUDONYM_MODEL: 'canary-model-name',
          PSEUDONYM_PROVIDER_BASE_URL: 'https://canary.example/v1',
        }),
      ).toThrow(/^Invalid environment variables: PSEUDONYM_PROVIDER_API_KEY$/);
    });

    it('an empty key is refused once, not twice', () => {
      expect(() => loadEnv({ ...GEMINI, PSEUDONYM_PROVIDER_API_KEY: '' })).toThrow(
        /^Invalid environment variables: PSEUDONYM_PROVIDER_API_KEY$/,
      );
    });

    it('a missing key is listed beside other wrong variables, not hidden by them', () => {
      expect(() => loadEnv({ PSEUDONYM_PROVIDER: 'gemini', PORT: 'x' })).toThrow(
        /^Invalid environment variables: PORT, PSEUDONYM_MODEL, PSEUDONYM_PROVIDER_API_KEY$/,
      );
    });
  });

  it('ollama needs no key; an unknown provider is not mistaken for gemini', () => {
    expect(loadEnv(REQUIRED).PSEUDONYM_PROVIDER_API_KEY).toBeUndefined();
    expect(() => loadEnv({ ...REQUIRED, PSEUDONYM_PROVIDER: 'Gemini' })).toThrow(
      /^Invalid environment variables: PSEUDONYM_PROVIDER$/,
    );
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
    ['PSEUDONYM_MAX_STREAM_BYTES', '0'],
    ['PSEUDONYM_MAX_STREAM_BYTES', '32MiB'],
    ['PSEUDONYM_RESTORE_IN_UNSAFE_REGIONS', 'yes'],
    ['PSEUDONYM_PLACEHOLDER_INSTRUCTION', '0'],
    ['PSEUDONYM_DISABLE_HARDENING', 'TRUE'],
    ['PSEUDONYM_DISABLE_HARDENING', '1'],
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

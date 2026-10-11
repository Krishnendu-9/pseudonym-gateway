import { describe, expect, it } from 'vitest';
import { isLoopbackHost, loadEnv, PROVIDER_BASE_URL_DEFAULTS } from '../../../src/config/env.js';

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

  // ADR-041 section 16, amendment item 3: a credential must not cross a
  // network in clear. Keyed to the key, not the provider.
  describe('a plain-HTTP base URL while a key is set', () => {
    const OFF_MACHINE = [
      'http://ollama.example/v1',
      'http://10.0.0.5:11434/v1',
      'http://host.docker.internal:11434/v1',
      'http://0.0.0.0:11434/v1',
      'http://192.0.2.10/v1',
      // Names that merely resolve to loopback, and an IPv4-mapped address.
      'http://127.0.0.1.nip.io/v1',
      'http://localhost./v1',
      'http://[::ffff:127.0.0.1]:11434/v1',
      'http://[2001:db8::1]/v1',
    ];
    const LOOPBACK = [
      'http://localhost:11434/v1',
      'http://LOCALHOST/v1',
      'http://127.0.0.1:11434/v1',
      'http://127.255.255.254/v1',
      // Read by the URL parser as 127.0.0.1 and [::1].
      'http://127.1/v1',
      'http://[::1]:8080/v1',
      'http://[0:0:0:0:0:0:0:1]/v1',
    ];
    const withKey = (provider: string, url: string) => ({
      ...REQUIRED,
      PSEUDONYM_PROVIDER: provider,
      PSEUDONYM_PROVIDER_API_KEY: 'key',
      PSEUDONYM_PROVIDER_BASE_URL: url,
    });

    it.each(OFF_MACHINE.flatMap((url) => [['ollama', url] as const, ['gemini', url] as const]))(
      '%s, %s: refuses to start, naming only the variable',
      (provider, url) => {
        expect(() => loadEnv(withKey(provider, url))).toThrow(
          /^Invalid environment variables: PSEUDONYM_PROVIDER_BASE_URL$/,
        );
      },
    );

    it.each(LOOPBACK.flatMap((url) => [['ollama', url] as const, ['gemini', url] as const]))(
      '%s, %s: loopback starts',
      (provider, url) => {
        expect(loadEnv(withKey(provider, url)).PSEUDONYM_PROVIDER_BASE_URL).toBe(url);
      },
    );

    it('HTTPS to any host starts with a key, for either provider', () => {
      for (const provider of ['ollama', 'gemini']) {
        const url = 'https://10.0.0.5:11434/v1';
        expect([provider, loadEnv(withKey(provider, url)).PSEUDONYM_PROVIDER_BASE_URL]).toEqual([
          provider,
          url,
        ]);
      }
    });

    it('with no key, any plain-HTTP URL starts, as before (Ollama unchanged)', () => {
      for (const url of OFF_MACHINE) {
        const env = loadEnv({ ...REQUIRED, PSEUDONYM_PROVIDER_BASE_URL: url });
        expect(env.PSEUDONYM_PROVIDER_BASE_URL).toBe(url);
      }
    });

    it('the error never quotes the URL, its user name or its password', () => {
      const url = 'http://canary-user:canary-pass@proxy.example/v1';
      let message = '';
      try {
        loadEnv(withKey('ollama', url));
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe('Invalid environment variables: PSEUDONYM_PROVIDER_BASE_URL');
    });

    it('is listed beside other wrong variables, not hidden by them', () => {
      expect(() =>
        loadEnv({ ...withKey('ollama', 'http://ollama.example/v1'), PORT: 'x' }),
      ).toThrow(/^Invalid environment variables: PORT, PSEUDONYM_PROVIDER_BASE_URL$/);
    });

    it('every default URL is HTTPS or loopback, so no default is ever refused', () => {
      for (const [provider, url] of Object.entries(PROVIDER_BASE_URL_DEFAULTS)) {
        const { protocol, hostname } = new URL(url);
        expect([provider, protocol === 'https:' || isLoopbackHost(hostname)]).toEqual([
          provider,
          true,
        ]);
        expect(
          loadEnv({ ...REQUIRED, PSEUDONYM_PROVIDER: provider, PSEUDONYM_PROVIDER_API_KEY: 'key' }),
        ).toBeDefined();
      }
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

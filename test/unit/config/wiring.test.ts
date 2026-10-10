// Every environment variable reaches the setting it is meant for. All the
// values differ, so handing one variable to another's setting fails here
// (main.ts itself is wiring with no tests).

import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../../src/config/env.js';
import {
  chatProvider,
  modelNameWarning,
  nameOptions,
  providerConfig,
  serverConfig,
} from '../../../src/config/wiring.js';
import { GEMINI_PROFILE } from '../../../src/providers/gemini.js';

const env = loadEnv({
  LOG_LEVEL: 'warn',
  PSEUDONYM_MODEL: 'qwen3:8b',
  PSEUDONYM_PROVIDER_BASE_URL: 'https://ollama.example/v1',
  PSEUDONYM_PROVIDER_API_KEY: 'key',
  PSEUDONYM_PROVIDER_TIMEOUT_MS: '1001',
  PSEUDONYM_MAX_BODY_BYTES: '1002',
  PSEUDONYM_MAX_RESPONSE_BYTES: '1003',
  PSEUDONYM_MAX_STREAM_BYTES: '1004',
  PSEUDONYM_RESTORE_IN_UNSAFE_REGIONS: 'true',
  PSEUDONYM_PLACEHOLDER_INSTRUCTION: 'false',
  PSEUDONYM_NAMES_TIMEOUT_MS: '1005',
  PSEUDONYM_NAMES_MAX_QUEUE: '1006',
});

describe('providerConfig', () => {
  it('takes each setting from its own variable', () => {
    expect(providerConfig(env)).toEqual({
      baseUrl: 'https://ollama.example/v1',
      model: 'qwen3:8b',
      apiKey: 'key',
      timeoutMs: 1001,
      maxResponseBytes: 1003,
      maxStreamBytes: 1004,
    });
  });

  it('has no API key when none is set', () => {
    expect(providerConfig(loadEnv({ PSEUDONYM_MODEL: 'qwen3:8b' })).apiKey).toBeUndefined();
  });

  it("gemini: Gemini's base URL by default, and the key", () => {
    const gemini = loadEnv({
      PSEUDONYM_PROVIDER: 'gemini',
      PSEUDONYM_MODEL: 'gemini-model',
      PSEUDONYM_PROVIDER_API_KEY: 'gemini-key',
    });
    expect(providerConfig(gemini)).toMatchObject({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      model: 'gemini-model',
      apiKey: 'gemini-key',
    });
  });
});

describe('chatProvider', () => {
  it("ollama by default, with Ollama's profile", () => {
    expect(chatProvider(loadEnv({ PSEUDONYM_MODEL: 'qwen3:8b' })).profile.name).toBe('ollama');
  });

  it("gemini: Gemini's profile", () => {
    const gemini = loadEnv({
      PSEUDONYM_PROVIDER: 'gemini',
      PSEUDONYM_MODEL: 'gemini-model',
      PSEUDONYM_PROVIDER_API_KEY: 'gemini-key',
    });
    expect(chatProvider(gemini).profile.name).toBe('gemini');
  });
});

describe('serverConfig', () => {
  it('takes each setting from its own variable', () => {
    // providerName added with option 3 and 4b (ADR-041 section 16); Ollama
    // has no measured refusals, so there is no `refusals` key.
    expect(serverConfig(env)).toEqual({
      model: 'qwen3:8b',
      providerName: 'ollama',
      bodyLimit: 1002,
      restoreInUnsafeRegions: true,
      placeholderInstruction: false,
      logLevel: 'warn',
    });
  });

  it('keeps the two switches apart the other way round too', () => {
    const config = serverConfig(
      loadEnv({
        PSEUDONYM_MODEL: 'qwen3:8b',
        PSEUDONYM_RESTORE_IN_UNSAFE_REGIONS: 'false',
        PSEUDONYM_PLACEHOLDER_INSTRUCTION: 'true',
      }),
    );
    expect([config.restoreInUnsafeRegions, config.placeholderInstruction]).toEqual([false, true]);
  });
});

// ADR-041 section 16: K1 (exact provider, exact model) and decision B.
describe('refusals and the models/ warning', () => {
  const gemini = (model: string) =>
    loadEnv({
      PSEUDONYM_PROVIDER: 'gemini',
      PSEUDONYM_MODEL: model,
      PSEUDONYM_PROVIDER_API_KEY: 'gemini-key',
    });

  it("gemini with the measured model: Gemini's entries for it, and no warning", () => {
    const config = serverConfig(gemini('gemini-3.5-flash-lite'));
    expect(config.providerName).toBe('gemini');
    expect(config.refusals).toBe(GEMINI_PROFILE.refusals!['gemini-3.5-flash-lite']);
    expect(modelNameWarning(gemini('gemini-3.5-flash-lite'))).toBeUndefined();
  });

  it('the model name must match exactly: case and a models/ prefix both miss', () => {
    for (const model of [
      'Gemini-3.5-Flash-Lite',
      'models/gemini-3.5-flash-lite',
      'gemini-3.5-flash',
    ]) {
      expect([model, serverConfig(gemini(model)).refusals]).toEqual([model, undefined]);
    }
  });

  it('the same model name under another provider gets nothing (the provider is part of the key)', () => {
    const ollama = loadEnv({ PSEUDONYM_MODEL: 'gemini-3.5-flash-lite' });
    expect(serverConfig(ollama).refusals).toBeUndefined();
    expect(modelNameWarning(ollama)).toBeUndefined();
  });

  it('a model name that is a built-in object property is not an entry', () => {
    for (const model of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect([model, serverConfig(gemini(model)).refusals]).toEqual([model, undefined]);
    }
  });

  it('warns when the model differs only by a leading models/, either way round, naming both', () => {
    const warning = modelNameWarning(gemini('models/gemini-3.5-flash-lite'));
    expect(warning).toBe(
      'PSEUDONYM_MODEL "models/gemini-3.5-flash-lite" differs only by a leading "models/" from ' +
        '"gemini-3.5-flash-lite", which the gemini profile has measured refusals for; ' +
        'requests for this model are not checked against them before sending',
    );
    expect(modelNameWarning(gemini('gemini-3.5-flash'))).toBeUndefined();
    expect(modelNameWarning(gemini('models/gemini-3.5-flash'))).toBeUndefined();
    expect(modelNameWarning(gemini('models/models/gemini-3.5-flash-lite'))).toBeUndefined();
  });
});

describe('nameOptions', () => {
  it('takes the timeout and the queue from their own variables', () => {
    expect(nameOptions(env)).toEqual({ timeoutMs: 1005, maxQueue: 1006 });
  });

  it('defaults to 202 s and 8 waiting (ADR-037, step 4b), applied here, not in the parsed configuration', () => {
    const plain = loadEnv({ PSEUDONYM_MODEL: 'qwen3:8b' });
    expect('PSEUDONYM_NAMES_TIMEOUT_MS' in plain).toBe(false);
    expect('PSEUDONYM_NAMES_MAX_QUEUE' in plain).toBe(false);
    expect(nameOptions(plain)).toEqual({ timeoutMs: 202_000, maxQueue: 8 });
  });

  it('accepts a queue of 0 (no request waits), not a timeout of 0', () => {
    const base = { PSEUDONYM_MODEL: 'qwen3:8b' };
    expect(nameOptions(loadEnv({ ...base, PSEUDONYM_NAMES_MAX_QUEUE: '0' })).maxQueue).toBe(0);
    expect(() => loadEnv({ ...base, PSEUDONYM_NAMES_TIMEOUT_MS: '0' })).toThrow(
      'Invalid environment variables: PSEUDONYM_NAMES_TIMEOUT_MS',
    );
    expect(() => loadEnv({ ...base, PSEUDONYM_NAMES_MAX_QUEUE: '-1' })).toThrow(
      'Invalid environment variables: PSEUDONYM_NAMES_MAX_QUEUE',
    );
  });
});

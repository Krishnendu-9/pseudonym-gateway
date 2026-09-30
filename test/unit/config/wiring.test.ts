// Every environment variable reaches the setting it is meant for. All the
// values differ, so handing one variable to another's setting fails here
// (main.ts itself is wiring with no tests).

import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../../src/config/env.js';
import { ollamaConfig, serverConfig } from '../../../src/config/wiring.js';

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
});

describe('ollamaConfig', () => {
  it('takes each setting from its own variable', () => {
    expect(ollamaConfig(env)).toEqual({
      baseUrl: 'https://ollama.example/v1',
      model: 'qwen3:8b',
      apiKey: 'key',
      timeoutMs: 1001,
      maxResponseBytes: 1003,
      maxStreamBytes: 1004,
    });
  });

  it('has no API key when none is set', () => {
    expect(ollamaConfig(loadEnv({ PSEUDONYM_MODEL: 'qwen3:8b' })).apiKey).toBeUndefined();
  });
});

describe('serverConfig', () => {
  it('takes each setting from its own variable', () => {
    expect(serverConfig(env)).toEqual({
      model: 'qwen3:8b',
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

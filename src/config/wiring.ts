// From the parsed environment to the settings each part takes. Kept out of
// main.ts so that it is under test: handing one variable to another's
// setting (the two size caps, the two on/off switches) would otherwise go
// unnoticed, since main.ts only runs as a process.

import type { NameFinder, ServerConfig } from '../gateway/server.js';
import type { OllamaConfig } from '../providers/ollama.js';
import type { Env } from './env.js';

export function ollamaConfig(env: Env): OllamaConfig {
  return {
    baseUrl: env.PSEUDONYM_PROVIDER_BASE_URL,
    model: env.PSEUDONYM_MODEL,
    apiKey: env.PSEUDONYM_PROVIDER_API_KEY,
    timeoutMs: env.PSEUDONYM_PROVIDER_TIMEOUT_MS,
    maxResponseBytes: env.PSEUDONYM_MAX_RESPONSE_BYTES,
    maxStreamBytes: env.PSEUDONYM_MAX_STREAM_BYTES,
  };
}

export function serverConfig(env: Env): ServerConfig {
  return {
    model: env.PSEUDONYM_MODEL,
    bodyLimit: env.PSEUDONYM_MAX_BODY_BYTES,
    restoreInUnsafeRegions: env.PSEUDONYM_RESTORE_IN_UNSAFE_REGIONS,
    placeholderInstruction: env.PSEUDONYM_PLACEHOLDER_INSTRUCTION,
    logLevel: env.LOG_LEVEL,
  };
}

/**
 * The name finder, started by `start` only when names are on
 * (PSEUDONYM_NAMES=true; ADR-037). With names off, `start` is never called,
 * so nothing that loads the name model runs. A `start` that fails refuses
 * start-up: its error is thrown.
 */
export async function nameFinder(
  env: Env,
  start: () => Promise<NameFinder>,
): Promise<NameFinder | undefined> {
  return env.PSEUDONYM_NAMES === 'true' ? await start() : undefined;
}

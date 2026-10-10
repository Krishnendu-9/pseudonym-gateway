// From the parsed environment to the settings each part takes. Kept out of
// main.ts so that it is under test: handing one variable to another's
// setting (the two size caps, the two on/off switches) would otherwise go
// unnoticed, since main.ts only runs as a process.

import type { NameDetectorOptions } from '../gateway/names.js';
import type { NameFinder, ServerConfig } from '../gateway/server.js';
import { GEMINI_PROFILE } from '../providers/gemini.js';
import { OLLAMA_PROFILE } from '../providers/ollama.js';
import {
  createOpenAICompatibleProvider,
  type OpenAICompatibleConfig,
  type ProviderProfile,
} from '../providers/openai-compatible.js';
import type { ChatProvider } from '../providers/provider.js';
import type { Env } from './env.js';

const PROFILES: Readonly<Record<Env['PSEUDONYM_PROVIDER'], ProviderProfile>> = {
  ollama: OLLAMA_PROFILE,
  gemini: GEMINI_PROFILE,
};

/** The adapter for the configured provider, with that provider's profile. */
export function chatProvider(env: Env): ChatProvider & { readonly profile: ProviderProfile } {
  return createOpenAICompatibleProvider(providerConfig(env), PROFILES[env.PSEUDONYM_PROVIDER]);
}

export function providerConfig(env: Env): OpenAICompatibleConfig {
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

// The name detector's defaults (ADR-037, Phase 6b step 4b follow-up).
//
// The timeout is derived: the time the largest request the default body
// limit allows would take at the slowest name-detection speed ever measured
// on a full 256 KiB body, with a margin. Slowest: 525.889 ms per KiB, B
// 524.319 + F 1.570, the comparison script's run of 2026-10-03
// (D:/pseudonym-6a/runs/2026-10-03-move-after); every other full-body run,
// script or gateway, was between 275.0 and 442.1. 256 KiB at that speed is
// 134.6 s. The margin, 1.5, covers the gateway's own path being slower than
// the script's (up to 1.21 times in the one session that measured both)
// with room to spare: 201.9 s, rounded up to the second. If the body limit
// is raised, this no longer covers the largest request, and option 1 of
// ADR-037's step 4b decision (never stop a long call) no longer holds as
// decided: see PSEUDONYM_MAX_BODY_BYTES in env.ts.
const SLOWEST_MS_PER_KIB = 525.889;
const LARGEST_TEXT_KIB = 256;
const TIMEOUT_MARGIN = 1.5;
export const NAMES_TIMEOUT_MS_DEFAULT =
  Math.ceil((SLOWEST_MS_PER_KIB * LARGEST_TEXT_KIB * TIMEOUT_MARGIN) / 1000) * 1000;
// The queue is chosen, not derived: it bounds how many requests wait while
// the model works (their bodies are already held: eight at most 2 MiB of
// text) and so how many are told "wait" rather than refused at once. It
// does not bound how long they wait; the timeout does.
export const NAMES_MAX_QUEUE_DEFAULT = 8;

/** The name detector's timeout and queue (read only when names are on). */
export function nameOptions(env: Env): NameDetectorOptions {
  return {
    timeoutMs: env.PSEUDONYM_NAMES_TIMEOUT_MS ?? NAMES_TIMEOUT_MS_DEFAULT,
    maxQueue: env.PSEUDONYM_NAMES_MAX_QUEUE ?? NAMES_MAX_QUEUE_DEFAULT,
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

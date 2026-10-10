// Gemini, through its OpenAI-compatible endpoint (`POST {base}/chat/completions`;
// the base is PROVIDER_BASE_URL_DEFAULTS in config/env.ts). A product provider
// since ADR-041 section 16, decision A: every Phase 7 measurement was sent to
// it (test/fixtures/gemini-7b/). The adapter is openai-compatible.ts; this is
// Gemini's profile.
//
// What Gemini does that the profile does not express yet, measured:
// - It refuses some fields and values (ADR-041 sections 13 and 14). The
//   gateway does not check them before sending yet; ADR-041 section 16's
//   option 3 adds that, keyed by model.
// - With `stream_options.include_usage`, it sends `usage` on every chunk, so
//   the adapter rejects the stream (attempt-4/s3, pinned in
//   test/integration/gemini-recordings.test.ts).

import type { ProviderProfile } from './openai-compatible.js';

/** Gemini's profile: its name. */
export const GEMINI_PROFILE: ProviderProfile = { name: 'gemini' };

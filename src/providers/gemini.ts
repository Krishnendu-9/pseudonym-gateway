// Gemini, through its OpenAI-compatible endpoint (`POST {base}/chat/completions`;
// the base is PROVIDER_BASE_URL_DEFAULTS in config/env.ts). A product provider
// since ADR-041 section 16, decision A: every Phase 7 measurement was sent to
// it (test/fixtures/gemini-7b/). The adapter is openai-compatible.ts; this is
// Gemini's profile.
//
// Its refusals are measured, never read from documentation, and keyed by
// the exact model name (ADR-041 section 16, decisions B and C). Each entry
// names the recordings it rests on, and gemini-profile.test.ts checks every
// one against its recording. `reasoning_effort: "none"` is not listed:
// p09's refusal was attributed by elimination only, and Google's own
// messages list `none` as valid (decision D); the registered s1/p09 pair
// settles it.
//
// Measured and not expressed here, because it is not a refusal: with
// `stream_options.include_usage`, Gemini sends `usage` on every chunk and the
// adapter rejects the stream (bug-log 75, to be fixed in the adapter).

import type { ProviderProfile } from './openai-compatible.js';

/** Gemini's profile: its name and its measured refusals. */
export const GEMINI_PROFILE: ProviderProfile = {
  name: 'gemini',
  refusals: {
    'gemini-3.5-flash-lite': {
      seed: { kind: 'any', probes: ['attempt-5/p03', 'attempt-6/p16'] },
      frequency_penalty: { kind: 'any', probes: ['attempt-5/p04', 'attempt-6/p17'] },
      presence_penalty: { kind: 'nonzero', probes: ['attempt-5/p05', 'attempt-6/p18'] },
      reasoning_effort: {
        kind: 'values',
        values: ['xhigh', 'max'],
        probes: ['attempt-5/p14', 'attempt-5/p15'],
      },
    },
  },
};

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
// `stream_options.include_usage`, Gemini sends `usage` on every chunk, as
// running totals. The adapter takes the last one (bug-log 75, fixed in the
// adapter, openai-compatible.ts), for every provider.

import type { ProviderProfile } from './openai-compatible.js';

// scripts/measure-gemini.ts keeps its own copy of this profile's name (and
// of the base URL, beside PROVIDER_BASE_URL_DEFAULTS), on purpose (ADR-041
// section 16, amendment item 5): Attempts 1 to 6 were made by the script as
// it stands, and a re-run of a registered command must send what was
// registered. Importing from here would let a change to the product
// silently change what that command sends. Change this one and the script
// must not follow.

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

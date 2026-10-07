// Ollama, through its OpenAI-compatible endpoint
// (`POST {base}/chat/completions`; docs.ollama.com/api/openai-compatibility,
// checked 2026-09-29 against release v0.34.4; the stream format from the
// source, `middleware/openai.go` and `openai/openai.go`, checked the same
// day, since the docs do not show it). Since Phase 7b (ADR-041, option A)
// the adapter is openai-compatible.ts; this is Ollama's profile, and the
// names every caller already imports.
//
// What an Ollama stream looks like (its source): `data: <chunk>` events, the
// first with `delta.role`; `delta.content` is empty or left out in a chunk
// that carries only `reasoning` (`"content":""` on main, 2026-09-30); a
// separate chunk carries `finish_reason`; with `include_usage`, a chunk with
// `choices: []` and `usage` follows; then `data: [DONE]`. A real stream from
// v0.35.0 (test/fixtures/ollama-stream-qwen3-4b.sse, recorded 2026-10-02)
// has exactly this shape, with `"content":""` on every reasoning chunk and
// an empty `delta` in the finish chunk. An error in the middle of a stream
// is not an event: Ollama has already sent 200, writes the error through the
// chunk writer, and ends without `[DONE]`, which is why the adapter treats a
// stream that ends before `[DONE]` as a failure.

import {
  createOpenAICompatibleProvider,
  MAX_EVENT_BYTES,
  type OpenAICompatibleConfig,
  type ProviderProfile,
} from './openai-compatible.js';
import type { ChatProvider } from './provider.js';

export { MAX_EVENT_BYTES };
export type OllamaConfig = OpenAICompatibleConfig;

/** Ollama's profile: its name, and no measured difference from the adapter's defaults. */
export const OLLAMA_PROFILE: ProviderProfile = { name: 'ollama' };

export const createOllamaProvider = (config: OllamaConfig): ChatProvider =>
  createOpenAICompatibleProvider(config, OLLAMA_PROFILE);

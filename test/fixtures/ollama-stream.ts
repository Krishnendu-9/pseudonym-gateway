// A real streamed answer from Ollama, recorded once by
// scripts/record-ollama-stream.ts (the Phase 4b follow-up): the raw bytes
// Ollama sent, unchanged, and a sidecar saying where they came from.
//
// The client request below is synthetic: a published test card (Visa
// 4111 1111 1111 1111, in PUBLISHED_TEST_CARDS) and an address at the
// reserved example.com domain. Ollama only ever saw the redacted text, so
// the recorded answer holds placeholders, never these values.

/** The chat request the client sent, before redaction. */
export const RECORDED_CLIENT_REQUEST = {
  model: 'test-model',
  messages: [
    {
      role: 'user',
      content:
        'In two short sentences, confirm to the customer that the refund to card ' +
        '4111 1111 1111 1111 was approved and that the receipt was emailed to ' +
        'asha.verma@example.com.',
    },
  ],
  stream: true,
  stream_options: { include_usage: true },
} as const;

/** The values in RECORDED_CLIENT_REQUEST, for checking what Ollama was sent. */
export const RECORDED_VALUES = ['4111 1111 1111 1111', 'asha.verma@example.com'] as const;

export const RECORDED_STREAM_FILE = new URL('./ollama-stream-qwen3-4b.sse', import.meta.url);
export const RECORDED_STREAM_INFO_FILE = new URL('./ollama-stream-qwen3-4b.json', import.meta.url);

/** The sidecar the recorder writes next to the bytes. */
export interface RecordedStreamInfo {
  readonly recordedOn: string;
  readonly ollamaVersion: string;
  readonly model: string;
  readonly modelDigest: string;
  /** The request body Pseudonym sent to Ollama, parsed. */
  readonly sentToProvider: unknown;
}

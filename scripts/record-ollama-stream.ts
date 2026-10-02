// Records one real streamed answer from a running Ollama as a test fixture
// (Phase 4b follow-up): test/fixtures/ollama-stream-qwen3-4b.sse, the bytes
// exactly as Ollama sent them, and a .json sidecar with the Ollama version,
// the model and its digest, and the body Pseudonym sent.
//
//   npx tsx scripts/record-ollama-stream.ts --model qwen3:4b [--base-url http://127.0.0.1:11434/v1]
//
// The request goes through the real pipeline: the synthetic client request
// in test/fixtures/ollama-stream.ts is parsed and redacted as the gateway
// does it (placeholder instruction on), then sent by the real Ollama adapter.
// `fetch` is wrapped only to keep a copy of the request body and of the
// response bytes; the adapter reads the response as usual, so a successful
// run also shows that the adapter accepts this real stream.
//
// Prints counts and the answer as the model wrote it (placeholders), never
// a restored value.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { redactRequest } from '../src/gateway/redact-request.js';
import { parseChatRequest } from '../src/gateway/schema.js';
import { createOllamaProvider } from '../src/providers/ollama.js';
import { PlaceholderMapping } from '../src/redaction/mapping.js';
import {
  RECORDED_CLIENT_REQUEST,
  RECORDED_STREAM_FILE,
  RECORDED_STREAM_INFO_FILE,
  RECORDED_VALUES,
  type RecordedStreamInfo,
} from '../test/fixtures/ollama-stream.js';

const { values: args } = parseArgs({
  options: {
    model: { type: 'string' },
    'base-url': { type: 'string', default: 'http://127.0.0.1:11434/v1' },
  },
});
if (!args.model) {
  console.error('usage: npx tsx scripts/record-ollama-stream.ts --model <name> [--base-url <url>]');
  process.exit(1);
}
const model = args.model;
const baseUrl = args['base-url'];
const ollamaRoot = baseUrl.replace(/\/v1\/?$/, '');

const version = ((await (await fetch(`${ollamaRoot}/api/version`)).json()) as { version: string })
  .version;
const tags = (await (await fetch(`${ollamaRoot}/api/tags`)).json()) as {
  models: { name: string; digest: string }[];
};
const digest = tags.models.find((m) => m.name === model)?.digest;
if (!digest) {
  console.error(`model ${model} is not pulled in this Ollama`);
  process.exit(1);
}

const mapping = new PlaceholderMapping();
const request = redactRequest(parseChatRequest(RECORDED_CLIENT_REQUEST), mapping, {
  placeholderInstruction: true,
});

// Keep a copy of what goes out and what comes back.
let sentBody = '';
const received: Uint8Array[] = [];
let copying: Promise<void> = Promise.resolve();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  sentBody = typeof init?.body === 'string' ? init.body : '';
  const response = await realFetch(input, init);
  if (!response.body) return response;
  const [forAdapter, forFile] = response.body.tee();
  copying = (async () => {
    for await (const chunk of forFile) received.push(chunk as Uint8Array);
  })();
  return new Response(forAdapter, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

// The synthetic values must not be in what was sent; stop before writing
// anything if they are.
for (const value of RECORDED_VALUES) {
  if (JSON.stringify(request).includes(value)) {
    console.error('a planted value is in the redacted request; nothing recorded');
    process.exit(1);
  }
}

const provider = createOllamaProvider({
  baseUrl,
  model,
  // CPU only: loading the model and thinking can take minutes per wait.
  timeoutMs: 600_000,
  maxResponseBytes: 1_048_576,
  maxStreamBytes: 33_554_432,
});

const started = Date.now();
const stream = await provider.stream(request, new AbortController().signal, {
  includeUsage: true,
});
let answer = '';
const counts = { content: 0, finish: '', usage: false };
for await (const event of stream.events) {
  if (event.type === 'content') {
    counts.content++;
    answer += event.text;
  } else if (event.type === 'finish') counts.finish = event.reason;
  else counts.usage = true;
}
await copying;
globalThis.fetch = realFetch;

const bytes = Buffer.concat(received);
writeFileSync(RECORDED_STREAM_FILE, bytes);
const info: RecordedStreamInfo = {
  recordedOn: new Date().toISOString().slice(0, 10),
  ollamaVersion: version,
  model,
  modelDigest: digest,
  sentToProvider: JSON.parse(sentBody) as unknown,
};
writeFileSync(RECORDED_STREAM_INFO_FILE, `${JSON.stringify(info, null, 2)}\n`);

console.log(`Ollama ${version}, ${model} (${digest.slice(0, 12)})`);
console.log(`${bytes.length} bytes in ${Math.round((Date.now() - started) / 1000)} s`);
console.log(
  `adapter: ${counts.content} content events, finish ${counts.finish}, usage ${counts.usage}`,
);
console.log(`answer as written by the model:\n${answer}`);
console.log(`wrote ${fileURLToPath(RECORDED_STREAM_FILE)} and the .json sidecar`);

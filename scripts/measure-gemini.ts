// The Phase 7b live run against Gemini's OpenAI-compatible endpoint
// (ADR-041 section 10). Two modes:
//
//   npx tsx --env-file=.env scripts/measure-gemini.ts --headers
//   npx tsx --env-file=.env scripts/measure-gemini.ts --out test/fixtures/gemini-7b
//
// `--headers` sends one plain and one streamed request through the real
// adapter to a local server on 127.0.0.1 and prints the request headers
// exactly as they arrived (raw names, in order), with the key replaced:
// what leaves this machine is measured, not remembered. Nothing goes to
// Google.
//
// Without it, the 18 calls of ADR-041 section 10 go to Google, one at a
// time, spaced, never retried. Every request goes through the real
// pipeline (parseChatRequest, redactRequest, the adapter) and is refused
// before sending if a planted synthetic value is in its bytes. `fetch` is
// wrapped to keep the response bytes before the adapter reads them (after
// HTTP content decoding, which fetch does itself): each call's bytes, its
// sent body and its response headers are written to `--out`, whatever the
// adapter then makes of them. A 429 or any status other than 200 and 400
// stops the run; a 400 is a probe's result; a stream the adapter rejects is
// a finding, recorded, and the run moves on.
//
// The key and the model come from PSEUDONYM_PROVIDER_API_KEY and
// PSEUDONYM_MODEL. The key is never printed. Answers are never printed
// either: only counts and shapes (a model may invent a value).

import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { redactRequest } from '../src/gateway/redact-request.js';
import { parseChatRequest } from '../src/gateway/schema.js';
import { createOpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { ProviderError, type ProviderChatRequest } from '../src/providers/provider.js';
import { PlaceholderMapping } from '../src/redaction/mapping.js';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
const SPACING_MS = 15_000;
const TIMEOUT_MS = 120_000;

// Synthetic: the published Visa test card and a reserved example domain.
const CARD = '4111 1111 1111 1111';
const EMAIL = 'asha.verma@example.com';
const PLANTED = [CARD, CARD.replaceAll(' ', ''), EMAIL];

const { values: args } = parseArgs({
  options: { headers: { type: 'boolean', default: false }, out: { type: 'string' } },
});
if (!args.headers && !args.out) {
  console.error('usage: measure-gemini.ts --headers | --out <dir>');
  process.exit(1);
}
const key = process.env.PSEUDONYM_PROVIDER_API_KEY;
const model = process.env.PSEUDONYM_MODEL;
if (!key || !model) {
  console.error('PSEUDONYM_PROVIDER_API_KEY and PSEUDONYM_MODEL must both be set');
  process.exit(1);
}

interface Call {
  readonly id: string;
  readonly what: string;
  readonly stream?: { readonly includeUsage: boolean };
  readonly extra?: Record<string, unknown>;
}

const CALLS: Call[] = [
  { id: 's1', what: 'not streamed' },
  { id: 's2', what: 'streamed', stream: { includeUsage: false } },
  { id: 's3', what: 'streamed with usage', stream: { includeUsage: true } },
  { id: 'p01', what: 'temperature 0', extra: { temperature: 0 } },
  { id: 'p02', what: 'top_p 0.5', extra: { top_p: 0.5 } },
  { id: 'p03', what: 'seed 42', extra: { seed: 42 } },
  { id: 'p04', what: 'frequency_penalty 0.5', extra: { frequency_penalty: 0.5 } },
  { id: 'p05', what: 'presence_penalty 0.5', extra: { presence_penalty: 0.5 } },
  { id: 'p06', what: 'stop ["\\n"]', extra: { stop: ['\n'] } },
  { id: 'p07', what: 'max_tokens 16', extra: { max_tokens: 16 } },
  {
    id: 'p08',
    what: 'response_format json_object',
    extra: { response_format: { type: 'json_object' } },
  },
  ...['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((effort, i): Call => ({
    id: `p${String(9 + i).padStart(2, '0')}`,
    what: `reasoning_effort ${effort}`,
    extra: { reasoning_effort: effort },
  })),
];

function providerRequest(call: Call): ProviderChatRequest {
  const client = {
    model,
    messages: [
      { role: 'system', content: 'Be brief.' },
      {
        role: 'user',
        content: `Please confirm the refund for card ${CARD} was sent to ${EMAIL}. Reply in one sentence.`,
      },
    ],
    ...(call.stream ? { stream: true } : {}),
    ...call.extra,
  };
  return redactRequest(parseChatRequest(client), new PlaceholderMapping(), {
    placeholderInstruction: false,
  });
}

// --- the transport: refuse planted values, keep the bytes ---------------

interface Captured {
  sentBody: string;
  status: number;
  headers: [string, string][];
  headersMs: number;
  firstByteMs: number | undefined;
  bytes: Uint8Array[];
  done: Promise<void>;
}
let captured: Captured | undefined;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const body = typeof init?.body === 'string' ? init.body : '';
  if (PLANTED.some((value) => body.toLowerCase().includes(value.toLowerCase()))) {
    console.error('a planted value is in the outgoing body; nothing sent');
    process.exit(1);
  }
  const started = Date.now();
  const response = await realFetch(input, init);
  const record: Captured = {
    sentBody: body,
    status: response.status,
    headers: [...response.headers].filter(([name]) => name !== 'set-cookie'),
    headersMs: Date.now() - started,
    firstByteMs: undefined,
    bytes: [],
    done: Promise.resolve(),
  };
  captured = record;
  if (!response.body) return response;
  const [forAdapter, forFile] = response.body.tee();
  record.done = (async () => {
    for await (const chunk of forFile) {
      record.firstByteMs ??= Date.now() - started;
      record.bytes.push(chunk as Uint8Array);
    }
  })();
  return new Response(forAdapter, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

const provider = (baseUrl: string) =>
  createOpenAICompatibleProvider(
    {
      baseUrl,
      model,
      apiKey: key,
      timeoutMs: TIMEOUT_MS,
      maxResponseBytes: 1_048_576,
      maxStreamBytes: 33_554_432,
    },
    { name: 'gemini' },
  );

/** Runs one call through the adapter; returns what the adapter made of it. */
async function run(
  adapter: ReturnType<typeof provider>,
  call: Call,
): Promise<Record<string, unknown>> {
  const request = providerRequest(call);
  const signal = new AbortController().signal;
  try {
    if (!call.stream) {
      const result = await adapter.complete(request, signal);
      return {
        adapter: 'ok',
        finishReason: result.finishReason,
        usage: result.usage !== undefined,
      };
    }
    const stream = await adapter.stream(request, signal, call.stream);
    const seen = { content: 0, finish: '', usage: 0 };
    for await (const event of stream.events) {
      if (event.type === 'content') seen.content++;
      else if (event.type === 'finish') seen.finish = event.reason;
      else seen.usage++;
    }
    return {
      adapter: 'ok',
      contentEvents: seen.content,
      finishReason: seen.finish,
      usageEvents: seen.usage,
    };
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    return { adapter: 'failed', failure: error.failure, status: error.status };
  }
}

// --- shapes of what came back, never its text ---------------------------

const placeholdersIn = (text: string) => ['CARD_1', 'EMAIL_1'].filter((p) => text.includes(p));
// 12 or more digits, allowing spaces and hyphens between them.
const longDigitRuns = (text: string) => [...text.matchAll(/\d(?:[ -]?\d){11,}/g)].length;

function shapeOf(text: string, isStream: boolean): Record<string, unknown> {
  if (!isStream) {
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      const choice = (json.choices as Record<string, unknown>[] | undefined)?.[0];
      const message = choice?.message as Record<string, unknown> | undefined;
      const content = message?.content;
      return {
        keys: Object.keys(json),
        choiceKeys: choice ? Object.keys(choice) : null,
        messageKeys: message ? Object.keys(message) : null,
        finishReasonRaw: choice?.finish_reason,
        contentType: content === null ? 'null' : typeof content,
        contentLength: typeof content === 'string' ? content.length : null,
        placeholders: typeof content === 'string' ? placeholdersIn(content) : [],
        longDigitRuns: longDigitRuns(text),
        errorKeys: json.error ? Object.keys(json.error as object) : null,
      };
    } catch {
      return { json: false, longDigitRuns: longDigitRuns(text) };
    }
  }
  const lines = text.split(/\r\n|\r|\n/);
  const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
  const chunks = data
    .filter((d) => d !== '[DONE]')
    .map((d) => {
      try {
        return JSON.parse(d) as Record<string, unknown>;
      } catch {
        return { unparsable: true } as Record<string, unknown>;
      }
    });
  const finishes = chunks.flatMap((c) =>
    ((c.choices as Record<string, unknown>[] | undefined) ?? [])
      .map((ch) => ch.finish_reason)
      .filter((f) => f !== null && f !== undefined),
  );
  let content = '';
  for (const c of chunks) {
    const delta = (c.choices as { delta?: { content?: unknown } }[] | undefined)?.[0]?.delta;
    if (typeof delta?.content === 'string') content += delta.content;
  }
  return {
    dataEvents: data.length,
    done: data.at(-1) === '[DONE]',
    doneAnywhere: data.includes('[DONE]'),
    crlf: text.includes('\r\n'),
    commentLines: lines.filter((l) => l.startsWith(':')).length,
    otherFieldLines: lines.filter((l) => /^[a-z]+:/.test(l) && !l.startsWith('data:')).length,
    chunkKeys: [...new Set(chunks.flatMap((c) => Object.keys(c)))],
    ids: new Set(chunks.map((c) => c.id)).size,
    finishReasonsRaw: finishes,
    usageChunks: chunks.filter((c) => c.usage !== null && c.usage !== undefined).length,
    usageNullChunks: chunks.filter((c) => c.usage === null).length,
    emptyChoicesChunks: chunks.filter((c) => Array.isArray(c.choices) && c.choices.length === 0)
      .length,
    errorEvents: chunks.filter((c) => 'error' in c).length,
    contentLength: content.length,
    placeholders: placeholdersIn(content),
    longDigitRuns: longDigitRuns(text),
  };
}

// --- mode 1: the headers, against a local server -------------------------

if (args.headers) {
  const arrived: string[][] = [];
  const server = createServer((req: IncomingMessage, res) => {
    arrived.push(req.rawHeaders);
    req.resume();
    req.on('end', () => {
      if (arrived.length === 1) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'x',
            created: 0,
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          }),
        );
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          'data: {"id":"x","created":0,"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  // The live run sends this model name; check it here, before Google sees it.
  console.log(`model ${model}`);
  const adapter = provider(`http://127.0.0.1:${port}/v1beta/openai/`);
  console.log(`s1: ${JSON.stringify(await run(adapter, CALLS[0]!))}`);
  console.log(`s3: ${JSON.stringify(await run(adapter, CALLS[2]!))}`);
  server.close();
  for (const [i, raw] of arrived.entries()) {
    console.log(`\nrequest ${i + 1}, headers as they arrived (${raw.length / 2}):`);
    for (let j = 0; j < raw.length; j += 2) {
      const name = raw[j]!;
      let value = raw[j + 1]!;
      if (name.toLowerCase() === 'authorization') {
        value =
          value === `Bearer ${key}` ? 'Bearer <the configured key>' : '<NOT the configured key>';
      }
      if (name.toLowerCase() === 'host') value = value.replace(/:\d+$/, ':<port>');
      console.log(`  ${name}: ${value}`);
    }
  }
  process.exit(0);
}

// --- mode 2: the live run ------------------------------------------------

const out = args.out!;
mkdirSync(out, { recursive: true });
const adapter = provider(GEMINI_BASE_URL);
console.log(`model ${model}, ${CALLS.length} calls, ${SPACING_MS / 1000} s apart`);

for (const [n, call] of CALLS.entries()) {
  if (n > 0) await sleep(SPACING_MS);
  captured = undefined;
  const started = Date.now();
  const outcome = await run(adapter, call);
  const record = captured as Captured | undefined;
  await record?.done.catch(() => undefined);
  const ms = Date.now() - started;
  if (!record) {
    console.log(`${call.id} ${call.what}: no response (${JSON.stringify(outcome)}, ${ms} ms)`);
    writeFileSync(
      join(out, `${call.id}.meta.json`),
      `${JSON.stringify({ ...call, outcome, ms }, null, 2)}\n`,
    );
    continue;
  }
  const bytes = Buffer.concat(record.bytes);
  const isSse = /text\/event-stream/i.test(
    record.headers.find(([name]) => name === 'content-type')?.[1] ?? '',
  );
  const ext = isSse ? 'sse' : 'json';
  writeFileSync(join(out, `${call.id}.response.${ext}`), bytes);
  const shape = shapeOf(bytes.toString('utf8'), isSse);
  const meta = {
    id: call.id,
    what: call.what,
    recordedOn: new Date().toISOString(),
    model,
    sentBody: JSON.parse(record.sentBody) as unknown,
    status: record.status,
    responseHeaders: Object.fromEntries(record.headers),
    headersMs: record.headersMs,
    firstByteMs: record.firstByteMs,
    totalMs: ms,
    bytes: bytes.length,
    outcome,
    shape,
  };
  writeFileSync(join(out, `${call.id}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(
    `${call.id} ${call.what}: ${record.status}, ${bytes.length} B, ${ms} ms; ${JSON.stringify(outcome)}; ${JSON.stringify(shape)}`,
  );
  if (record.status === 429) {
    console.log('429: the run stops here (no retries)');
    break;
  }
  if (record.status !== 200 && record.status !== 400) {
    console.log(`status ${record.status}: the run stops here`);
    break;
  }
}
globalThis.fetch = realFetch;

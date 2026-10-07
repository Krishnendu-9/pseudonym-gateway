// The Phase 7b live run against Gemini's OpenAI-compatible endpoint
// (ADR-041 section 10). Three modes:
//
//   npx tsx --env-file=.env scripts/measure-gemini.ts --list-models --out test/fixtures/gemini-7b
//   npx tsx --env-file=.env scripts/measure-gemini.ts --headers --model <name>
//   npx tsx --env-file=.env scripts/measure-gemini.ts --model <name> --out test/fixtures/gemini-7b [--calls s1,s2,s3]
//
// `--calls` picks calls by id, so the run can be split to fit a day's
// allowance (20 requests on the free tier). If `s1` is answered 404 for the
// bare model name, one call with `models/<name>` follows: the
// pre-registered two-form probe of ADR-041 section 10, not a retry.
//
// The model is named on the command line, never taken from .env (which
// keeps the local Ollama setup), so the command that produced a recording
// names the model that produced it. Every run that writes goes to its own
// new folder, `<out>/attempt-N` (the next unused N), with an attempt.json
// naming the mode, the model and the time: a rerun never overwrites an
// earlier attempt's bytes.
//
// `--list-models` sends `GET {base}/models` with the key and no content,
// and records the answer.
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
// The key comes from PSEUDONYM_PROVIDER_API_KEY and is never printed. Answers are never printed
// either: only counts and shapes (a model may invent a value).
//
// The two modes that reach Google refuse to start unless the working tree is
// clean (`live-run-guard.ts`, ADR-041 section 11): the plan governing a run
// must be committed before it, and attempt.json records the commit it ran
// from. `--headers` sends nothing to Google and is not guarded. The guard
// changes nothing about what is sent.

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { redactRequest } from '../src/gateway/redact-request.js';
import { parseChatRequest } from '../src/gateway/schema.js';
import { createOpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { ProviderError, type ProviderChatRequest } from '../src/providers/provider.js';
import { PlaceholderMapping } from '../src/redaction/mapping.js';
import { checkTree, gitIn } from './live-run-guard.js';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
const SPACING_MS = 15_000;
const TIMEOUT_MS = 120_000;

// Synthetic: the published Visa test card and a reserved example domain.
const CARD = '4111 1111 1111 1111';
const EMAIL = 'asha.verma@example.com';
const PLANTED = [CARD, CARD.replaceAll(' ', ''), EMAIL];

const { values: args } = parseArgs({
  options: {
    'list-models': { type: 'boolean', default: false },
    headers: { type: 'boolean', default: false },
    model: { type: 'string' },
    out: { type: 'string' },
    // Comma-separated call ids (s1,s2,s3): the run is split to fit a day's allowance.
    calls: { type: 'string' },
  },
});
const mode = args['list-models'] ? 'list-models' : args.headers ? 'headers' : 'calls';
if (
  (mode === 'list-models' && !args.out) ||
  (mode === 'headers' && !args.model) ||
  (mode === 'calls' && (!args.model || !args.out))
) {
  console.error(
    'usage: measure-gemini.ts --list-models --out <dir> | --headers --model <name> | --model <name> --out <dir>',
  );
  process.exit(1);
}
// Before anything else that could lead to a call: a run whose plan is not
// committed does not start (ADR-041 section 11).
let head: string | null = null;
if (mode !== 'headers') {
  const tree = checkTree(gitIn(fileURLToPath(new URL('..', import.meta.url))));
  if (!tree.ok) {
    console.error(tree.reason);
    process.exit(1);
  }
  head = tree.head;
  console.log(`working tree clean at ${head}`);
}
const key = process.env.PSEUDONYM_PROVIDER_API_KEY;
if (!key) {
  console.error('PSEUDONYM_PROVIDER_API_KEY must be set');
  process.exit(1);
}
const model = args.model ?? '';

/** Creates `<out>/attempt-N` for the next unused N and records how it was made. */
function newAttempt(out: string): string {
  mkdirSync(out, { recursive: true });
  const used = readdirSync(out)
    .map((name) => /^attempt-(\d+)$/.exec(name)?.[1])
    .filter((n) => n !== undefined)
    .map(Number);
  const dir = join(out, `attempt-${Math.max(0, ...used) + 1}`);
  mkdirSync(dir);
  const about = {
    mode,
    model: args.model ?? null,
    calls: mode === 'calls' ? (args.calls ?? 'all') : null,
    startedAt: new Date().toISOString(),
    // The commit the run started from, with a clean tree (live-run-guard.ts).
    head,
  };
  writeFileSync(join(dir, 'attempt.json'), `${JSON.stringify(about, null, 2)}\n`);
  return dir;
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

const provider = (baseUrl: string, modelName: string = model) =>
  createOpenAICompatibleProvider(
    {
      baseUrl,
      model: modelName,
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

// --- mode 1: the model list ----------------------------------------------

if (mode === 'list-models') {
  const dir = newAttempt(args.out!);
  const url = new URL('models', GEMINI_BASE_URL);
  const response = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
  const record = captured as Captured | undefined;
  await record?.done;
  const bytes = Buffer.concat(record?.bytes ?? []);
  writeFileSync(join(dir, 'models.response.json'), bytes);
  const meta = {
    request: `GET ${url.href}`,
    recordedOn: new Date().toISOString(),
    status: response.status,
    responseHeaders: Object.fromEntries(record?.headers ?? []),
    bytes: bytes.length,
  };
  writeFileSync(join(dir, 'models.meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`GET models: ${response.status}, ${bytes.length} B, written to ${dir}`);
  try {
    const json = JSON.parse(bytes.toString('utf8')) as { data?: { id?: unknown }[] };
    const ids = (json.data ?? []).map((m) => m.id);
    console.log(`${ids.length} models:`);
    for (const id of ids) console.log(`  ${String(id)}`);
  } catch {
    console.log('the answer is not JSON');
  }
  process.exit(0);
}

// --- mode 2: the headers, against a local server -------------------------

if (mode === 'headers') {
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

// --- mode 3: the live run ------------------------------------------------

const selected = args.calls?.split(',') ?? CALLS.map((c) => c.id);
const unknown = selected.filter((id) => !CALLS.some((c) => c.id === id));
if (unknown.length > 0) {
  console.error(`unknown call ids: ${unknown.join(', ')}`);
  process.exit(1);
}
const toRun = CALLS.filter((c) => selected.includes(c.id));
const out = newAttempt(args.out!);
console.log(`model ${model}, ${toRun.length} calls, ${SPACING_MS / 1000} s apart, into ${out}`);

/** Makes one call and records it; returns the status, or undefined if no answer came. */
async function measure(
  call: Call,
  modelName: string,
  id: string = call.id,
): Promise<number | undefined> {
  captured = undefined;
  const started = Date.now();
  const outcome = await run(provider(GEMINI_BASE_URL, modelName), call);
  const record = captured as Captured | undefined;
  await record?.done.catch(() => undefined);
  const ms = Date.now() - started;
  if (!record) {
    console.log(`${id} ${call.what}: no response (${JSON.stringify(outcome)}, ${ms} ms)`);
    writeFileSync(
      join(out, `${id}.meta.json`),
      `${JSON.stringify({ ...call, id, model: modelName, outcome, ms }, null, 2)}\n`,
    );
    return undefined;
  }
  const bytes = Buffer.concat(record.bytes);
  const isSse = /text\/event-stream/i.test(
    record.headers.find(([name]) => name === 'content-type')?.[1] ?? '',
  );
  const ext = isSse ? 'sse' : 'json';
  writeFileSync(join(out, `${id}.response.${ext}`), bytes);
  const shape = shapeOf(bytes.toString('utf8'), isSse);
  const meta = {
    id,
    what: call.what,
    recordedOn: new Date().toISOString(),
    model: modelName,
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
  writeFileSync(join(out, `${id}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(
    `${id} ${call.what} (${modelName}): ${record.status}, ${bytes.length} B, ${ms} ms; ${JSON.stringify(outcome)}; ${JSON.stringify(shape)}`,
  );
  return record.status;
}

/** Whether the run goes on after this status (ADR-041 section 10). */
function goesOn(status: number | undefined): boolean {
  if (status === 429) {
    console.log('429: the run stops here (no retries)');
    return false;
  }
  if (status !== undefined && status !== 200 && status !== 400) {
    console.log(`status ${status}: the run stops here`);
    return false;
  }
  return true;
}

let liveModel = model;
let calls = 0;
for (const call of toRun) {
  if (calls > 0) await sleep(SPACING_MS);
  let status = await measure(call, liveModel);
  calls++;
  // The pre-registered two-form probe: on a 404 for the bare name, exactly
  // one call with the prefixed name. Not a retry (ADR-041 section 10).
  if (call.id === 's1' && status === 404 && !liveModel.startsWith('models/')) {
    console.log('s1: 404 for the bare name; the pre-registered prefixed probe follows');
    await sleep(SPACING_MS);
    liveModel = `models/${model}`;
    status = await measure(call, liveModel, 's1-prefixed');
    calls++;
    if (status !== 200) {
      console.log('both forms of the model name failed: the run stops here');
      break;
    }
  }
  if (!goesOn(status)) break;
}
console.log(`${calls} chat calls made`);
globalThis.fetch = realFetch;

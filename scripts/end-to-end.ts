// The end-to-end calls of ADR-041 section 17 (decision H): two requests
// through the whole gateway (names, detection, redaction, the provider,
// restoration) with Gemini as the configured provider. E1 with names off,
// then E2 with names on, 15 s apart, nothing retried. The command is
// scripts/run-end-to-end.ts; this module holds what the registration fixes
// and the run itself, so that both are under test.
//
// The registration was written before this file and governs it (section 17
// item 1: "the script implements what is registered here and cannot shape
// it"). The request texts, the planted values and the predicted outgoing
// texts below are typed from it, never derived from the code under test,
// and a test compares them with the committed text of section 17.
//
// What the run does, per call:
//  - posts the registered client request to a gateway built with main.ts's
//    wiring (loadEnv, serverConfig, chatProvider, nameFinder), listening on
//    127.0.0.1, over HTTP, as a client would;
//  - wraps `fetch`, the last point in this process before the bytes leave
//    over TLS, and keeps every provider request's body exactly as passed;
//  - refuses before sending (nothing leaves) if the body holds a planted
//    value in any form, if a log line written so far does, if the body is
//    not the registered one (the dry-run gate, checked again on the live
//    run itself), or if the request goes anywhere but the provider's base
//    URL;
//  - checks every log line again once the call is over: a line written
//    after the provider answered cannot be checked before sending, so a
//    planted value there stops the run instead;
//  - records the client request, the gateway's status and body as the
//    client received them, the outgoing body, the provider's status,
//    response bytes and timings, and the gateway's log lines.
//
// The log lines are checked as the gateway wrote them, then written with
// this machine's name (Pino adds it to every line as `hostname`) replaced by
// HOSTNAME_TOKEN, since the live run's recordings are committed to a public
// repository (ADR-041 section 17, amendment 2026-10-15, ruling 1). Each
// call's meta.json says so, with the count.
//
// The answers the client receives hold the restored synthetic values; they
// are written to files, never printed.

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { loadEnv, type Env } from '../src/config/env.js';
import {
  baseUrlWarning,
  chatProvider,
  modelNameWarning,
  nameFinder,
  serverConfig,
} from '../src/config/wiring.js';
import type { LogStream } from '../src/gateway/logging.js';
import { buildServer, type NameFinder } from '../src/gateway/server.js';

// --- the registration (ADR-041 section 17 item 2) -------------------------

export const MODEL = 'gemini-3.5-flash-lite';
export const SYSTEM = 'Be brief.';
export const E1_USER =
  'Please check my refund. My card 4111 1111 1111 1111 was charged twice, the receipt went to ' +
  'billing.desk@example.com, I last logged in from 203.0.113.42, and the refund should go to ' +
  'IFSC HDFC0001234. In one sentence, repeat these four details back to me exactly as I gave them.';
export const E2_USER = `My name is Meera Iyer. ${E1_USER}`;
/** E1's user message as the registration predicts it is sent to Google. */
export const E1_SENT =
  'Please check my refund. My card [CARD_1] was charged twice, the receipt went to [EMAIL_1], ' +
  'I last logged in from [IP_1], and the refund should go to IFSC [IFSC_1]. In one sentence, ' +
  'repeat these four details back to me exactly as I gave them.';
export const E2_SENT = `My name is [PERSON_1]. ${E1_SENT}`;
/** E1, then E2, this long after E1's answer (section 17 item 7). */
export const SPACING_MS = 15_000;

export interface Planted {
  readonly label: string;
  readonly value: string;
}

const CARD: Planted = { label: 'card', value: '4111 1111 1111 1111' };
const EMAIL: Planted = { label: 'email', value: 'billing.desk@example.com' };
const IP: Planted = { label: 'IP address', value: '203.0.113.42' };
const IFSC: Planted = { label: 'IFSC', value: 'HDFC0001234' };
const NAME: Planted = { label: 'name', value: 'Meera Iyer' };

export interface Call {
  readonly id: 'e1' | 'e2';
  readonly names: boolean;
  /** The user message the client sends. */
  readonly user: string;
  /** The user message the registration predicts goes to the provider. */
  readonly sent: string;
  readonly planted: readonly Planted[];
}

export const CALLS: readonly Call[] = [
  { id: 'e1', names: false, user: E1_USER, sent: E1_SENT, planted: [CARD, EMAIL, IP, IFSC] },
  { id: 'e2', names: true, user: E2_USER, sent: E2_SENT, planted: [CARD, EMAIL, IP, IFSC, NAME] },
];

/** The client's request: the model, the two messages, nothing else (`stream` not set). */
export const clientBody = (call: Call): string =>
  JSON.stringify({
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: call.user },
    ],
  });

// --- the planted-value check ----------------------------------------------

export interface Form {
  readonly label: string;
  readonly text: string;
}

/**
 * Every form a planted value is looked for in: as written, and, for a value
 * with digits and anything else, its digits with nothing between them (the
 * card's 16 digits; also the IP address's and the IFSC's digits, which only
 * makes the check stricter). Lower-cased copies are found by plantedIn(),
 * which compares lower-cased text.
 *
 * Every form must read the same inside a JSON string, or a search of a JSON
 * body or log line could miss it: thrown otherwise.
 */
export function plantedForms(planted: readonly Planted[]): Form[] {
  const forms: Form[] = [];
  for (const { label, value } of planted) {
    forms.push({ label: `${label} as written`, text: value });
    const digits = value.replace(/[^0-9]/g, '');
    if (digits !== '' && digits !== value) {
      forms.push({ label: `${label}'s digits without separators`, text: digits });
    }
  }
  for (const form of forms) {
    if (JSON.stringify(form.text) !== `"${form.text}"`) {
      throw new Error(`${form.label} is escaped in JSON, so it cannot be searched for`);
    }
  }
  return forms;
}

/** The labels of the forms in `text`, compared lower-cased on both sides. Never the values. */
export function plantedIn(text: string, forms: readonly Form[]): string[] {
  const lower = text.toLowerCase();
  return forms.filter((form) => lower.includes(form.text.toLowerCase())).map((form) => form.label);
}

// --- the dry-run gate: the outgoing body against the registration ----------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Where two different texts first differ, with the text around it. */
export function textDifference(sent: string, registered: string): string {
  let at = 0;
  while (at < sent.length && at < registered.length && sent[at] === registered[at]) at++;
  const around = (text: string): string =>
    JSON.stringify(text.slice(Math.max(0, at - 20), at + 40));
  return (
    `differs from character ${at} (sent ${sent.length} characters, registered ` +
    `${registered.length}): sent ${around(sent)}, registered ${around(registered)}`
  );
}

/**
 * How an outgoing provider body differs from what the registration fixes
 * for `call`, or undefined if it does not: the model, then the two messages,
 * role and content, character for character. Other fields (the adapter's own
 * `stream: false`) are not registered and not compared; they are recorded.
 */
export function outgoingDifference(body: string, call: Call): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return 'the outgoing body is not JSON';
  }
  if (!isRecord(json)) return 'the outgoing body is not a JSON object';
  if (json.model !== MODEL) {
    return `the outgoing model is ${JSON.stringify(json.model)}, registered ${JSON.stringify(MODEL)}`;
  }
  const messages = json.messages;
  if (!Array.isArray(messages)) return 'the outgoing body has no messages array';
  if (messages.length !== 2)
    return `the outgoing body has ${messages.length} messages, registered 2`;
  const registered = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: call.sent },
  ];
  for (const [i, want] of registered.entries()) {
    const got: unknown = messages[i];
    const which = `message ${i + 1} (${want.role})`;
    if (!isRecord(got)) return `${which} is not an object`;
    const fields = Object.keys(got).sort().join(', ');
    if (fields !== 'content, role')
      return `${which} has the fields ${fields}, registered content, role`;
    if (got.role !== want.role) return `${which} has the role ${JSON.stringify(got.role)}`;
    if (typeof got.content !== 'string') return `${which} has content that is not text`;
    if (got.content !== want.content)
      return `${which} ${textDifference(got.content, want.content)}`;
  }
  return undefined;
}

// --- the transport: check, refuse or send, keep the bytes --------------------

/** One request the gateway made to the provider, or tried to. */
export interface Exchange {
  readonly url: string;
  /** The body exactly as passed to fetch ('' if it was not text). */
  readonly body: string;
  /** Why it was not sent; empty when it was. */
  readonly refused: readonly string[];
  readonly startedAt: string;
  status: number | undefined;
  headers: [string, string][];
  headersMs: number | undefined;
  firstByteMs: number | undefined;
  totalMs: number | undefined;
  readonly bytes: Uint8Array[];
  /** Set if fetch itself failed: the error's name and code, never its message. */
  failure: string | undefined;
  done: Promise<void>;
}

interface CallState {
  readonly call: Call;
  readonly forms: readonly Form[];
  readonly logs: string[];
  readonly exchanges: Exchange[];
}

/** What the transport needs to know: the call in progress, and where strays go. */
interface Recorder {
  current: CallState | undefined;
  readonly stray: Exchange[];
}

const urlOf = (input: string | URL | Request): string =>
  input instanceof Request ? input.url : String(input);

const failureOf = (error: unknown): string => {
  const name = error instanceof Error ? error.name : typeof error;
  const cause =
    error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  return typeof cause?.code === 'string' ? `${name} (${cause.code})` : name;
};

/**
 * A `fetch` that checks every request before anything leaves (see the
 * header) and, when one passes, sends it with `realFetch` and keeps the
 * response's bytes alongside the copy it hands back.
 */
export function checkingFetch(
  realFetch: typeof fetch,
  providerBase: string,
  recorder: Recorder,
): typeof fetch {
  return async (input, init) => {
    const url = urlOf(input);
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const state = recorder.current;
    const refused: string[] = [];
    if (state === undefined) refused.push('a request made outside a call');
    if (!url.startsWith(providerBase)) {
      refused.push("a request to an address other than the provider's base URL");
    }
    if (body === undefined) refused.push('a body that is not text, so it cannot be checked');
    if (state !== undefined) {
      if (body !== undefined) {
        for (const label of plantedIn(body, state.forms)) {
          refused.push(`a planted value in the outgoing body: ${label}`);
        }
        const difference = outgoingDifference(body, state.call);
        if (difference !== undefined) refused.push(`not the registered request: ${difference}`);
      }
      for (const label of plantedIn(state.logs.join(''), state.forms)) {
        refused.push(`a planted value in a log line before sending: ${label}`);
      }
    }
    const exchange: Exchange = {
      url,
      body: body ?? '',
      refused,
      startedAt: new Date().toISOString(),
      status: undefined,
      headers: [],
      headersMs: undefined,
      firstByteMs: undefined,
      totalMs: undefined,
      bytes: [],
      failure: undefined,
      done: Promise.resolve(),
    };
    (state?.exchanges ?? recorder.stray).push(exchange);
    if (refused.length > 0) throw new Error('refused before sending');

    const started = performance.now();
    let response: Response;
    try {
      response = await realFetch(input, init);
    } catch (error) {
      exchange.failure = failureOf(error);
      exchange.totalMs = performance.now() - started;
      throw error;
    }
    exchange.status = response.status;
    exchange.headers = [...response.headers].filter(([name]) => name !== 'set-cookie');
    exchange.headersMs = performance.now() - started;
    if (!response.body) {
      exchange.totalMs = exchange.headersMs;
      return response;
    }
    const [forGateway, forFile] = response.body.tee();
    exchange.done = (async () => {
      try {
        for await (const chunk of forFile) {
          exchange.firstByteMs ??= performance.now() - started;
          exchange.bytes.push(chunk as Uint8Array);
        }
      } catch (error) {
        exchange.failure = failureOf(error);
      } finally {
        exchange.totalMs = performance.now() - started;
      }
    })();
    return new Response(forGateway, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

// --- the gateway, wired as main.ts wires it -------------------------------

export interface Gateway {
  /** Its address, `http://127.0.0.1:<port>`. */
  readonly url: string;
  close(): Promise<void>;
}

/** Starts the gateway one call is made to, writing its log lines to `log`. */
export type StartGateway = (call: Call, log: LogStream) => Promise<Gateway>;

/**
 * The environment for one call (section 17 item 3): the provider, the model
 * and the names switch set here, never read from .env; the key passed in
 * (only it comes from .env); the base URL only for the dry run's stub.
 */
export function gatewayEnv(call: Call, key: string, baseUrl?: string): Env {
  return loadEnv({
    PSEUDONYM_PROVIDER: 'gemini',
    PSEUDONYM_MODEL: MODEL,
    PSEUDONYM_NAMES: call.names ? 'true' : 'false',
    PSEUDONYM_PROVIDER_API_KEY: key,
    ...(baseUrl === undefined ? {} : { PSEUDONYM_PROVIDER_BASE_URL: baseUrl }),
  });
}

/**
 * Builds each call's gateway as main.ts does: loadEnv, the two start-up
 * warnings, nameFinder (which calls `startNames` only with names on),
 * serverConfig, chatProvider; then listens on 127.0.0.1. The start-up guard
 * (hardening) is not part of what is tested (section 17 item 3). The only
 * addition is `logStream`, so the log lines can be kept.
 */
export function gatewayStarter(
  key: string,
  baseUrl: string | undefined,
  startNames: (env: Env) => Promise<NameFinder>,
  say: (line: string) => void,
): StartGateway {
  return async (call, log) => {
    const env = gatewayEnv(call, key, baseUrl);
    for (const warning of [modelNameWarning(env), baseUrlWarning(env)]) {
      if (warning !== undefined) say(`${call.id} gateway, provider warning: ${warning}`);
    }
    const names = await nameFinder(env, () => startNames(env));
    const app = buildServer(
      { ...serverConfig(env), ...(names === undefined ? {} : { names }), logStream: log },
      chatProvider(env),
    );
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, close: () => app.close() };
  };
}

// --- the dry run's provider --------------------------------------------------

export interface StubProvider {
  /** The base URL to configure: `http://127.0.0.1:<port>/v1beta/openai/`, Gemini's path. */
  readonly baseUrl: string;
  /** The bodies it received, in order. */
  readonly received: string[];
  close(): Promise<void>;
}

const userText = (body: string): string => {
  try {
    const json = JSON.parse(body) as { messages?: { role?: unknown; content?: unknown }[] };
    const user = json.messages?.findLast((message) => message.role === 'user');
    return typeof user?.content === 'string' ? user.content : '';
  } catch {
    return '';
  }
};

/**
 * A provider on 127.0.0.1 for the dry run (section 17 item 3), answering in
 * the shape Gemini's recorded non-streamed answers have: it echoes the user
 * message it received as the answer, with an `extra_content` thought
 * signature, so the dry run also exercises restoration and the dropped
 * extra-content line. `status` answers every request with that status
 * instead (tests).
 */
export async function startStubProvider(status = 200): Promise<StubProvider> {
  const received: string[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      received.push(body);
      response.writeHead(status, { 'content-type': 'application/json' });
      if (status !== 200) {
        response.end(JSON.stringify([{ error: { code: status, status: 'STUB' } }]));
        return;
      }
      response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              index: 0,
              message: {
                content: userText(body),
                extra_content: { google: { thought_signature: 'c3R1Yi1zaWduYXR1cmU=' } },
                role: 'assistant',
              },
            },
          ],
          created: 0,
          id: 'stub',
          model: MODEL,
          object: 'chat.completion',
          usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1beta/openai/`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// --- recordings -------------------------------------------------------------

/** Creates `<out>/attempt-N` for the next unused N, with `about` as its attempt.json. */
export function newAttempt(out: string, about: Record<string, unknown>): string {
  mkdirSync(out, { recursive: true });
  const used = readdirSync(out)
    .map((name) => /^attempt-(\d+)$/.exec(name)?.[1])
    .filter((n) => n !== undefined)
    .map(Number);
  const dir = join(out, `attempt-${Math.max(0, ...used) + 1}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'attempt.json'), `${JSON.stringify(about, null, 2)}\n`);
  return dir;
}

/** What a recorded log file shows where the gateway wrote this machine's name. */
export const HOSTNAME_TOKEN = '<this machine>';

/**
 * `logs` with every occurrence of `host` (in any case) replaced by
 * HOSTNAME_TOKEN, and how many there were. For writing only: the checks read
 * the lines as written. An empty name replaces nothing.
 */
export function withoutHostname(logs: string, host: string): { text: string; replaced: number } {
  if (host === '') return { text: logs, replaced: 0 };
  let replaced = 0;
  const pattern = new RegExp(host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const text = logs.replace(pattern, () => {
    replaced++;
    return HOSTNAME_TOKEN;
  });
  return { text, replaced };
}

/** What a meta.json says about its log file (ruling 1 of the 2026-10-15 amendment). */
const logFileNote = (replaced: number) => ({
  checked: 'the lines as the gateway wrote them',
  written: `this machine's name replaced by ${HOSTNAME_TOKEN}`,
  replaced,
});

/**
 * A timing as meta.json records it: whole milliseconds. Unrounded, a
 * duration from performance.now() has up to 17 digits across its decimal
 * point, and the repository's hygiene scan reads such a run as a number:
 * Attempt 8's `e2.meta.json` held one that was a valid card number by the
 * card detector's own rules (bug-log 76). A duration of at most 10^12 - 1
 * ms rounds to at most 12 digits, fewer than the shortest card.
 */
export const wholeMs = (ms: number | undefined): number | undefined =>
  ms === undefined ? undefined : Math.round(ms);

// --- the run ----------------------------------------------------------------

export interface CallOutcome {
  readonly id: Call['id'];
  /** The gateway's status to the client; undefined if no answer came. */
  readonly clientStatus: number | undefined;
  /** The provider's status; undefined if nothing was sent or nothing came back. */
  readonly providerStatus: number | undefined;
  /** How many provider requests left this process. */
  readonly sent: number;
  /** Why a provider request was refused before sending; empty if none was. */
  readonly refused: readonly string[];
  /** The outgoing body, as passed to fetch, of the call's first provider request. */
  readonly outgoing: string | undefined;
  /** Planted values in the call's log lines, checked once the call was over. */
  readonly plantedInLogs: readonly string[];
}

export interface RunResult {
  readonly outcomes: readonly CallOutcome[];
  /** Why the run stopped early, or undefined if every call ran and none stopped it. */
  readonly stopped: string | undefined;
  /** Provider requests made outside any call (refused). */
  readonly stray: number;
}

export interface RunOptions {
  /** The provider's base URL as the gateway is configured with it. */
  readonly providerBase: string;
  readonly startGateway: StartGateway;
  readonly sleep: (ms: number) => Promise<void>;
  /** Writes one file of the recording. */
  readonly write: (name: string, data: string | Uint8Array) => void;
  readonly say: (line: string) => void;
  readonly calls?: readonly Call[];
  readonly spacingMs?: number;
  /** The name replaced in the written log files; this machine's by default. */
  readonly hostname?: string;
}

const COMPLETED = '"msg":"request completed"';

/** Waits, a turn at a time, for Fastify's "request completed" line; at most `ms`. */
async function settled(logs: readonly string[], ms: number): Promise<boolean> {
  const until = performance.now() + ms;
  while (!logs.some((line) => line.includes(COMPLETED))) {
    if (performance.now() > until) return false;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return true;
}

/** Why the run stops after this call, or undefined if it goes on (section 17 item 7). */
function stopReason(outcome: CallOutcome): string | undefined {
  if (outcome.refused.length > 0) return `${outcome.id}: refused before sending`;
  if (outcome.plantedInLogs.length > 0) return `${outcome.id}: a planted value in a log line`;
  if (outcome.sent > 1) return `${outcome.id}: ${outcome.sent} provider requests, not one`;
  // 429 included: section 17 names it, and it is not 200 or 400.
  const provider = outcome.providerStatus;
  if (provider !== undefined && provider !== 200 && provider !== 400) {
    return `${outcome.id}: the provider answered ${provider}`;
  }
  if (outcome.clientStatus !== 200) {
    return `${outcome.id}: the gateway answered ${outcome.clientStatus ?? 'nothing'}, not 200`;
  }
  return undefined;
}

/**
 * Makes the calls in order, each to its own gateway, all gateways started
 * before the first call (so a name model that does not load costs no call).
 * Stops at the first call that refuses, leaks into a log line, or is not
 * answered 200; nothing is retried. `fetch` is wrapped for the run and put
 * back however it ends.
 */
export async function runCalls(options: RunOptions): Promise<RunResult> {
  const calls = options.calls ?? CALLS;
  const spacingMs = options.spacingMs ?? SPACING_MS;
  const host = options.hostname ?? hostname();
  const realFetch = globalThis.fetch;
  const recorder: Recorder = { current: undefined, stray: [] };
  const setupLogs: string[] = [];
  const sink: LogStream = { write: (line) => (recorder.current?.logs ?? setupLogs).push(line) };
  const gateways: Gateway[] = [];
  const outcomes: CallOutcome[] = [];
  let stopped: string | undefined;
  globalThis.fetch = checkingFetch(realFetch, options.providerBase, recorder);
  try {
    for (const call of calls) gateways.push(await options.startGateway(call, sink));
    for (const [i, call] of calls.entries()) {
      if (i > 0) await options.sleep(spacingMs);
      const state: CallState = {
        call,
        forms: plantedForms(call.planted),
        logs: [],
        exchanges: [],
      };
      recorder.current = state;
      const request = clientBody(call);
      const startedAt = new Date().toISOString();
      const started = performance.now();
      let clientStatus: number | undefined;
      let clientType: string | null = null;
      let clientBytes: Uint8Array | undefined;
      let clientFailure: string | undefined;
      try {
        const response = await realFetch(`${gateways[i]!.url}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: request,
        });
        clientStatus = response.status;
        clientType = response.headers.get('content-type');
        clientBytes = new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        clientFailure = failureOf(error);
      }
      const clientMs = performance.now() - started;
      await Promise.all(state.exchanges.map((exchange) => exchange.done));
      const completedLogged = await settled(state.logs, 1_000);
      recorder.current = undefined;

      const first = state.exchanges[0];
      const refused = state.exchanges.flatMap((exchange) => exchange.refused);
      const sentExchanges = state.exchanges.filter((exchange) => exchange.refused.length === 0);
      const outcome: CallOutcome = {
        id: call.id,
        clientStatus,
        providerStatus: sentExchanges[0]?.status,
        sent: sentExchanges.length,
        refused,
        outgoing: first?.body,
        plantedInLogs: plantedIn(state.logs.join(''), state.forms),
      };
      outcomes.push(outcome);

      options.write(`${call.id}.request.json`, request);
      if (clientBytes !== undefined) options.write(`${call.id}.response.json`, clientBytes);
      for (const [n, exchange] of state.exchanges.entries()) {
        const suffix = n === 0 ? '' : `-${n + 1}`;
        const kind = exchange.refused.length > 0 ? 'refused' : 'sent';
        options.write(`${call.id}${suffix}.${kind}.json`, exchange.body);
        if (exchange.refused.length === 0) {
          options.write(
            `${call.id}${suffix}.provider-response.json`,
            Buffer.concat(exchange.bytes),
          );
        }
      }
      const written = withoutHostname(state.logs.join(''), host);
      options.write(`${call.id}.log.txt`, written.text);
      const meta = {
        id: call.id,
        names: call.names,
        recordedOn: new Date().toISOString(),
        client: {
          startedAt,
          status: clientStatus,
          contentType: clientType,
          ms: wholeMs(clientMs),
        },
        ...(clientFailure === undefined ? {} : { clientFailure }),
        provider: state.exchanges.map((exchange) => ({
          url: exchange.url,
          startedAt: exchange.startedAt,
          refused: exchange.refused,
          status: exchange.status,
          headers: Object.fromEntries(exchange.headers),
          headersMs: wholeMs(exchange.headersMs),
          firstByteMs: wholeMs(exchange.firstByteMs),
          totalMs: wholeMs(exchange.totalMs),
          bytes: exchange.bytes.reduce((n, chunk) => n + chunk.length, 0),
          failure: exchange.failure,
        })),
        outgoingIsRegistered:
          first === undefined ? null : outgoingDifference(first.body, call) === undefined,
        plantedInLogs: outcome.plantedInLogs,
        completedLogged,
        logFile: logFileNote(written.replaced),
      };
      options.write(`${call.id}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);

      stopped = stopReason(outcome);
      if (stopped !== undefined) break;
    }
  } finally {
    globalThis.fetch = realFetch;
    recorder.current = undefined;
    for (const gateway of gateways) await gateway.close();
    const written = withoutHostname(setupLogs.join(''), host);
    options.write('setup.log.txt', written.text);
    options.write(
      'setup.meta.json',
      `${JSON.stringify({ logFile: logFileNote(written.replaced) }, null, 2)}\n`,
    );
  }
  const setupPlanted = plantedIn(setupLogs.join(''), plantedForms(calls.flatMap((c) => c.planted)));
  if (stopped === undefined && setupPlanted.length > 0)
    stopped = 'a planted value in a start-up log line';
  if (stopped === undefined && recorder.stray.length > 0)
    stopped = 'a provider request outside a call';
  return { outcomes, stopped, stray: recorder.stray.length };
}

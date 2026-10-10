// The 12 answers Gemini really sent (ADR-041 sections 10 to 13,
// test/fixtures/gemini-7b, attempts 4 and 5), replayed byte for byte through
// the real adapter and the real gateway. ADR-041 section 15, decision 3
// (3a + 3c): `extra_content` (in every recording exactly
// `{google: {thought_signature}}`) is dropped on purpose, reaches neither the
// client nor a log line, and is recorded only as a count and the signature's
// length.
//
// The signatures are read from the recordings only to check that they are
// absent, and only through boolean checks, so a failing assertion never
// prints one: they are opaque provider data with no reason to be emitted.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpenAICompatibleProvider } from '../../src/providers/openai-compatible.js';
import type { ProviderChatRequest, ProviderStreamEvent } from '../../src/providers/provider.js';
import type { RedactedText } from '../../src/redaction/redact.js';
import { startMockProvider, type MockProvider, type Responder } from '../support/mock-provider.js';
import {
  post,
  readStreamed,
  startTestGateway,
  TEST_MODEL,
  type TestGateway,
} from '../support/gateway.js';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'gemini-7b');

interface Recording {
  readonly id: string;
  readonly streamed: boolean;
  readonly body: string;
  readonly contentType: string;
  /** Every thought_signature in the answer; only ever tested for absence. */
  readonly signatures: readonly string[];
}

function load(attempt: string, id: string): Recording {
  const meta = JSON.parse(readFileSync(join(DIR, attempt, `${id}.meta.json`), 'utf8')) as {
    responseHeaders: Record<string, string>;
  };
  const streamed = meta.responseHeaders['content-type']!.startsWith('text/event-stream');
  const body = readFileSync(
    join(DIR, attempt, `${id}.response.${streamed ? 'sse' : 'json'}`),
    'utf8',
  );
  type Extra = { google?: { thought_signature?: string } } | undefined;
  const signatureOf = (extra: Extra): string[] =>
    typeof extra?.google?.thought_signature === 'string' ? [extra.google.thought_signature] : [];
  const signatures = streamed
    ? body
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data: {'))
        .flatMap((line) => {
          const chunk = JSON.parse(line.slice(6)) as {
            choices: { delta?: { extra_content?: Extra } }[];
          };
          return signatureOf(chunk.choices[0]?.delta?.extra_content);
        })
    : signatureOf(
        (JSON.parse(body) as { choices: { message: { extra_content?: Extra } }[] }).choices[0]!
          .message.extra_content,
      );
  return {
    id: `${attempt}/${id}`,
    streamed,
    body,
    contentType: meta.responseHeaders['content-type']!,
    signatures,
  };
}

const NON_STREAMED: readonly Recording[] = [
  load('attempt-4', 's1'),
  ...['p01', 'p02', 'p06', 'p07', 'p08', 'p10', 'p11', 'p12', 'p13'].map((p) =>
    load('attempt-5', p),
  ),
];
const S2 = load('attempt-4', 's2');
const S3 = load('attempt-4', 's3');
/** The usage on s3's last two chunks (its four totals: 31, 48, 50, 50). */
const S3_LAST_USAGE = { prompt_tokens: 29, completion_tokens: 21, total_tokens: 50 };

/** True if any 16-character stretch of any signature appears in `text`. */
function holdsSignature(text: string, signatures: readonly string[]): boolean {
  for (const signature of signatures) {
    for (let i = 0; i + 16 <= signature.length; i++) {
      if (text.includes(signature.slice(i, i + 16))) return true;
    }
  }
  return false;
}

/**
 * A count as it may be printed: numbers stay, anything else becomes its type
 * name. Every count assertion compares this form, so a fault that put the
 * signature where its length goes fails without printing the signature.
 */
function printable(value: unknown): unknown {
  const number = (n: unknown): unknown => (typeof n === 'number' ? n : `<${typeof n}>`);
  if (typeof value !== 'object' || value === null) return `<${typeof value}>`;
  const { extraContent, thoughtSignatureLengths } = value as Record<string, unknown>;
  return {
    extraContent: number(extraContent),
    thoughtSignatureLengths: Array.isArray(thoughtSignatureLengths)
      ? thoughtSignatureLengths.map(number)
      : `<${typeof thoughtSignatureLengths}>`,
  };
}

/** Answers with the recording's bytes and content type, as Gemini did. */
const serve =
  (recording: Recording): Responder =>
  (_req, res) => {
    res.writeHead(200, { 'content-type': recording.contentType });
    res.end(recording.body);
  };

const EMAIL = 'asha.rao@example.com';
/** s3's answer with this request's mapping: [EMAIL_1] restored; [CARD_1] is not in it. */
const S3_RESTORED = `The refund for card [CARD_1] has been successfully processed and sent to ${EMAIL}.`;
const DROPPED_MESSAGE = 'provider extra content dropped';

describe('the recordings are the 12 answers measured', () => {
  it('10 not streamed, 2 streamed, each with exactly one thought signature', () => {
    expect([NON_STREAMED.length, [S2, S3].filter((r) => r.streamed).length]).toEqual([10, 2]);
    expect(NON_STREAMED.every((r) => !r.streamed)).toBe(true);
    for (const r of [...NON_STREAMED, S2, S3])
      expect([r.id, r.signatures.length]).toEqual([r.id, 1]);
    expect(
      [...NON_STREAMED, S2, S3].map((r) => r.signatures[0]!.length).sort((a, b) => a - b),
    ).toEqual([132, 132, 132, 132, 132, 132, 132, 132, 132, 132, 952, 1004]);
  });
});

describe('the adapter, replaying each recording', () => {
  let mock: MockProvider;
  afterEach(async () => {
    await mock.close();
  });
  const REQUEST: ProviderChatRequest = {
    messages: [{ role: 'user', content: 'Hello.' as RedactedText }],
    options: {},
  };
  const adapter = () =>
    createOpenAICompatibleProvider(
      {
        baseUrl: mock.baseUrl,
        model: 'm',
        timeoutMs: 5_000,
        maxResponseBytes: 1_048_576,
        maxStreamBytes: 33_554_432,
      },
      { name: 'recordings' },
    );

  it.each(NON_STREAMED.map((r) => [r.id, r] as const))(
    '%s, not streamed: only our own fields, and the drop counted with its length',
    async (_id, recording) => {
      mock = await startMockProvider();
      mock.respondWith(serve(recording));
      const result = await adapter().complete(REQUEST, new AbortController().signal);
      expect(Object.keys(result).sort()).toEqual([
        'content',
        'created',
        'dropped',
        'finishReason',
        'id',
        'usage',
      ]);
      expect(printable(result.dropped)).toEqual({
        extraContent: 1,
        thoughtSignatureLengths: [recording.signatures[0]!.length],
      });
      expect(holdsSignature(JSON.stringify(result), recording.signatures)).toBe(false);
    },
  );

  it('attempt-4/s2, streamed: events carry only content and the finish; the drop counted with its length', async () => {
    mock = await startMockProvider();
    mock.respondWith(serve(S2));
    const stream = await adapter().stream(REQUEST, new AbortController().signal, {
      includeUsage: false,
    });
    const events: ProviderStreamEvent[] = [];
    for await (const event of stream.events) events.push(event);
    expect(events.map((e) => e.type)).toEqual(['content', 'content', 'content', 'finish']);
    expect(
      events.every((e) => Object.keys(e).every((k) => ['type', 'text', 'reason'].includes(k))),
    ).toBe(true);
    expect(holdsSignature(JSON.stringify(events), S2.signatures)).toBe(false);
    expect(printable(stream.dropped?.())).toEqual({
      extraContent: 1,
      thoughtSignatureLengths: [S2.signatures[0]!.length],
    });
  });

  // Usage on every chunk, as running totals (bug-log 75): until the fix this
  // replay failed with bad_response at the first chunk.
  it('attempt-4/s3, streamed with usage: content, the finish, then the last usage once; the drop counted with its length', async () => {
    mock = await startMockProvider();
    mock.respondWith(serve(S3));
    const stream = await adapter().stream(REQUEST, new AbortController().signal, {
      includeUsage: true,
    });
    const events: ProviderStreamEvent[] = [];
    for await (const event of stream.events) events.push(event);
    expect(events.map((e) => e.type)).toEqual(['content', 'content', 'content', 'finish', 'usage']);
    expect(events.at(-1)).toEqual({ type: 'usage', usage: S3_LAST_USAGE });
    expect(stream.usageDecreased?.()).toEqual([]);
    expect(holdsSignature(JSON.stringify(events), S3.signatures)).toBe(false);
    expect(printable(stream.dropped?.())).toEqual({
      extraContent: 1,
      thoughtSignatureLengths: [S3.signatures[0]!.length],
    });
  });
});

describe('the gateway, replaying each recording', () => {
  let gateway: TestGateway | undefined;
  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
  });
  const request = (extra: Record<string, unknown> = {}) => ({
    model: TEST_MODEL,
    messages: [{ role: 'user', content: `Please confirm the refund to ${EMAIL}.` }],
    ...extra,
  });
  /** The count lines, each reduced to its level and printable counts. */
  const droppedLines = (g: TestGateway): unknown[] =>
    g.logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === DROPPED_MESSAGE)
      .map((line) => ({ level: line.level, counts: printable(line) }));
  /** Nothing of the signature or of the request in any log line. */
  const logsClean = (g: TestGateway, signatures: readonly string[]): boolean => {
    const all = g.logs.join('\n');
    return !holdsSignature(all, signatures) && !all.includes(EMAIL) && !all.includes('refund');
  };

  it.each(NON_STREAMED.map((r) => [r.id, r] as const))(
    '%s, not streamed: no extra field reaches the client; one log line with the count and the length',
    async (_id, recording) => {
      gateway = await startTestGateway();
      gateway.provider.respondWith(serve(recording));
      const response = await post(gateway, request());
      expect(response.statusCode).toBe(200);
      const body = response.json() as Record<string, unknown> & {
        choices: { message: Record<string, unknown> }[];
      };
      expect(Object.keys(body).sort()).toEqual([
        'choices',
        'created',
        'id',
        'model',
        'object',
        'usage',
      ]);
      expect(Object.keys(body.choices[0]!.message).sort()).toEqual(['content', 'refusal', 'role']);
      expect(response.body.includes('extra_content')).toBe(false);
      expect(response.body.includes('thought_signature')).toBe(false);
      expect(holdsSignature(response.body, recording.signatures)).toBe(false);
      expect(droppedLines(gateway)).toEqual([
        {
          level: 30,
          counts: { extraContent: 1, thoughtSignatureLengths: [recording.signatures[0]!.length] },
        },
      ]);
      expect(logsClean(gateway, recording.signatures)).toBe(true);
    },
  );

  it('attempt-4/s2, streamed: no extra field in any chunk; one log line with the count and the length', async () => {
    gateway = await startTestGateway();
    gateway.provider.respondWith(serve(S2));
    const response = await post(gateway, request({ stream: true }));
    const streamed = readStreamed(response.body);
    expect(streamed.done).toBe(true);
    expect(
      streamed.chunks.every((c) =>
        c.choices.every((choice) =>
          Object.keys(choice.delta).every((k) => ['role', 'content', 'refusal'].includes(k)),
        ),
      ),
    ).toBe(true);
    expect(response.body.includes('extra_content')).toBe(false);
    expect(response.body.includes('thought_signature')).toBe(false);
    expect(holdsSignature(response.body, S2.signatures)).toBe(false);
    expect(droppedLines(gateway)).toEqual([
      {
        level: 30,
        counts: { extraContent: 1, thoughtSignatureLengths: [S2.signatures[0]!.length] },
      },
    ]);
    expect(logsClean(gateway, S2.signatures)).toBe(true);
  });

  // Gemini sent usage on every chunk although this client did not ask for it.
  // Until the fix (bug-log 75) this replay ended in a provider_bad_response
  // error event, and nothing was counted.
  it('attempt-4/s3, streamed: the answer restored, no usage asked for so none sent; one log line with the count and the length', async () => {
    gateway = await startTestGateway();
    gateway.provider.respondWith(serve(S3));
    const response = await post(gateway, request({ stream: true }));
    const streamed = readStreamed(response.body);
    expect(streamed.done).toBe(true);
    expect(streamed.error).toBeUndefined();
    expect(streamed.content).toBe(S3_RESTORED);
    expect(streamed.chunks.every((c) => !('usage' in c))).toBe(true);
    expect(response.body.includes('extra_content')).toBe(false);
    expect(holdsSignature(response.body, S3.signatures)).toBe(false);
    expect(droppedLines(gateway)).toEqual([
      {
        level: 30,
        counts: { extraContent: 1, thoughtSignatureLengths: [S3.signatures[0]!.length] },
      },
    ]);
    expect(logsClean(gateway, S3.signatures)).toBe(true);
  });

  it('attempt-4/s3, streamed with include_usage: one usage chunk, the last counts, after the finish; no warn line', async () => {
    gateway = await startTestGateway();
    gateway.provider.respondWith(serve(S3));
    const response = await post(
      gateway,
      request({ stream: true, stream_options: { include_usage: true } }),
    );
    const streamed = readStreamed(response.body);
    expect(streamed.done).toBe(true);
    expect(streamed.content).toBe(S3_RESTORED);
    expect(streamed.chunks.at(-1)).toMatchObject({ choices: [], usage: S3_LAST_USAGE });
    expect(streamed.chunks.at(-2)?.choices[0]?.finish_reason).toBe('stop');
    expect(streamed.chunks.slice(0, -1).every((c) => c.usage === null)).toBe(true);
    expect(gateway.logs.some((line) => (JSON.parse(line) as { level: number }).level === 40)).toBe(
      false,
    );
    expect(logsClean(gateway, S3.signatures)).toBe(true);
  });
});

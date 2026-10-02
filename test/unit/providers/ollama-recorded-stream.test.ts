// A real Ollama stream, recorded once (scripts/record-ollama-stream.ts), run
// through everything that reads streams: the SSE parser, the Ollama adapter
// and the gateway. Until this recording, the streaming code had been built
// from Ollama's documentation and source only (ADR-019).

import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { redactRequest } from '../../../src/gateway/redact-request.js';
import { parseChatRequest } from '../../../src/gateway/schema.js';
import { MAX_EVENT_BYTES } from '../../../src/providers/ollama.js';
import { SseParser, type SseEvent } from '../../../src/providers/sse.js';
import { PlaceholderMapping } from '../../../src/redaction/mapping.js';
import { restore } from '../../../src/redaction/restore.js';
import {
  RECORDED_CLIENT_REQUEST,
  RECORDED_STREAM_FILE,
  RECORDED_STREAM_INFO_FILE,
  RECORDED_VALUES,
  type RecordedStreamInfo,
} from '../../fixtures/ollama-stream.js';
import {
  post,
  readStreamed,
  startTestGateway,
  TEST_MODEL,
  type TestGateway,
} from '../../support/gateway.js';
import { assertPropertyQuietly } from '../../support/quiet-property.js';

const BYTES = new Uint8Array(readFileSync(RECORDED_STREAM_FILE));
const INFO = JSON.parse(readFileSync(RECORDED_STREAM_INFO_FILE, 'utf8')) as RecordedStreamInfo;

// What the recording holds, read without the parser: Ollama writes every
// event as one `data: …` line and a blank line, with LF endings.
const TEXT = new TextDecoder('utf-8', { fatal: true }).decode(BYTES);
const DATA = TEXT.slice(0, -2)
  .split('\n\n')
  .map((block) => {
    if (!block.startsWith('data: ') || block.includes('\n')) throw new Error('unexpected event');
    return block.slice('data: '.length);
  });

interface Chunk {
  choices: {
    delta: { role?: string; content?: string; reasoning?: string };
    finish_reason: string | null;
  }[];
  usage?: { completion_tokens: number };
}
const CHUNKS = DATA.slice(0, -1).map((data) => JSON.parse(data) as Chunk);
const deltas = CHUNKS.flatMap((chunk) => chunk.choices.map((choice) => choice.delta));
const MODEL_CONTENT = deltas.map((delta) => delta.content ?? '').join('');
const MODEL_REASONING = deltas.map((delta) => delta.reasoning ?? '').join('');

const parse = (pieces: Uint8Array[]): SseEvent[] => {
  const parser = new SseParser(MAX_EVENT_BYTES);
  return pieces.flatMap((piece) => parser.push(piece));
};
const cut = (at: readonly number[]): Uint8Array[] => {
  const points = [0, ...[...new Set(at)].sort((a, b) => a - b), BYTES.length];
  return points.slice(1).map((end, i) => BYTES.subarray(points[i], end));
};

describe('the recorded Ollama stream', () => {
  it('came from the pipeline as it is today, with no planted value sent', () => {
    const sent = JSON.stringify(INFO.sentToProvider);
    for (const value of RECORDED_VALUES) {
      expect(sent).not.toContain(value);
      expect(sent).not.toContain(value.replace(/ /g, ''));
    }
    const today = redactRequest(
      parseChatRequest(RECORDED_CLIENT_REQUEST),
      new PlaceholderMapping(),
      {
        placeholderInstruction: true,
      },
    );
    expect((INFO.sentToProvider as { messages: unknown }).messages).toEqual(today.messages);
  });

  it('has the shape the adapter was built for from Ollama’s source (ADR-019)', () => {
    // A thinking model: reasoning-only chunks carry `"content":""`, the
    // first one also the role; answer chunks carry content only; the
    // finish chunk has an empty delta.
    const reasoningOnly = deltas.filter((delta) => delta.reasoning !== undefined);
    expect(reasoningOnly.length).toBeGreaterThan(0);
    expect(reasoningOnly.every((delta) => delta.content === '')).toBe(true);
    expect(deltas[0]).toMatchObject({ role: 'assistant', content: '' });
    expect(deltas.filter((delta) => delta.role !== undefined)).toHaveLength(1);
    const answer = deltas.filter((delta) => delta.content);
    expect(answer.every((delta) => delta.reasoning === undefined)).toBe(true);
    expect(deltas.at(-1)).toEqual({});
    expect(MODEL_CONTENT).toContain('[CARD_1]');
    expect(MODEL_CONTENT).toContain('[EMAIL_1]');
  });

  it('ends with [DONE] after one finish chunk and one usage chunk', () => {
    expect(DATA.at(-1)).toBe('[DONE]');
    const finishes = CHUNKS.filter((chunk) => chunk.choices[0]?.finish_reason);
    expect(finishes).toHaveLength(1);
    const usage = CHUNKS.at(-1)!;
    expect(usage.choices).toEqual([]);
    expect(usage.usage?.completion_tokens).toBeGreaterThan(0);
  });

  it('is parsed whole into exactly the events Ollama wrote', () => {
    expect(parse([BYTES]).map((event) => event.data)).toEqual(DATA);
  });

  it('is parsed the same one byte at a time', () => {
    const pieces = Array.from({ length: BYTES.length }, (_, i) => BYTES.subarray(i, i + 1));
    expect(parse(pieces).map((event) => event.data)).toEqual(DATA);
  });

  it('is parsed the same however the bytes are cut', () => {
    assertPropertyQuietly(
      fc.property(
        fc.array(fc.integer({ min: 1, max: BYTES.length - 1 }), { maxLength: 60 }),
        (at) => {
          const events = parse(cut(at)).map((event) => event.data);
          return events.length === DATA.length && events.every((data, i) => data === DATA[i]);
        },
      ),
      // Each run parses the whole 516 KB recording: 20 runs take 0.4 s alone
      // under coverage; 200 took 31.9 s in a full coverage run (bug-log 45).
      // Every single cut is covered by the byte-at-a-time test above.
      { numRuns: 20 },
    );
  });
});

describe('the recorded Ollama stream through the gateway', () => {
  let gateway: TestGateway | undefined;
  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
  });

  it('streams back the restored answer, without the reasoning', async () => {
    gateway = await startTestGateway({ placeholderInstruction: true });
    gateway.provider.respondWith((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      // Uneven pieces, so events and characters are cut on the way.
      for (let i = 0, size = 1; i < BYTES.length; i += size, size = (size * 7) % 997) {
        response.write(BYTES.subarray(i, i + size));
      }
      response.end();
    });
    const response = await post(gateway, { ...RECORDED_CLIENT_REQUEST, model: TEST_MODEL });

    const sent = JSON.parse(gateway.provider.requests[0]!.body) as { messages: unknown };
    expect(sent.messages).toEqual((INFO.sentToProvider as { messages: unknown }).messages);

    const mapping = new PlaceholderMapping();
    redactRequest(parseChatRequest(RECORDED_CLIENT_REQUEST), mapping, {
      placeholderInstruction: true,
    });
    const answer = readStreamed(response.body);
    expect(answer.error).toBeUndefined();
    expect(answer.done).toBe(true);
    expect(answer.content).toBe(restore(MODEL_CONTENT, mapping));
    expect(answer.chunks.at(-2)?.choices[0]?.finish_reason).toBe(
      CHUNKS.find((chunk) => chunk.choices[0]?.finish_reason)!.choices[0]!.finish_reason,
    );
    if (MODEL_REASONING !== '') expect(answer.content).not.toContain(MODEL_REASONING);
  });
});

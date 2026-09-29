// sseEvents (ADR-019): a provider stream in, OpenAI's chunk events out,
// restored as they go. The exact shapes, include_usage, and what a
// failure after the start looks like: held-back text restored and sent,
// then one error event, and no [DONE].
//
// Values are opaque strings («card-1»), not personal data, so plain
// `expect` is safe here.

import { describe, expect, it } from 'vitest';
import { GatewayError } from '../../../src/gateway/errors.js';
import { sseEvents } from '../../../src/gateway/stream.js';
import {
  ProviderError,
  type ProviderStream,
  type ProviderStreamEvent,
} from '../../../src/providers/provider.js';
import { PlaceholderMapping } from '../../../src/redaction/mapping.js';
import { StreamRestorer } from '../../../src/redaction/restore.js';
import { readStreamed } from '../../support/gateway.js';

const USAGE = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };

function mapping(): PlaceholderMapping {
  const m = new PlaceholderMapping();
  m.getOrAssign('CARD', 'card', '«card-1»');
  m.getOrAssign('EMAIL', 'email', '«email-1»');
  return m;
}

/** A provider stream yielding `events`, then throwing `failWith` if given. */
function providerStream(events: ProviderStreamEvent[], failWith?: unknown): ProviderStream {
  return {
    id: 'chatcmpl-x',
    created: 1_790_000_200,
    events: (async function* () {
      yield* events;
      if (failWith !== undefined) throw failWith;
    })(),
  };
}

const content = (text: string): ProviderStreamEvent => ({ type: 'content', text });
const FINISH: ProviderStreamEvent = { type: 'finish', reason: 'stop' };

async function run(
  stream: ProviderStream,
  options: { includeUsage?: boolean; restoreInUnsafeRegions?: boolean } = {},
): Promise<{ body: string; errors: unknown[] }> {
  const errors: unknown[] = [];
  let body = '';
  for await (const event of sseEvents(stream, {
    model: 'our-model',
    includeUsage: options.includeUsage ?? false,
    restorer: new StreamRestorer(mapping(), {
      restoreInUnsafeRegions: options.restoreInUnsafeRegions ?? false,
    }),
    onError: (error) => {
      errors.push(error);
      return new GatewayError(502, 'provider_bad_response', 'fixed message');
    },
  })) {
    body += event;
  }
  return { body, errors };
}

describe('sseEvents: a successful stream', () => {
  it('sends the role chunk, the content, the finish chunk and [DONE], in our model name', async () => {
    const { body } = await run(providerStream([content('Hello '), content('world'), FINISH]));
    const base = { id: 'chatcmpl-x', object: 'chat.completion.chunk', created: 1_790_000_200 };
    expect(readStreamed(body).events).toEqual([
      {
        ...base,
        model: 'our-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      },
      {
        ...base,
        model: 'our-model',
        choices: [{ index: 0, delta: { content: 'Hello ' }, finish_reason: null }],
      },
      {
        ...base,
        model: 'our-model',
        choices: [{ index: 0, delta: { content: 'world' }, finish_reason: null }],
      },
      { ...base, model: 'our-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ]);
  });

  it('restores a placeholder split across pieces, and sends nothing for a piece that decides nothing', async () => {
    const { body } = await run(
      providerStream([content('Card '), content('[CA'), content('RD_1]'), content(' ok'), FINISH]),
    );
    const streamed = readStreamed(body);
    expect(streamed.content).toBe('Card «card-1» ok');
    // "[CA" decides nothing and "RD_1]" waits for the next character (the
    // host rule), so neither sends a chunk of its own.
    expect(streamed.chunks.map((c) => c.choices[0]?.delta.content)).toEqual([
      '',
      'Card ',
      '«card-1» ok',
      undefined,
    ]);
  });

  it('sends the held-back text at the finish, restored', async () => {
    const { body } = await run(providerStream([content('Sent to [EMAIL_1]'), FINISH]));
    const streamed = readStreamed(body);
    expect(streamed.chunks.map((c) => c.choices[0]?.delta.content)).toEqual([
      '',
      'Sent to ',
      '«email-1»',
      undefined,
    ]);
    expect(streamed.done).toBe(true);
  });

  it('keeps restoration safety: a placeholder in a markdown image URL stays a placeholder', async () => {
    const pieces = ['![x](https://a.example/?d=', '[CARD_1]', ') and [CARD_1].'];
    const safe = await run(providerStream([...pieces.map(content), FINISH]));
    expect(readStreamed(safe.body).content).toBe(
      '![x](https://a.example/?d=[CARD_1]) and «card-1».',
    );
    const unsafe = await run(providerStream([...pieces.map(content), FINISH]), {
      restoreInUnsafeRegions: true,
    });
    expect(readStreamed(unsafe.body).content).toBe(
      '![x](https://a.example/?d=«card-1») and «card-1».',
    );
  });

  it('passes the finish reason through', async () => {
    const { body } = await run(
      providerStream([content('a'), { type: 'finish', reason: 'length' }]),
    );
    expect(readStreamed(body).chunks.at(-1)!.choices[0]!.finish_reason).toBe('length');
  });
});

describe('sseEvents: include_usage', () => {
  it('every chunk has usage: null, and a last chunk with no choices carries the usage', async () => {
    const { body } = await run(
      providerStream([content('a'), FINISH, { type: 'usage', usage: USAGE }]),
      { includeUsage: true },
    );
    const { chunks, done } = readStreamed(body);
    expect(chunks.slice(0, -1).every((c) => c.usage === null)).toBe(true);
    expect(chunks.at(-1)).toMatchObject({ choices: [], usage: USAGE });
    expect(done).toBe(true);
  });

  it('without include_usage no chunk has a usage key, and provider usage is dropped', async () => {
    const { body } = await run(
      providerStream([content('a'), FINISH, { type: 'usage', usage: USAGE }]),
    );
    const { chunks } = readStreamed(body);
    expect(chunks.some((c) => 'usage' in c)).toBe(false);
    expect(chunks.every((c) => c.choices.length === 1)).toBe(true);
  });
});

describe('sseEvents: a failure after the start', () => {
  it('restores and sends the held-back text, then one error event, and no [DONE]', async () => {
    const failure = new ProviderError('unavailable');
    const { body, errors } = await run(providerStream([content('Refund to [CARD_1]')], failure));
    const streamed = readStreamed(body);
    expect(streamed.chunks.map((c) => c.choices[0]?.delta.content)).toEqual([
      '',
      'Refund to ',
      '«card-1»',
    ]);
    expect(streamed.events.at(-1)).toEqual({
      error: {
        message: 'fixed message',
        type: 'api_error',
        param: null,
        code: 'provider_bad_response',
      },
    });
    expect(streamed.done).toBe(false);
    expect(errors).toEqual([failure]);
  });

  it('an incomplete placeholder held back is sent as it is', async () => {
    const { body } = await run(
      providerStream([content('Card [CARD_')], new ProviderError('timeout')),
    );
    expect(readStreamed(body).content).toBe('Card [CARD_');
  });

  it('nothing held back: no extra content chunk before the error', async () => {
    const { body } = await run(providerStream([content('Done. ')], new ProviderError('timeout')));
    const streamed = readStreamed(body);
    expect(streamed.chunks).toHaveLength(2);
    expect(streamed.error).toBeDefined();
  });

  it('a failure before any content: the role chunk, then the error', async () => {
    const { body } = await run(providerStream([], new ProviderError('timeout')));
    const streamed = readStreamed(body);
    expect(streamed.chunks).toHaveLength(1);
    expect(streamed.events).toHaveLength(2);
    expect(streamed.error).toBeDefined();
  });

  it('a failure after the finish: nothing is flushed twice', async () => {
    const { body } = await run(
      providerStream([content('Sent to [EMAIL_1]'), FINISH], new ProviderError('bad_response')),
    );
    const streamed = readStreamed(body);
    expect(streamed.content).toBe('Sent to «email-1»');
    expect(streamed.chunks.at(-1)!.choices[0]!.finish_reason).toBe('stop');
    expect([streamed.error !== undefined, streamed.done]).toEqual([true, false]);
  });
});

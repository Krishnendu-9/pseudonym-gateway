// Person names end to end (ADR-037), with the fake model standing in for B
// and the real everything else: the name detector as startNameDetection()
// builds it (the real list, F, the join), the real gateway, the real Ollama
// adapter, and a mock provider that records the raw bytes it received.
// Every assertion about what was sent reads those bytes, never an
// intermediate.

import { afterEach, describe, expect, it } from 'vitest';
import {
  NameDetector,
  startNameDetection,
  type NameDetectorOptions,
} from '../../src/gateway/names.js';
import { normalise } from '../../src/detection/normalise.js';
import { createRng, type Rng } from '../../src/synthetic/rng.js';
import { writtenName } from '../../src/synthetic/names.js';
import { WIKIDATA_NAMES, type NameRegion } from '../../src/synthetic/wikidata-names.js';
import { FakeNameModel, gate, occurrencesOf } from '../support/fake-name-model.js';
import {
  chatBody,
  post,
  readStreamed,
  startTestGateway,
  TEST_MODEL,
  type TestGateway,
} from '../support/gateway.js';
import { expandCaptured, leakedForm } from '../support/leak-check.js';
import {
  echoLastUserMessage,
  ollamaStreamEvents,
  streamed,
  SUCCESS_DEADLINE_MS,
} from '../support/mock-provider.js';
import { assertTextEqualQuietly } from '../support/quiet-text.js';

const OPTIONS: NameDetectorOptions = { timeoutMs: SUCCESS_DEADLINE_MS, maxQueue: 8 };

let gateway: TestGateway | undefined;
afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

async function namesGateway(
  model: FakeNameModel,
  options: NameDetectorOptions = OPTIONS,
): Promise<{ gateway: TestGateway; detector: NameDetector }> {
  const detector = await startNameDetection(() => Promise.resolve(model), options);
  gateway = await startTestGateway({ names: detector });
  return { gateway, detector };
}

const REGIONS = Object.keys(WIKIDATA_NAMES) as NameRegion[];

const FULL_WIDTH = (text: string): string =>
  text.replace(/[A-Za-z]/gu, (c) => String.fromCodePoint(c.codePointAt(0)! + 0xfee0));

/** A name, written one of the ways that move offsets or hide characters. */
function plantedName(rng: Rng): string {
  const script = rng.chance(0.3) ? 'devanagari' : 'latin';
  const { name } = writtenName(rng, rng.pick(REGIONS), script, 'full');
  switch (rng.int(0, 4)) {
    case 0:
      return name;
    case 1:
      return script === 'latin' ? FULL_WIDTH(name) : name;
    case 2:
      // A soft hyphen inside the first word.
      return name.length > 3 ? `${name.slice(0, 2)}\u00AD${name.slice(2)}` : name;
    case 3:
      return `${name.slice(0, 1)}\u200B${name.slice(1)}`;
    default:
      return name.toUpperCase();
  }
}

const TEMPLATES = [
  (a: string, b: string) => `Customer ${a} called about the refund; ${b} approved it.`,
  (a: string, b: string) => `${a} wrote: please copy ${b} on the reply.`,
  (a: string, b: string) => `मैंने ${a} से बात की, ${b} कल आएँगे।`,
  (a: string, b: string) => `Ticket from ${a}. Assigned to ${b}. Card 4111 1111 1111 1111.`,
];

interface History {
  readonly body: Record<string, unknown>;
  readonly names: readonly string[];
  /** The request's own words, without the names: a name word found here is no leak. */
  readonly template: string;
  readonly lastUser: string;
}

function histories(count: number, seed: number): History[] {
  const rng = createRng(seed);
  return Array.from({ length: count }, () => {
    const names: string[] = [];
    const keys = new Set<string>();
    // Distinct by value key: one name written two ways is one value, and
    // comes back as first written (ADR-013), which is not this test's point.
    const fresh = (): string => {
      for (;;) {
        const name = plantedName(rng);
        const key = normalise(name).text.toLowerCase();
        if (!keys.has(key)) {
          keys.add(key);
          names.push(name);
          return name;
        }
      }
    };
    const message = (): { text: string; bare: string } => {
      const a = fresh();
      const b = fresh();
      const template = rng.pick(TEMPLATES);
      return { text: template(a, b), bare: template('', '') };
    };
    const system = message();
    const earlier = message();
    const answer = message();
    const last = message();
    const stopName = fresh();
    return {
      body: {
        model: TEST_MODEL,
        messages: [
          { role: 'system', content: system.text },
          { role: 'user', content: [{ type: 'text', text: earlier.text }] },
          { role: 'assistant', content: answer.text },
          { role: 'user', content: last.text },
        ],
        stop: [`${stopName}:`],
      },
      names,
      template: [system, earlier, answer, last].map((m) => m.bare).join(' '),
      lastUser: last.text,
    };
  });
}

/** Each planted name, and each of its words of 4+ letters that the request's own text does not hold. */
function leakTargets(history: History): string[] {
  const own = history.template.toLowerCase();
  return history.names.flatMap((name) => [
    name,
    ...name
      .split(/\s+/u)
      .filter((word) => [...word].length >= 4 && !own.includes(word.toLowerCase())),
  ]);
}

describe('names on: no planted name reaches the provider, and every one comes back', () => {
  it('60 histories, 9 names each, in Latin, Devanagari, full width, capitals and split by invisible characters', async () => {
    const all = histories(60, 20_261_003);
    const model = new FakeNameModel(occurrencesOf(all.flatMap((h) => h.names)));
    const { gateway: g } = await namesGateway(model);
    g.provider.respondWith(echoLastUserMessage);

    let checked = 0;
    for (const [i, history] of all.entries()) {
      const response = await post(g, history.body);
      expect(response.statusCode).toBe(200);
      const outbound = expandCaptured(g.provider.requests[i]!.body);
      for (const target of leakTargets(history)) {
        // Only the form is reported, never the name (ADR-009).
        expect(leakedForm(outbound, target)).toBeUndefined();
        checked++;
      }
      const content = (response.json() as { choices: { message: { content: string } }[] })
        .choices[0]!.message.content;
      assertTextEqualQuietly(content, history.lastUser);
    }
    expect(g.provider.requests).toHaveLength(60);
    expect(checked).toBeGreaterThan(540);
    // Nothing the gateway logged holds a name either.
    const logs = expandCaptured(g.logs.join('\n'));
    for (const history of all) {
      for (const name of history.names) expect(leakedForm(logs, name)).toBeUndefined();
    }
    // The model saw every text of every request: four messages and a stop.
    expect(model.calls.every((texts) => texts.length === 5)).toBe(true);
  });

  it('the stop sequence goes out redacted to the placeholder the model will write', async () => {
    const [history] = histories(1, 7);
    const { gateway: g } = await namesGateway(new FakeNameModel(occurrencesOf(history!.names)));
    await post(g, history!.body);
    const sent = JSON.parse(g.provider.requests[0]!.body) as { stop: string[] };
    expect(sent.stop).toHaveLength(1);
    expect(sent.stop[0]).toMatch(/^\[PERSON_\d+\]:$/u);
  });
});

describe('names on: when names cannot be found, the request is refused and the provider never called', () => {
  const NAME = 'Zarvenka Thalimor';
  const body = chatBody(`Please ask ${NAME} to call back.`);

  async function refused(model: FakeNameModel, options?: NameDetectorOptions): Promise<void> {
    const { gateway: g } = await namesGateway(model, options);
    const response = await post(g, body);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        message: 'name detection is unavailable',
        type: 'api_error',
        param: null,
        code: 'name_detection_unavailable',
      },
    });
    expect(g.provider.requests).toHaveLength(0);
    // The canary: not in the response, the logs, or any error the gateway handled.
    const captured = expandCaptured(
      [response.body, ...g.logs, ...g.errors.map((e) => `${String(e)} ${(e as Error).stack}`)].join(
        '\n',
      ),
    );
    for (const target of [NAME, 'Zarvenka', 'Thalimor']) {
      expect(leakedForm(captured, target)).toBeUndefined();
    }
  }

  it('the model throws (with the text in its message)', async () => {
    await refused(
      new FakeNameModel(() => {
        throw new Error(`could not read ${NAME}`);
      }),
    );
  });

  it('the model does not answer in time', async () => {
    await refused(new FakeNameModel(() => gate().promise), { timeoutMs: 20, maxQueue: 8 });
  });

  it('the queue is full', async () => {
    const running = gate();
    const model = new FakeNameModel(() => running.promise);
    const { gateway: g } = await namesGateway(model, {
      timeoutMs: SUCCESS_DEADLINE_MS,
      maxQueue: 0,
    });
    const first = post(g, chatBody('First request.'));
    // Wait until the first is with the model.
    while (model.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const second = await post(g, body);
    expect(second.statusCode).toBe(503);
    expect((second.json() as { error: { code: string } }).error.code).toBe(
      'name_detection_unavailable',
    );
    expect(g.provider.requests).toHaveLength(0);
    running.open([[]]);
    expect((await first).statusCode).toBe(200);
    // Only the first request reached the provider.
    expect(g.provider.requests).toHaveLength(1);
    expect(g.provider.requests[0]!.body).toContain('First request.');
    expect(leakedForm(expandCaptured(g.logs.join('\n')), NAME)).toBeUndefined();
  });

  it('the model answers garbage', async () => {
    await refused(new FakeNameModel(() => [[{ start: 0, end: 10_000, score: 1 }]]));
  });

  it('the model has crashed: every request is refused and health says unhealthy, with no restart', async () => {
    const model = new FakeNameModel(occurrencesOf([NAME]));
    const { gateway: g } = await namesGateway(model);
    expect((await g.app.inject({ method: 'GET', url: '/health' })).json()).toEqual({
      status: 'ok',
    });
    model.crash();
    for (let i = 0; i < 3; i++) {
      const response = await post(g, body);
      expect(response.statusCode).toBe(503);
    }
    const health = await g.app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(503);
    expect(health.json()).toEqual({ status: 'unhealthy' });
    expect(model.calls).toHaveLength(0);
    expect(g.provider.requests).toHaveLength(0);
  });

  it('a model held past the timeout: health is 503 until the call ends, then ok again', async () => {
    const running = gate();
    const model = new FakeNameModel(() => running.promise);
    const { gateway: g } = await namesGateway(model, { timeoutMs: 20, maxQueue: 0 });
    expect((await post(g, body)).statusCode).toBe(503);
    // Node's timer clock is coarser than performance.now(): wait a little
    // past the timeout before asking.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const held = await g.app.inject({ method: 'GET', url: '/health' });
    expect(held.statusCode).toBe(503);
    expect(held.json()).toEqual({ status: 'unhealthy' });
    model.answer = (texts) => texts.map(() => []);
    running.open([[]]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await g.app.inject({ method: 'GET', url: '/health' })).json()).toEqual({
      status: 'ok',
    });
    expect(g.provider.requests).toHaveLength(0);
  });

  it('also when streaming: the 503 comes before any byte of a stream', async () => {
    const { gateway: g } = await namesGateway(
      new FakeNameModel(() => {
        throw new Error('down');
      }),
    );
    const response = await post(g, { ...body, stream: true });
    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toMatch(/application\/json/u);
    expect(g.provider.requests).toHaveLength(0);
  });
});

describe('names off: health is ok and no name step exists', () => {
  it('GET /health is ok, and a name is sent as written (names were not asked for)', async () => {
    gateway = await startTestGateway();
    gateway.provider.respondWith(echoLastUserMessage);
    expect((await gateway.app.inject({ method: 'GET', url: '/health' })).json()).toEqual({
      status: 'ok',
    });
    await post(gateway, chatBody('Please ask Zarvenka Thalimor.'));
    expect(gateway.provider.requests[0]!.body).toContain('Zarvenka Thalimor');
  });
});

describe('streaming: PERSON placeholders restored however the reply is cut (ADR-018, ADR-019)', () => {
  // Ten names, so that [PERSON_10] exists beside [PERSON_1].
  const rng = createRng(1_003);
  const NAMES: string[] = [];
  while (NAMES.length < 10) {
    const { name } = writtenName(rng, rng.pick(REGIONS), 'latin', 'full');
    if (!NAMES.includes(name)) NAMES.push(name);
  }
  const REQUEST = chatBody(`People: ${NAMES.join(', ')}.`);
  const REPLY = 'Hi [PERSON_1] and [PERSON_10]; Person_2 replied, [person_3] too. Person 4 left.';
  // Bracketed in any case and the bare underscore form are restored; the
  // bare space form is not, for PERSON ("Person 4" is ordinary English).
  const RESTORED = `Hi ${NAMES[0]} and ${NAMES[9]}; ${NAMES[1]} replied, ${NAMES[2]} too. Person 4 left.`;

  async function streamedReply(g: TestGateway, pieces: readonly string[]): Promise<string> {
    g.provider.respondWith(streamed(ollamaStreamEvents(pieces)));
    const response = await post(g, { ...REQUEST, stream: true });
    expect(response.statusCode).toBe(200);
    const parsed = readStreamed(response.body);
    expect(parsed.done).toBe(true);
    return parsed.content;
  }

  it('the request goes out with ten PERSON placeholders, in order', async () => {
    const { gateway: g } = await namesGateway(new FakeNameModel(occurrencesOf(NAMES)));
    await streamedReply(g, [REPLY]);
    const sent = (JSON.parse(g.provider.requests[0]!.body) as { messages: { content: string }[] })
      .messages[0]!.content;
    expect(sent).toBe(`People: ${NAMES.map((_, i) => `[PERSON_${i + 1}]`).join(', ')}.`);
  });

  it('cut into two at every position', async () => {
    const { gateway: g } = await namesGateway(new FakeNameModel(occurrencesOf(NAMES)));
    for (let cut = 1; cut < REPLY.length; cut++) {
      const content = await streamedReply(g, [REPLY.slice(0, cut), REPLY.slice(cut)]);
      assertTextEqualQuietly(content, RESTORED);
    }
  });

  it('cut one character at a time, and into random pieces biased to fall inside placeholders', async () => {
    const { gateway: g } = await namesGateway(new FakeNameModel(occurrencesOf(NAMES)));
    assertTextEqualQuietly(await streamedReply(g, [...REPLY]), RESTORED);
    const cuts = createRng(20_261_003);
    const inside = [...REPLY.matchAll(/\[[^\]]*\]|Person_\d+/gu)].flatMap((m) =>
      Array.from({ length: m[0].length - 1 }, (_, k) => m.index + k + 1),
    );
    for (let round = 0; round < 60; round++) {
      const points = new Set<number>();
      for (let k = cuts.int(1, 4); k > 0; k--) {
        points.add(cuts.chance(0.8) ? cuts.pick(inside) : cuts.int(1, REPLY.length - 1));
      }
      const sorted = [0, ...[...points].sort((a, b) => a - b), REPLY.length];
      const pieces = sorted.slice(1).map((end, i) => REPLY.slice(sorted[i], end));
      assertTextEqualQuietly(await streamedReply(g, pieces), RESTORED);
    }
  });

  it('a placeholder cut at the very end of the stream is restored when the stream ends', async () => {
    const { gateway: g } = await namesGateway(new FakeNameModel(occurrencesOf(NAMES)));
    assertTextEqualQuietly(await streamedReply(g, ['Bye [PERSON_', '1]']), `Bye ${NAMES[0]}`);
    // Unclosed, the bare form inside it is still a placeholder (ADR-013).
    assertTextEqualQuietly(await streamedReply(g, ['Bye [PERSON_1']), `Bye [${NAMES[0]}`);
  });
});

describe('garbage from the model, through the gateway (item 10)', () => {
  const TEXT = 'Please ask Zarvenka Thalimor about it.';
  const NAME = { start: 11, end: 28 };

  async function send(answer: (texts: readonly string[]) => unknown): Promise<{
    status: number;
    sent: string | undefined;
  }> {
    const { gateway: g } = await namesGateway(new FakeNameModel(answer));
    g.provider.respondWith(echoLastUserMessage);
    const response = await post(g, chatBody(TEXT));
    const body = g.provider.requests[0]?.body;
    const sent =
      body && (JSON.parse(body) as { messages: { content: string }[] }).messages[0]!.content;
    await g.close();
    gateway = undefined;
    return { status: response.statusCode, sent };
  }
  const one = (span: object) => (texts: readonly string[]) => texts.map(() => [span]);

  it.each([
    ['an offset past the end', { start: 11, end: TEXT.length + 1, score: 1 }],
    ['a span wholly past the end', { start: 500, end: 600, score: 1 }],
    ['a negative offset', { start: -3, end: 28, score: 1 }],
    ['start after end', { start: 28, end: 11, score: 1 }],
    ['a fractional offset', { start: 11.5, end: 28, score: 1 }],
    ['a score out of range', { start: 11, end: 28, score: 7 }],
    ['offsets that are not numbers', { start: '11', end: '28', score: 1 }],
  ])('refused, provider never called: %s', async (_label, span) => {
    expect(await send(one(span))).toEqual({ status: 503, sent: undefined });
  });

  it('refused: a list for the wrong number of texts, and more spans than characters', async () => {
    expect(await send(() => [])).toEqual({ status: 503, sent: undefined });
    const many = Array.from({ length: TEXT.length + 1 }, () => ({ ...NAME, score: 1 }));
    expect(await send((texts) => texts.map(() => many))).toEqual({ status: 503, sent: undefined });
  });

  it('discarded: a span with no characters claims nothing (the request goes out without it)', async () => {
    expect(await send(one({ start: 15, end: 15, score: 1 }))).toEqual({ status: 200, sent: TEXT });
  });

  it('merged: overlapping spans make one name', async () => {
    const answer = (texts: readonly string[]) =>
      texts.map(() => [
        { start: 11, end: 20, score: 0.95 },
        { start: 15, end: 28, score: 0.95 },
      ]);
    expect(await send(answer)).toEqual({ status: 200, sent: 'Please ask [PERSON_1] about it.' });
  });

  it('kept: a span over the whole message makes the whole message one name', async () => {
    expect(await send(one({ start: 0, end: TEXT.length, score: 1 }))).toEqual({
      status: 200,
      sent: '[PERSON_1]',
    });
  });

  it('kept: several thousand spans at once, overlapping and out of order, corrupt nothing', async () => {
    const long = `${'Zarvenka Thalimor met Qorin Vale. '.repeat(200)}End.`;
    const spans = [];
    for (let at = long.indexOf('Zarvenka'); at >= 0; at = long.indexOf('Zarvenka', at + 1)) {
      // The name, its first word, and its second word: three spans each.
      spans.push(
        { start: at + 9, end: at + 17, score: 0.95 },
        { start: at, end: at + 17, score: 0.95 },
      );
      spans.push({ start: at, end: at + 8, score: 0.95 });
    }
    spans.reverse();
    expect(spans.length).toBe(600);
    const lots = [...spans, ...spans, ...spans, ...spans, ...spans];
    expect(lots.length).toBe(3_000);
    const { gateway: g } = await namesGateway(new FakeNameModel((texts) => texts.map(() => lots)));
    g.provider.respondWith(echoLastUserMessage);
    const response = await post(g, chatBody(long));
    expect(response.statusCode).toBe(200);
    const sent = (JSON.parse(g.provider.requests[0]!.body) as { messages: { content: string }[] })
      .messages[0]!.content;
    expect(sent).toBe(`${'[PERSON_1] met Qorin Vale. '.repeat(200)}End.`);
    const content = (response.json() as { choices: { message: { content: string } }[] }).choices[0]!
      .message.content;
    expect(content).toBe(long);
  });
});

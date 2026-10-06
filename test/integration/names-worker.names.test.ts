// Person names with the real model (Phase 6b step 4b): step 3's contract,
// which the fake model defined, held by the real worker thread running B.
// Its own Vitest project (`npm run test:names`): it needs the runtime and
// the model files (`npm run fetch:model`), which the main suite and CI do
// not have, and it fails, not skips, when they are missing.
//
// Every failure is a 503 with the provider never called. Garbage comes from
// the real model's real answers, corrupted on their way out of a stand-in
// thread (test/support/garbage-name-worker.ts); everything else runs the
// shipped entry.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateCases } from '../../eval/generate.js';
import { NAMES_SHAPE } from '../../eval/names/measure.js';
import type { Span } from '../../src/detection/normalise.js';
import {
  checkModelFiles,
  loadNameModel,
  MODEL_ROOT,
  NAME_MODEL,
} from '../../src/gateway/name-model.js';
import { workerEntry, WorkerNameModel } from '../../src/gateway/name-worker.js';
import {
  startNameDetection,
  type NameDetector,
  type NameDetectorOptions,
} from '../../src/gateway/names.js';
import type { NameFinder } from '../../src/gateway/server.js';
import { chatBody, post, startTestGateway, type TestGateway } from '../support/gateway.js';
import { echoLastUserMessage } from '../support/mock-provider.js';

const MODEL_DIR = join(MODEL_ROOT, NAME_MODEL.dir);
const WORKING: NameDetectorOptions = { timeoutMs: 60_000, maxQueue: 16 };

// Synthetic messages with names in them: the generated set's names block.
const NAMED = generateCases()
  .filter((c) => c.tags.includes(NAMES_SHAPE))
  .flatMap((c) => c.messages.map((m) => m.text));
/** About 16 KiB of them: B takes seconds on it, long enough to be caught busy. */
const LONG = NAMED.join('\n\n').slice(0, 16 * 1024);

beforeAll(async () => {
  // Fail loudly, never skip: a names run without the model would prove nothing.
  await checkModelFiles(MODEL_DIR);
});

const models: WorkerNameModel[] = [];
const gateways: TestGateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()));
  await Promise.all(models.splice(0).map((m) => m.close()));
});

interface Found {
  readonly text: string;
  readonly spans: Span[];
}

async function realNames(
  options: NameDetectorOptions,
  load: () => Promise<WorkerNameModel> = async () =>
    (await loadNameModel(MODEL_DIR)) as WorkerNameModel,
): Promise<{ g: TestGateway; detector: NameDetector; model: WorkerNameModel; found: Found[] }> {
  let model: WorkerNameModel | undefined;
  const detector = await startNameDetection(async () => {
    model = await load();
    models.push(model);
    return model;
  }, options);
  // What the server was given, per text, to compare with what it sent.
  const found: Found[] = [];
  const finder: NameFinder = {
    find: async (texts, signal) => {
      const names = await detector.find(texts, signal);
      found.push(...names.map((n) => ({ text: n.text, spans: [...n.spans] })));
      return names;
    },
    get healthy() {
      return detector.healthy;
    },
  };
  const g = await startTestGateway({ names: finder });
  gateways.push(g);
  g.provider.respondWith(echoLastUserMessage);
  return { g, detector, model: model!, found };
}

const sentContent = (g: TestGateway, i: number): string =>
  (JSON.parse(g.provider.requests[i]!.body) as { messages: { content: string }[] }).messages[0]!
    .content;

const until = async (condition: () => boolean, ms = 60_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('the real model, through the gateway', () => {
  it('no name the model found is sent, and the reply comes back with the text as written', async () => {
    const { g, found } = await realNames(WORKING);
    let checked = 0;
    for (const [i, text] of NAMED.slice(0, 40).entries()) {
      const response = await post(g, chatBody(text));
      expect(response.statusCode).toBe(200);
      const sent = sentContent(g, i);
      expect(found[i]!.text).toBe(text);
      for (const span of found[i]!.spans) {
        const name = text.slice(span.start, span.end);
        // A name written once in its message cannot be in what was sent.
        if (text.indexOf(name) === text.lastIndexOf(name)) {
          expect(sent.includes(name)).toBe(false);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  it('requests sent at once each get their own names (the thread answers by id)', async () => {
    const { g, found } = await realNames(WORKING);
    const texts = NAMED.slice(40, 52);
    for (const text of texts) expect((await post(g, chatBody(text))).statusCode).toBe(200);
    const alone = new Map(found.splice(0).map((f) => [f.text, JSON.stringify(f.spans)]));
    const together = await Promise.all(texts.map((text) => post(g, chatBody(text))));
    expect(together.every((r) => r.statusCode === 200)).toBe(true);
    expect(found).toHaveLength(texts.length);
    expect(new Map(found.map((f) => [f.text, JSON.stringify(f.spans)]))).toEqual(alone);
    expect([...alone.values()].some((spans) => spans !== '[]')).toBe(true);
  });
});

describe('fail closed with the real model: a 503, the provider never called', () => {
  it('the model takes too long: refused; health unhealthy while it is held; then it serves again', async () => {
    const { g, detector } = await realNames({ timeoutMs: 100, maxQueue: 0 });
    const slow = await post(g, chatBody(LONG));
    expect(slow.statusCode).toBe(503);
    expect((slow.json() as { error: { code: string } }).error.code).toBe(
      'name_detection_unavailable',
    );
    // B is still working on it (seconds); nothing else may run meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const held = await g.app.inject({ method: 'GET', url: '/health' });
    expect(held.statusCode).toBe(503);
    expect((await post(g, chatBody('Short.'))).statusCode).toBe(503);
    expect(g.provider.requests).toHaveLength(0);
    // When B finishes, the thread is alive and answers within the timeout.
    await until(() => detector.healthy);
    expect((await g.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await post(g, chatBody('Short.'))).statusCode).toBe(200);
    expect(g.provider.requests).toHaveLength(1);
  });

  it('the queue is full: refused at once, while the request ahead completes', async () => {
    const { g, found } = await realNames({ timeoutMs: 60_000, maxQueue: 0 });
    const first = post(g, chatBody(LONG));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = await post(g, chatBody('Second.'));
    expect(second.statusCode).toBe(503);
    expect(g.provider.requests).toHaveLength(0);
    expect((await first).statusCode).toBe(200);
    expect(g.provider.requests).toHaveLength(1);
    expect(found).toHaveLength(1);
  });

  it('garbage from the real model, every kind: refused; its plain answer goes through', async () => {
    const { entry, execArgv } = workerEntry(pathToFileURL('src/gateway/name-worker.ts').href);
    expect(entry.pathname.endsWith('.ts')).toBe(true);
    const { g } = await realNames(WORKING, () =>
      WorkerNameModel.start({
        entry: new URL('../support/garbage-name-worker.ts', import.meta.url),
        workerData: { dir: MODEL_DIR },
        execArgv,
      }),
    );
    const text = NAMED[0]!;
    // Seven corruptions, one per call, then the answer as B gave it.
    for (let call = 0; call < 7; call++) {
      expect((await post(g, chatBody(text))).statusCode).toBe(503);
    }
    expect(g.provider.requests).toHaveLength(0);
    expect((await post(g, chatBody(text))).statusCode).toBe(200);
    expect(g.provider.requests).toHaveLength(1);
  });

  it('the thread exits: every request refused, health unhealthy, no restart', async () => {
    // Stopped while idle: stopping it during an inference ends the whole
    // process instead (bug-log 68), so the exit is made between calls.
    const { g, model } = await realNames(WORKING);
    expect((await post(g, chatBody(NAMED[0]!))).statusCode).toBe(200);
    await model.terminate();
    for (let i = 0; i < 3; i++) expect((await post(g, chatBody('Later.'))).statusCode).toBe(503);
    const health = await g.app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(503);
    expect(health.json()).toEqual({ status: 'unhealthy' });
    expect(g.provider.requests).toHaveLength(1);
  });
});

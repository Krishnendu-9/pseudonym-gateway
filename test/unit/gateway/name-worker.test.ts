// The channel to the name model's worker thread (Phase 6b step 4b). The
// thread's side (serveNames) runs here on a MessageChannel; the gateway's
// side (WorkerNameModel) starts real worker threads, with a scripted
// stand-in for B (test/support/fake-name-worker.ts), so nothing here needs
// the runtime or the model. The real model's tests are the names project
// (`npm run test:names`).

import { pathToFileURL } from 'node:url';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { NameDetectionUnavailable } from '../../../src/gateway/errors.js';
import {
  NameWorkerStartError,
  serveNames,
  startNameWorker,
  WORKER_START_TIMEOUT_MS,
  workerEntry,
  WorkerNameModel,
  type NameReply,
  type NameRequest,
  type ReplyPort,
} from '../../../src/gateway/name-worker.js';
import { NameDetector } from '../../../src/gateway/names.js';
import { gate } from '../../support/fake-name-model.js';

const FAKE_ENTRY = new URL('../../support/fake-name-worker.ts', import.meta.url);
const TSX = workerEntry(pathToFileURL('src/gateway/name-worker.ts').href).execArgv;
const NAME = 'Zarvenka';

const started: WorkerNameModel[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((model) => model.close()));
});

async function start(mode: string, startTimeoutMs?: number): Promise<WorkerNameModel> {
  const model = await WorkerNameModel.start({
    entry: FAKE_ENTRY,
    workerData: { mode },
    execArgv: TSX,
    ...(startTimeoutMs === undefined ? {} : { startTimeoutMs }),
  });
  started.push(model);
  return model;
}

/** What start() refused with, as name and message. */
async function startRefusal(mode: string, startTimeoutMs?: number): Promise<unknown> {
  try {
    await start(mode, startTimeoutMs);
  } catch (error) {
    expect(error).toBeInstanceOf(NameWorkerStartError);
    return { name: (error as Error).name, message: (error as Error).message };
  }
  return 'started';
}

/** The message a rejected promise carried, or 'resolved'. */
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return (error as Error).message;
  }
}

/** The thread's side of a MessageChannel, and every reply it sent. */
function channel(): {
  port: ReplyPort;
  send: (request: NameRequest) => void;
  replies: NameReply[];
} {
  const { port1, port2 } = new MessageChannel();
  const replies: NameReply[] = [];
  port2.on('message', (reply: NameReply) => replies.push(reply));
  return {
    port: port1 as MessagePort as unknown as ReplyPort,
    send: (request) => port2.postMessage(request),
    replies,
  };
}

const until = async (condition: () => boolean): Promise<void> => {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 1));
};

describe("serveNames: the thread's side", () => {
  it('says it is ready, then answers each text of a request, in order', async () => {
    const { port, send, replies } = channel();
    serveNames(port, (text) => Promise.resolve([{ start: 0, end: text.length, score: 0.5 }]));
    send({ id: 7, texts: ['ab', 'abcd'] });
    await until(() => replies.length === 2);
    expect(replies).toEqual([
      { type: 'ready' },
      {
        type: 'answer',
        id: 7,
        spans: [[{ start: 0, end: 2, score: 0.5 }], [{ start: 0, end: 4, score: 0.5 }]],
      },
    ]);
  });

  it('works on one request at a time: a slow first one is answered before a fast second one', async () => {
    const { port, send, replies } = channel();
    const slow = gate<{ start: number; end: number; score: number }[]>();
    const begun: string[] = [];
    serveNames(port, (text) => {
      begun.push(text);
      return text === 'slow' ? slow.promise : Promise.resolve([]);
    });
    send({ id: 1, texts: ['slow'] });
    send({ id: 2, texts: ['fast'] });
    await until(() => begun.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The second request has not started while the first runs.
    expect(begun).toEqual(['slow']);
    slow.open([]);
    await until(() => replies.length === 3);
    expect(replies.slice(1).map((r) => (r as { id: number }).id)).toEqual([1, 2]);
  });

  it('answers "failed" with nothing of the error, and goes on to the next request', async () => {
    const { port, send, replies } = channel();
    serveNames(port, (text) =>
      text === NAME ? Promise.reject(new Error(`cannot read ${NAME}`)) : Promise.resolve([]),
    );
    send({ id: 1, texts: ['fine', NAME] });
    send({ id: 2, texts: ['fine'] });
    await until(() => replies.length === 3);
    expect(replies.slice(1)).toEqual([
      { type: 'failed', id: 1 },
      { type: 'answer', id: 2, spans: [[]] },
    ]);
  });
});

describe("workerEntry: the thread's module", () => {
  it('the built gateway: the .js entry beside the module, with no Node options', () => {
    expect(workerEntry('file:///app/dist/src/gateway/name-worker.js')).toEqual({
      entry: new URL('file:///app/dist/src/gateway/name-worker-entry.js'),
      execArgv: [],
    });
  });

  it("from source: the .ts entry, with tsx's loader (a thread does not inherit it)", () => {
    const { entry, execArgv } = workerEntry(pathToFileURL('src/gateway/name-worker.ts').href);
    expect(entry.href).toBe(pathToFileURL('src/gateway/name-worker-entry.ts').href);
    expect(execArgv).toHaveLength(2);
    expect(execArgv[0]).toBe('--import');
    expect(execArgv[1]).toMatch(/^file:\/\/\/.*\/node_modules\/tsx\/.*\.mjs$/u);
  });
});

describe("WorkerNameModel: the gateway's side, on real threads", () => {
  it('answers each call with its own spans, calls in flight at once included', async () => {
    const model = await start('names');
    const answers = await Promise.all([
      model.run([`Ask ${NAME}.`, 'Nobody.']),
      model.run([`${NAME} and ${NAME}`]),
    ]);
    expect(answers).toEqual([
      [[{ start: 4, end: 12, score: 0.95 }], []],
      [
        [
          { start: 0, end: 8, score: 0.95 },
          { start: 13, end: 21, score: 0.95 },
        ],
      ],
    ]);
  });

  it('passes on what the thread answered, unchecked: checking is the detector’s job', async () => {
    const model = await start('garbage');
    expect(await model.run(['x'])).toEqual([[{ start: -1, end: 1e9, score: 7 }]]);
    const detector = new NameDetector(model, { timeoutMs: 5_000, maxQueue: 0 }, new Set());
    const refused = await detector.find(['x']).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(NameDetectionUnavailable);
    expect((refused as NameDetectionUnavailable).reason).toBe('malformed');
  });

  it('a call the thread could not answer fails with a fixed message, never the text', async () => {
    const model = await start('throws');
    const message = await rejection(model.run([`About ${NAME}.`]));
    expect(message).toBe('the name model could not answer');
    // The thread is still there for the next call.
    expect(await rejection(model.run(['again']))).toBe('the name model could not answer');
  });

  it('ignores a reply for no call, and a second "ready"', async () => {
    const model = await start('strays');
    expect(await model.run(['x'])).toEqual([['the answer']]);
  });

  it('a thread that exits is a crash: the call fails, the listener is told, later calls fail at once', async () => {
    const model = await start('exits-on-call');
    let crashes = 0;
    model.onCrash(() => crashes++);
    expect(await rejection(model.run([NAME]))).toBe('the name model worker has stopped');
    await until(() => crashes === 1);
    expect(await rejection(model.run(['later']))).toBe('the name model worker has stopped');
    expect(crashes).toBe(1);
  });

  it('through the detector: a crash makes every request a 503 and health unhealthy', async () => {
    const model = await start('exits-on-call');
    const detector = new NameDetector(model, { timeoutMs: 5_000, maxQueue: 0 }, new Set());
    expect(detector.healthy).toBe(true);
    const first = await detector.find([NAME]).catch((error: unknown) => error);
    expect((first as NameDetectionUnavailable).reason).toBe('crashed');
    expect(detector.healthy).toBe(false);
    const later = await detector.find(['later']).catch((error: unknown) => error);
    expect((later as NameDetectionUnavailable).reason).toBe('crashed');
  });

  it('through the detector: a thread that never answers times out, and health says held', async () => {
    const model = await start('hangs');
    const detector = new NameDetector(model, { timeoutMs: 50, maxQueue: 0 }, new Set());
    const refused = await detector.find([NAME]).catch((error: unknown) => error);
    expect((refused as NameDetectionUnavailable).reason).toBe('timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(detector.healthy).toBe(false);
  });

  it('terminate() is a crash: the call in flight fails and the listener is told', async () => {
    const model = await start('hangs');
    let crashes = 0;
    model.onCrash(() => crashes++);
    const call = rejection(model.run(['x']));
    await model.terminate();
    expect(await call).toBe('the name model worker has stopped');
    await until(() => crashes === 1);
  });

  it('close() is not a crash: the call in flight fails, the listener is not told', async () => {
    const model = await start('hangs');
    let crashes = 0;
    model.onCrash(() => crashes++);
    const call = rejection(model.run(['x']));
    await model.close();
    expect(await call).toBe('the name model worker has stopped');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(crashes).toBe(0);
  });
});

describe('WorkerNameModel.start: refuses, with a fixed message, unless the thread says it is ready', () => {
  const REFUSED = { name: 'NameWorkerStartError', message: 'the name model worker did not start' };

  it('the thread fails while loading (its error quotes its input, and is never read)', async () => {
    expect(await startRefusal('fails-to-load')).toEqual(REFUSED);
  });

  it('the thread exits before it is ready', async () => {
    expect(await startRefusal('exits-before-ready')).toEqual(REFUSED);
  });

  it('the thread sends something else first', async () => {
    expect(await startRefusal('not-ready-first')).toEqual(REFUSED);
  });

  it('the thread never says it is ready (and is stopped)', async () => {
    expect(await startRefusal('never-ready', 2_000)).toEqual(REFUSED);
  });

  it('the real entry, on a directory with no model in it, refuses (no model needed here)', async () => {
    const refused = await startNameWorker('no-such-model-directory').catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(NameWorkerStartError);
  });

  it('waits two minutes by default: the measured load is about a second', () => {
    expect(WORKER_START_TIMEOUT_MS).toBe(120_000);
  });
});

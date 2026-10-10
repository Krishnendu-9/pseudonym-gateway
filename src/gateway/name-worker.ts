// The name model in a worker thread (Phase 6b step 4b). What the thread
// buys, measured (ADR-036, "Step 4b"): module isolation (the runtime and
// the model are loaded only inside it, never by the server's own code) and
// a clean boundary behind which NameDetector (names.ts) keeps the queue,
// the timeout and every fail-closed rule. Not event-loop isolation: the
// runtime already ran inference on its own threads, and the longest
// event-loop delay was the same with the thread as without it. This module
// is only the channel to the thread, and implements the same NameModel
// contract the step 3 fake did.
//
// Both sides of the channel are here. The thread's entry
// (name-worker-entry.ts) loads the runtime and the model and calls
// serveNames(); WorkerNameModel starts the thread and talks to it.
// What crosses back is spans (offsets and scores), never text. The
// thread's own errors are never read: an error from inside the model may
// quote what it was given.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { ScoredSpan } from '../detection/names/spans.js';
import type { NameModel } from './names.js';

/** From the gateway to the thread: the texts of one request. */
export interface NameRequest {
  readonly id: number;
  readonly texts: readonly string[];
}

/** From the thread to the gateway. */
export type NameReply =
  | { readonly type: 'ready' }
  | { readonly type: 'answer'; readonly id: number; readonly spans: unknown }
  | { readonly type: 'failed'; readonly id: number };

/** The thread's side of its port, as serveNames() uses it. */
export interface ReplyPort {
  postMessage(reply: NameReply): void;
  on(event: 'message', listener: (request: NameRequest) => void): unknown;
}

/**
 * Runs in the thread, once the model has loaded: says it is ready, then
 * answers each request with `find`'s spans for each of its texts, in
 * order, one request at a time. A request whose texts `find` cannot read
 * is answered `failed`, with nothing of the error.
 */
export function serveNames(port: ReplyPort, find: (text: string) => Promise<ScoredSpan[]>): void {
  let previous: Promise<void> = Promise.resolve();
  port.on('message', (request) => {
    previous = previous.then(async () => {
      try {
        const spans: ScoredSpan[][] = [];
        for (const text of request.texts) spans.push(await find(text));
        port.postMessage({ type: 'answer', id: request.id, spans });
      } catch {
        port.postMessage({ type: 'failed', id: request.id });
      }
    });
  });
  port.postMessage({ type: 'ready' });
}

/** How long the thread may take to load the runtime and the model before start-up is refused. */
export const WORKER_START_TIMEOUT_MS = 120_000;

/** Why start() refused. Fixed text: nothing of the thread's own error is kept. */
export class NameWorkerStartError extends Error {
  constructor() {
    super('the name model worker did not start');
    this.name = 'NameWorkerStartError';
  }
}

/** A call the thread can no longer answer. Fixed text, like every name failure. */
class NameWorkerStopped extends Error {
  constructor() {
    super('the name model worker has stopped');
    this.name = 'NameWorkerStopped';
  }
}

/** A call the thread answered "failed". Fixed text: the thread's error is not sent. */
class NameWorkerFailed extends Error {
  constructor() {
    super('the name model could not answer');
    this.name = 'NameWorkerFailed';
  }
}

export interface WorkerStartOptions {
  /** The thread's entry module. */
  readonly entry: URL;
  readonly workerData: unknown;
  /** Node options for the thread (empty for the built gateway). */
  readonly execArgv: readonly string[];
  readonly startTimeoutMs?: number;
}

interface Call {
  readonly resolve: (spans: unknown) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Turns off ONNX Runtime's telemetry (ADR-046). Its Linux build sends usage
 * events to Microsoft by default from 1.30 (the CPU model, a device ID, the
 * model's file name and hashes; never the text), and keeps unsent ones on
 * disk. Forced, whatever the environment held: the runtime reads the
 * process's environment from its native code, so this must run on the main
 * thread, where assigning to process.env changes it, before any thread
 * loads the runtime.
 */
export function disableRuntimeTelemetry(env: NodeJS.ProcessEnv = process.env): void {
  env.ORT_DISABLE_TELEMETRY = '1';
}

export class WorkerNameModel implements NameModel {
  readonly #worker: Worker;
  readonly #calls = new Map<number, Call>();
  #nextId = 0;
  #stopped = false;
  #closing = false;
  #onCrash: (() => void) | undefined;

  private constructor(worker: Worker) {
    this.#worker = worker;
    worker.on('message', (reply: NameReply) => this.#reply(reply));
    worker.on('exit', () => this.#exit());
  }

  /**
   * Starts the thread and waits until it says it is ready. Rejects with a
   * NameWorkerStartError if it fails, exits or takes longer than
   * `startTimeoutMs` first (and then stops it).
   */
  static start({
    entry,
    workerData,
    execArgv,
    startTimeoutMs = WORKER_START_TIMEOUT_MS,
  }: WorkerStartOptions): Promise<WorkerNameModel> {
    disableRuntimeTelemetry();
    const worker = new Worker(entry, { workerData, execArgv: [...execArgv] });
    // An error from the thread may quote its input: swallowed, never read.
    // (The thread exits after one, and 'exit' is what is acted on.)
    worker.on('error', () => {});
    return new Promise((resolve, reject) => {
      // Only these listeners are removed: removeAllListeners() would also
      // remove the Worker's own, which start its message port.
      const stopWaiting = (): void => {
        clearTimeout(timer);
        worker.off('exit', refuse);
        worker.off('message', ready);
      };
      const refuse = (): void => {
        stopWaiting();
        void worker.terminate();
        reject(new NameWorkerStartError());
      };
      const ready = (reply: NameReply): void => {
        if (reply.type !== 'ready') return refuse();
        stopWaiting();
        resolve(new WorkerNameModel(worker));
      };
      const timer = setTimeout(refuse, startTimeoutMs);
      worker.on('exit', refuse);
      worker.on('message', ready);
    });
  }

  run(texts: readonly string[]): Promise<unknown> {
    if (this.#stopped) return Promise.reject(new NameWorkerStopped());
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#calls.set(id, { resolve, reject });
      this.#worker.postMessage({ id, texts } satisfies NameRequest);
    });
  }

  onCrash(listener: () => void): void {
    this.#onCrash = listener;
  }

  /**
   * Stops the thread as a crash would: every call fails and the crash
   * listener is told. **Only while no call is running.** Stopping the
   * thread while the runtime is inside an inference ends the whole process
   * (0xC0000409 on Windows, 5 of 5 tries; bug-log 68), and the runtime
   * cannot cancel a run itself (its `terminate` run option is WebAssembly
   * only). Whether a call that runs too long should be stopped is the
   * user's decision (Phase 6b step 4b, item 3); nothing calls this in the
   * gateway.
   */
  async terminate(): Promise<void> {
    await this.#worker.terminate();
  }

  /**
   * Stops the thread on shutdown: every call still waiting fails, but it is
   * not a crash. Like terminate(), only while no call is running.
   */
  async close(): Promise<void> {
    this.#closing = true;
    await this.#worker.terminate();
  }

  #reply(reply: NameReply): void {
    if (reply.type === 'ready') return;
    const call = this.#calls.get(reply.id);
    if (!call) return;
    this.#calls.delete(reply.id);
    if (reply.type === 'answer') call.resolve(reply.spans);
    else call.reject(new NameWorkerFailed());
  }

  #exit(): void {
    this.#stopped = true;
    for (const call of this.#calls.values()) call.reject(new NameWorkerStopped());
    this.#calls.clear();
    if (!this.#closing) this.#onCrash?.();
  }
}

/**
 * The thread's entry next to `moduleUrl` (this module's own URL): the built
 * `.js` file with no Node options, or, when running from TypeScript source
 * (tests, `npm run dev`), the `.ts` file with tsx's loader, which the thread
 * does not inherit on its own.
 */
export function workerEntry(moduleUrl: string): { entry: URL; execArgv: string[] } {
  if (!moduleUrl.endsWith('.ts')) {
    return { entry: new URL('./name-worker-entry.js', moduleUrl), execArgv: [] };
  }
  const tsx = pathToFileURL(createRequire(moduleUrl).resolve('tsx')).href;
  return { entry: new URL('./name-worker-entry.ts', moduleUrl), execArgv: ['--import', tsx] };
}

/** Starts B in its thread on the model in `dir` (files already checked by loadNameModel). */
export function startNameWorker(dir: string): Promise<WorkerNameModel> {
  return WorkerNameModel.start({ ...workerEntry(import.meta.url), workerData: { dir } });
}

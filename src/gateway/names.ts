// Person names in the request path (ADR-037). Loaded only when names are on:
// with names off, nothing imports this module.
//
// A request's names are found before anything is redacted, on exactly the
// texts redactRequest() will redact (requestTexts), and handed to it. The
// model (B, in a worker from step 4) runs one request at a time; the rest
// wait in a queue of fixed size. Fail closed, always (ADR-036):
//  - the queue is full, the request waited too long, the model failed or
//    answered something unreadable: that request gets a 503;
//  - the model crashed: every request gets a 503 from then on, and health
//    says unhealthy, until the process is restarted. It is not restarted
//    here;
//  - nothing ever sends a request on without its names.
// A request that times out while the model is working on it stops waiting,
// but the model is not interrupted (it cannot be), so the next request
// starts only when the model has finished: a timeout never lets work pile
// up behind a busy model. While the model is held that way, past the
// timeout, health says unhealthy, and recovers when the call ends.

import { createHash } from 'node:crypto';
import { GAZETTEER } from '../detection/names/gazetteer.js';
import { modelSpans, nameSpans } from '../detection/names/find.js';
import type { NameSpans } from '../redaction/redact.js';
import { NameDetectionUnavailable, NameStartupError, type NameFailure } from './errors.js';
import type { NameFinder } from './server.js';

/** What step 4's worker provides: B's scored spans for each text. */
export interface NameModel {
  /**
   * B's person spans for each of `texts`, in that text's UTF-16 offsets.
   * Untrusted: checked by modelSpans() before use.
   */
  run(texts: readonly string[]): Promise<unknown>;
  /** Registers the listener told once if the model stops for good (its worker exits). */
  onCrash(listener: () => void): void;
}

export interface NameDetectorOptions {
  /** How long a request may wait for its names, queued and running together. */
  readonly timeoutMs: number;
  /** How many requests may wait while the model works on another. */
  readonly maxQueue: number;
}

interface Job {
  readonly texts: readonly string[];
  readonly resolve: (names: NameSpans[]) => void;
  readonly reject: (error: NameDetectionUnavailable) => void;
  settled: boolean;
  timer?: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class NameDetector implements NameFinder {
  readonly #model: NameModel;
  readonly #options: NameDetectorOptions;
  readonly #list: ReadonlySet<string>;
  readonly #queue: Job[] = [];
  #running: Job | undefined;
  #busy = false;
  /** When the model started its current call (performance.now()). */
  #busySince = 0;
  #crashed = false;

  constructor(model: NameModel, options: NameDetectorOptions, list: ReadonlySet<string>) {
    this.#model = model;
    this.#options = options;
    this.#list = list;
    model.onCrash(() => this.#crash());
  }

  /**
   * Whether the detector can serve names now. False once the model has
   * crashed, until the process restarts. Also false while the model is held
   * by a call that has run longer than timeoutMs: that call's request has
   * already been refused, nothing else can run until it ends, so every
   * request meanwhile times out or finds the queue full. True again when
   * the call ends. A full queue behind a model that still answers in time
   * is load, not inability, and stays healthy.
   */
  get healthy(): boolean {
    const held = this.#busy && performance.now() - this.#busySince >= this.#options.timeoutMs;
    return !this.#crashed && !held;
  }

  find(texts: readonly string[], signal?: AbortSignal): Promise<NameSpans[]> {
    if (this.#crashed) return Promise.reject(new NameDetectionUnavailable('crashed'));
    if (signal?.aborted) return Promise.reject(new NameDetectionUnavailable('aborted'));
    if (this.#busy && this.#queue.length >= this.#options.maxQueue) {
      return Promise.reject(new NameDetectionUnavailable('queue_full'));
    }
    return new Promise((resolve, reject) => {
      const job: Job = { texts, resolve, reject, settled: false };
      job.timer = setTimeout(() => this.#fail(job, 'timeout'), this.#options.timeoutMs);
      if (signal) {
        job.signal = signal;
        job.onAbort = () => this.#fail(job, 'aborted');
        signal.addEventListener('abort', job.onAbort, { once: true });
      }
      this.#queue.push(job);
      this.#next();
    });
  }

  #next(): void {
    if (this.#busy || this.#crashed) return;
    const job = this.#queue.shift();
    if (!job) return;
    this.#busy = true;
    this.#busySince = performance.now();
    this.#running = job;
    let answer: Promise<unknown>;
    try {
      answer = this.#model.run(job.texts);
    } catch {
      answer = Promise.reject(new Error('the name model threw'));
    }
    answer
      .then(
        (output) => this.#succeed(job, output),
        () => this.#fail(job, 'failed'),
      )
      .finally(() => {
        this.#running = undefined;
        this.#busy = false;
        this.#next();
      });
  }

  #succeed(job: Job, output: unknown): void {
    if (job.settled) return;
    let names: NameSpans[];
    try {
      const spans = modelSpans(job.texts, output);
      names = job.texts.map((text, i) => ({ text, spans: nameSpans(text, spans[i]!, this.#list) }));
    } catch {
      this.#fail(job, 'malformed');
      return;
    }
    this.#settle(job);
    job.resolve(names);
  }

  #fail(job: Job, reason: NameFailure): void {
    if (job.settled) return;
    this.#settle(job);
    const queued = this.#queue.indexOf(job);
    if (queued >= 0) this.#queue.splice(queued, 1);
    job.reject(new NameDetectionUnavailable(reason));
  }

  #settle(job: Job): void {
    job.settled = true;
    clearTimeout(job.timer);
    if (job.onAbort) job.signal!.removeEventListener('abort', job.onAbort);
  }

  #crash(): void {
    this.#crashed = true;
    for (const job of [...(this.#running ? [this.#running] : []), ...this.#queue]) {
      this.#fail(job, 'crashed');
    }
  }
}

/**
 * The name list ADR-035 measured, by its canonical SHA-256 (ADR-036): the
 * strings sorted by UTF-16 code unit, joined by LF, as UTF-8.
 */
export const NAME_LIST_SHA256 = '313b89ea3a88ba35265f8f8bf5d2022c8dd85e90cdff4744bc3bb388821f3951';

export const listSha256 = (list: ReadonlySet<string>): string =>
  createHash('sha256')
    .update([...list].sort().join('\n'))
    .digest('hex');

/** The start-up check on the list (ADR-036): refuses unless it is the measured one. */
export function checkNameList(list: ReadonlySet<string>): void {
  if (listSha256(list) !== NAME_LIST_SHA256) throw new NameStartupError('NAME_LIST_MISMATCH');
}

/**
 * Starts name detection, or refuses (ADR-036): the list the detector will
 * use must match NAME_LIST_SHA256 (checked first), and the model must load,
 * which includes its own file check (loadNameModel). Either failure is a
 * NameStartupError, and the gateway does not start. A NameStartupError from
 * the loader keeps its code and file; any other error becomes
 * NAME_MODEL_LOAD_FAILED, keeping nothing of it.
 */
export async function startNameDetection(
  loadModel: () => Promise<NameModel>,
  options: NameDetectorOptions,
  list: ReadonlySet<string> = GAZETTEER,
): Promise<NameDetector> {
  checkNameList(list);
  let model: NameModel;
  try {
    model = await loadModel();
  } catch (error) {
    if (error instanceof NameStartupError) throw error;
    throw new NameStartupError('NAME_MODEL_LOAD_FAILED');
  }
  return new NameDetector(model, options, list);
}

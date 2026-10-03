// A stand-in for B (Phase 6b step 3): no runtime, no worker. Each call's
// answer comes from `answer`, which a test sets to anything, garbage
// included; `crash()` plays the worker exiting.

import type { NameModel } from '../../src/gateway/names.js';

export type Answer = (texts: readonly string[]) => unknown;

export class FakeNameModel implements NameModel {
  /** The texts of every call, in order. */
  readonly calls: (readonly string[])[] = [];
  answer: Answer;
  #onCrash: (() => void) | undefined;

  constructor(answer: Answer = (texts) => texts.map(() => [])) {
    this.answer = answer;
  }

  run(texts: readonly string[]): Promise<unknown> {
    this.calls.push(texts);
    // A microtask later, like a reply from a worker, and a throwing answer
    // becomes a rejection.
    return Promise.resolve().then(() => this.answer(texts));
  }

  onCrash(listener: () => void): void {
    this.#onCrash = listener;
  }

  crash(): void {
    this.#onCrash?.();
  }
}

/** An answer that is every occurrence of each of `names`, scored `score`. */
export const occurrencesOf =
  (names: readonly string[], score = 0.95): Answer =>
  (texts) =>
    texts.map((text) =>
      names.flatMap((name) => {
        const found = [];
        for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + name.length)) {
          found.push({ start: at, end: at + name.length, score });
        }
        return found;
      }),
    );

/** A promise and the functions that settle it, for answers that wait. */
export function gate<T = unknown>(): {
  promise: Promise<T>;
  open: (value: T) => void;
  fail: (error: unknown) => void;
} {
  let open!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

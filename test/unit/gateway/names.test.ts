// The name detector in the request path (ADR-037), against the fake model:
// one request at a time, a fixed queue, a timeout, a crash that is never
// repaired, and the start-up checks. Every failure is a 503 that names its
// reason only in the logs.

import { describe, expect, it } from 'vitest';
import { GAZETTEER } from '../../../src/detection/names/gazetteer.js';
import {
  NameDetectionUnavailable,
  NameStartupError,
  safeErrorDetails,
  toGatewayError,
} from '../../../src/gateway/errors.js';
import {
  checkNameList,
  listSha256,
  NAME_LIST_SHA256,
  NameDetector,
  startNameDetection,
  type NameDetectorOptions,
} from '../../../src/gateway/names.js';
import { FakeNameModel, gate, occurrencesOf } from '../../support/fake-name-model.js';
import { SUCCESS_DEADLINE_MS } from '../../support/mock-provider.js';

const TEXT = 'Please ask Asha Rao about it.';
const OPTIONS: NameDetectorOptions = { timeoutMs: SUCCESS_DEADLINE_MS, maxQueue: 4 };

const detector = (model: FakeNameModel, options: Partial<NameDetectorOptions> = {}): NameDetector =>
  new NameDetector(model, { ...OPTIONS, ...options }, new Set());

/** The reason a find() was refused for, or 'resolved'. */
async function outcome(found: Promise<unknown>): Promise<string> {
  try {
    await found;
    return 'resolved';
  } catch (error) {
    expect(error).toBeInstanceOf(NameDetectionUnavailable);
    return (error as NameDetectionUnavailable).reason;
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('NameDetector: answers', () => {
  it("returns each text's names with the text itself, in order", async () => {
    const model = new FakeNameModel(occurrencesOf(['Asha Rao']));
    const names = await detector(model).find([TEXT, 'nothing here']);
    expect(names).toEqual([
      { text: TEXT, spans: [{ start: 11, end: 19 }] },
      { text: 'nothing here', spans: [] },
    ]);
    expect(model.calls).toEqual([[TEXT, 'nothing here']]);
  });

  it("joins F's names from the list it was given (here none, so only the model's)", async () => {
    const model = new FakeNameModel(occurrencesOf(['Rao'], 0.5));
    // 0.5 is under both of B's thresholds: nothing is kept.
    expect(await detector(model).find([TEXT])).toEqual([{ text: TEXT, spans: [] }]);
  });

  it('runs the model on one request at a time, in order', async () => {
    const first = gate();
    const model = new FakeNameModel(() => first.promise);
    const d = detector(model);
    const a = d.find(['a']);
    const b = d.find(['b']);
    await tick();
    expect(model.calls).toEqual([['a']]);
    model.answer = (texts) => texts.map(() => []);
    first.open([[]]);
    await Promise.all([a, b]);
    expect(model.calls).toEqual([['a'], ['b']]);
  });
});

describe('NameDetector: fail closed, always a 503 (ADR-036)', () => {
  it('a full queue refuses at once, without calling the model', async () => {
    const running = gate();
    const model = new FakeNameModel(() => running.promise);
    const d = detector(model, { maxQueue: 1 });
    const a = d.find(['a']);
    const b = d.find(['b']);
    expect(await outcome(d.find(['c']))).toBe('queue_full');
    model.answer = (texts) => texts.map(() => []);
    running.open([[]]);
    expect([await outcome(a), await outcome(b)]).toEqual(['resolved', 'resolved']);
    expect(model.calls).toEqual([['a'], ['b']]);
  });

  it('with no queue, any request while the model works is refused', async () => {
    const running = gate();
    const d = detector(new FakeNameModel(() => running.promise), { maxQueue: 0 });
    const a = d.find(['a']);
    expect(await outcome(d.find(['b']))).toBe('queue_full');
    running.open([[]]);
    expect(await outcome(a)).toBe('resolved');
  });

  it('a request that waits too long in the queue is refused and never run', async () => {
    const running = gate();
    const model = new FakeNameModel(() => running.promise);
    const d = detector(model, { timeoutMs: 20 });
    const a = d.find(['a']);
    const b = d.find(['b']);
    expect(await outcome(a)).toBe('timeout');
    expect(await outcome(b)).toBe('timeout');
    running.open([[]]);
    await tick();
    await tick();
    expect(model.calls).toEqual([['a']]);
  });

  it('a request the model takes too long on is refused; the next starts only when the model is done', async () => {
    const running = gate();
    const model = new FakeNameModel(() => running.promise);
    const d = detector(model, { timeoutMs: 20 });
    expect(await outcome(d.find(['a']))).toBe('timeout');
    model.answer = (texts) => texts.map(() => []);
    const b = detector(model).find(['other detector']);
    await b;
    // The same detector: still busy with the abandoned call.
    const c = d.find(['c']);
    await tick();
    expect(model.calls.map((texts) => texts[0])).toEqual(['a', 'other detector']);
    running.open([[]]);
    expect(await outcome(c)).toBe('resolved');
    expect(model.calls.map((texts) => texts[0])).toEqual(['a', 'other detector', 'c']);
  });

  it('a model that rejects, or throws as it is called, fails that request only', async () => {
    const model = new FakeNameModel(() => {
      throw new Error('model failure quoting Asha Rao');
    });
    const d = detector(model);
    expect(await outcome(d.find([TEXT]))).toBe('failed');
    const throwing = {
      run: (): Promise<unknown> => {
        throw new Error('synchronous failure');
      },
      onCrash: (): void => {},
    };
    const sync = new NameDetector(throwing, OPTIONS, new Set());
    expect(await outcome(sync.find([TEXT]))).toBe('failed');
    model.answer = (texts) => texts.map(() => []);
    expect(await outcome(d.find([TEXT]))).toBe('resolved');
    expect(d.healthy).toBe(true);
  });

  it.each([
    ['not a list', () => 'spans'],
    ['one list too few', () => []],
    [
      'a span past the end',
      (texts: readonly string[]) => [[{ start: 0, end: texts[0]!.length + 1, score: 1 }]],
    ],
    ['a negative offset', () => [[{ start: -1, end: 2, score: 1 }]]],
    ['start after end', () => [[{ start: 5, end: 2, score: 1 }]]],
    ['a score over 1', () => [[{ start: 0, end: 2, score: 2 }]]],
    [
      'more spans than characters',
      () => [Array.from({ length: 40 }, () => ({ start: 0, end: 1, score: 1 }))],
    ],
  ])('an unreadable answer (%s) is refused as malformed', async (_label, answer) => {
    expect(await outcome(detector(new FakeNameModel(answer)).find([TEXT]))).toBe('malformed');
  });

  it('a crash fails the running and queued requests, and every later one without calling the model', async () => {
    const running = gate();
    const model = new FakeNameModel(() => running.promise);
    const d = detector(model);
    const a = d.find(['a']);
    const b = d.find(['b']);
    await tick();
    expect(d.healthy).toBe(true);
    model.crash();
    expect([await outcome(a), await outcome(b)]).toEqual(['crashed', 'crashed']);
    expect(d.healthy).toBe(false);
    expect(await outcome(d.find(['c']))).toBe('crashed');
    // The abandoned call settling later changes nothing: no restart.
    running.open([[]]);
    await tick();
    await tick();
    expect(model.calls).toEqual([['a']]);
    expect(d.healthy).toBe(false);
  });

  it('a model held past the timeout is unhealthy until the call ends, then healthy again', async () => {
    const running = gate();
    const model = new FakeNameModel(() => running.promise);
    const d = detector(model, { timeoutMs: 20, maxQueue: 0 });
    const a = d.find(['a']);
    expect(d.healthy).toBe(true);
    expect(await outcome(a)).toBe('timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(d.healthy).toBe(false);
    // Meanwhile nothing can be served.
    expect(await outcome(d.find(['b']))).toBe('queue_full');
    running.open([[]]);
    await tick();
    await tick();
    expect(d.healthy).toBe(true);
    model.answer = (texts) => texts.map(() => []);
    expect(await outcome(d.find(['c']))).toBe('resolved');
  });

  it('a model that answers in time stays healthy, even with the queue full', async () => {
    const running = gate();
    const d = detector(new FakeNameModel(() => running.promise), { maxQueue: 0 });
    const a = d.find(['a']);
    expect(await outcome(d.find(['b']))).toBe('queue_full');
    expect(d.healthy).toBe(true);
    running.open([[]]);
    expect(await outcome(a)).toBe('resolved');
    expect(d.healthy).toBe(true);
  });

  it('a request that timed out while running stays a timeout when the model then crashes', async () => {
    const running = gate();
    const model = new FakeNameModel(() => running.promise);
    const d = detector(model, { timeoutMs: 20 });
    const a = d.find(['a']);
    expect(await outcome(a)).toBe('timeout');
    model.crash();
    expect(await outcome(a)).toBe('timeout');
    expect(d.healthy).toBe(false);
  });

  it('a crash while idle makes the detector unhealthy at once', async () => {
    const model = new FakeNameModel();
    const d = detector(model);
    model.crash();
    expect(d.healthy).toBe(false);
    expect(await outcome(d.find(['a']))).toBe('crashed');
    expect(model.calls).toEqual([]);
  });

  it('a client that has left is refused: before, while queued and while running', async () => {
    const running = gate();
    const model = new FakeNameModel(() => running.promise);
    const d = detector(model);
    const gone = new AbortController();
    gone.abort();
    expect(await outcome(d.find(['x'], gone.signal))).toBe('aborted');

    const leavesWhileRunning = new AbortController();
    const leavesWhileQueued = new AbortController();
    const a = d.find(['a'], leavesWhileRunning.signal);
    const b = d.find(['b'], leavesWhileQueued.signal);
    leavesWhileQueued.abort();
    expect(await outcome(b)).toBe('aborted');
    leavesWhileRunning.abort();
    expect(await outcome(a)).toBe('aborted');
    running.open([[]]);
    await tick();
    await tick();
    expect(model.calls).toEqual([['a']]);
  });

  it('aborting after the answer came changes nothing', async () => {
    const controller = new AbortController();
    const names = await detector(new FakeNameModel()).find([TEXT], controller.signal);
    controller.abort();
    expect(names).toEqual([{ text: TEXT, spans: [] }]);
  });

  it('every refusal is the same fixed 503; only the logs say why, and never with text', () => {
    for (const reason of [
      'timeout',
      'queue_full',
      'crashed',
      'failed',
      'malformed',
      'aborted',
    ] as const) {
      const error = new NameDetectionUnavailable(reason);
      expect(toGatewayError(error, 1).body()).toEqual({
        error: {
          message: 'name detection is unavailable',
          type: 'api_error',
          param: null,
          code: 'name_detection_unavailable',
        },
      });
      expect(toGatewayError(error, 1).statusCode).toBe(503);
      expect(safeErrorDetails(error)).toEqual({
        name: 'NameDetectionUnavailable',
        code: 'name_detection_unavailable',
        reason,
      });
    }
  });
});

describe('startNameDetection: refuses to start unless the list and the model are right (ADR-036)', () => {
  it('pins the measured list: the gazetteer hashes to NAME_LIST_SHA256', () => {
    expect(NAME_LIST_SHA256).toBe(
      '313b89ea3a88ba35265f8f8bf5d2022c8dd85e90cdff4744bc3bb388821f3951',
    );
    expect(listSha256(GAZETTEER)).toBe(NAME_LIST_SHA256);
  });

  it('hashes the canonical form: order does not matter, content does', () => {
    expect(listSha256(new Set(['b', 'a']))).toBe(listSha256(new Set(['a', 'b'])));
    expect(listSha256(new Set(['a']))).not.toBe(listSha256(new Set(['a', 'b'])));
  });

  it('starts with the gazetteer and a model that loads', async () => {
    const model = new FakeNameModel(occurrencesOf(['Asha Rao']));
    const d = await startNameDetection(() => Promise.resolve(model), OPTIONS);
    expect(await d.find([TEXT])).toEqual([{ text: TEXT, spans: [{ start: 11, end: 19 }] }]);
  });

  it('a list that differs from the measured one refuses before the model is loaded', async () => {
    let loads = 0;
    const load = (): Promise<FakeNameModel> => {
      loads++;
      return Promise.resolve(new FakeNameModel());
    };
    const changed = new Set([...GAZETTEER, 'extra']);
    const missing = new Set([...GAZETTEER].slice(1));
    for (const list of [changed, missing, new Set<string>()]) {
      const refused = startNameDetection(load, OPTIONS, list);
      await expect(refused).rejects.toBeInstanceOf(NameStartupError);
      await expect(refused).rejects.toMatchObject({ code: 'NAME_LIST_MISMATCH' });
    }
    expect(loads).toBe(0);
  });

  it('checkNameList, called directly: the gazetteer passes, any other list refuses', () => {
    expect(() => checkNameList(GAZETTEER)).not.toThrow();
    const lists = [
      new Set([...GAZETTEER, 'extra']),
      new Set([...GAZETTEER].slice(1)),
      new Set([...GAZETTEER].map((name, i) => (i === 0 ? `${name}x` : name))),
      new Set<string>(),
    ];
    for (const list of lists) {
      expect(() => checkNameList(list)).toThrow(NameStartupError);
      try {
        checkNameList(list);
      } catch (error) {
        expect(safeErrorDetails(error)).toEqual({
          name: 'NameStartupError',
          code: 'NAME_LIST_MISMATCH',
        });
      }
    }
  });

  it('a model file refusal keeps its code and file: the operator learns which file', async () => {
    for (const code of ['NAME_MODEL_FILE_MISSING', 'NAME_MODEL_FILE_MISMATCH'] as const) {
      const refused = startNameDetection(
        () => Promise.reject(new NameStartupError(code, 'onnx/model_quantized.onnx')),
        OPTIONS,
      );
      const error = await refused.catch((e: unknown) => e);
      expect(safeErrorDetails(error)).toEqual({
        name: 'NameStartupError',
        code,
        file: 'onnx/model_quantized.onnx',
      });
    }
  });

  it('a model that fails to load refuses start-up, keeping nothing of its error', async () => {
    const refused = startNameDetection(
      () => Promise.reject(new Error('cannot open /models/Asha Rao.onnx')),
      OPTIONS,
    );
    await expect(refused).rejects.toBeInstanceOf(NameStartupError);
    const error = (await refused.catch((e: unknown) => e)) as NameStartupError;
    expect(error.code).toBe('NAME_MODEL_LOAD_FAILED');
    expect(error.message).toBe('name detection could not start');
    expect(safeErrorDetails(error)).toEqual({
      name: 'NameStartupError',
      code: 'NAME_MODEL_LOAD_FAILED',
    });
  });
});

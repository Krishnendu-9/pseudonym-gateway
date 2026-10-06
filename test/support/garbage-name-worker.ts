// The real name model in its own worker thread, with its answers corrupted
// (names tests, Phase 6b step 4b): the runtime, B and the channel are the
// shipped ones; only the answer is changed on its way back, one way per
// call, in the order of CORRUPTIONS, so that the gateway's check of an
// untrusted answer is tested against what the real model produces. The
// production entry has no test hook; this file is its stand-in.

import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import { loadBert, type Ort } from '../../src/detection/names/bert.js';
import type { ScoredSpan } from '../../src/detection/names/spans.js';
import type { NameRequest } from '../../src/gateway/name-worker.js';

type Answer = ScoredSpan[][];

/** Each call's answer, from B's real one. The last leaves it as it is. */
const CORRUPTIONS: readonly [string, (answer: Answer, texts: readonly string[]) => unknown][] = [
  [
    'an offset past the end',
    (a, t) => a.map((s, i) => [...s, { start: 0, end: t[i]!.length + 1, score: 0.99 }]),
  ],
  ['a negative offset', (a) => a.map((s) => [...s, { start: -1, end: 2, score: 0.99 }])],
  ['start after end', (a) => a.map((s) => [...s, { start: 3, end: 1, score: 0.99 }])],
  [
    'a score that is not a number',
    (a) => a.map((s) => [...s, { start: 0, end: 1, score: Number.NaN }]),
  ],
  ['a score above 1', (a) => a.map((s) => [...s, { start: 0, end: 1, score: 1.5 }])],
  ['one list too many', (a) => [...a, []]],
  ['not a list', () => ({ spans: 'none' })],
  ['as answered', (a) => a],
];

const require = createRequire(import.meta.url);
const bert = await loadBert(
  {
    ort: require('onnxruntime-node') as Ort,
    Tokenizer: (require('@huggingface/tokenizers') as { Tokenizer: never }).Tokenizer,
  },
  (workerData as { dir: string }).dir,
);
let call = 0;
parentPort!.on('message', (request: NameRequest) => {
  void (async () => {
    const answer: Answer = [];
    for (const text of request.texts) answer.push(await bert.find(text));
    const [, corrupt] = CORRUPTIONS[call++ % CORRUPTIONS.length]!;
    parentPort!.postMessage({
      type: 'answer',
      id: request.id,
      spans: corrupt(answer, request.texts),
    });
  })();
});
parentPort!.postMessage({ type: 'ready' });

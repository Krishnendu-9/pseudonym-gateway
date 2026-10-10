// A stand-in for the name model's worker thread (Phase 6b step 4b): a real
// worker thread and the real channel, with B replaced by a scripted answer,
// so that WorkerNameModel is tested without the runtime or the model.
// `workerData.mode` picks the behaviour.

import { parentPort, workerData } from 'node:worker_threads';
import { serveNames } from '../../src/gateway/name-worker.js';

const { mode } = workerData as { mode: string };
const port = parentPort!;

const NAME = 'Zarvenka';
/** Every occurrence of NAME, scored 0.95. */
const occurrences = (text: string): { start: number; end: number; score: number }[] => {
  const found = [];
  for (let at = text.indexOf(NAME); at >= 0; at = text.indexOf(NAME, at + 1)) {
    found.push({ start: at, end: at + NAME.length, score: 0.95 });
  }
  return found;
};

switch (mode) {
  case 'names':
    serveNames(port, (text) => Promise.resolve(occurrences(text)));
    break;
  case 'garbage':
    // Spans no text has: the gateway must refuse them, not trust the thread.
    serveNames(port, () => Promise.resolve([{ start: -1, end: 1e9, score: 7 }]));
    break;
  case 'throws':
    serveNames(port, (text) => Promise.reject(new Error(`cannot read ${text}`)));
    break;
  case 'hangs':
    serveNames(port, () => new Promise(() => {}));
    break;
  case 'exits-on-call':
    port.on('message', () => process.exit(3));
    port.postMessage({ type: 'ready' });
    break;
  case 'strays':
    // A reply for no call, a second "ready", then the real answer.
    port.on('message', (request: { id: number }) => {
      port.postMessage({ type: 'answer', id: request.id + 100, spans: 'not this one' });
      port.postMessage({ type: 'ready' });
      port.postMessage({ type: 'answer', id: request.id, spans: [['the answer']] });
    });
    port.postMessage({ type: 'ready' });
    break;
  case 'telemetry-off':
    // Ready only if the thread was started with ONNX Runtime's telemetry
    // switch on (ADR-046); otherwise it exits, and start() refuses.
    if (process.env.ORT_DISABLE_TELEMETRY !== '1') process.exit(4);
    serveNames(port, (text) => Promise.resolve(occurrences(text)));
    break;
  case 'not-ready-first':
    port.postMessage({ type: 'answer', id: 0, spans: [] });
    setInterval(() => {}, 1_000);
    break;
  case 'never-ready':
    setInterval(() => {}, 1_000);
    break;
  case 'exits-before-ready':
    process.exit(0);
    break;
  default:
    // Loading failed, with an error that quotes its input.
    throw new Error(`could not load the model for ${NAME} Thalimor`);
}

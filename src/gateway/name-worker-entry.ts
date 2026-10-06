// The name model's worker thread (Phase 6b step 4b). Wiring only: load the
// runtime and B, then answer (serveNames, in name-worker.ts, has the logic
// and its tests). Excluded from coverage (vitest.config.ts): it runs only
// inside a worker thread, which the coverage run cannot see; the names
// tests (`npm run test:names`) and `npm run eval:names` run it for real.
//
// The runtime is the pair of optional dependencies (ADR-036 (a)), loaded
// here and nowhere else, so a gateway with names off never loads them, and
// an install without them refuses start-up with names on: this module then
// fails before it says it is ready.

import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import { loadBert, type Ort, type Runtime } from '../detection/names/bert.js';
import { serveNames } from './name-worker.js';

const require = createRequire(import.meta.url);
const runtime: Runtime = {
  ort: require('onnxruntime-node') as Ort,
  Tokenizer: (require('@huggingface/tokenizers') as { Tokenizer: never }).Tokenizer,
};
const bert = await loadBert(runtime, (workerData as { dir: string }).dir);
serveNames(parentPort!, bert.find);

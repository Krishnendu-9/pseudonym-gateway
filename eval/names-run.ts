// `npm run eval:names` (Phase 6b step 4b): person names through the gateway,
// on the messages ADR-035 measured, checked against eval/names-baseline.json
// (eval/names/gateway.ts says what is compared, and why).
//
//   npm run eval:names                     everything below; exit 1 on any difference
//   npx tsx eval/names-run.ts --no-speed   the comparison only (no timing runs)
//
// Needs the runtime (the optional dependencies) and the model
// (`npm run fetch:model`); not part of `npm run eval` or CI until then (6c).
// The generated set only: the held-out set is spent for names (ADR-035).
//
// How it runs, in one process, as the gateway would: the model starts in
// its worker thread through loadNameModel() (files checked first), the
// detector through startNameDetection() (list checked first), then
//  1. speed, as 6a timed it: a 16 KiB warm-up, then 256 KiB of the same
//     messages, each as one call to the detector (queue, the worker and its
//     messages, the answer's check, F and the join), then the added latency
//     at 1, 4, 16 and 64 KiB (median of 5, different text each time);
//  2. every message as its own request to POST /v1/chat/completions on the
//     real server (`app.inject`, a provider stub that answers "ok"),
//     recording B's raw answer and the names the server was given.
// Memory as 6a measured it: the process's peak resident memory minus what
// it held before the model started (the worker thread is in this process).
//
// Prints counts, hashes, timings and memory; never a text, a name or a span.
// Wiring only; every decision is in a tested module.

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { leftoverMutation } from '../scripts/mutation-marker.js';
import type { ScoredSpan } from '../src/detection/names/spans.js';
import type { Span } from '../src/detection/normalise.js';
import { loadNameModel, MODEL_ROOT, NAME_MODEL } from '../src/gateway/name-model.js';
import type { WorkerNameModel } from '../src/gateway/name-worker.js';
import { startNameDetection, type NameModel } from '../src/gateway/names.js';
import { buildServer, type NameFinder } from '../src/gateway/server.js';
import type { ChatProvider } from '../src/providers/provider.js';
import { generateCases } from './generate.js';
import {
  differences,
  firstMessages,
  messageTexts,
  modelSpansSha256,
  nameSpansSha256,
  textsSha256,
  type NamesBaseline,
} from './names/gateway.js';
import { LATENCY_SIZES_KIB, median, speedText } from './names/latency.js';
import { fpPer1000, measure, share } from './names/measure.js';

const REPO = join(import.meta.dirname, '..');
const BASELINE = join(REPO, 'eval', 'names-baseline.json');
const WARM_UP_BYTES = 16 * 1024;
const SPEED_BYTES = 256 * 1024;
const LATENCY_REPS = 5;
/** Each repetition starts this many messages further on (the script's REP_STRIDE). */
const REP_STRIDE = 211;
/** Long enough for 256 KiB on a slow run; the speed runs measure, they do not test the timeout. */
const TIMEOUT_MS = 30 * 60 * 1000;

const { values: args } = parseArgs({
  options: { 'no-speed': { type: 'boolean', default: false } },
});
const write = (line = ''): void => void process.stdout.write(`${line}\n`);
const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const refusal = leftoverMutation(REPO, process.env);
if (refusal) fail(`REFUSED. ${refusal}`);

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as NamesBaseline;
const cases = firstMessages(generateCases(), baseline.dataset.messages);
const texts = messageTexts(cases);
const mib = (bytes: number): string => `${(bytes / 2 ** 20).toFixed(0)} MiB`;

// The model and the detector, as main.ts starts them, with B's raw answers kept.
const baseRss = process.memoryUsage.rss();
const loadStart = performance.now();
let worker: WorkerNameModel | undefined;
const raw: unknown[] = [];
const detector = await startNameDetection(
  async () => {
    worker = (await loadNameModel(join(REPO, MODEL_ROOT, NAME_MODEL.dir))) as WorkerNameModel;
    const recording: NameModel = {
      run: async (batch) => {
        const answer = await worker!.run(batch);
        raw.push(answer);
        return answer;
      },
      onCrash: (listener) => worker!.onCrash(listener),
    };
    return recording;
  },
  { timeoutMs: TIMEOUT_MS, maxQueue: 0 },
);
const loadMs = performance.now() - loadStart;
const loadedRss = process.memoryUsage.rss();
write(`Model started in its worker in ${Math.round(loadMs)} ms (files hashed first).`);

// 1. Speed.
const timed = async (text: string): Promise<number> => {
  const started = performance.now();
  await detector.find([text]);
  return performance.now() - started;
};
let msPerKiB: number | undefined;
const latency: Record<number, number> = {};
if (!args['no-speed']) {
  await timed(speedText(texts, WARM_UP_BYTES));
  const full = speedText(texts, SPEED_BYTES);
  msPerKiB = (await timed(full)) / (Buffer.byteLength(full) / 1024);
  write(`Speed: ${msPerKiB.toFixed(1)} ms per KiB on ${Buffer.byteLength(full)} bytes.`);
  for (const kib of LATENCY_SIZES_KIB) {
    const runs: number[] = [];
    for (let rep = 0; rep < LATENCY_REPS; rep++) {
      runs.push(await timed(speedText(texts, kib * 1024, rep * REP_STRIDE)));
    }
    latency[kib] = median(runs)!;
  }
  write(
    `Added latency (median of ${LATENCY_REPS}): ${LATENCY_SIZES_KIB.map((k) => `${k} KiB ${Math.round(latency[k]!)} ms`).join(', ')}.`,
  );
}

// 2. Every message through the server.
raw.length = 0;
const found: (readonly Span[])[] = [];
const recordingFinder: NameFinder = {
  find: async (batch, signal) => {
    const names = await detector.find(batch, signal);
    found.push(...names.map((n) => n.spans));
    return names;
  },
  get healthy() {
    return detector.healthy;
  },
};
const provider: ChatProvider = {
  complete: () =>
    Promise.resolve({ id: 'eval', created: 0, content: 'ok', finishReason: 'stop' as const }),
  stream: () => Promise.reject(new Error('not used')),
};
const app = buildServer(
  {
    model: 'eval-names',
    bodyLimit: 4 * 2 ** 20,
    restoreInUnsafeRegions: false,
    placeholderInstruction: false,
    names: recordingFinder,
    logLevel: 'silent',
  },
  provider,
);
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
const setStart = performance.now();
for (const [i, text] of texts.entries()) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    payload: { model: 'eval-names', messages: [{ role: 'user', content: text }] },
  });
  if (response.statusCode !== 200) fail(`message ${i}: HTTP ${response.statusCode}`);
}
const setMs = performance.now() - setStart;
delay.disable();
await app.close();
const peakRss = process.resourceUsage().maxRSS * 1024;
await worker!.close();

if (raw.length !== texts.length || found.length !== texts.length) {
  fail(`expected ${texts.length} answers, got ${raw.length} from B and ${found.length} names`);
}
const modelSpans = raw.map((answer) => (answer as ScoredSpan[][])[0]!);
const byText = new Map<string, readonly Span[]>();
texts.forEach((text, i) => {
  if (!byText.has(text)) byText.set(text, found[i]!);
});
const measured: NamesBaseline = {
  dataset: { messages: texts.length, sha256: textsSha256(texts) },
  spans: { model: modelSpansSha256(modelSpans), names: nameSpansSha256(found) },
  detections: found.reduce((n, list) => n + list.length, 0),
  metrics: measure(cases, (text) => byText.get(text)!),
};

const m = measured.metrics;
const pct = (c: { hit: number; of: number }): string =>
  `${c.hit}/${c.of} (${(Math.floor(share(c) * 1000) / 10).toFixed(1)}%)`;
write();
write(
  `Messages: ${texts.length} (${cases.length} cases), through the server in ${Math.round(setMs / 1000)} s.`,
);
write(`B's spans:  ${measured.spans.model} (baseline ${baseline.spans.model.slice(0, 16)}…)`);
write(`Names:      ${measured.spans.names} (baseline ${baseline.spans.names.slice(0, 16)}…)`);
write(
  `Detections ${measured.detections}; R ${pct(m.recall)}; main PERSON ${pct(m.main)}; precision ${pct(m.precision)}; ${fpPer1000(m).toFixed(2)} per 1,000 words.`,
);
write(
  `Memory: ${mib(loadedRss - baseRss)} more resident after the model started; peak ${mib(peakRss - baseRss)} over the run (6a's measure); process peak ${mib(peakRss)}.`,
);
write(`Event loop: longest delay ${(delay.max / 1e6).toFixed(0)} ms while the messages ran.`);
const differ = differences(baseline, measured);
write();
if (differ.length > 0) fail(`DIFFERENT from eval/names-baseline.json: ${differ.join(', ')}`);
write("Identical to eval/names-baseline.json: messages, B's spans, the names, every metric.");

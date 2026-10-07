// `npm run eval:names` (Phase 6b step 4b): person names through the gateway,
// on the messages ADR-035 measured, checked against the baseline of the CPU
// model it runs on (eval/names-baselines.json; eval/names/gateway.ts says
// what is compared, and why).
//
//   npm run eval:names                     everything below
//   npx tsx eval/names-run.ts --no-speed   the comparison only (no timing runs)
//
// Exit 0: identical to this CPU's baseline, or a CPU with no baseline yet
// (a warning; its result is in names-result.json, to be committed by a
// human). Exit 1: different from this CPU's baseline, or the two passes
// over the messages disagree. names-result.json is written on every run.
//
// Needs the runtime (the optional dependencies) and the model
// (`npm run fetch:model`); run by the Names workflow, not by `npm run eval`.
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
//     recording B's raw answer and the names the server was given; then all
//     of them again, a second pass whose hashes must equal the first's.
// Memory as 6a measured it: the process's peak resident memory minus what
// it held before the model started (the worker thread is in this process).
//
// Prints counts, hashes, timings and memory; never a text, a name or a span.
// Wiring only; every decision is in a tested module.

import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release } from 'node:os';
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
  baselineFor,
  exitCode,
  firstMessages,
  messageTexts,
  modelSpansSha256,
  nameSpansSha256,
  outcome,
  outcomeLines,
  parseIndex,
  textsSha256,
  type NamesBaseline,
} from './names/gateway.js';
import { LATENCY_SIZES_KIB, median, speedText } from './names/latency.js';
import { fpPer1000, measure, share } from './names/measure.js';

const REPO = join(import.meta.dirname, '..');
/** The published baseline (the i5-12450H's): it also fixes which messages are measured. */
const REFERENCE = join(REPO, 'eval', 'names-baseline.json');
/** CPU model → baseline file (option C1, ADR-036). */
const INDEX = join(REPO, 'eval', 'names-baselines.json');
/** What this run measured, for a human to commit as a new CPU's baseline (gitignored). */
const RESULT = join(REPO, 'names-result.json');
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

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const reference = readJson(REFERENCE) as NamesBaseline;
const cpuModel = cpus()[0]?.model.trim() ?? 'unknown CPU';
const entry = baselineFor(parseIndex(readJson(INDEX)), cpuModel);
const baseline = entry && (readJson(join(REPO, 'eval', entry.file)) as NamesBaseline);
const cases = firstMessages(generateCases(), reference.dataset.messages);
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
// The machine, as ADR-036's pre-registered Linux comparison requires each
// run to record it: operating system and CPU model. The install variable is
// printed as this process sees it; what the install itself fetched is
// recorded where the install runs.
write(
  `Machine: ${platform()} ${release()} ${arch()}, ${cpus().length} logical CPUs, ` +
    `${cpuModel}, Node ${process.version}, ` +
    `ONNXRUNTIME_NODE_INSTALL in this run: ${process.env.ONNXRUNTIME_NODE_INSTALL ?? '(unset)'}.`,
);
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

// 2. Every message through the server, twice (option C3): the first pass
// is the one measured and compared; the second must give the same hashes.
let found: (readonly Span[])[] = [];
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
/** One pass of every message as its own request; B's raw answers and the names it gave, per message. */
async function pass(): Promise<{ modelSpans: ScoredSpan[][]; names: (readonly Span[])[] }> {
  raw.length = 0;
  found = [];
  for (const [i, text] of texts.entries()) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'eval-names', messages: [{ role: 'user', content: text }] },
    });
    if (response.statusCode !== 200) fail(`message ${i}: HTTP ${response.statusCode}`);
  }
  if (raw.length !== texts.length || found.length !== texts.length) {
    fail(`expected ${texts.length} answers, got ${raw.length} from B and ${found.length} names`);
  }
  return { modelSpans: raw.map((answer) => (answer as ScoredSpan[][])[0]!), names: found };
}

const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
const setStart = performance.now();
const first = await pass();
const setMs = performance.now() - setStart;
delay.disable();
const second = await pass();
await app.close();
const peakRss = process.resourceUsage().maxRSS * 1024;
await worker!.close();

const byText = new Map<string, readonly Span[]>();
texts.forEach((text, i) => {
  if (!byText.has(text)) byText.set(text, first.names[i]!);
});
const measured: NamesBaseline = {
  dataset: { messages: texts.length, sha256: textsSha256(texts) },
  spans: { model: modelSpansSha256(first.modelSpans), names: nameSpansSha256(first.names) },
  detections: first.names.reduce((n, list) => n + list.length, 0),
  metrics: measure(cases, (text) => byText.get(text)!),
};
const repeat = {
  model: modelSpansSha256(second.modelSpans),
  names: nameSpansSha256(second.names),
};

const m = measured.metrics;
const pct = (c: { hit: number; of: number }): string =>
  `${c.hit}/${c.of} (${(Math.floor(share(c) * 1000) / 10).toFixed(1)}%)`;
write();
write(
  `Messages: ${texts.length} (${cases.length} cases), through the server in ${Math.round(setMs / 1000)} s.`,
);
const against = (hash: string | undefined): string =>
  hash === undefined ? 'no baseline for this CPU' : `baseline ${hash.slice(0, 16)}…`;
write(`B's spans:  ${measured.spans.model} (${against(baseline?.spans.model)})`);
write(`Names:      ${measured.spans.names} (${against(baseline?.spans.names)})`);
write(
  `Second pass: B's spans ${repeat.model.slice(0, 16)}…, names ${repeat.names.slice(0, 16)}… (must equal the first).`,
);
write(
  `Detections ${measured.detections}; R ${pct(m.recall)}; main PERSON ${pct(m.main)}; precision ${pct(m.precision)}; ${fpPer1000(m).toFixed(2)} per 1,000 words.`,
);
write(
  `Memory: ${mib(loadedRss - baseRss)} more resident after the model started; peak ${mib(peakRss - baseRss)} over the run (6a's measure); process peak ${mib(peakRss)}.`,
);
write(`Event loop: longest delay ${(delay.max / 1e6).toFixed(0)} ms while the messages ran.`);
const result = outcome(measured, repeat, baseline);
// Hashes and counts only, never a text: a new CPU's baseline is committed from it.
writeFileSync(
  RESULT,
  `${JSON.stringify(
    {
      machine: {
        platform: platform(),
        release: release(),
        arch: arch(),
        logicalCpus: cpus().length,
        cpuModel,
        node: process.version,
      },
      outcome: result,
      secondPass: repeat,
      measured,
    },
    null,
    2,
  )}\n`,
);
write();
for (const line of outcomeLines(result, cpuModel, entry)) write(line);
if (result.kind === 'new-cpu' && process.env.GITHUB_ACTIONS === 'true') {
  write(`::warning title=New CPU, no names baseline::${cpuModel}: see names-result.json`);
}
process.exitCode = exitCode(result);

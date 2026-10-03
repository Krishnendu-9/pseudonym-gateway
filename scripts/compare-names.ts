// The Phase 6a comparison of name detectors (ADR-035): candidates A, B, D,
// E and F on the generated set, the stopping rule applied to the results.
//
//   npx tsx scripts/compare-names.ts --held-out-committed --out <dir outside the repo>
//       [--runtime D:/pseudonym-6a] [--candidates A,B,D,F,E] [--ollama-model <name>]
//   npx tsx scripts/compare-names.ts --held-out-committed --out <dir> --held-out <id>
//       runs the chosen configuration once on the held-out set (PERSON row only)
//   npx tsx scripts/compare-names.ts --held-out-committed --out <dir> --smoke
//       loads every candidate and runs it on one fixed sentence that is in no
//       dataset; prints how many spans each found (a check of the wiring)
//   npx tsx scripts/compare-names.ts --held-out-committed --out <dir> --latency
//       added latency at 1, 4, 16 and 64 KiB per candidate, tokens per KiB for
//       the models, and Ollama's own time to first token (in E's child)
//
// Each child prints progress (counts, never text). One that prints nothing
// for 10 minutes is killed, and the run stops, writing why to STOPPED.txt
// in --out; so does a candidate that fails. Nothing is retried.
//
// No model runs without --held-out-committed: 6a waits until the extra
// held-out PERSON cases are committed, so that set stays blind (ADR-035).
//
// Each candidate runs in a child process of its own, so that its peak
// memory is its own. A child writes the spans it found (offsets and
// scores, never text) to --out; the parent scores them with eval/names and
// prints counts. No text, no name and no value is printed or written.
//
// The runtime (onnxruntime-node, @huggingface/tokenizers) and the models
// live outside the repo, in --runtime; they are not project dependencies.
//
// Wiring only (files in, processes, text out); every decision is in a
// tested module under eval/names or src/detection/names.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { generateCases } from '../eval/generate.js';
import { loadHeldOut } from '../eval/held-out.js';
import { listSpans } from '../src/detection/names/gazetteer.js';
import {
  glinerFedTokens,
  glinerPrompt,
  glinerSpans,
  type GlinerFeeds,
  type GlinerSetup,
  type GlinerSpan,
} from '../eval/names/gliner.js';
import { LATENCY_SIZES_KIB, median, perKiB, tokensByScript } from '../eval/names/latency.js';
import { isContextRefusal, locate, namesMessages, parseNames } from '../eval/names/llm.js';
import { compareCard, parseCard } from '../eval/names/gliner-card.js';
import { fpPer1000, measure, share, type Metrics } from '../eval/names/measure.js';
import { choosePoint, decide, failedLimits, LIMITS, type Measured } from '../eval/names/rule.js';
import { grid } from '../eval/names/spans.js';
import { fedTokens } from '../eval/names/token-classification.js';
import { glinerWords } from '../eval/names/words.js';
import { detectionsAt, merge, type Point, type ScoredSpan } from '../src/detection/names/spans.js';
import {
  labelWords,
  personSpans,
  type BertSetup,
  type EncodedWord,
} from '../src/detection/names/token-classification.js';
import { bertWords, type Word } from '../src/detection/names/words.js';
import type { LabelledCase } from '../eval/types.js';
import { WIKIDATA_NAMES } from '../src/synthetic/wikidata-names.js';
import { leftoverMutation } from './mutation-marker.js';

const REPO = resolve(import.meta.dirname, '..');
// E last: it is by far the slowest, and each candidate's results are saved
// as it finishes, so a stop during E keeps the others.
const CANDIDATES = ['A', 'B', 'D', 'F', 'E'] as const;
type CandidateId = (typeof CANDIDATES)[number];
const MODEL_DIRS: Readonly<Record<'A' | 'B' | 'D', string>> = {
  A: 'models/Xenova__bert-base-NER@8e892123e8b7',
  B: 'models/Xenova__bert-base-multilingual-cased-ner-hrl@263e82c06569',
  D: 'models/onnx-community__gliner_multi_pii-v1@2e0397a7e8a2',
};
const SPEED_BYTES = 256 * 1024;
const WARM_UP_BYTES = 16 * 1024;
/** The whole 256 KiB budget at the speed limit: more than this for 16 KiB is over. */
const SPEED_BUDGET_MS = LIMITS.msPerKiB * 256;
const OLLAMA_SEED = 20_261_003;
const OLLAMA_TIMEOUT_MS = 300_000;
/** A child that prints no progress for this long is stopped, and so is the run. */
const STALL_MS = 10 * 60 * 1000;
/** A child prints progress at most this often (and at every phase). */
const PROGRESS_EVERY_MS = 30_000;

const { values: args } = parseArgs({
  options: {
    'held-out-committed': { type: 'boolean', default: false },
    out: { type: 'string' },
    runtime: { type: 'string', default: 'D:/pseudonym-6a' },
    candidates: { type: 'string', default: CANDIDATES.join(',') },
    'ollama-model': { type: 'string', default: 'qwen3:4b-instruct-2507-q4_K_M' },
    'ollama-url': { type: 'string', default: 'http://127.0.0.1:11434' },
    child: { type: 'string' },
    'held-out': { type: 'string' },
    point: { type: 'string' },
    smoke: { type: 'boolean', default: false },
    latency: { type: 'boolean', default: false },
    'gliner-card': { type: 'boolean', default: false },
    'gliner-file': { type: 'string', default: 'model_quantized.onnx' },
  },
});

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const refusal = leftoverMutation(REPO, process.env);
if (refusal) fail(`REFUSED. ${refusal}`);
if (!args['held-out-committed']) {
  fail(
    'REFUSED. No model runs until the extra held-out PERSON cases are committed (ADR-035). ' +
      'When they are, pass --held-out-committed.',
  );
}
if (!args.out) fail('usage: --out <directory outside the repo> is required');
const out = resolve(args.out!);
// On another drive, relative() gives an absolute path, not one starting "..".
const fromRepo = relative(REPO, out);
if (!fromRepo.startsWith('..') && !isAbsolute(fromRepo)) fail('--out must be outside the repo');
mkdirSync(out, { recursive: true });

// ---------------------------------------------------------------------------
// The runtime, loaded from outside the repo, typed by what is used of it.

interface OrtTensor {
  readonly data: Float32Array;
}
interface OrtSession {
  readonly inputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
}
interface Ort {
  InferenceSession: { create(path: string): Promise<OrtSession> };
  Tensor: new (type: string, data: unknown, dims: readonly number[]) => unknown;
}
interface Tokenizer {
  encode(text: string, options: { add_special_tokens: boolean }): { ids: number[] };
}

function runtime(): { ort: Ort; Tokenizer: new (json: unknown, config: unknown) => Tokenizer } {
  const require = createRequire(join(resolve(args.runtime), 'package.json'));
  return {
    ort: require('onnxruntime-node') as Ort,
    Tokenizer: (require('@huggingface/tokenizers') as { Tokenizer: never }).Tokenizer,
  };
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const int64 = (values: readonly number[]): BigInt64Array =>
  BigInt64Array.from(values, (v) => BigInt(v));

/** A candidate's names in `text`; `timeoutMs` bounds E's call (the models cannot be stopped). */
type Find = (text: string, timeoutMs?: number) => Promise<ScoredSpan[]>;

/** A loaded candidate; the models also count tokens: the text's own, and what the model is fed. */
interface Loaded {
  readonly find: Find;
  readonly count?: (text: string) => { readonly text: number; readonly fed: number };
}

/** Ollama refused a request for being longer than its context (bug-log 55). */
class ContextRefusal extends Error {
  override readonly name = 'ContextRefusal';
}

/** Encodes each word on its own, without special tokens; words that encode to nothing are dropped. */
function encodeWords(tokenizer: Tokenizer, words: readonly Word[]): EncodedWord[] {
  return words
    .map((w) => ({ ...w, ids: tokenizer.encode(w.text, { add_special_tokens: false }).ids }))
    .filter((w) => w.ids.length > 0);
}

async function bertCandidate(id: 'A' | 'B'): Promise<Loaded> {
  const { ort, Tokenizer } = runtime();
  const dir = join(resolve(args.runtime), MODEL_DIRS[id]);
  const tokenizer = new Tokenizer(
    readJson(join(dir, 'tokenizer.json')),
    readJson(join(dir, 'tokenizer_config.json')),
  );
  const config = readJson(join(dir, 'config.json')) as { id2label: Record<string, string> };
  const labels = Object.keys(config.id2label)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => config.id2label[k]!);
  const session = await ort.InferenceSession.create(join(dir, 'onnx', 'model_quantized.onnx'));
  const special = (text: string): number =>
    tokenizer.encode(text, { add_special_tokens: false }).ids[0]!;
  const setup: BertSetup = {
    clsId: special('[CLS]'),
    sepId: special('[SEP]'),
    labels,
    maxTokens: 512,
    context: 64,
  };
  const run = async (ids: readonly number[]): Promise<Float32Array> => {
    const dims = [1, ids.length];
    const feeds: Record<string, unknown> = {
      input_ids: new ort.Tensor('int64', int64(ids), dims),
      attention_mask: new ort.Tensor('int64', int64(ids.map(() => 1)), dims),
    };
    if (session.inputNames.includes('token_type_ids')) {
      feeds.token_type_ids = new ort.Tensor('int64', int64(ids.map(() => 0)), dims);
    }
    return (await session.run(feeds)).logits!.data;
  };
  return {
    find: async (text) => {
      const words = encodeWords(tokenizer, bertWords(text));
      return personSpans(words, await labelWords(words, setup, run));
    },
    count: (text) => {
      const words = encodeWords(tokenizer, bertWords(text));
      return { text: words.reduce((n, w) => n + w.ids.length, 0), fed: fedTokens(words, setup) };
    },
  };
}

/** D, with its spans' labels as well (the model-card check asks for several). */
interface GlinerLoaded extends Loaded {
  readonly spans: (text: string) => Promise<GlinerSpan[]>;
}

/**
 * Candidate D. The comparison asks for one label, "person", with the int8
 * model and the grid's floor; the model-card check (--gliner-card) passes
 * the card's labels, its threshold and, to tell the port from the
 * quantisation, a full-precision file.
 */
async function glinerCandidate({
  labels = ['person'],
  file = 'model_quantized.onnx',
  floor = Math.min(...grid().map((p) => p.mid ?? p.high)),
}: { labels?: readonly string[]; file?: string; floor?: number } = {}): Promise<GlinerLoaded> {
  const { ort, Tokenizer } = runtime();
  const dir = join(resolve(args.runtime), MODEL_DIRS.D);
  const tokenizer = new Tokenizer(
    readJson(join(dir, 'tokenizer.json')),
    readJson(join(dir, 'tokenizer_config.json')),
  );
  const gliner = readJson(join(dir, 'gliner_config.json')) as {
    max_width: number;
    max_len: number;
  };
  const session = await ort.InferenceSession.create(join(dir, 'onnx', file));
  const ids = (text: string): number[] => tokenizer.encode(text, { add_special_tokens: false }).ids;
  const setup: GlinerSetup = {
    clsId: ids('[CLS]')[0]!,
    sepId: ids('[SEP]')[0]!,
    prompt: glinerPrompt(ids('<<ENT>>'), ids('<<SEP>>'), labels.map(ids)),
    labels: labels.length,
    maxWidth: gliner.max_width,
    maxWords: gliner.max_len,
    maxTokens: 512,
    floor,
  };
  const run = async (f: GlinerFeeds): Promise<Float32Array> => {
    const n = f.inputIds.length;
    const spans = f.spanMask.length;
    const result = await session.run({
      input_ids: new ort.Tensor('int64', int64(f.inputIds), [1, n]),
      attention_mask: new ort.Tensor('int64', int64(f.attentionMask), [1, n]),
      words_mask: new ort.Tensor('int64', int64(f.wordsMask), [1, n]),
      text_lengths: new ort.Tensor('int64', int64([f.textLength]), [1, 1]),
      span_idx: new ort.Tensor('int64', int64(f.spanIdx), [1, spans, 2]),
      span_mask: new ort.Tensor('bool', Uint8Array.from(f.spanMask, Number), [1, spans]),
    });
    return result.logits!.data;
  };
  const spans = (text: string): Promise<GlinerSpan[]> =>
    glinerSpans(encodeWords(tokenizer, glinerWords(text)), setup, run);
  return {
    find: spans,
    spans,
    count: (text) => {
      const words = encodeWords(tokenizer, glinerWords(text));
      return {
        text: words.reduce((n, w) => n + w.ids.length, 0),
        fed: glinerFedTokens(words, setup),
      };
    },
  };
}

let invented = 0;
let unparsed = 0;
function llmCandidate(): Find {
  return async (text, timeoutMs = OLLAMA_TIMEOUT_MS) => {
    const response = await fetch(`${args['ollama-url']}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: args['ollama-model'],
        messages: namesMessages(text),
        temperature: 0,
        seed: OLLAMA_SEED,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      if (isContextRefusal(response.status, await response.text())) throw new ContextRefusal();
      fail(`Ollama answered HTTP ${response.status}`);
    }
    const body = (await response.json()) as { choices: { message: { content: string } }[] };
    const names = parseNames(body.choices[0]!.message.content);
    if (names === undefined) {
      unparsed++;
      return [];
    }
    const found = locate(text, names);
    invented += found.invented;
    return found.spans;
  };
}

const GAZETTEER: ReadonlySet<string> = new Set(
  Object.values(WIKIDATA_NAMES).flatMap((r) =>
    [...r.gazetteerGiven, ...r.gazetteerFamily].flatMap(([latin, devanagari]) =>
      devanagari === undefined ? [latin.toLowerCase()] : [latin.toLowerCase(), devanagari],
    ),
  ),
);

async function candidate(id: CandidateId): Promise<Loaded> {
  if (id === 'A' || id === 'B') return bertCandidate(id);
  if (id === 'D') return glinerCandidate();
  if (id === 'E') return { find: llmCandidate() };
  return { find: async (text) => listSpans(text, GAZETTEER) };
}

// ---------------------------------------------------------------------------
// A child: one candidate on the generated set (or the held-out set).

interface ChildResult {
  readonly id: CandidateId;
  /** Per message, in dataset order: [start, end, score] of each span. */
  readonly spans: (readonly [number, number, number])[][];
  readonly namesBlockOnly: boolean;
  readonly msPerKiB: number;
  readonly memoryBytes: number;
  readonly loadMs: number;
  readonly eventLoopMaxMs: number;
  readonly invented: number;
  readonly unparsed: number;
  /** SHA-256 of the spans, to compare runs (and machines) without the spans. */
  readonly spanHash: string;
  readonly threads: number;
  /** Why the speed is over the limit when no 256 KiB run was made. */
  readonly overReason?: 'time' | 'context';
}

const messagesOf = (cases: readonly LabelledCase[]): string[] =>
  cases.flatMap((c) => c.messages.map((m) => m.text));

/**
 * Generated messages joined by blank lines, from message `from` (the first
 * by default) and round again if need be (the whole set is about 248 KiB),
 * until the next would pass `bytes` of UTF-8.
 */
function speedText(texts: readonly string[], bytes: number, from = 0): string {
  const parts: string[] = [];
  let size = 0;
  for (let i = from; ; i++) {
    const text = texts[i % texts.length]!;
    const add = Buffer.byteLength(text) + (parts.length > 0 ? 2 : 0);
    if (size + add > bytes) break;
    parts.push(text);
    size += add;
  }
  return parts.join('\n\n');
}

/** Progress on stderr: the candidate, a phase and counts, never text. */
function progress(id: CandidateId): (line: string, force?: boolean) => void {
  const started = performance.now();
  let last = 0;
  return (line, force = false) => {
    const now = performance.now();
    if (!force && now - last < PROGRESS_EVERY_MS) return;
    last = now;
    process.stderr.write(`[${id}] ${line} (${Math.round((now - started) / 1000)} s)\n`);
  };
}

const isTimeout = (error: unknown): boolean =>
  error instanceof Error && error.name === 'TimeoutError';

async function ollamaBytes(): Promise<number> {
  const ps = (await (await fetch(`${args['ollama-url']}/api/ps`)).json()) as {
    models: { name: string; size: number }[];
  };
  return ps.models.find((m) => m.name === args['ollama-model'])?.size ?? 0;
}

async function runChild(
  id: CandidateId,
  cases: readonly LabelledCase[],
  file: string,
): Promise<void> {
  const say = progress(id);
  say('loading', true);
  const baseRss = process.memoryUsage.rss();
  const loadStart = performance.now();
  const { find } = await candidate(id);
  const loadMs = performance.now() - loadStart;
  say(`loaded in ${Math.round(loadMs)} ms`, true);

  const texts = messagesOf(cases);
  const all = messagesOf(generateCases());
  const warmUp = speedText(all, WARM_UP_BYTES);
  let start = performance.now();
  let warmedUp = true;
  let overReason: 'time' | 'context' | undefined;
  try {
    // Past the whole budget is over the limit whatever follows, so E's
    // call is cut there; a model run cannot be cut, and finishes. A text
    // the LLM refuses as longer than its context is over the limit too
    // (bug-log 55; the user's option 1, 2026-10-03).
    await find(warmUp, SPEED_BUDGET_MS);
  } catch (error) {
    if (isTimeout(error)) overReason = 'time';
    else if (error instanceof ContextRefusal) overReason = 'context';
    else throw error;
    warmedUp = false;
  }
  let msPerKiB = Number.POSITIVE_INFINITY;
  if (warmedUp && performance.now() - start <= SPEED_BUDGET_MS) {
    say('warm-up done; speed text', true);
    const full = speedText(all, SPEED_BYTES);
    start = performance.now();
    await find(full);
    msPerKiB = (performance.now() - start) / (Buffer.byteLength(full) / 1024);
    say(`speed ${msPerKiB.toFixed(1)} ms per KiB`, true);
  } else {
    say(
      overReason === 'context'
        ? 'warm-up refused as longer than the context: speed recorded as over the limit'
        : 'warm-up over the budget: speed recorded as over the limit',
      true,
    );
  }

  // Too slow for the whole set: the names block only, for the record.
  const namesBlockOnly = msPerKiB > LIMITS.msPerKiB && id === 'E';
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const inBlock = cases.flatMap((c) => c.messages.map(() => c.tags.includes('shape:names')));
  const todo = namesBlockOnly ? inBlock.filter(Boolean).length : texts.length;
  let done = 0;
  const spans: (readonly [number, number, number])[][] = [];
  for (const [i, text] of texts.entries()) {
    if (namesBlockOnly && !inBlock[i]) {
      spans.push([]);
      continue;
    }
    spans.push((await find(text)).map((s) => [s.start, s.end, s.score] as const));
    say(`${++done} of ${todo} messages`, done === todo);
  }
  delay.disable();

  const memoryBytes =
    id === 'E' ? await ollamaBytes() : process.resourceUsage().maxRSS * 1024 - baseRss;
  const result: ChildResult = {
    id,
    spans,
    namesBlockOnly,
    msPerKiB,
    memoryBytes,
    loadMs,
    eventLoopMaxMs: delay.max / 1e6,
    invented,
    unparsed,
    spanHash: createHash('sha256').update(JSON.stringify(spans)).digest('hex'),
    threads: cpus().length,
    ...(overReason ? { overReason } : {}),
  };
  writeFileSync(file, JSON.stringify(result));
  say('results saved', true);
}

// ---------------------------------------------------------------------------
// Latency at request sizes and tokens per KiB (asked for by the user after
// the first run, 2026-10-03). Reported beside ms per KiB, which stays the
// rule's measure (ADR-035).

const LATENCY_REPS = 5;
/** E's calls and Ollama's first tokens take seconds each: fewer repetitions. */
const OLLAMA_REPS = 3;
/** Each repetition starts this many messages further on, so no two texts repeat (Ollama caches prompts). */
const REP_STRIDE = 211;
/** Ollama's time to first token is measured on its own texts, apart from E's. */
const TTFT_OFFSET = 97;
const ANSWER_PROMPT = 'You are a customer-support assistant. Reply to the customer.';

type Timing = number | 'refused';

interface LatencyResult {
  readonly id: CandidateId;
  /** Per size in KiB, every run in milliseconds, or "refused" (too long for E's context). */
  readonly runsMs: Record<string, Timing[]>;
  /** Text tokens per KiB of the generated messages, by script; fed tokens per KiB of the speed text. */
  readonly tokens?: {
    readonly latin: number;
    readonly devanagari: number;
    readonly all: number;
    readonly fedPerKiB: number;
    readonly speedTextPerKiB: number;
  };
  /** Ollama's own time to first token for a support answer, per size (E's child only). */
  readonly ttftMs?: Record<string, Timing[]>;
}

/** Ollama's time to first token on `text`, streamed, or "refused" when it is too long. */
async function timeToFirstToken(text: string): Promise<Timing> {
  const started = performance.now();
  const response = await fetch(`${args['ollama-url']}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: args['ollama-model'],
      messages: [
        { role: 'system', content: ANSWER_PROMPT },
        { role: 'user', content: text },
      ],
      temperature: 0,
      seed: OLLAMA_SEED,
      stream: true,
      max_tokens: 8,
    }),
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
  });
  if (!response.ok) {
    if (isContextRefusal(response.status, await response.text())) return 'refused';
    return fail(`Ollama answered HTTP ${response.status}`);
  }
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return fail('Ollama ended the stream without content');
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      const chunk = JSON.parse(line.slice(6)) as {
        choices?: { delta?: { content?: string } }[];
      };
      if (chunk.choices?.[0]?.delta?.content) {
        const ms = performance.now() - started;
        await reader.cancel();
        return ms;
      }
    }
  }
}

async function runLatency(id: CandidateId, file: string): Promise<void> {
  const say = progress(id);
  say('loading', true);
  const loaded = await candidate(id);
  const all = messagesOf(generateCases());
  const timed = async (work: () => Promise<unknown>): Promise<Timing> => {
    const started = performance.now();
    try {
      await work();
    } catch (error) {
      if (error instanceof ContextRefusal) return 'refused';
      throw error;
    }
    return performance.now() - started;
  };
  await timed(() => loaded.find(speedText(all, 1024, 1_000)));
  say('warmed up', true);

  const reps = id === 'E' ? OLLAMA_REPS : LATENCY_REPS;
  const runsMs: Record<string, Timing[]> = {};
  for (const kib of LATENCY_SIZES_KIB) {
    runsMs[kib] = [];
    for (let rep = 0; rep < reps; rep++) {
      const text = speedText(all, kib * 1024, rep * REP_STRIDE);
      runsMs[kib].push(await timed(() => loaded.find(text)));
      say(`${kib} KiB, run ${rep + 1} of ${reps}`, true);
    }
  }

  let tokens: LatencyResult['tokens'];
  if (loaded.count) {
    const count = loaded.count;
    const byScript = tokensByScript(all, (text) => count(text).text);
    const full = speedText(all, SPEED_BYTES);
    const fullKiB = Buffer.byteLength(full) / 1024;
    const fullCount = count(full);
    tokens = {
      latin: perKiB(byScript.latin),
      devanagari: perKiB(byScript.devanagari),
      all: perKiB(byScript.all),
      fedPerKiB: fullCount.fed / fullKiB,
      speedTextPerKiB: fullCount.text / fullKiB,
    };
  }

  let ttftMs: Record<string, Timing[]> | undefined;
  if (id === 'E') {
    ttftMs = {};
    for (const kib of LATENCY_SIZES_KIB) {
      ttftMs[kib] = [];
      for (let rep = 0; rep < OLLAMA_REPS; rep++) {
        const text = speedText(all, kib * 1024, rep * REP_STRIDE + TTFT_OFFSET);
        ttftMs[kib].push(await timeToFirstToken(text));
        say(`first token at ${kib} KiB, run ${rep + 1} of ${OLLAMA_REPS}`, true);
      }
    }
  }
  const result: LatencyResult = {
    id,
    runsMs,
    ...(tokens ? { tokens } : {}),
    ...(ttftMs ? { ttftMs } : {}),
  };
  writeFileSync(file, JSON.stringify(result));
  say('results saved', true);
}

/** A row's median: milliseconds rounded, or "refused" when every run was refused. */
function latencyCell(runs: readonly Timing[] | undefined): string {
  const times = (runs ?? []).filter((t): t is number => t !== 'refused');
  if (times.length === 0) return runs && runs.length > 0 ? 'refused (context)' : '-';
  const refused = runs!.length - times.length;
  return `${Math.round(median(times)!)} ms${refused > 0 ? ` (${refused} refused)` : ''}`;
}

function latencyReport(results: readonly LatencyResult[]): void {
  const write = (line = ''): void => void process.stdout.write(`${line}\n`);
  write('## Tokens per KiB (A, B, D)');
  write();
  write(
    '| Candidate | Latin messages | Devanagari messages | All messages | Speed text | Fed to the model (speed text) | ms per KiB (run) | ms per fed token |',
  );
  write('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of results.filter((x) => x.tokens)) {
    const run = existsSync(childFile(r.id))
      ? (readJson(childFile(r.id)) as ChildResult).msPerKiB
      : Number.NaN;
    const t = r.tokens!;
    write(
      `| ${r.id} | ${t.latin.toFixed(0)} | ${t.devanagari.toFixed(0)} | ${t.all.toFixed(0)} | ${t.speedTextPerKiB.toFixed(0)} | ${t.fedPerKiB.toFixed(0)} | ${run.toFixed(1)} | ${(run / t.fedPerKiB).toFixed(2)} |`,
    );
  }
  write();
  write(
    `## Added latency per request (median of ${LATENCY_REPS} runs; E and first token: ${OLLAMA_REPS})`,
  );
  write();
  write(`| Candidate | ${LATENCY_SIZES_KIB.map((k) => `${k} KiB`).join(' | ')} |`);
  write(`| --- | ${LATENCY_SIZES_KIB.map(() => '---').join(' | ')} |`);
  for (const r of results) {
    write(`| ${r.id} | ${LATENCY_SIZES_KIB.map((k) => latencyCell(r.runsMs[k])).join(' | ')} |`);
  }
  const e = results.find((r) => r.ttftMs);
  if (e) {
    write(
      `| Ollama, first token of an answer (${args['ollama-model']}) | ${LATENCY_SIZES_KIB.map((k) => latencyCell(e.ttftMs![k])).join(' | ')} |`,
    );
  }
}

// ---------------------------------------------------------------------------
// The parent: a child per candidate, then the scores and the decision.

/**
 * Runs one candidate in a child process. Rejects, with the reason, when
 * the child fails or prints no progress for STALL_MS (it is then killed).
 * Never retries: a stop is for the user to look at.
 */
function spawnChild(childArgs: readonly string[]): Promise<void> {
  const name = childArgs[childArgs.length - 1]!;
  return new Promise((done, failed) => {
    const child = spawn(
      process.execPath,
      [...process.execArgv, import.meta.filename, ...childArgs],
      { stdio: ['ignore', 'inherit', 'pipe'] },
    );
    let lastSeen = Date.now();
    let stalled = false;
    child.stderr.on('data', (chunk: Buffer) => {
      lastSeen = Date.now();
      process.stderr.write(chunk);
    });
    const watch = setInterval(() => {
      if (Date.now() - lastSeen < STALL_MS) return;
      stalled = true;
      child.kill();
    }, 15_000);
    child.on('exit', (code) => {
      clearInterval(watch);
      if (stalled) {
        failed(new Error(`${name} stalled: no progress for ${STALL_MS / 60_000} minutes; stopped`));
      } else if (code === 0) {
        done();
      } else {
        failed(new Error(`${name} failed (exit code ${code}); its error is above`));
      }
    });
  });
}

/** Stops the whole run, saying why on the console and in STOPPED.txt in --out. */
async function orStop(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    const message = `STOPPED at ${new Date().toISOString()}: ${(error as Error).message}. Not retried.`;
    writeFileSync(join(out, 'STOPPED.txt'), `${message}\n`);
    fail(message);
  }
}

const pct = (c: { hit: number; of: number }): string =>
  `${c.hit}/${c.of} (${(Math.floor(share(c) * 1000) / 10).toFixed(1)}%)`;
const pointText = (p: Point): string =>
  p.mid === undefined ? `${p.high}` : `${p.high} / ${p.mid}`;
const mib = (bytes: number): string => `${Math.round(bytes / 2 ** 20)} MiB`;

function findFor(
  cases: readonly LabelledCase[],
  result: ChildResult,
  point: Point,
): (text: string) => ReturnType<typeof detectionsAt> {
  const byText = new Map<string, ScoredSpan[]>();
  messagesOf(cases).forEach((text, i) => {
    if (!byText.has(text)) {
      byText.set(
        text,
        result.spans[i]!.map(([start, end, score]) => ({ start, end, score })),
      );
    }
  });
  return (text) => detectionsAt(text, byText.get(text) ?? [], point);
}

const NO_SCORE: Point = { high: 0.5 };

function measured(cases: readonly LabelledCase[], result: ChildResult): Measured {
  const scoreCases = result.namesBlockOnly
    ? cases.filter((c) => c.tags.includes('shape:names'))
    : cases;
  const hasScores = result.id === 'A' || result.id === 'B' || result.id === 'D';
  const tried = (hasScores ? grid() : [NO_SCORE]).map((point) => ({
    point,
    metrics: measure(scoreCases, findFor(cases, result, point)),
  }));
  const chosen = choosePoint(tried);
  return {
    id: result.id,
    point: chosen.point,
    metrics: chosen.metrics,
    msPerKiB: result.msPerKiB,
    memoryBytes: result.memoryBytes,
    ...(result.namesBlockOnly ? { partial: true as const } : {}),
  };
}

function combine(
  cases: readonly LabelledCase[],
  model: ChildResult,
  m: Measured,
  list: ChildResult,
): Measured {
  const a = findFor(cases, model, m.point);
  const f = findFor(cases, list, NO_SCORE);
  const metrics: Metrics = measure(
    m.partial ? cases.filter((c) => c.tags.includes('shape:names')) : cases,
    (text) => merge([...a(text), ...f(text)]),
  );
  return {
    id: `${m.id}+F`,
    point: m.point,
    metrics,
    msPerKiB: m.msPerKiB + list.msPerKiB,
    memoryBytes: m.memoryBytes,
    ...(m.partial ? { partial: true as const } : {}),
  };
}

function report(results: readonly ChildResult[], rows: readonly Measured[]): void {
  const write = (line = ''): void => void process.stdout.write(`${line}\n`);
  write('## Candidates at their operating points (generated set)');
  write();
  write(
    '| Candidate | Point (high / mid) | R (names block) | Main PERSON | Precision | FP per 1,000 words | ms per KiB | Memory | Limits failed |',
  );
  write('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const m of rows) {
    write(
      `| ${m.id} | ${pointText(m.point)} | ${pct(m.metrics.recall)} | ${pct(m.metrics.main)} | ${pct(m.metrics.precision)} | ${fpPer1000(m.metrics).toFixed(2)} | ${Number.isFinite(m.msPerKiB) ? m.msPerKiB.toFixed(1) : 'over'} | ${mib(m.memoryBytes)} | ${failedLimits(m).join(', ') || '-'} |`,
    );
  }
  write();
  write('## Rows of the names block');
  write();
  const tags = [...new Set(rows.flatMap((m) => Object.keys(m.metrics.rows)))].sort();
  write(`| Row | ${rows.map((m) => m.id).join(' | ')} |`);
  write(`| --- | ${rows.map(() => '---').join(' | ')} |`);
  for (const tag of tags) {
    write(
      `| ${tag} | ${rows.map((m) => (m.metrics.rows[tag] ? pct(m.metrics.rows[tag]) : '-')).join(' | ')} |`,
    );
  }
  write();
  write('## Over-redactions by lookalike kind');
  write();
  const kinds = [...new Set(rows.flatMap((m) => Object.keys(m.metrics.lookalikes)))].sort();
  write(`| Kind | ${rows.map((m) => m.id).join(' | ')} |`);
  write(`| --- | ${rows.map(() => '---').join(' | ')} |`);
  for (const kind of kinds) {
    write(`| ${kind} | ${rows.map((m) => m.metrics.lookalikes[kind] ?? 0).join(' | ')} |`);
  }
  write();
  write('## Runs');
  write();
  for (const r of results) {
    write(
      `${r.id}: load ${Math.round(r.loadMs)} ms, event loop max ${Math.round(r.eventLoopMaxMs)} ms, ` +
        `${r.threads} logical CPUs, invented ${r.invented}, unparsed ${r.unparsed}, ` +
        `${r.namesBlockOnly ? 'names block only, ' : ''}spans ${r.spanHash.slice(0, 16)}`,
    );
  }
}

const childFile = (id: string): string => join(out, `${id}.json`);
type ChildSet = 'generated' | 'held-out' | 'latency';
const childArgs = (id: CandidateId, set: ChildSet): string[] => [
  '--held-out-committed',
  '--out',
  out,
  '--runtime',
  args.runtime,
  '--ollama-model',
  args['ollama-model'],
  '--ollama-url',
  args['ollama-url'],
  '--child',
  `${id}:${set}`,
];

if (args.child) {
  const [id, set] = args.child.split(':') as [CandidateId, ChildSet];
  if (set === 'latency') {
    await runLatency(id, childFile(`latency-${id}`));
  } else {
    const cases = set === 'held-out' ? loadHeldOut() : generateCases();
    await runChild(id, cases, childFile(set === 'held-out' ? `held-out-${id}` : id));
  }
} else if (args.latency) {
  const ids = args.candidates.split(',') as CandidateId[];
  for (const id of ids) {
    if (!existsSync(childFile(`latency-${id}`))) {
      await orStop(() => spawnChild(childArgs(id, 'latency')));
    }
  }
  const results = ids.map((id) => readJson(childFile(`latency-${id}`)) as LatencyResult);
  latencyReport(results);
  writeFileSync(join(out, 'latency-summary.json'), JSON.stringify(results, null, 2));
} else if (args['gliner-card']) {
  // D's port against the example on GLiNER's model card (the user's
  // decision, 2026-10-03). The card is fetched, pinned to a commit, and
  // never stored; only labels and outcomes are printed.
  const repo = 'urchade/gliner_multi_pii-v1';
  const info = (await (await fetch(`https://huggingface.co/api/models/${repo}`)).json()) as {
    sha: string;
  };
  const readme = await (
    await fetch(`https://huggingface.co/${repo}/raw/${info.sha}/README.md`)
  ).text();
  const card = parseCard(readme) ?? fail('the model card has no example in the expected layout');
  // GLiNER's predict_entities: threshold 0.5, flat (no overlaps), as the card ran it.
  const d = await glinerCandidate({ labels: card.labels, file: args['gliner-file'], floor: 0.5 });
  const found = (await d.spans(card.text)).map((s) => ({
    text: card.text.slice(s.start, s.end),
    label: card.labels[s.label]!,
  }));
  const verdict = compareCard(card.expected, found);
  const write = (line = ''): void => void process.stdout.write(`${line}\n`);
  write(`GLiNER card check: ${repo}@${info.sha.slice(0, 12)}, ${args['gliner-file']}`);
  write(`${card.labels.length} labels, ${card.expected.length} expected entities`);
  for (const row of verdict.rows) write(`  ${row.label}: ${row.result}`);
  write(`  not on the card: ${verdict.extra.length === 0 ? 'none' : verdict.extra.join(', ')}`);
  write(verdict.reproduced ? 'REPRODUCED' : 'NOT REPRODUCED');
} else if (args.smoke) {
  // Not a measurement: every candidate once, in this process, on a fixed
  // sentence written for this check.
  for (const id of args.candidates.split(',') as CandidateId[]) {
    const started = performance.now();
    const spans = await (await candidate(id)).find('Hello, my name is Ravi and I live in Pune.');
    process.stdout.write(
      `${id}: loaded and ran in ${Math.round(performance.now() - started)} ms, ${spans.length} span(s)\n`,
    );
  }
} else if (args['held-out']) {
  // The chosen configuration, once, on the held-out set: the PERSON row only.
  const ids = args['held-out'].split('+') as CandidateId[];
  const [high, mid] = (args.point ?? '0.5').split('/').map(Number) as [number, number?];
  const point: Point = mid === undefined ? { high } : { high, mid };
  for (const id of ids) await orStop(() => spawnChild(childArgs(id, 'held-out')));
  const cases = loadHeldOut();
  const results = ids.map((id) => readJson(childFile(`held-out-${id}`)) as ChildResult);
  const finds = results.map((r, i) => findFor(cases, r, i === 0 ? point : NO_SCORE));
  const metrics = measure(cases, (text) => merge(finds.flatMap((f) => f(text))));
  process.stdout.write(
    `Held-out, ${args['held-out']} at ${pointText(point)}: PERSON ${pct(metrics.main)}, precision ${pct(metrics.precision)}\n`,
  );
} else {
  const ids = args.candidates.split(',') as CandidateId[];
  for (const id of ids) {
    if (!CANDIDATES.includes(id)) fail(`unknown candidate ${id}`);
    if (!existsSync(childFile(id))) {
      await orStop(() => spawnChild(childArgs(id, 'generated')));
    }
  }
  const cases = generateCases();
  const results = ids.map((id) => readJson(childFile(id)) as ChildResult);
  const rows = results.map((r) => measured(cases, r));
  const list = results.find((r) => r.id === 'F');
  const combined = (m: Measured): Measured | undefined => {
    const model = results.find((r) => r.id === m.id);
    return list && model && m.id !== 'F' ? combine(cases, model, m, list) : undefined;
  };
  const withCombinations = [...rows, ...rows.flatMap((m) => combined(m) ?? [])];
  report(results, withCombinations);
  const decision = decide(rows, combined);
  process.stdout.write(
    `\n## Decision: ${decision.tier}${decision.chosen ? ` (${decision.chosen.id} at ${pointText(decision.chosen.point)})` : ''}\n\n`,
  );
  for (const reason of decision.reasons) process.stdout.write(`- ${reason}\n`);
  writeFileSync(
    join(out, 'summary.json'),
    JSON.stringify({ rows: withCombinations, decision }, null, 2),
  );
}

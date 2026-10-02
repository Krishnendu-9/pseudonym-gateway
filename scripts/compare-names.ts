// The Phase 6a comparison of name detectors (ADR-035): candidates A, B, D,
// E and F on the generated set, the stopping rule applied to the results.
//
//   npx tsx scripts/compare-names.ts --held-out-committed --out <dir outside the repo>
//       [--runtime D:/pseudonym-6a] [--candidates A,B,D,E,F] [--ollama-model <name>]
//   npx tsx scripts/compare-names.ts --held-out-committed --out <dir> --held-out <id>
//       runs the chosen configuration once on the held-out set (PERSON row only)
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
// tested module under eval/names.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { generateCases } from '../eval/generate.js';
import { loadHeldOut } from '../eval/held-out.js';
import { listSpans } from '../eval/names/gazetteer.js';
import { glinerSpans, type GlinerFeeds, type GlinerSetup } from '../eval/names/gliner.js';
import { locate, namesMessages, parseNames } from '../eval/names/llm.js';
import { fpPer1000, measure, share, type Metrics } from '../eval/names/measure.js';
import { choosePoint, decide, failedLimits, LIMITS, type Measured } from '../eval/names/rule.js';
import { detectionsAt, grid, merge, type Point, type ScoredSpan } from '../eval/names/spans.js';
import {
  labelWords,
  personSpans,
  type BertSetup,
  type EncodedWord,
} from '../eval/names/token-classification.js';
import { bertWords, glinerWords, type Word } from '../eval/names/words.js';
import type { LabelledCase } from '../eval/types.js';
import { WIKIDATA_NAMES } from '../src/synthetic/wikidata-names.js';
import { leftoverMutation } from './mutation-marker.js';

const REPO = resolve(import.meta.dirname, '..');
const CANDIDATES = ['A', 'B', 'D', 'E', 'F'] as const;
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
if (!relative(REPO, out).startsWith('..')) fail('--out must be outside the repo');
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

type Find = (text: string) => Promise<ScoredSpan[]>;

/** Encodes each word on its own, without special tokens; words that encode to nothing are dropped. */
function encodeWords(tokenizer: Tokenizer, words: readonly Word[]): EncodedWord[] {
  return words
    .map((w) => ({ ...w, ids: tokenizer.encode(w.text, { add_special_tokens: false }).ids }))
    .filter((w) => w.ids.length > 0);
}

async function bertCandidate(id: 'A' | 'B'): Promise<Find> {
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
  return async (text) => {
    const words = encodeWords(tokenizer, bertWords(text));
    return personSpans(words, await labelWords(words, setup, run));
  };
}

async function glinerCandidate(): Promise<Find> {
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
  const session = await ort.InferenceSession.create(join(dir, 'onnx', 'model_quantized.onnx'));
  const ids = (text: string): number[] => tokenizer.encode(text, { add_special_tokens: false }).ids;
  const setup: GlinerSetup = {
    clsId: ids('[CLS]')[0]!,
    sepId: ids('[SEP]')[0]!,
    prompt: [...ids('<<ENT>>'), ...ids('person'), ...ids('<<SEP>>')],
    maxWidth: gliner.max_width,
    maxWords: gliner.max_len,
    maxTokens: 512,
    floor: Math.min(...grid().map((p) => p.mid ?? p.high)),
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
  return async (text) => glinerSpans(encodeWords(tokenizer, glinerWords(text)), setup, run);
}

let invented = 0;
let unparsed = 0;
function llmCandidate(): Find {
  return async (text) => {
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
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });
    if (!response.ok) fail(`Ollama answered HTTP ${response.status}`);
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

async function candidate(id: CandidateId): Promise<Find> {
  if (id === 'A' || id === 'B') return bertCandidate(id);
  if (id === 'D') return glinerCandidate();
  if (id === 'E') return llmCandidate();
  return async (text) => listSpans(text, GAZETTEER);
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
}

const messagesOf = (cases: readonly LabelledCase[]): string[] =>
  cases.flatMap((c) => c.messages.map((m) => m.text));

/** Generated messages joined until the next would pass `bytes` of UTF-8. */
function speedText(texts: readonly string[], bytes: number): string {
  let joined = '';
  for (const text of texts) {
    const next = joined === '' ? text : `${joined}\n\n${text}`;
    if (Buffer.byteLength(next) > bytes) break;
    joined = next;
  }
  return joined;
}

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
  const baseRss = process.memoryUsage.rss();
  const loadStart = performance.now();
  const find = await candidate(id);
  const loadMs = performance.now() - loadStart;

  const texts = messagesOf(cases);
  const all = messagesOf(generateCases());
  const warmUp = speedText(all, WARM_UP_BYTES);
  let start = performance.now();
  await find(warmUp);
  let msPerKiB = Number.POSITIVE_INFINITY;
  if (performance.now() - start <= SPEED_BUDGET_MS) {
    const full = speedText(all, SPEED_BYTES);
    start = performance.now();
    await find(full);
    msPerKiB = (performance.now() - start) / (Buffer.byteLength(full) / 1024);
  }

  // Too slow for the whole set: the names block only, for the record.
  const namesBlockOnly = msPerKiB > LIMITS.msPerKiB && id === 'E';
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const inBlock = cases.flatMap((c) => c.messages.map(() => c.tags.includes('shape:names')));
  const spans: (readonly [number, number, number])[][] = [];
  for (const [i, text] of texts.entries()) {
    spans.push(
      namesBlockOnly && !inBlock[i]
        ? []
        : (await find(text)).map((s) => [s.start, s.end, s.score] as const),
    );
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
  };
  writeFileSync(file, JSON.stringify(result));
}

// ---------------------------------------------------------------------------
// The parent: a child per candidate, then the scores and the decision.

function spawnChild(childArgs: readonly string[]): Promise<void> {
  return new Promise((done, failed) => {
    const child = spawn(
      process.execPath,
      [...process.execArgv, import.meta.filename, ...childArgs],
      { stdio: 'inherit' },
    );
    child.on('exit', (code) => (code === 0 ? done() : failed(new Error(`child exited ${code}`))));
  });
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
const childArgs = (id: CandidateId, set: 'generated' | 'held-out'): string[] => [
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
  const [id, set] = args.child.split(':') as [CandidateId, 'generated' | 'held-out'];
  const cases = set === 'held-out' ? loadHeldOut() : generateCases();
  await runChild(id, cases, childFile(set === 'held-out' ? `held-out-${id}` : id));
} else if (args['held-out']) {
  // The chosen configuration, once, on the held-out set: the PERSON row only.
  const ids = args['held-out'].split('+') as CandidateId[];
  const [high, mid] = (args.point ?? '0.5').split('/').map(Number) as [number, number?];
  const point: Point = mid === undefined ? { high } : { high, mid };
  for (const id of ids) await spawnChild(childArgs(id, 'held-out'));
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
      await spawnChild(childArgs(id, 'generated'));
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

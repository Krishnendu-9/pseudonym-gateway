// The model-rewrite measurement (Phase 5d part 4, ADR-017): the 15 tasks of
// eval/rewrite-tasks.ts, each sent twice through the real pipeline (the
// placeholder instruction on, then off) to a running Ollama, temperature 0
// and a fixed seed, non-streaming. Each answer is classified by
// eval/rewrites.ts and the decision rule fixed in ADR-017 is applied.
//
//   npx tsx scripts/measure-rewrites.ts --model qwen3:4b-instruct-2507-q4_K_M --answers <dir outside the repo>
//
// Writes eval/model-rewrites.json: the run's settings, Ollama's version and
// the model's digest, per task and condition the fate of each value (by
// type), the placeholder-shaped text the model wrote instead, and the
// totals and decision. Never a value. The model's raw answers (placeholders
// only: the model never sees a value) go to --answers, outside the repo, so
// the classification can be checked by reading them.
//
// Stops at the first failed call, keeping what was measured so far; it
// never retries.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  classifyAnswer,
  decide,
  sentValues,
  totals,
  type AnswerVerdict,
  type ConditionTotals,
} from '../eval/rewrites.js';
import { REWRITE_SEED, REWRITE_TASKS, rewriteCases } from '../eval/rewrite-tasks.js';
import { safeErrorDetails } from '../src/gateway/errors.js';
import { redactRequest } from '../src/gateway/redact-request.js';
import { parseChatRequest } from '../src/gateway/schema.js';
import { createOllamaProvider } from '../src/providers/ollama.js';
import { PlaceholderMapping } from '../src/redaction/mapping.js';

const RESULTS_FILE = join(import.meta.dirname, '..', 'eval', 'model-rewrites.json');
const TEMPERATURE = 0;
const MAX_TOKENS = 400;
const CALL_TIMEOUT_MS = 900_000;

const { values: args } = parseArgs({
  options: {
    model: { type: 'string' },
    answers: { type: 'string' },
    'base-url': { type: 'string', default: 'http://127.0.0.1:11434/v1' },
  },
});
if (!args.model || !args.answers) {
  console.error(
    'usage: npx tsx scripts/measure-rewrites.ts --model <name> --answers <dir> [--base-url <url>]',
  );
  process.exit(1);
}
const model = args.model;
const baseUrl = args['base-url'];
const ollamaRoot = baseUrl.replace(/\/v1\/?$/, '');
mkdirSync(args.answers, { recursive: true });

const version = ((await (await fetch(`${ollamaRoot}/api/version`)).json()) as { version: string })
  .version;
const tags = (await (await fetch(`${ollamaRoot}/api/tags`)).json()) as {
  models: { name: string; digest: string }[];
};
const digest = tags.models.find((m) => m.name === model)?.digest;
if (!digest) {
  console.error(`model ${model} is not pulled in this Ollama`);
  process.exit(1);
}

const provider = createOllamaProvider({
  baseUrl,
  model,
  timeoutMs: CALL_TIMEOUT_MS,
  maxResponseBytes: 1_048_576,
  maxStreamBytes: 33_554_432,
});

type Condition = 'on' | 'off';
interface Call {
  readonly fates: readonly { readonly placeholder: string; readonly fate: string }[];
  readonly rewrites: readonly string[];
  readonly invented: readonly string[];
  readonly finishReason: string;
  readonly ms: number;
}
const results: { id: string; what: string; on?: Call; off?: Call }[] = [];
const verdicts: Record<Condition, AnswerVerdict[]> = { on: [], off: [] };

function save(stoppedAt?: string): void {
  const sums = { on: totals(verdicts.on), off: totals(verdicts.off) };
  const complete =
    verdicts.on.length === REWRITE_TASKS.length && verdicts.off.length === REWRITE_TASKS.length;
  writeFileSync(
    RESULTS_FILE,
    `${JSON.stringify(
      {
        measuredOn: new Date().toISOString().slice(0, 10),
        ollama: version,
        model,
        digest,
        seed: REWRITE_SEED,
        temperature: TEMPERATURE,
        maxTokens: MAX_TOKENS,
        tasks: results,
        totals: sums,
        decision: complete ? decide(sums.on, sums.off) : null,
        ...(stoppedAt ? { stoppedAt } : {}),
      },
      null,
      2,
    )}\n`,
  );
}

const cases = rewriteCases();
for (const [i, task] of REWRITE_TASKS.entries()) {
  const labelled = cases[i]!;
  const row: (typeof results)[number] = { id: task.id, what: task.what };
  results.push(row);
  for (const condition of ['on', 'off'] as const) {
    const mapping = new PlaceholderMapping();
    const request = redactRequest(
      parseChatRequest({
        model,
        messages: labelled.messages.map((m) => ({ role: m.role, content: m.text })),
        temperature: TEMPERATURE,
        seed: REWRITE_SEED,
        max_tokens: MAX_TOKENS,
      }),
      mapping,
      { placeholderInstruction: condition === 'on' },
    );
    // No planted value may be in what is sent, written or with its
    // separators removed; stop before the call if one is.
    const outgoing = JSON.stringify(request);
    const bare = outgoing.replace(/[^0-9A-Za-z]/g, '');
    for (const m of labelled.messages) {
      for (const piece of m.pieces) {
        const value = m.text.slice(piece.start, piece.end);
        const compact = value.replace(/[^0-9A-Za-z]/g, '');
        if (outgoing.includes(value) || (compact.length >= 6 && bare.includes(compact))) {
          console.error(`${task.id}: a planted value is in the outgoing request; stopped`);
          save(`${task.id} ${condition}: planted value in request`);
          process.exit(1);
        }
      }
    }

    const values = sentValues(mapping);
    const started = Date.now();
    let content: string;
    let finishReason: string;
    try {
      const answer = await provider.complete(request, new AbortController().signal);
      // A refusal has no answer to classify; it stops the run, as it did
      // when the adapter still failed on it (ADR-041 section 15, decision 1).
      if (answer.content === null) {
        console.error(`${task.id} ${condition}: the model refused; stopped`);
        save(`${task.id} ${condition}: refused`);
        process.exit(1);
      }
      content = answer.content;
      finishReason = answer.finishReason;
    } catch (error) {
      console.error(`${task.id} ${condition}: call failed`, safeErrorDetails(error));
      save(`${task.id} ${condition}: call failed`);
      process.exit(1);
    }
    const ms = Date.now() - started;
    writeFileSync(join(args.answers, `${task.id}-${condition}.txt`), content);
    const verdict = classifyAnswer(content, mapping, values);
    verdicts[condition].push(verdict);
    row[condition] = {
      fates: values.map((v, k) => ({
        placeholder: `${v.namespace}_${v.index}`,
        fate: verdict.fates[k]!,
      })),
      rewrites: verdict.rewrites,
      invented: verdict.invented,
      finishReason,
      ms,
    };
    const tally = (fate: string): number => verdict.fates.filter((f) => f === fate).length;
    console.log(
      `${task.id.padEnd(11)} ${condition.padEnd(3)} ${String(ms).padStart(7)} ms  ` +
        `restored ${tally('restored')}/${values.length}  held ${tally('held')}  ` +
        `rewritten ${tally('rewritten')}  dropped ${tally('dropped')}  invented ${verdict.invented.length}`,
    );
    save();
  }
}

const show = (name: string, t: ConditionTotals): void =>
  console.log(
    `${name}: ${t.values} values, restored ${t.restored}, held ${t.held}, ` +
      `rewritten ${t.rewritten}, dropped ${t.dropped}, invented ${t.invented}`,
  );
show('instruction on ', totals(verdicts.on));
show('instruction off', totals(verdicts.off));
console.log(`decision (ADR-017 rule): ${decide(totals(verdicts.on), totals(verdicts.off))}`);

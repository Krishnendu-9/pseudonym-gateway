// loadBert (moved from scripts/compare-names.ts in Phase 6b step 4b), with a
// fake runtime: what it reads from the model's directory, what it feeds the
// session, and how it turns logits into spans. The real model's spans are
// proven equal to 6a's by `npm run eval:names` (span SHA-256s), not here.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  encodeWords,
  int64,
  loadBert,
  readJson,
  type OrtSession,
  type Runtime,
} from '../../../../src/detection/names/bert.js';

// Labels in id order O, B-PER, I-PER, B-LOC; written out of order and with
// ids that sort differently as text ("10" before "2").
const ID2LABEL = { '10': 'B-LOC', '0': 'O', '2': 'I-PER', '1': 'B-PER' };
const LABELS = ['O', 'B-PER', 'I-PER', 'B-LOC'];
const VOCAB: Record<string, number> = { '[CLS]': 101, '[SEP]': 102, Asha: 7, Rao: 8, met: 9 };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bert-'));
  mkdirSync(join(dir, 'onnx'));
  writeFileSync(join(dir, 'tokenizer.json'), '{"vocab":"tokenizer"}');
  writeFileSync(join(dir, 'tokenizer_config.json'), '{"config":"tokenizer"}');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ id2label: ID2LABEL }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Fed {
  readonly name: string;
  readonly type: string;
  readonly data: unknown;
  readonly dims: readonly number[];
}

/** A runtime whose session labels each token by `labelOf(id)`, with probability 0.9. */
function fakeRuntime(
  inputNames: readonly string[],
  labelOf: (id: number) => string,
): { runtime: Runtime; created: string[]; tokenizerArgs: unknown[]; fed: Fed[][] } {
  const created: string[] = [];
  const tokenizerArgs: unknown[] = [];
  const fed: Fed[][] = [];
  class Tensor {
    constructor(
      readonly type: string,
      readonly data: unknown,
      readonly dims: readonly number[],
    ) {}
  }
  const session: OrtSession = {
    inputNames,
    run: (feeds) => {
      fed.push(Object.entries(feeds).map(([name, t]) => ({ name, ...(t as Tensor) })));
      const ids = [...((feeds.input_ids as Tensor).data as BigInt64Array)].map(Number);
      const logits = new Float32Array(ids.length * LABELS.length);
      ids.forEach((id, row) => {
        // log(9) above the rest: softmax gives the label 0.75 among four.
        logits[row * LABELS.length + LABELS.indexOf(labelOf(id))] = Math.log(9);
      });
      return Promise.resolve({ logits: { data: logits } });
    },
  };
  class Tokenizer {
    constructor(json: unknown, config: unknown) {
      tokenizerArgs.push(json, config);
    }
    encode(text: string, options: { add_special_tokens: boolean }): { ids: number[] } {
      expect(options).toEqual({ add_special_tokens: false });
      return { ids: VOCAB[text] === undefined ? [] : [VOCAB[text]] };
    }
  }
  const runtime: Runtime = {
    ort: {
      InferenceSession: {
        create: (path) => {
          created.push(path);
          return Promise.resolve(session);
        },
      },
      Tensor,
    },
    Tokenizer,
  };
  return { runtime, created, tokenizerArgs, fed };
}

const PERSON: Record<number, string> = { 7: 'B-PER', 8: 'I-PER' };

describe('loadBert', () => {
  it('reads the tokenizer files, the labels in id order and the quantised model', async () => {
    const fake = fakeRuntime(['input_ids', 'attention_mask'], () => 'O');
    const bert = await loadBert(fake.runtime, dir);
    expect(fake.tokenizerArgs).toEqual([{ vocab: 'tokenizer' }, { config: 'tokenizer' }]);
    expect(fake.created).toEqual([join(dir, 'onnx', 'model_quantized.onnx')]);
    expect(bert.setup).toEqual({
      clsId: 101,
      sepId: 102,
      labels: LABELS,
      maxTokens: 512,
      context: 64,
    });
  });

  it('finds a name: consecutive PER words, scored by the mean of their probabilities', async () => {
    const fake = fakeRuntime(['input_ids', 'attention_mask'], (id) => PERSON[id] ?? 'O');
    const bert = await loadBert(fake.runtime, dir);
    const spans = await bert.find('Asha Rao met');
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 0, end: 8 });
    expect(spans[0]!.score).toBeCloseTo(0.75, 6);
  });

  it('feeds int64 ids between [CLS] and [SEP], a mask of ones, and no token types the model lacks', async () => {
    const fake = fakeRuntime(['input_ids', 'attention_mask'], () => 'O');
    await (await loadBert(fake.runtime, dir)).find('Asha met');
    expect(fake.fed).toEqual([
      [
        { name: 'input_ids', type: 'int64', data: int64([101, 7, 9, 102]), dims: [1, 4] },
        { name: 'attention_mask', type: 'int64', data: int64([1, 1, 1, 1]), dims: [1, 4] },
      ],
    ]);
  });

  it('feeds token types of zero when the model takes them (B does)', async () => {
    const fake = fakeRuntime(['input_ids', 'attention_mask', 'token_type_ids'], () => 'O');
    await (await loadBert(fake.runtime, dir)).find('Rao');
    expect(fake.fed[0]![2]).toEqual({
      name: 'token_type_ids',
      type: 'int64',
      data: int64([0, 0, 0]),
      dims: [1, 3],
    });
  });

  it('encode: BERT words with their ids; a word with no tokens is dropped', async () => {
    const bert = await loadBert(fakeRuntime([], () => 'O').runtime, dir);
    expect(bert.encode('Asha ??? Rao')).toEqual([
      { text: 'Asha', start: 0, end: 4, ids: [7] },
      { text: 'Rao', start: 9, end: 12, ids: [8] },
    ]);
  });
});

describe('the helpers it shares with the comparison script', () => {
  it('int64 makes 64-bit integers', () => {
    expect(int64([1, 2 ** 40])).toEqual(BigInt64Array.from([1n, 2n ** 40n]));
  });

  it('readJson parses a file', () => {
    expect(readJson(join(dir, 'config.json'))).toEqual({ id2label: ID2LABEL });
  });

  it('encodeWords encodes each word on its own', () => {
    const tokenizer = { encode: (text: string) => ({ ids: text === 'a' ? [1, 2] : [] }) };
    expect(
      encodeWords(tokenizer, [
        { text: 'a', start: 0, end: 1 },
        { text: 'b', start: 2, end: 3 },
      ]),
    ).toEqual([{ text: 'a', start: 0, end: 1, ids: [1, 2] }]);
  });
});

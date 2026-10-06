// Candidates A and B as the Phase 6a comparison loaded and ran them
// (ADR-035), moved from scripts/compare-names.ts in Phase 6b step 4b, to
// the move standard of ADR-036 (imports and paths only, no logic changes,
// span SHA-256s identical before and after), so that the gateway's worker
// runs the code the measurement scored. The script now calls it.
//
// The runtime is passed in, never imported here: the comparison loads its
// copy from outside the repo, the gateway loads the optional dependency in
// its worker, and the gateway must typecheck without the packages
// installed (ADR-036 (a)). Both are typed by the few members used.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScoredSpan } from './spans.js';
import {
  labelWords,
  personSpans,
  type BertSetup,
  type EncodedWord,
} from './token-classification.js';
import { bertWords, type Word } from './words.js';

export interface OrtTensor {
  readonly data: Float32Array;
}
export interface OrtSession {
  readonly inputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
}
export interface Ort {
  InferenceSession: { create(path: string): Promise<OrtSession> };
  Tensor: new (type: string, data: unknown, dims: readonly number[]) => unknown;
}
export interface Tokenizer {
  encode(text: string, options: { add_special_tokens: boolean }): { ids: number[] };
}
/** `onnxruntime-node` and `@huggingface/tokenizers`' Tokenizer, as loaded by the caller. */
export interface Runtime {
  readonly ort: Ort;
  readonly Tokenizer: new (json: unknown, config: unknown) => Tokenizer;
}

export const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
export const int64 = (values: readonly number[]): BigInt64Array =>
  BigInt64Array.from(values, (v) => BigInt(v));

/** Encodes each word on its own, without special tokens; words that encode to nothing are dropped. */
export function encodeWords(tokenizer: Tokenizer, words: readonly Word[]): EncodedWord[] {
  return words
    .map((w) => ({ ...w, ids: tokenizer.encode(w.text, { add_special_tokens: false }).ids }))
    .filter((w) => w.ids.length > 0);
}

/** A loaded BERT candidate. */
export interface Bert {
  /** The person spans in `text`, scored, in its UTF-16 offsets. */
  readonly find: (text: string) => Promise<ScoredSpan[]>;
  /** The words of `text` as the model is given them (for counting tokens). */
  readonly encode: (text: string) => EncodedWord[];
  readonly setup: BertSetup;
}

/**
 * Loads the model in `dir` (the layout `fetch:model` writes): the
 * tokenizer, the labels from `config.json`'s `id2label` in id order, and an
 * inference session on `onnx/model_quantized.onnx` with the runtime's
 * default options (its CPU provider, as 6a ran it).
 */
export async function loadBert({ ort, Tokenizer }: Runtime, dir: string): Promise<Bert> {
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
  const encode = (text: string): EncodedWord[] => encodeWords(tokenizer, bertWords(text));
  return {
    find: async (text) => {
      const words = encode(text);
      return personSpans(words, await labelWords(words, setup, run));
    },
    encode,
    setup,
  };
}

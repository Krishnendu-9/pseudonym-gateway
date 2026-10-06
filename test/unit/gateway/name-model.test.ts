// The name model's load-time check (ADR-036 (b)): start-up is refused unless
// every pinned file is present and hashes to its pinned value. Each check is
// called directly with wrong input, since a correct install never reaches a
// refusal. The real model is not here (it is not in the repo, and CI does
// not download it); the checks run on small files with their own pins.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NameStartupError, safeErrorDetails } from '../../../src/gateway/errors.js';
import {
  checkModelFiles,
  fileSha256,
  loadNameModel,
  MODEL_ROOT,
  NAME_MODEL,
  verifyFile,
  type ModelFile,
} from '../../../src/gateway/name-model.js';

const pinned = (path: string, content: string): ModelFile => ({
  path,
  bytes: Buffer.byteLength(content),
  sha256: createHash('sha256').update(content).digest('hex'),
});

const CONTENT = { 'a.json': '{"a":1}', 'onnx/m.onnx': 'model bytes' } as const;
const FILES: readonly ModelFile[] = Object.entries(CONTENT).map(([path, c]) => pinned(path, c));

let dir: string;

const write = (path: string, content: string): void => {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), content);
};
const writeAll = (): void => {
  for (const [path, content] of Object.entries(CONTENT)) write(path, content);
};

/** The refusal checkModelFiles gives, as safeErrorDetails would log it. */
async function refusal(check: Promise<unknown>): Promise<Record<string, unknown>> {
  const error = await check.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(NameStartupError);
  expect((error as Error).message).toBe('name detection could not start');
  return safeErrorDetails(error);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'name-model-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the pinned model (ADR-036)', () => {
  it('is B at its full commit, four files, the hashes the 6a run and the 2026-10-07 download measured', () => {
    expect(NAME_MODEL.repo).toBe('Xenova/bert-base-multilingual-cased-ner-hrl');
    expect(NAME_MODEL.commit).toBe('263e82c06569c8c2ac46238a7ae5107598934234');
    expect(NAME_MODEL.dir).toBe('Xenova__bert-base-multilingual-cased-ner-hrl@263e82c06569');
    expect(MODEL_ROOT).toBe('models');
    expect(NAME_MODEL.files).toEqual([
      {
        path: 'config.json',
        bytes: 1207,
        sha256: '7aa891abae067f95a40f5e2005b3de44824a083f256802934a993d301ec25076',
      },
      {
        path: 'tokenizer.json',
        bytes: 2919362,
        sha256: 'bf1b59b7b11c95f194f51708d918eea378e09d05f84c0e1656dc5180e8117088',
      },
      {
        path: 'tokenizer_config.json',
        bytes: 367,
        sha256: 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a',
      },
      {
        path: 'onnx/model_quantized.onnx',
        bytes: 178495423,
        sha256: '5b65139844be260b624a2a13782b01d122e613d64ce16ed0ba4d82e0b816f1a9',
      },
    ]);
  });
});

describe('fileSha256', () => {
  it('hashes the bytes of a file (FIPS 180-2 "abc" vector)', async () => {
    write('abc', 'abc');
    expect(await fileSha256(join(dir, 'abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes a file larger than one read chunk whole', async () => {
    const big = 'x'.repeat(200_000) + 'y';
    write('big', big);
    expect(await fileSha256(join(dir, 'big'))).toBe(createHash('sha256').update(big).digest('hex'));
  });
});

describe('verifyFile', () => {
  const file = pinned('f', 'right');

  it('ok for the pinned bytes', async () => {
    write('f', 'right');
    expect(await verifyFile(join(dir, 'f'), file)).toBe('ok');
  });

  it('missing when nothing is there, or a directory is', async () => {
    expect(await verifyFile(join(dir, 'f'), file)).toBe('missing');
    mkdirSync(join(dir, 'f'));
    expect(await verifyFile(join(dir, 'f'), file)).toBe('missing');
  });

  it('mismatch for the same size and other bytes, and for another size', async () => {
    write('f', 'wrong');
    expect(await verifyFile(join(dir, 'f'), file)).toBe('mismatch');
    write('f', 'right!');
    expect(await verifyFile(join(dir, 'f'), file)).toBe('mismatch');
    write('f', '');
    expect(await verifyFile(join(dir, 'f'), file)).toBe('mismatch');
  });

  it('mismatch when only the hash is wrong (the size alone is not trusted)', async () => {
    write('f', 'right');
    expect(await verifyFile(join(dir, 'f'), { ...file, sha256: '0'.repeat(64) })).toBe('mismatch');
  });
});

describe('checkModelFiles: refuses start-up unless every file matches', () => {
  it('passes when every file is present and right', async () => {
    writeAll();
    await expect(checkModelFiles(dir, FILES)).resolves.toBeUndefined();
  });

  it('a missing file refuses, naming it', async () => {
    write('a.json', CONTENT['a.json']);
    expect(await refusal(checkModelFiles(dir, FILES))).toEqual({
      name: 'NameStartupError',
      code: 'NAME_MODEL_FILE_MISSING',
      file: 'onnx/m.onnx',
    });
  });

  it('an empty model directory, or none, refuses on the first file', async () => {
    for (const where of [dir, join(dir, 'absent')]) {
      expect(await refusal(checkModelFiles(where, FILES))).toMatchObject({
        code: 'NAME_MODEL_FILE_MISSING',
        file: 'a.json',
      });
    }
  });

  it('a file with other bytes refuses, naming it', async () => {
    writeAll();
    write('onnx/m.onnx', 'model bytez');
    expect(await refusal(checkModelFiles(dir, FILES))).toEqual({
      name: 'NameStartupError',
      code: 'NAME_MODEL_FILE_MISMATCH',
      file: 'onnx/m.onnx',
    });
  });

  it('a truncated file refuses (an interrupted copy)', async () => {
    writeAll();
    write('onnx/m.onnx', 'model');
    expect(await refusal(checkModelFiles(dir, FILES))).toMatchObject({
      code: 'NAME_MODEL_FILE_MISMATCH',
    });
  });

  it('reports the first wrong file in list order', async () => {
    write('a.json', '{"a":2}');
    expect(await refusal(checkModelFiles(dir, FILES))).toMatchObject({
      code: 'NAME_MODEL_FILE_MISMATCH',
      file: 'a.json',
    });
  });

  it('checks the real pinned list by default: a directory without the model refuses', async () => {
    expect(await refusal(checkModelFiles(dir))).toMatchObject({
      code: 'NAME_MODEL_FILE_MISSING',
      file: 'config.json',
    });
  });
});

describe('loadNameModel', () => {
  it('checks the files before anything else', async () => {
    expect(await refusal(loadNameModel(dir, FILES))).toMatchObject({
      code: 'NAME_MODEL_FILE_MISSING',
    });
    expect(await refusal(loadNameModel(dir))).toMatchObject({ file: 'config.json' });
  });

  it('with the files right, starts the model on that directory (its worker, step 4b)', async () => {
    writeAll();
    const model = { run: () => Promise.resolve([]), onCrash: () => {} };
    const asked: string[] = [];
    const loaded = await loadNameModel(dir, FILES, (at) => {
      asked.push(at);
      return Promise.resolve(model);
    });
    expect(loaded).toBe(model);
    expect(asked).toEqual([dir]);
  });

  it('a file wrong: the model is never started', async () => {
    let started = false;
    const start = () => {
      started = true;
      return Promise.resolve({ run: () => Promise.resolve([]), onCrash: () => {} });
    };
    expect(await refusal(loadNameModel(dir, FILES, start))).toMatchObject({
      code: 'NAME_MODEL_FILE_MISSING',
    });
    expect(started).toBe(false);
  });

  it('a worker that does not start: its rejection is passed on (startNameDetection makes it NAME_MODEL_LOAD_FAILED)', async () => {
    writeAll();
    await expect(
      loadNameModel(dir, FILES, () => Promise.reject(new Error('no worker'))),
    ).rejects.toThrow('no worker');
  });
});

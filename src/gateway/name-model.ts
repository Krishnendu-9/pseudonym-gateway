// The name model's files (ADR-036 (b)): where they come from, what they must
// be, and the check that refuses start-up when they are not. Loaded only
// when names are on; `scripts/fetch-model.ts` downloads from the same list,
// so the pins exist once.
//
// The SHA-256 values are the guarantee: a file is the measured model only if
// its bytes hash to the pinned value. They were recorded by the 6a download
// and measured again on a fresh download from the pinned commit on
// 2026-10-07 (ADR-036). The size is checked first only because it is cheap.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { NameStartupError } from './errors.js';
import { startNameWorker } from './name-worker.js';
import type { NameModel } from './names.js';

export interface ModelFile {
  /** Path inside the model directory and the repository, `/`-separated. */
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** B: the model ADR-035 measured, pinned to one commit of its repository. */
export const NAME_MODEL = {
  repo: 'Xenova/bert-base-multilingual-cased-ner-hrl',
  commit: '263e82c06569c8c2ac46238a7ae5107598934234',
  /** The directory the files go in, under the model root (the 6a layout). */
  dir: 'Xenova__bert-base-multilingual-cased-ner-hrl@263e82c06569',
  files: [
    {
      path: 'config.json',
      bytes: 1_207,
      sha256: '7aa891abae067f95a40f5e2005b3de44824a083f256802934a993d301ec25076',
    },
    {
      path: 'tokenizer.json',
      bytes: 2_919_362,
      sha256: 'bf1b59b7b11c95f194f51708d918eea378e09d05f84c0e1656dc5180e8117088',
    },
    {
      path: 'tokenizer_config.json',
      bytes: 367,
      sha256: 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a',
    },
    {
      path: 'onnx/model_quantized.onnx',
      bytes: 178_495_423,
      sha256: '5b65139844be260b624a2a13782b01d122e613d64ce16ed0ba4d82e0b816f1a9',
    },
  ] as readonly ModelFile[],
} as const;

/** Where the model directory goes, relative to the working directory (gitignored). */
export const MODEL_ROOT = 'models';

/** The SHA-256 of a file's bytes, read as a stream (the model is 178.5 MB). */
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Whether `path` holds exactly `file`: 'missing' (nothing there, or not a
 * regular file), 'mismatch' (wrong size or wrong SHA-256) or 'ok'.
 */
export async function verifyFile(
  path: string,
  file: ModelFile,
): Promise<'ok' | 'missing' | 'mismatch'> {
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) return 'missing';
    size = info.size;
  } catch {
    return 'missing';
  }
  if (size !== file.bytes) return 'mismatch';
  return (await fileSha256(path)) === file.sha256 ? 'ok' : 'mismatch';
}

/**
 * The load-time check (ADR-036): every file of `files` is in `dir` and
 * matches its pinned hash, or start-up is refused with the first file that
 * is not. Files are checked in list order.
 */
export async function checkModelFiles(
  dir: string,
  files: readonly ModelFile[] = NAME_MODEL.files,
): Promise<void> {
  for (const file of files) {
    const result = await verifyFile(join(dir, file.path), file);
    if (result === 'missing') throw new NameStartupError('NAME_MODEL_FILE_MISSING', file.path);
    if (result === 'mismatch') throw new NameStartupError('NAME_MODEL_FILE_MISMATCH', file.path);
  }
}

/**
 * Loads the name model from `dir`: checks its files first, so nothing is
 * loaded from a file that is not the measured one, then starts it in its
 * worker thread (`start`; name-worker.ts). A worker that does not start
 * rejects, and startNameDetection() refuses start-up with
 * NAME_MODEL_LOAD_FAILED.
 */
export async function loadNameModel(
  dir: string,
  files: readonly ModelFile[] = NAME_MODEL.files,
  start: (dir: string) => Promise<NameModel> = startNameWorker,
): Promise<NameModel> {
  await checkModelFiles(dir, files);
  return start(dir);
}

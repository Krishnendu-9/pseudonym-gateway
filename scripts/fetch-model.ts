// Downloads the name model's four files from the pinned commit and checks
// each against its pinned size and SHA-256 (ADR-036 (b)). Needed only for
// names on (PSEUDONYM_NAMES=true); names off never reads the model.
//
//   npm run fetch:model
//   npx tsx scripts/fetch-model.ts [--dir <model root>] [--from <base URL>]
//
// (PowerShell drops the flags of `npm run fetch:model -- --dir x`; use npx.)
// --dir: the model root, default `models` (the gateway looks in
// models/<NAME_MODEL.dir>). --from: a base URL holding the same files at the
// same paths, in place of Hugging Face at the pinned commit (a mirror; the
// hashes do not change, so a different file is refused).
//
// Files already in place and matching are kept. On the first file that does
// not match, its temporary copy is deleted, the file name and both hashes
// are printed, and the script exits 1 without touching the rest.

import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { MODEL_ROOT, NAME_MODEL } from '../src/gateway/name-model.js';
import { downloadVerified, ModelDownloadError } from './model-download.js';

const { values: args } = parseArgs({
  options: {
    dir: { type: 'string', default: MODEL_ROOT },
    from: { type: 'string' },
  },
});

const base = args.from ?? `https://huggingface.co/${NAME_MODEL.repo}/resolve/${NAME_MODEL.commit}`;
const dir = join(args.dir, NAME_MODEL.dir);

process.stdout.write(
  [
    `Model: ${NAME_MODEL.repo} at commit ${NAME_MODEL.commit}`,
    '',
    // ADR-036, licence amendment of 2026-10-11 (not legal advice).
    'Licence: these files state none; the repository above gives none. They',
    "are used on the strength of its card's statement that they are",
    'Davlan/bert-base-multilingual-cased-ner-hrl, licensed AFL-3.0',
    '(https://opensource.org/license/afl-3-0-php), converted to ONNX; that',
    'model is a fine-tune of google-bert/bert-base-multilingual-cased',
    '(Apache-2.0). If the statement were wrong, there would be no stated',
    'licence for these files.',
    '',
    'AFL-3.0 treats running the model for other people over a network as',
    'distribution. Whoever does so keeps its notices, does not use the',
    "licensor's name to endorse anything, and makes a reasonable effort to",
    "obtain their users' assent to the licence; the licence ends for anyone",
    'who sues claiming the model infringes a patent.',
    '',
    "Training data: Davlan's card lists CoNLL 2002 and 2003, ANERcorp,",
    'Europeana Newspapers, I-CAB, Latvian NER, Paramopama + Second HAREM and',
    "MSRA. Their terms were not checked, and whether a dataset's terms reach",
    'a model trained on it is legally unsettled. Names are off by default;',
    'if you switch them on, assess those terms for your own use.',
    '',
    `Into: ${dir}`,
    '',
  ].join('\n'),
);

try {
  for (const file of NAME_MODEL.files) {
    const result = await downloadVerified(
      `${base}/${file.path}`,
      join(dir, ...file.path.split('/')),
      file,
    );
    const what = result === 'present' ? 'already present' : 'downloaded';
    process.stdout.write(`ok  ${file.path}  ${file.bytes} bytes  sha256 ${file.sha256}  ${what}\n`);
  }
} catch (error) {
  // A refused file, or the network (fetch's own message names no data).
  const why = error instanceof ModelDownloadError ? error.message : `${String(error)}`;
  process.stderr.write(`refused: ${why}\n`);
  process.exitCode = 1;
}

// One verified download (ADR-036 (b)), kept apart from fetch-model.ts so it
// can be tested against a local server. A file is written to a temporary
// name next to its destination, hashed, and renamed into place only if its
// size and SHA-256 match the pinned ones; otherwise the temporary file is
// deleted and the download refused. A bad download never sits where the
// gateway looks. The hash is computed by the same function the gateway's
// load-time check uses (fileSha256).

import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { fileSha256, verifyFile, type ModelFile } from '../src/gateway/name-model.js';

/** A download that did not produce the pinned file. Names the file, never anything else. */
export class ModelDownloadError extends Error {
  readonly file: string;

  constructor(file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = 'ModelDownloadError';
    this.file = file;
  }
}

/** Fails the stream once more than `limit` bytes have passed through it. */
const capAt = (limit: number, file: string): Transform => {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > limit) done(new ModelDownloadError(file, `more than the pinned ${limit} bytes`));
      else done(null, chunk);
    },
  });
};

/**
 * Makes `dest` hold exactly `file`, downloading it from `url` unless it
 * already does. A file already at `dest` that does not match is deleted
 * first. Throws ModelDownloadError on an HTTP failure, a response longer
 * than the pinned size, or a size or SHA-256 that does not match.
 */
export async function downloadVerified(
  url: string,
  dest: string,
  file: ModelFile,
): Promise<'present' | 'downloaded'> {
  const before = await verifyFile(dest, file);
  if (before === 'ok') return 'present';
  if (before === 'mismatch') await rm(dest, { force: true });

  await mkdir(dirname(dest), { recursive: true });
  const temporary = `${dest}.download`;
  await rm(temporary, { force: true });
  let placed = false;
  try {
    const response = await fetch(url);
    if (!response.ok || response.body === null) {
      throw new ModelDownloadError(file.path, `HTTP ${response.status}`);
    }
    await pipeline(
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
      capAt(file.bytes, file.path),
      createWriteStream(temporary),
    );
    const got = await verifyFile(temporary, file);
    if (got !== 'ok') {
      const actual = await fileSha256(temporary);
      throw new ModelDownloadError(
        file.path,
        `SHA-256 mismatch: expected ${file.sha256}, got ${actual}`,
      );
    }
    await rename(temporary, dest);
    placed = true;
    return 'downloaded';
  } finally {
    if (!placed) await rm(temporary, { force: true });
  }
}

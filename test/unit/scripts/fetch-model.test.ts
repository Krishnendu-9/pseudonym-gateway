// The model download (ADR-036 (b)) against a local server: a file is put in
// place only when its size and SHA-256 match the pins; otherwise nothing is
// left where the gateway looks (no file, no temporary copy) and the download
// is refused. The last test runs the command itself and checks it exits 1.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ModelFile } from '../../../src/gateway/name-model.js';
import { NAME_MODEL } from '../../../src/gateway/name-model.js';
import { downloadVerified, ModelDownloadError } from '../../../scripts/model-download.js';

const RIGHT = 'the pinned bytes';
const FILE: ModelFile = {
  path: 'onnx/m.onnx',
  bytes: Buffer.byteLength(RIGHT),
  sha256: createHash('sha256').update(RIGHT).digest('hex'),
};

// What the server answers for each path, and how many requests it saw.
const routes = new Map<string, { status: number; body: string }>();
let requests = 0;
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    requests++;
    const route = routes.get(req.url ?? '') ?? { status: 404, body: 'not found' };
    res.writeHead(route.status).end(route.body);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));

let dir: string;
let dest: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fetch-model-'));
  dest = join(dir, 'onnx', 'm.onnx');
  routes.clear();
  requests = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const serve = (body: string, status = 200): void => {
  routes.set('/m', { status, body });
};
const download = (): Promise<'present' | 'downloaded'> => downloadVerified(`${base}/m`, dest, FILE);
/** Every file under dir, so a leftover temporary copy shows. */
const leftovers = (): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);

async function refused(): Promise<ModelDownloadError> {
  const error = await download().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ModelDownloadError);
  expect((error as ModelDownloadError).file).toBe(FILE.path);
  return error as ModelDownloadError;
}

describe('downloadVerified', () => {
  it('puts the pinned bytes in place, with no temporary copy left', async () => {
    serve(RIGHT);
    expect(await download()).toBe('downloaded');
    expect(readFileSync(dest, 'utf8')).toBe(RIGHT);
    expect(leftovers()).toEqual(['m.onnx']);
  });

  it('keeps a file already in place and right, without a request', async () => {
    serve(RIGHT);
    await download();
    requests = 0;
    expect(await download()).toBe('present');
    expect(requests).toBe(0);
  });

  it('other bytes of the same size: refused, nothing left, both hashes named', async () => {
    serve('the pinned bytez');
    const error = await refused();
    expect(error.message).toContain(`expected ${FILE.sha256}`);
    expect(error.message).toContain(
      `got ${createHash('sha256').update('the pinned bytez').digest('hex')}`,
    );
    expect(existsSync(dest)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('a short body: refused, nothing left', async () => {
    serve('the pinned');
    expect((await refused()).message).toContain('SHA-256 mismatch');
    expect(leftovers()).toEqual([]);
  });

  it('a body longer than the pinned size: stopped and refused, nothing left', async () => {
    serve(RIGHT + 'and more');
    expect((await refused()).message).toContain(`more than the pinned ${FILE.bytes} bytes`);
    expect(leftovers()).toEqual([]);
  });

  it('an HTTP error: refused, nothing written', async () => {
    serve(RIGHT, 500);
    expect((await refused()).message).toBe('onnx/m.onnx: HTTP 500');
    expect(leftovers()).toEqual([]);
    routes.clear();
    expect((await refused()).message).toBe('onnx/m.onnx: HTTP 404');
  });

  it('a wrong file already in place is replaced by a right download', async () => {
    mkdirSync(join(dir, 'onnx'));
    writeFileSync(dest, 'stale');
    serve(RIGHT);
    expect(await download()).toBe('downloaded');
    expect(readFileSync(dest, 'utf8')).toBe(RIGHT);
  });

  it('a wrong file already in place is removed even when the download is refused', async () => {
    mkdirSync(join(dir, 'onnx'));
    writeFileSync(dest, 'stale');
    serve('the pinned bytez');
    await refused();
    expect(leftovers()).toEqual([]);
  });
});

describe('npm run fetch:model', () => {
  it('exits 1 on a mismatch, names the file and both hashes, and leaves nothing', async () => {
    // Every path answers the same wrong bytes; the real pins expect others.
    for (const file of NAME_MODEL.files) routes.set(`/x/${file.path}`, { status: 200, body: 'x' });
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'scripts/fetch-model.ts', '--dir', dir, '--from', `${base}/x`],
      { cwd: join(import.meta.dirname, '..', '..', '..') },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number | null>((done) => child.on('close', done));
    expect(code).toBe(1);
    const [first] = NAME_MODEL.files;
    expect(stderr).toContain(
      `refused: ${first!.path}: SHA-256 mismatch: expected ${first!.sha256}`,
    );
    expect(leftovers()).toEqual([]);
    expect(requests).toBe(1); // stops at the first refused file
  });
});

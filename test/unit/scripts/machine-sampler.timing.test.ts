// The machine sampler's tests that wait on the real operating system
// (scripts/machine-sampler.ts). On Windows each sample runs `tasklist`,
// which may take up to LISTING_TIMEOUT_MS (15 s) and took longer than that
// under the full suite's load (bug-log 69). Each of these three has failed
// in a full run for that reason and passed alone: the first by getting no
// listing, the other two by reaching the 30 s test timeout, since they wait
// for two or more samples in a row. So they run in the timing project,
// after `main` and at limited workers (ADR-032 amendment 2026-11-04). The
// parsers and file rules stay in machine-sampler.test.ts.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HEADER,
  KEEP_FILES,
  processes,
  SAMPLES_DIR,
  startSampling,
} from '../../../scripts/machine-sampler.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sampler-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('reading the processes', () => {
  it('this machine: some processes, at least one of them Node (this one)', async () => {
    const found = await processes();
    expect(found).toBeDefined();
    expect(found!.total).toBeGreaterThan(1);
    expect(found!.node).toBeGreaterThanOrEqual(1);
  });
});

describe('the files', () => {
  it('a run shorter than the interval still gets a first and a last sample', async () => {
    const sampler = startSampling(dir, { intervalMs: 60_000 });
    const summary = await sampler.stop();
    expect(readFileSync(sampler.file, 'utf8').trimEnd().split('\n')).toHaveLength(4);
    expect(summary).toMatch(/^machine: 2 samples every 60 s;/u);
  });

  it('a real run: a header, then one line per sample, and old files pruned', async () => {
    const samplesDir = join(dir, SAMPLES_DIR);
    mkdirSync(samplesDir);
    for (let i = 0; i < KEEP_FILES + 5; i++) {
      writeFileSync(join(samplesDir, `20200101T0000${String(i).padStart(2, '0')}-1.tsv`), '');
    }
    const sampler = startSampling(dir, { intervalMs: 50 });
    // A sample waits for the process listing (on Windows a `tasklist` run),
    // so wait for samples rather than for a fixed time.
    const read = (): string[] => readFileSync(sampler.file, 'utf8').trimEnd().split('\n');
    for (let waited = 0; read().length < 4 && waited < 20_000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const summary = await sampler.stop();
    const lines = read();
    expect(lines[0]).toMatch(/^# \w+ \d+ logical CPUs, \d+ MB, Node v[\d.]+, every 0\.05 s$/u);
    expect(lines[1]).toBe(HEADER);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines.slice(2)) expect(line.split('\t')).toHaveLength(8);
    expect(summary).toMatch(/^machine: \d+ samples every 0\.05 s; free memory lowest \d+ MB/u);
    expect(summary.endsWith(`${SAMPLES_DIR}/${sampler.file.split(/[\\/]/u).at(-1)}`)).toBe(true);
    expect(readdirSync(samplesDir)).toHaveLength(KEEP_FILES);
  });
});

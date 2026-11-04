// The machine sampler (scripts/machine-sampler.ts): its parsers on fixed
// inputs, a fake /proc tree, the summary line and the pruning of old files.
// The tests that wait on this machine's real process listing are in
// machine-sampler.timing.test.ts (ADR-032 amendment 2026-11-04).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  busyPercent,
  filesToRemove,
  HEADER,
  parsePs,
  parseTasklist,
  processes,
  readProc,
  sampleLine,
  summaryLine,
  type Sample,
} from '../../../scripts/machine-sampler.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sampler-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('reading the processes', () => {
  it('tasklist (Windows): counts every process, and Node ones with their memory', () => {
    const output = [
      '"System Idle Process","0","Services","0","8 K"',
      '"node.exe","100","Console","1","1,024 K"',
      '"NODE.EXE","101","Console","1","2.048 K"',
      '"chrome.exe","200","Console","1","512,000 K"',
      '',
      'not a process line',
    ].join('\r\n');
    expect(parseTasklist(output)).toEqual({ total: 4, node: 2, nodeMb: 3 });
  });

  it('ps (macOS, Unix): RSS in KiB, then the command, a path or a bare name', () => {
    const output = '  2048 /usr/local/bin/node\n 1024 node\n 9999 /bin/zsh\n\n 10 nodemon\n';
    expect(parsePs(output)).toEqual({ total: 4, node: 2, nodeMb: 3 });
  });

  it('/proc (Linux): numeric directories only, Node by name, resident pages from statm', () => {
    const proc = join(dir, 'proc');
    const add = (pid: string, comm: string, statm?: string): void => {
      mkdirSync(join(proc, pid), { recursive: true });
      writeFileSync(join(proc, pid, 'comm'), `${comm}\n`);
      if (statm) writeFileSync(join(proc, pid, 'statm'), statm);
    };
    add('1', 'systemd', '100 50 0 0 0 0 0');
    add('20', 'node', '9000 2560 0 0 0 0 0');
    add('21', 'node', '9000 2560 0 0 0 0 0');
    // Like the real one, /proc/self is the reading process itself, with a
    // comm: only the numeric filter keeps it from being counted twice.
    add('self', 'node', '9000 2560 0 0 0 0 0');
    // A process that ended between the listing and the read: no comm.
    mkdirSync(join(proc, '99'));
    expect(readProc(proc)).toEqual({ total: 3, node: 2, nodeMb: 20 });
  });

  it('a platform whose command fails: no reading, no error', async () => {
    // "ps" with these options does not exist on Windows; elsewhere the
    // listing works, so only the Windows case is checked for undefined.
    // It stays in `main`: a failed and a timed-out listing both give
    // undefined, and the listing's 15 s limit is under the test timeout,
    // so load cannot change the outcome.
    const found = await processes(process.platform === 'win32' ? 'darwin' : process.platform);
    if (process.platform === 'win32') expect(found).toBeUndefined();
    else expect(found!.total).toBeGreaterThan(0);
  });
});

describe('a sample, and the summary', () => {
  const sample = (over: Partial<Sample>): Sample => ({
    at: new Date('2026-10-07T00:00:05.000Z'),
    elapsedS: 5,
    gapS: 5,
    freeMb: 6000,
    cpuBusy: 40,
    processes: { total: 300, node: 4, nodeMb: 900 },
    ...over,
  });

  it('busy CPU as a percentage of the time between two readings', () => {
    expect(busyPercent({ busy: 100, total: 1000 }, { busy: 350, total: 1500 })).toBe(50);
    expect(busyPercent({ busy: 1, total: 1 }, { busy: 1, total: 1 })).toBeUndefined();
  });

  it('one tab-separated line, "-" for a reading not taken, matching the header', () => {
    expect(sampleLine(sample({}))).toBe(
      '2026-10-07T00:00:05.000Z\t5.0\t5.0\t6000\t40\t300\t4\t900',
    );
    const line = sampleLine(sample({ cpuBusy: undefined, processes: undefined }));
    expect(line).toBe('2026-10-07T00:00:05.000Z\t5.0\t5.0\t6000\t-\t-\t-\t-');
    expect(line.split('\t')).toHaveLength(HEADER.split('\t').length);
  });

  it('the summary: lowest free memory and when, how often below 3,500 MB, the maxima, the longest gap', () => {
    const samples = [
      sample({}),
      sample({ elapsedS: 10, freeMb: 3200, cpuBusy: 97 }),
      sample({
        elapsedS: 15,
        freeMb: 3400,
        gapS: 21,
        processes: { total: 310, node: 9, nodeMb: 1500 },
      }),
    ];
    expect(summaryLine(samples, 'f.tsv', 5000)).toBe(
      'machine: 3 samples every 5 s; free memory lowest 3200 MB at 10 s, below 3500 MB in 2; ' +
        'CPU busy up to 97%; processes up to 310, Node up to 9 holding up to 1500 MB; ' +
        'longest gap 21.0 s (the sampler was held up); f.tsv',
    );
  });

  it('the summary with nothing below the threshold, readings missing, or no samples', () => {
    const plain = summaryLine(
      [sample({ cpuBusy: undefined, processes: undefined })],
      'f.tsv',
      5000,
    );
    expect(plain).toBe(
      'machine: 1 samples every 5 s; free memory lowest 6000 MB at 5 s; CPU busy up to -%; ' +
        'processes up to -, Node up to - holding up to - MB; longest gap 5.0 s; f.tsv',
    );
    expect(summaryLine([], 'f.tsv', 5000)).toBe('machine: no samples (f.tsv)');
  });
});

describe('the files', () => {
  it('keeps the newest KEEP_FILES - 1 sample files before a new one, and touches nothing else', () => {
    const names = [
      '20261007T010000-1.tsv',
      'notes.txt',
      '20261006T235959-9.tsv',
      '20261007T020000-2.tsv',
    ];
    expect(filesToRemove(names, 3)).toEqual(['20261006T235959-9.tsv']);
    expect(filesToRemove(names, 10)).toEqual([]);
  });
});

// Samples the machine while tests run (after bug-log 57 and the
// 2026-10-07 gate run of 1,227 s: twice, a test run went slow with no data
// on why). Every few seconds: free memory, CPU busy, how many processes are
// running, how many of them are Node and how much memory those hold, and
// the gap since the last sample (a gap much longer than the interval means
// the sampler itself was held up: a stalled or sleeping machine). Each
// sample is appended to the file as it is taken, so a run that hangs or is
// killed still leaves its samples. Started and stopped by the Vitest global
// setup (test/support/machine-sampling.ts).
//
// Never fails a test run: a reading it cannot take is written as "-".
// Holds numbers only: no command line, path or process name is recorded.

import { execFile } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from 'node:fs';
import { constants, cpus, freemem, platform, setPriority, totalmem } from 'node:os';
import { basename, join } from 'node:path';

/** Where the files go, at the repo root (gitignored). */
export const SAMPLES_DIR = '.machine-samples';
/** How many files are kept; older ones are removed when a run starts. */
export const KEEP_FILES = 20;
export const INTERVAL_MS = 5_000;
/** The free memory below which runs failed in bug-log 57. */
export const LOW_MEMORY_MB = 3_500;

export interface Processes {
  readonly total: number;
  readonly node: number;
  /** Resident memory of the Node processes together, in MiB. */
  readonly nodeMb: number;
}

const MIB = 2 ** 20;

/** `tasklist /FO CSV /NH` (Windows): one quoted line per process, memory as "45,328 K". */
export function parseTasklist(output: string): Processes {
  let total = 0;
  let node = 0;
  let nodeKb = 0;
  for (const line of output.split(/\r?\n/u)) {
    const fields = [...line.matchAll(/"([^"]*)"/gu)].map((m) => m[1]!);
    if (fields.length < 5) continue;
    total++;
    if (fields[0]!.toLowerCase() === 'node.exe') {
      node++;
      nodeKb += Number(fields[4]!.replace(/\D/gu, '')) || 0;
    }
  }
  return { total, node, nodeMb: Math.round(nodeKb / 1024) };
}

/** `ps -A -o rss=,comm=` (macOS and other Unix): RSS in KiB, then the command. */
export function parsePs(output: string): Processes {
  let total = 0;
  let node = 0;
  let nodeKb = 0;
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (!match) continue;
    total++;
    if (/(^|\/)node$/u.test(match[2]!.trim())) {
      node++;
      nodeKb += Number(match[1]);
    }
  }
  return { total, node, nodeMb: Math.round(nodeKb / 1024) };
}

/**
 * Linux, from /proc: every numeric directory is a process. A Node process
 * is one whose executable (`exe`) is named `node`; where `exe` cannot be
 * read (another user's process), its `comm`, which a process can rename
 * (`process.title`). The second field of `statm` is its resident size in
 * pages (4 KiB assumed). A process that ends while being read is skipped.
 */
export function readProc(root = '/proc'): Processes {
  let total = 0;
  let node = 0;
  let nodePages = 0;
  for (const entry of readdirSync(root)) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      let name: string;
      try {
        name = basename(readlinkSync(join(root, entry, 'exe')));
      } catch {
        name = readFileSync(join(root, entry, 'comm'), 'utf8').trim();
      }
      total++;
      if (name === 'node') {
        node++;
        nodePages += Number(readFileSync(join(root, entry, 'statm'), 'utf8').split(' ')[1]) || 0;
      }
    } catch {
      // Gone between the listing and the read.
    }
  }
  return { total, node, nodeMb: Math.round((nodePages * 4096) / MIB) };
}

/**
 * How long a process listing may take. Generous on purpose: under the full
 * suite's load `tasklist` took over 4 s, and then over 15 s (bug-log 69),
 * the moments the listing matters most. A slow listing delays the next
 * sample (one is taken at a time), and the longer gap then shows the
 * machine was struggling.
 */
export const LISTING_TIMEOUT_MS = 15_000;

/** The processes on this machine, or undefined if they cannot be read. */
export function processes(os: NodeJS.Platform = platform()): Promise<Processes | undefined> {
  if (os === 'linux') {
    try {
      return Promise.resolve(readProc());
    } catch {
      return Promise.resolve(undefined);
    }
  }
  const [command, args, parse] =
    os === 'win32'
      ? (['tasklist', ['/FO', 'CSV', '/NH'], parseTasklist] as const)
      : (['ps', ['-A', '-o', 'rss=,comm='], parsePs] as const);
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      { timeout: LISTING_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => resolve(error ? undefined : parse(stdout)),
    );
    // Starved by busy test workers, `tasklist` took 14.1 s at normal
    // priority and 1.2 s raised, measured back to back under load (bug-log
    // 69). Best-effort: Unix refuses a raise without root, and `ps` does not
    // need one.
    if (os === 'win32' && child.pid !== undefined) {
      try {
        setPriority(child.pid, constants.priority.PRIORITY_HIGH);
      } catch {
        // Left at normal priority.
      }
    }
  });
}

/** CPU time so far, summed over every core: busy and total, in ms. */
export function cpuTimes(): { busy: number; total: number } {
  let busy = 0;
  let total = 0;
  for (const { times } of cpus()) {
    const all = times.user + times.nice + times.sys + times.idle + times.irq;
    total += all;
    busy += all - times.idle;
  }
  return { busy, total };
}

/** The share of CPU time spent busy between two readings, as a whole percentage. */
export function busyPercent(
  before: { busy: number; total: number },
  after: { busy: number; total: number },
): number | undefined {
  const total = after.total - before.total;
  return total > 0 ? Math.round(((after.busy - before.busy) / total) * 100) : undefined;
}

export interface Sample {
  readonly at: Date;
  /** Seconds since sampling started. */
  readonly elapsedS: number;
  /** Seconds since the previous sample. */
  readonly gapS: number;
  readonly freeMb: number;
  readonly cpuBusy: number | undefined;
  readonly processes: Processes | undefined;
}

export const HEADER =
  'time\telapsed_s\tgap_s\tfree_mb\tcpu_busy_pct\tprocesses\tnode_processes\tnode_mb';

const cell = (value: number | undefined): string => (value === undefined ? '-' : String(value));

export function sampleLine(s: Sample): string {
  return [
    s.at.toISOString(),
    s.elapsedS.toFixed(1),
    s.gapS.toFixed(1),
    String(s.freeMb),
    cell(s.cpuBusy),
    cell(s.processes?.total),
    cell(s.processes?.node),
    cell(s.processes?.nodeMb),
  ].join('\t');
}

/** One line for the console at the end of a run. */
export function summaryLine(samples: readonly Sample[], file: string, intervalMs: number): string {
  if (samples.length === 0) return `machine: no samples (${file})`;
  const lowest = samples.reduce((a, b) => (b.freeMb < a.freeMb ? b : a));
  const low = samples.filter((s) => s.freeMb < LOW_MEMORY_MB).length;
  const max = (read: (s: Sample) => number | undefined): string => {
    const values = samples.map(read).filter((v): v is number => v !== undefined);
    return values.length === 0 ? '-' : String(Math.max(...values));
  };
  const gap = Math.max(...samples.map((s) => s.gapS));
  const held = gap > (3 * intervalMs) / 1000 ? ' (the sampler was held up)' : '';
  return (
    `machine: ${samples.length} samples every ${intervalMs / 1000} s; ` +
    `free memory lowest ${lowest.freeMb} MB at ${lowest.elapsedS.toFixed(0)} s` +
    `${low > 0 ? `, below ${LOW_MEMORY_MB} MB in ${low}` : ''}; ` +
    `CPU busy up to ${max((s) => s.cpuBusy)}%; processes up to ${max((s) => s.processes?.total)}, ` +
    `Node up to ${max((s) => s.processes?.node)} holding up to ${max((s) => s.processes?.nodeMb)} MB; ` +
    `longest gap ${gap.toFixed(1)} s${held}; ${file}`
  );
}

/** The sample files in `dir`, oldest first, past the newest `keep - 1`: removed before a new one starts. */
export function filesToRemove(names: readonly string[], keep: number): string[] {
  const samples = names.filter((n) => /^\d{8}T\d{6}-\d+\.tsv$/u.test(n)).sort();
  return samples.slice(0, Math.max(0, samples.length - (keep - 1)));
}

export interface Sampler {
  readonly file: string;
  /** Takes a last sample, stops, and returns the summary line. */
  stop(): Promise<string>;
}

/** Starts sampling into a new file under `root`/SAMPLES_DIR. */
export function startSampling(
  root: string,
  { intervalMs = INTERVAL_MS, now = () => new Date() } = {},
): Sampler {
  const dir = join(root, SAMPLES_DIR);
  mkdirSync(dir, { recursive: true });
  for (const old of filesToRemove(readdirSync(dir), KEEP_FILES))
    rmSync(join(dir, old), { force: true });
  const started = now();
  const stamp = started.toISOString().replace(/[-:]/gu, '').slice(0, 15);
  const name = `${stamp}-${process.pid}.tsv`;
  const file = join(dir, name);
  appendFileSync(
    file,
    `# ${platform()} ${cpus().length} logical CPUs, ${Math.round(totalmem() / MIB)} MB, Node ${process.version}, every ${intervalMs / 1000} s\n${HEADER}\n`,
  );
  const samples: Sample[] = [];
  let last = started.getTime();
  let cpu = cpuTimes();
  let busy = false;
  let pending: Promise<void> = Promise.resolve();
  const take = (): Promise<void> => {
    if (busy) return pending;
    busy = true;
    pending = record();
    return pending;
  };
  const record = async (): Promise<void> => {
    try {
      const at = now();
      const cpuNow = cpuTimes();
      const sample: Sample = {
        at,
        elapsedS: (at.getTime() - started.getTime()) / 1000,
        gapS: (at.getTime() - last) / 1000,
        freeMb: Math.round(freemem() / MIB),
        cpuBusy: busyPercent(cpu, cpuNow),
        processes: await processes(),
      };
      last = at.getTime();
      cpu = cpuNow;
      samples.push(sample);
      appendFileSync(file, `${sampleLine(sample)}\n`);
    } catch {
      // Sampling never fails the run.
    } finally {
      busy = false;
    }
  };
  void take();
  const timer = setInterval(() => void take(), intervalMs);
  timer.unref();
  return {
    file,
    // One last sample, after any still being taken, so that even a run
    // shorter than the interval has a reading from its start and its end.
    stop: async () => {
      clearInterval(timer);
      await pending;
      await take();
      return summaryLine(samples, `${SAMPLES_DIR}/${name}`, intervalMs);
    },
  };
}

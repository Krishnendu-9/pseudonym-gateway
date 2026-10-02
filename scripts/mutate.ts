// Mutation checks, one at a time (bug-log 24): change one thing in a source
// file, run the given tests with a time limit, count what fails, put the
// file back.
//
//   npx tsx scripts/mutate.ts --out <dir> <mutations.mjs> [id …]
//   npx tsx scripts/mutate.ts --restore
//
// A mutation list is a module exporting MUTATIONS, each
// { id, what, file, tests, find, replace }: `find` must occur exactly once
// in `file` (repo-relative). Lists and results live outside the repo.
// `tests` are file paths; Vitest runs each in its own project, so a
// `*.timing.test.ts` file runs in the timing project. List it whenever a
// mutation could make code slower without changing an answer: only the
// timing tests catch that (ADR-032).
//
// The file is put back in `finally`, on SIGINT/SIGTERM and on exit. None of
// those runs when the process is killed outright, so before writing a
// mutation the runner writes the marker (scripts/mutation-marker.ts) at the
// repo root, and every later test or evaluation run refuses to start until
// `--restore` has put the file back. The time limit is checked against the
// wall clock every few seconds, so a run that outlived it (the machine
// slept) is stopped as soon as the runner wakes.

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  MUTATION_ID_ENV,
  leftoverMutation,
  readMarker,
  removeMarker,
  restoreLeftover,
  writeMarker,
} from './mutation-marker.js';

interface Mutation {
  readonly id: string;
  readonly what: string;
  readonly file: string;
  readonly tests: readonly string[];
  readonly find: string;
  readonly replace: string;
}

const ROOT = resolve(import.meta.dirname, '..');
const LIMIT_MS = Number(process.env.MUT_LIMIT_MS ?? 15 * 60 * 1000);
const REPORTER = join(import.meta.dirname, 'mutation-reporter.ts').replaceAll('\\', '/');
const args = process.argv.slice(2);

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

if (args[0] === '--restore') {
  const marker = readMarker(ROOT);
  if (marker && marker.pid !== process.pid && isAlive(marker.pid)) {
    console.log(
      `Process ${marker.pid}, which wrote mutation ${marker.mutation}, is still running. ` +
        `Stop it first (taskkill /PID ${marker.pid} /T /F), then run --restore again.`,
    );
    process.exit(2);
  }
  const outcome = restoreLeftover(ROOT);
  const messages = {
    none: 'No mutation marker: nothing to restore.',
    restored: `${marker?.file} put back (mutation ${marker?.mutation}); marker removed.`,
    'already-original': `${marker?.file} already held its original text; marker removed.`,
    'changed-since':
      `${marker?.file} is neither the original nor the mutant: it was edited after mutation ` +
      `${marker?.mutation} was written. Nothing changed; compare it with the marker by hand.`,
  } as const;
  console.log(messages[outcome]);
  process.exit(outcome === 'changed-since' ? 1 : 0);
}

const outIndex = args.indexOf('--out');
if (outIndex < 0 || !args[outIndex + 1] || !args[outIndex + 2]) {
  console.log('Usage: npx tsx scripts/mutate.ts --out <dir> <mutations.mjs> [id …] | --restore');
  process.exit(2);
}
const OUT = resolve(args[outIndex + 1]!);
const listPath = resolve(args[outIndex + 2]!);
const only = args.slice(outIndex + 3);
const RESULTS = join(OUT, 'results.log');
// The tests report into OUT: without it they report nothing (bug-log 38).
mkdirSync(OUT, { recursive: true });

const refusal = leftoverMutation(ROOT, {});
if (refusal) {
  console.log(`REFUSED. ${refusal}`);
  process.exit(2);
}

let pending: { path: string; original: string } | undefined;
const putBack = (): void => {
  if (!pending) return;
  writeFileSync(pending.path, pending.original);
  if (readFileSync(pending.path, 'utf8') !== pending.original) {
    throw new Error(`${pending.path} could not be put back; the marker stays`);
  }
  removeMarker(ROOT);
  pending = undefined;
};
let child: ChildProcess | undefined;
const killChild = (): void => {
  if (child?.pid !== undefined && child.exitCode === null) {
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
    } catch {
      child.kill('SIGKILL');
    }
  }
};
process.on('exit', () => {
  killChild();
  putBack();
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => process.exit(130));
}

const { MUTATIONS } = (await import(pathToFileURL(listPath).href)) as {
  MUTATIONS: readonly Mutation[];
};
const log = (line: string): void => {
  console.log(line);
  appendFileSync(RESULTS, `${line}\n`);
};

for (const m of MUTATIONS) {
  if (only.length > 0 && !only.includes(m.id)) continue;
  const path = join(ROOT, m.file);
  const original = readFileSync(path, 'utf8');
  const count = original.split(m.find).length - 1;
  if (count !== 1) {
    log(`${m.id}: SKIPPED, "find" occurs ${count} times in ${m.file}`);
    continue;
  }
  const mutated = original.replace(m.find, () => m.replace);
  const progress = join(OUT, `mut-${m.id}.progress`);
  rmSync(progress, { force: true });
  const id = randomUUID();
  writeMarker(ROOT, {
    id,
    mutation: m.id,
    file: m.file,
    original,
    mutated,
    startedAt: new Date().toISOString(),
    pid: process.pid,
  });
  pending = { path, original };
  const started = Date.now();
  let stopped = false;
  try {
    writeFileSync(path, mutated);
    await new Promise<void>((done) => {
      child = spawn('npx', ['vitest', 'run', ...m.tests, `--reporter=${REPORTER}`], {
        cwd: ROOT,
        shell: true,
        env: { ...process.env, MUT_PROGRESS: progress, [MUTATION_ID_ENV]: id },
        stdio: 'ignore',
      });
      const watchdog = setInterval(() => {
        if (Date.now() - started > LIMIT_MS) {
          stopped = true;
          killChild();
        }
      }, 2_000);
      child.on('exit', () => {
        clearInterval(watchdog);
        done();
      });
    });
  } finally {
    putBack();
  }
  const lines = existsSync(progress)
    ? readFileSync(progress, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  const failed = lines.filter((l) => l.startsWith('failed\t')).map((l) => l.slice(7));
  const moduleErrors = lines.filter((l) => l.startsWith('module-error\t')).length;
  const secs = Math.round((Date.now() - started) / 1000);
  // No test reported at all is no result, never "0 of 0 failed": that reads
  // as a mutation the tests did not catch (bug-log 38).
  const head = stopped
    ? `stopped after ${Math.round(LIMIT_MS / 60_000)} minutes with ${failed.length} already failed (${lines.length} reported)`
    : lines.length === 0
      ? 'NO RESULT: no test reported anything'
      : `${failed.length} of ${lines.length - moduleErrors} failed`;
  const errors = moduleErrors ? ` (+${moduleErrors} module error(s))` : '';
  log(`${m.id}: ${head}${errors} in ${secs}s | ${m.what}`);
  for (const t of failed.slice(0, 6)) log(`      - ${t.slice(0, 140)}`);
  if (failed.length > 6) log(`      … and ${failed.length - 6} more`);
}

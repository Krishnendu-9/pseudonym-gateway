import { availableParallelism } from 'node:os';
import { configDefaults, defineConfig } from 'vitest/config';

// Growth-ratio tests (test/support/linear-time.ts) live in *.timing.test.ts
// files and run in their own project, after the rest and at most three files
// at a time (ADR-032). Measured on this machine: alongside the other tests,
// 11 workers on 12 logical CPUs inflated ratios to 8.6 and stretched one call
// to 42.8 s; on their own, three at a time, 267 calls never reached 6.3 and
// none took over 10 s. Other heavy work on the machine still breaks them.
// PSEUDONYM_TIMING_WORKERS overrides the count: CI sets it to 1, because the
// three at a time was measured on 12 cores and GitHub's ubuntu-latest runner
// has 4. The --maxWorkers flag cannot do this: a project's own maxWorkers wins.
const TIMING_TESTS = 'test/**/*.timing.test.ts';
const TIMING_WORKERS = timingWorkers(process.env.PSEUDONYM_TIMING_WORKERS);

function timingWorkers(setting: string | undefined): number {
  if (setting === undefined) return Math.max(1, Math.min(3, availableParallelism() - 1));
  if (!/^[1-9][0-9]*$/.test(setting)) {
    throw new Error('PSEUDONYM_TIMING_WORKERS must be a whole number of at least 1');
  }
  return Number(setting);
}

export default defineConfig({
  test: {
    environment: 'node',
    // Refuses to run while a mutation may still be written into a source file
    // (bug-log 24, scripts/mutation-marker.ts).
    globalSetup: ['test/support/mutation-guard.ts'],
    // A timeout only guards against a hang. The 5 s default failed property
    // tests on a busy machine, so no test asserts wall-clock time any more:
    // linear-time tests compare growth ratios instead (test/support/linear-time.ts).
    testTimeout: 30_000,
    // Hooks get the same guard. The first server built in a worker loads
    // Fastify's parts from disk: 0.4 to 2.8 s in an ordinary full run and 5.6 s
    // on a busy machine, and in no-leak.test.ts that happens in a beforeAll,
    // under Vitest's 10 s default for hooks (bug-log 21).
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'main',
          include: ['test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, TIMING_TESTS],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'timing',
          include: [TIMING_TESTS],
          maxWorkers: TIMING_WORKERS,
          sequence: { groupOrder: 1 },
        },
      },
    ],
    // `npm run test:coverage` runs with --maxWorkers=4 (package.json): half
    // the memory at no measured cost in time. A mitigation, not a proven fix:
    // the failures it guards against came from memory taken outside the
    // test run (bug-log 57).
    coverage: {
      provider: 'v8',
      // The evaluation's code decides what the published numbers are, so it
      // is held to the same coverage as the gateway.
      include: ['src/**/*.ts', 'eval/**/*.ts'],
      // Wiring only (read env or files, print, exit); every decision they
      // make is in a tested module. Testing them would mean spawning a process.
      exclude: ['src/main.ts', 'eval/run.ts', 'eval/check-held-out.ts'],
      reporter: ['text', 'html'],
      // Every line, branch, function and statement, or the run fails (CI too).
      thresholds: { 100: true },
    },
  },
});

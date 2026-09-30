import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // A timeout only guards against a hang. The 5 s default failed property
    // tests on a busy machine, so no test asserts wall-clock time any more:
    // linear-time tests compare growth ratios instead (test/support/linear-time.ts).
    testTimeout: 30_000,
    // Hooks get the same guard. The first server built in a worker loads
    // Fastify's parts from disk: 0.4 to 2.8 s in an ordinary full run and 5.6 s
    // on a busy machine, and in no-leak.test.ts that happens in a beforeAll,
    // under Vitest's 10 s default for hooks (bug-log 21).
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Wiring only (read env, check hardening, listen); every decision it
      // makes is in a tested module. Testing it would mean spawning a process.
      exclude: ['src/main.ts'],
      reporter: ['text', 'html'],
    },
  },
});

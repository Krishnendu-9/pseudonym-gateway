import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // A timeout only guards against a hang. The 5 s default failed property
    // tests on a busy machine, so no test asserts wall-clock time any more:
    // linear-time tests compare growth ratios instead (test/support/linear-time.ts).
    testTimeout: 30_000,
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

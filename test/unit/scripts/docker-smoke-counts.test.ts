// The Docker smoke test's check count (ADR-046 amendment H): the script
// fails a run with any other count, and the testing guide must state the
// same numbers. Before this, the docs' count fell behind the script's more
// than once.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  countProblem,
  expectedChecks,
  SMOKE_CHECKS,
  SMOKE_CHECKS_WITH_MODELS,
} from '../../../scripts/docker-smoke-counts.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');

describe('the smoke test check count', () => {
  it('expects 31 checks in a plain run and 9 more with --models', () => {
    expect(expectedChecks(false)).toBe(SMOKE_CHECKS);
    expect(expectedChecks(true)).toBe(SMOKE_CHECKS + SMOKE_CHECKS_WITH_MODELS);
  });

  it('accepts exactly the expected count', () => {
    expect(countProblem(SMOKE_CHECKS, false)).toBeUndefined();
    expect(countProblem(SMOKE_CHECKS + SMOKE_CHECKS_WITH_MODELS, true)).toBeUndefined();
  });

  it('rejects one check more or fewer, and the other mode', () => {
    for (const [ran, withModels] of [
      [SMOKE_CHECKS - 1, false],
      [SMOKE_CHECKS + 1, false],
      [SMOKE_CHECKS + SMOKE_CHECKS_WITH_MODELS, false],
      [SMOKE_CHECKS, true],
      [SMOKE_CHECKS + SMOKE_CHECKS_WITH_MODELS + 1, true],
    ] as const) {
      expect(countProblem(ran, withModels)).toBe(
        `made ${ran} checks, expected ${expectedChecks(withModels)} (scripts/docker-smoke-counts.ts)`,
      );
    }
  });

  it('the testing guide states the same counts', () => {
    const guide = readFileSync(join(ROOT, 'docs', 'testing-guide.md'), 'utf8').replace(/\s+/g, ' ');
    expect(guide).toContain(
      `It runs ${SMOKE_CHECKS} checks, plus ${SMOKE_CHECKS_WITH_MODELS} more with \`--models\` (${expectedChecks(true)} in all)`,
    );
  });
});

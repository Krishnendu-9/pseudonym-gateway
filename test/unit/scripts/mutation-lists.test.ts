// Every tracked mutation list (scripts/mutations/, ADR-043) must stay
// runnable: a list whose `find` no longer matches is skipped by the runner,
// and a tracked list that cannot be run is no better than a lost one.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Mutation } from '../../../scripts/mutate.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const DIR = join(ROOT, 'scripts', 'mutations');
const LISTS = readdirSync(DIR).filter((name) => name.endsWith('.ts'));

describe('tracked mutation lists', () => {
  it('there is at least one', () => {
    expect(LISTS.length).toBeGreaterThan(0);
  });

  it.each(LISTS)('%s can be run as it stands', async (name) => {
    const { MUTATIONS } = (await import(pathToFileURL(join(DIR, name)).href)) as {
      MUTATIONS: readonly Mutation[];
    };
    expect(MUTATIONS.length).toBeGreaterThan(0);
    const ids = MUTATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of MUTATIONS) {
      const source = readFileSync(join(ROOT, m.file), 'utf8');
      // The runner's own rule: `find` occurs exactly once.
      expect(source.split(m.find).length - 1, `${m.id}: find in ${m.file}`).toBe(1);
      expect(m.replace, `${m.id}: replace`).not.toBe(m.find);
      expect(m.tests.length, `${m.id}: tests`).toBeGreaterThan(0);
      for (const test of m.tests)
        expect(existsSync(join(ROOT, test)), `${m.id}: ${test}`).toBe(true);
    }
  });
});

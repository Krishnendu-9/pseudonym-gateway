// The mutation marker (bug-log 24): a leftover marker stops every test and
// evaluation run, except the runner's own; --restore puts the file back only
// when it is exactly the mutant.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MUTATION_ID_ENV,
  leftoverMutation,
  markerPath,
  readMarker,
  restoreLeftover,
  writeMarker,
  type Marker,
} from '../../../scripts/mutation-marker.js';

const ORIGINAL = 'const gluedAfter = GLUED_AFTER.test(next);\n';
const MUTATED = 'const gluedAfter = false;\n';

let root: string;
const file = (): string => join(root, 'src', 'ip.ts');
const marker: Marker = {
  id: 'run-1',
  mutation: 'I6',
  file: 'src/ip.ts',
  original: ORIGINAL,
  mutated: MUTATED,
  startedAt: '2026-10-01T08:47:54.000Z',
  pid: 1,
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mutation-marker-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(file(), MUTATED);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('leftoverMutation', () => {
  it('lets a run go on when there is no marker', () => {
    expect(leftoverMutation(root, {})).toBeUndefined();
  });

  it('refuses while a marker exists, naming the mutation, the file and the way out', () => {
    writeMarker(root, marker);
    const refusal = leftoverMutation(root, {});
    expect(refusal).toContain('Mutation I6');
    expect(refusal).toContain('src/ip.ts');
    expect(refusal).toContain('npx tsx scripts/mutate.ts --restore');
    expect(refusal).not.toContain(MUTATED.trim());
  });

  it("lets the runner's own test run go on, and only that one", () => {
    writeMarker(root, marker);
    expect(leftoverMutation(root, { [MUTATION_ID_ENV]: 'run-1' })).toBeUndefined();
    expect(leftoverMutation(root, { [MUTATION_ID_ENV]: 'run-0' })).toBeDefined();
  });

  it('reads back what was written', () => {
    writeMarker(root, marker);
    expect(readMarker(root)).toEqual(marker);
  });
});

describe('restoreLeftover', () => {
  it('does nothing without a marker', () => {
    expect(restoreLeftover(root)).toBe('none');
    expect(readFileSync(file(), 'utf8')).toBe(MUTATED);
  });

  it('puts the mutated file back and removes the marker', () => {
    writeMarker(root, marker);
    expect(restoreLeftover(root)).toBe('restored');
    expect(readFileSync(file(), 'utf8')).toBe(ORIGINAL);
    expect(existsSync(markerPath(root))).toBe(false);
  });

  it('only removes the marker when the file is already the original', () => {
    writeFileSync(file(), ORIGINAL);
    writeMarker(root, marker);
    expect(restoreLeftover(root)).toBe('already-original');
    expect(readFileSync(file(), 'utf8')).toBe(ORIGINAL);
    expect(existsSync(markerPath(root))).toBe(false);
  });

  it('leaves a file edited since the mutation, and the marker, alone', () => {
    writeFileSync(file(), `${MUTATED}// edited afterwards\n`);
    writeMarker(root, marker);
    expect(restoreLeftover(root)).toBe('changed-since');
    expect(readFileSync(file(), 'utf8')).toBe(`${MUTATED}// edited afterwards\n`);
    expect(existsSync(markerPath(root))).toBe(true);
  });
});

// The mutation runner's marker (bug-log 24). Before the runner writes a
// mutation into a source file it writes this marker at the repo root, with
// the file's original and mutated text, and it deletes the marker once the
// file is back. A runner killed outright (a usage limit ends the session,
// the machine is shut down) runs no exit handler, so the marker stays, and
// with it the mutated file. Every test run and every evaluation run checks
// for the marker first and refuses to go on (vitest.config.ts, eval/run.ts):
// a result measured on a mutated file must never be believed, and an
// `eval --update` must never write it into the baseline.
//
// The runner's own test runs carry the marker's id in PSEUDONYM_MUTATION_ID;
// they are the only ones allowed to run while it exists.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MARKER_NAME = '.mutation-in-progress.json';
export const MUTATION_ID_ENV = 'PSEUDONYM_MUTATION_ID';

export interface Marker {
  /** Unique per mutation written; the runner's test runs carry it. */
  readonly id: string;
  /** The mutation's id in its list, e.g. "I6". */
  readonly mutation: string;
  /** Repo-relative path of the mutated file, with forward slashes. */
  readonly file: string;
  readonly original: string;
  readonly mutated: string;
  readonly startedAt: string;
  /** The runner's process id, to tell a live run from an interrupted one. */
  readonly pid: number;
}

export const markerPath = (root: string): string => join(root, MARKER_NAME);

export function readMarker(root: string): Marker | undefined {
  const path = markerPath(root);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Marker) : undefined;
}

export function writeMarker(root: string, marker: Marker): void {
  writeFileSync(markerPath(root), JSON.stringify(marker));
}

export function removeMarker(root: string): void {
  rmSync(markerPath(root), { force: true });
}

/** Why a run must not go on, or undefined when it may. */
export function leftoverMutation(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const marker = readMarker(root);
  if (!marker || env[MUTATION_ID_ENV] === marker.id) return undefined;
  return (
    `Mutation ${marker.mutation} (started ${marker.startedAt}) may still be written into ` +
    `${marker.file}: ${MARKER_NAME} exists. Either a mutation run is going on, or one was ` +
    `stopped before it could put the file back (bug-log 24). Results measured now could be ` +
    `the mutant's. Run "npx tsx scripts/mutate.ts --restore", then run this again.`
  );
}

export type RestoreOutcome = 'none' | 'restored' | 'already-original' | 'changed-since';

/**
 * Puts the marker's file back, only when it is exactly the mutated text: a
 * file edited since the mutation is left alone for a person to look at.
 */
export function restoreLeftover(root: string): RestoreOutcome {
  const marker = readMarker(root);
  if (!marker) return 'none';
  const path = join(root, marker.file);
  const current = readFileSync(path, 'utf8');
  if (current === marker.original) {
    removeMarker(root);
    return 'already-original';
  }
  if (current !== marker.mutated) return 'changed-since';
  writeFileSync(path, marker.original);
  removeMarker(root);
  return 'restored';
}

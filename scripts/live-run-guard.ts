// The guard in front of every live call to a provider (ADR-041 section 11,
// "PROCESS FAILURE"). Attempt 4 ran while the plan that governed it was
// staged but not committed, so the history cannot show that the plan came
// first. A check to remember (`git log -1` before a run) was recorded and
// then replaced by this one: a live run refuses unless the working tree is
// clean, so the plan in docs/decisions.md, staged or not, is in a commit
// before anything is sent, and the run records which commit.
//
// The whole tree, not only docs/decisions.md: the bytes sent are decided by
// the measuring script and src/, so a run from uncommitted code could not be
// reproduced from the history; and an earlier attempt's recordings left
// uncommitted would go into one commit with the next plan, the mixing
// Attempt 4 produced. Ignored files (.env, models/, .machine-samples/) do
// not count: git does not report them.
//
// What it cannot do: stop the history being rewritten after a run (a plan
// amended into an earlier commit). It proves the tree was clean when the run
// started and names the commit; the recording carries that name.

import { execFileSync } from 'node:child_process';

export const PLAN_FILE = 'docs/decisions.md';
const MAX_LISTED = 10;

/** Runs git with these arguments; returns its standard output, throws on failure. */
export type Git = (args: readonly string[]) => string;

export const gitIn =
  (dir: string): Git =>
  (args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export type TreeCheck =
  { readonly ok: true; readonly head: string } | { readonly ok: false; readonly reason: string };

/** The paths in `git status --porcelain=v1 -z` output; a rename's old path is skipped. */
export function changedPaths(porcelain: string): string[] {
  const fields = porcelain.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) i++;
  }
  return paths;
}

const refused = (why: string): TreeCheck => ({
  ok: false,
  reason: `refusing to make a live call: ${why}`,
});

/** Whether a live run may start: a clean working tree on a commit. */
export function checkTree(git: Git): TreeCheck {
  let porcelain: string;
  try {
    porcelain = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  } catch {
    return refused('git could not report the working tree (is this a git repository?).');
  }
  const paths = changedPaths(porcelain);
  if (paths.length > 0) {
    const plan = paths.includes(PLAN_FILE)
      ? `, ${PLAN_FILE} among them (a plan staged or edited but not committed is the ` +
        `failure Attempt 4 had)`
      : '';
    const listed = paths.slice(0, MAX_LISTED).map((path) => `\n  ${path}`);
    const more = paths.length > MAX_LISTED ? `\n  and ${paths.length - MAX_LISTED} more` : '';
    return refused(
      `the working tree has ${paths.length} uncommitted change(s)${plan}. Commit the plan ` +
        `for this run (ADR-041 section 11) and everything else first, then run again:` +
        listed.join('') +
        more,
    );
  }
  let head: string;
  try {
    head = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).trim();
  } catch {
    return refused('there is no commit to run from.');
  }
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head)) {
    return refused('git did not name a commit for HEAD.');
  }
  return { ok: true, head };
}

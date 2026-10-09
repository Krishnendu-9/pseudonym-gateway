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
// It also requires HEAD to be an ancestor of the last known origin/main
// (amendment 2026-10-10): a local commit can be amended or rebased after a
// run, a pushed one is on GitHub's record. The check reads only the local
// ref `refs/remotes/origin/main`, which `git push` and `git fetch` update and
// which is otherwise stale, and which anyone can set by hand. It is a
// tripwire, not evidence: the evidence is GitHub's record of the push.
//
// What it cannot do: stop the history being rewritten after a run (a plan
// amended into an earlier commit). It proves the tree was clean when the run
// started and names the commit; the recording carries that name.

import { execFileSync } from 'node:child_process';

export const PLAN_FILE = 'docs/decisions.md';
/** The last known state of GitHub's main, as this repository last saw it. */
export const REMOTE_REF = 'refs/remotes/origin/main';
const MAX_LISTED = 10;

/** Runs git with these arguments; returns its standard output, throws on failure. */
export type Git = (args: readonly string[]) => string;

export const gitIn =
  (dir: string): Git =>
  (args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export type TreeCheck =
  | { readonly ok: true; readonly head: string; readonly remote: string }
  | { readonly ok: false; readonly reason: string };

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

const isCommitId = (id: string): boolean => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(id);

/** The exit status of a failed git call, if it got that far. */
const exitStatus = (error: unknown): unknown =>
  typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;

/**
 * Whether a live run may start: a clean working tree on a commit that is an
 * ancestor of the last known origin/main (the local ref, not GitHub itself).
 */
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
  if (!isCommitId(head)) {
    return refused('git did not name a commit for HEAD.');
  }
  let remote: string;
  try {
    remote = git(['rev-parse', '--verify', '--quiet', `${REMOTE_REF}^{commit}`]).trim();
  } catch {
    return refused(
      `there is no ${REMOTE_REF} here, so whether ${head} was pushed cannot be checked. ` +
        `Push the plan's commit (that sets the ref), then run again.`,
    );
  }
  if (!isCommitId(remote)) {
    return refused(`git did not name a commit for ${REMOTE_REF}.`);
  }
  try {
    // Exit 0: an ancestor (HEAD itself counts); 1: not one; anything else: no answer.
    git(['merge-base', '--is-ancestor', head, remote]);
  } catch (error) {
    return refused(
      exitStatus(error) === 1
        ? `HEAD ${head} is not an ancestor of the last known origin/main (${remote}). ` +
            `Push the plan's commit first; if it is already pushed, \`git fetch origin\` ` +
            `updates the local ref. This compares with the local ref only; GitHub's ` +
            `record of the push is the evidence, not this check.`
        : `git could not compare HEAD ${head} with the last known origin/main (${remote}).`,
    );
  }
  return { ok: true, head, remote };
}

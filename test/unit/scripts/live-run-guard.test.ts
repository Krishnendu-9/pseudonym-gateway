// The guard in front of every live call (ADR-041 section 11): a live run
// refuses unless the working tree is clean, docs/decisions.md included,
// staged or not. Attempt 4 ran with its plan staged but not committed; these
// tests show the guard fires on exactly that, with real git, and that the
// measuring script calls it before it could send anything, in a throwaway
// repository, so the result never depends on this repository's state.
//
// The push requirement (HEAD an ancestor of the last known origin/main) is
// tested with git's answers fixed only. A real repository that gets that
// far needs commits, and no test here makes one (rule 1 of the project
// brief: no script that creates commits); ADR-041 section 11.

import { spawn } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PLAN_FILE,
  changedPaths,
  checkTree,
  gitIn,
  type Git,
  type TreeCheck,
} from '../../../scripts/live-run-guard.js';

const HEAD = 'a'.repeat(40);
const REMOTE = 'c'.repeat(40);

/** An error as execFileSync throws one for a non-zero exit. */
const exited = (status: number): Error => Object.assign(new Error(`exit ${status}`), { status });

const text = (answer: string | Error): string => (answer instanceof Error ? '' : answer.trim());

/**
 * A git that answers from fixed text: status, HEAD, origin/main and whether
 * one is an ancestor of the other (`ancestor` is the exit status). The last
 * two are answered only for the exact question (the ref spelled out here,
 * HEAD first), so a wrong ref or a swapped pair gets an error, never a pass.
 */
const fakeGit =
  (
    status: string | Error,
    head: string | Error = `${HEAD}\n`,
    remote: string | Error = `${REMOTE}\n`,
    ancestor: 0 | 1 | 128 = 0,
  ): Git =>
  (args) => {
    let answer: string | Error;
    if (args[0] === 'status') answer = status;
    else if (args[0] === 'merge-base') {
      const asked = args.join(' ') === `merge-base --is-ancestor ${text(head)} ${text(remote)}`;
      answer = !asked ? new Error('a different question') : ancestor ? exited(ancestor) : '';
    } else if (args.includes('refs/remotes/origin/main^{commit}')) answer = remote;
    else answer = head;
    if (answer instanceof Error) throw answer;
    return answer;
  };

const reasonOf = (check: TreeCheck): string => {
  if (check.ok) throw new Error('expected a refusal');
  return check.reason;
};

describe('changedPaths', () => {
  it('reads every kind of entry, skipping a rename source', () => {
    const porcelain = [
      ' M src/a.ts',
      'M  docs/decisions.md',
      'MM scripts/b.ts',
      '?? test/fixtures/new.json',
      'A  c.ts',
      'R  d-new.ts',
      'd-old.ts',
      '',
    ].join('\0');
    expect(changedPaths(porcelain)).toEqual([
      'src/a.ts',
      'docs/decisions.md',
      'scripts/b.ts',
      'test/fixtures/new.json',
      'c.ts',
      'd-new.ts',
    ]);
  });

  it('finds nothing in a clean tree', () => {
    expect(changedPaths('')).toEqual([]);
  });
});

describe('checkTree, with git answers fixed', () => {
  it('lets a run start on a clean, pushed tree and names both commits', () => {
    expect(checkTree(fakeGit(''))).toEqual({ ok: true, head: HEAD, remote: REMOTE });
  });

  it.each([
    ['staged, not committed (Attempt 4)', `M  ${PLAN_FILE}\0`],
    ['edited, not staged', ` M ${PLAN_FILE}\0`],
    ['staged and edited again', `MM ${PLAN_FILE}\0`],
    ['new, staged', `A  ${PLAN_FILE}\0`],
  ])('refuses when the plan file is %s', (_, status) => {
    const reason = reasonOf(checkTree(fakeGit(status)));
    expect(reason).toContain('refusing to make a live call');
    expect(reason).toContain(`${PLAN_FILE} among them`);
    expect(reason).toContain('Attempt 4');
  });

  it('refuses when anything else is uncommitted, without blaming the plan', () => {
    const reason = reasonOf(checkTree(fakeGit('?? test/fixtures/gemini-7b/attempt-5/s1.json\0')));
    expect(reason).toContain('1 uncommitted change(s)');
    expect(reason).toContain('test/fixtures/gemini-7b/attempt-5/s1.json');
    expect(reason).not.toContain(PLAN_FILE);
  });

  it('lists ten paths and counts the rest', () => {
    const status = Array.from({ length: 13 }, (_, i) => `?? f${i}.txt\0`).join('');
    const reason = reasonOf(checkTree(fakeGit(status)));
    expect(reason).toContain('13 uncommitted change(s)');
    expect(reason).toContain('f9.txt');
    expect(reason).not.toContain('f10.txt');
    expect(reason).toContain('and 3 more');
  });

  it('refuses when git cannot report the tree', () => {
    expect(reasonOf(checkTree(fakeGit(new Error('not a repository'))))).toContain(
      'git could not report the working tree',
    );
  });

  it('refuses when there is no commit', () => {
    expect(reasonOf(checkTree(fakeGit('', new Error('unborn'))))).toContain('no commit');
  });

  it('refuses when HEAD is not a commit id', () => {
    expect(reasonOf(checkTree(fakeGit('', 'main\n')))).toContain('did not name a commit');
  });

  it('accepts a SHA-256 repository id', () => {
    const long = 'b'.repeat(64);
    expect(checkTree(fakeGit('', long))).toEqual({ ok: true, head: long, remote: REMOTE });
  });
});

describe('checkTree, the push requirement, with git answers fixed', () => {
  it('REFUSES a clean tree whose HEAD is not an ancestor of the last known origin/main', () => {
    const reason = reasonOf(checkTree(fakeGit('', `${HEAD}\n`, `${REMOTE}\n`, 1)));
    expect(reason).toContain('refusing to make a live call');
    expect(reason).toContain(`HEAD ${HEAD} is not an ancestor of the last known origin/main`);
    expect(reason).toContain(REMOTE);
    expect(reason).toContain('git fetch origin');
    expect(reason).toContain("GitHub's record of the push is the evidence");
  });

  it('refuses when there is no origin/main ref', () => {
    const reason = reasonOf(checkTree(fakeGit('', `${HEAD}\n`, exited(1))));
    expect(reason).toContain('there is no refs/remotes/origin/main here');
    expect(reason).toContain('cannot be checked');
  });

  it('refuses when origin/main is not a commit id', () => {
    const reason = reasonOf(checkTree(fakeGit('', `${HEAD}\n`, 'main\n')));
    expect(reason).toContain('did not name a commit for refs/remotes/origin/main');
  });

  it('refuses, without calling it unpushed, when git cannot compare the two', () => {
    const reason = reasonOf(checkTree(fakeGit('', `${HEAD}\n`, `${REMOTE}\n`, 128)));
    expect(reason).toContain('could not compare');
    expect(reason).not.toContain('not an ancestor');
  });

  it('reports an uncommitted change first, before the push', () => {
    const reason = reasonOf(checkTree(fakeGit(`M  ${PLAN_FILE}\0`, `${HEAD}\n`, `${REMOTE}\n`, 1)));
    expect(reason).toContain(`${PLAN_FILE} among them`);
    expect(reason).not.toContain('not an ancestor');
  });
});

describe('checkTree, with real git (no commit is ever made)', () => {
  let dir: string;
  let git: Git;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'live-run-guard-'));
    git = gitIn(dir);
    git(['init', '--quiet']);
    mkdirSync(join(dir, 'docs'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('FIRES on a staged plan file: the failure Attempt 4 had', () => {
    writeFileSync(join(dir, PLAN_FILE), '### 12. A plan\n');
    git(['add', '--', PLAN_FILE]);
    const reason = reasonOf(checkTree(git));
    expect(reason).toContain(`${PLAN_FILE} among them`);
  });

  it('FIRES on a plan file staged and then edited again', () => {
    writeFileSync(join(dir, PLAN_FILE), '### 12. A plan\n');
    git(['add', '--', PLAN_FILE]);
    writeFileSync(join(dir, PLAN_FILE), '### 12. A plan, edited\n');
    expect(git(['status', '--porcelain=v1', '-z'])).toContain(`AM ${PLAN_FILE}`);
    expect(reasonOf(checkTree(git))).toContain(`${PLAN_FILE} among them`);
  });

  it('FIRES on an untracked plan file', () => {
    writeFileSync(join(dir, PLAN_FILE), '### 12. A plan\n');
    expect(reasonOf(checkTree(git))).toContain(`${PLAN_FILE} among them`);
  });

  it('does not count ignored files, and still needs a commit', () => {
    writeFileSync(join(dir, '.gitignore'), '.env\n');
    git(['add', '--', '.gitignore']);
    writeFileSync(join(dir, '.env'), 'X=1\n');
    expect(changedPaths(git(['status', '--porcelain=v1', '-z', '--untracked-files=all']))).toEqual([
      '.gitignore',
    ]);
    expect(reasonOf(checkTree(git))).toContain('1 uncommitted change(s)');
  });

  it('refuses in a clean repository with no commit', () => {
    expect(reasonOf(checkTree(git))).toContain('no commit');
  });

  it('refuses outside a repository', () => {
    const outside = mkdtempSync(join(tmpdir(), 'live-run-guard-none-'));
    try {
      expect(reasonOf(checkTree(gitIn(outside)))).toContain('could not report');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('measure-gemini.ts', () => {
  // The script checks the repository it sits in, so it is run from a
  // throwaway repository: the script and the guard copied byte for byte at
  // test time (a change to either reaches this test), `src` linked to the
  // real one, and docs/decisions.md staged but not committed, Attempt 4's
  // case. The outcome no longer depends on the state of this repository.
  const root = join(import.meta.dirname, '..', '..', '..');
  let repo: string;
  let out: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'live-run-guard-repo-'));
    out = mkdtempSync(join(tmpdir(), 'live-run-guard-out-'));
    const git = gitIn(repo);
    git(['init', '--quiet']);
    mkdirSync(join(repo, 'scripts'));
    for (const name of ['measure-gemini.ts', 'live-run-guard.ts']) {
      copyFileSync(join(root, 'scripts', name), join(repo, 'scripts', name));
    }
    symlinkSync(join(root, 'src'), join(repo, 'src'), 'junction');
    writeFileSync(join(repo, 'package.json'), '{ "type": "module" }\n');
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, PLAN_FILE), '### 12. A plan\n');
    git(['add', '--', PLAN_FILE]);
  });
  afterEach(() => {
    // The link first, so removing the repository can never reach the real src.
    unlinkSync(join(repo, 'src'));
    rmSync(repo, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it('refuses a staged plan before anything else; with no key nothing could be sent anyway', async () => {
    // No key: if the guard did not stop the run, the script would stop at
    // the key check, so no outcome of this test can reach the network.
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        join(repo, 'scripts', 'measure-gemini.ts'),
        '--list-models',
        '--out',
        out,
      ],
      { cwd: root, env: { ...process.env, PSEUDONYM_PROVIDER_API_KEY: '' } },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number | null>((done) => child.on('close', done));
    expect(code).toBe(1);
    expect(stderr).toContain('refusing to make a live call');
    expect(stderr).toContain(`${PLAN_FILE} among them`);
    expect(stderr).not.toContain('PSEUDONYM_PROVIDER_API_KEY');
    expect(stdout).not.toContain('working tree clean');
    expect(readdirSync(out)).toEqual([]); // no attempt folder was made
  });
});

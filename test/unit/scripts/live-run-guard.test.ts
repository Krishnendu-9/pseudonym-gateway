// The guard in front of every live call (ADR-041 section 11): a live run
// refuses unless the working tree is clean, docs/decisions.md included,
// staged or not. Attempt 4 ran with its plan staged but not committed; these
// tests show the guard fires on exactly that, with real git, and that the
// measuring script calls it before it could send anything, in a throwaway
// repository, so the result never depends on this repository's state.
//
// The push requirement (HEAD an ancestor of the last known origin/main) is
// tested with git's answers fixed, and with real git in throwaway
// repositories that hold real commits. Those commits are allowed by ADR-044
// (rule 1 governs this repository's history and remote) and only under its
// conditions; `throwaway` below is how every one of them is met.

import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
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
// Spelled out, not imported: a wrong ref in the guard must not move the tests too.
const ORIGIN_MAIN = 'refs/remotes/origin/main';

/** The environment without any GIT_* variable, so none can point git elsewhere. */
const withoutGitVariables = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')),
  );

// A synthetic identity (rules 4 and 5; example.com is reserved).
const AUTHOR = { name: 'Throwaway Test', email: 'throwaway@example.com' };

/**
 * Runs git to build a throwaway repository in `dir` (ADR-044). Inherited
 * GIT_* variables are dropped; no system or global config is read, so this
 * machine's hooks, signing or identity never apply; and the identity comes
 * from GIT_AUTHOR_* and GIT_COMMITTER_* variables, which git never writes to
 * any config. No command here adds a remote, fetches or pushes.
 */
const throwaway =
  (dir: string) =>
  (args: readonly string[]): string =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...withoutGitVariables(process.env),
        GIT_CONFIG_NOSYSTEM: '1',
        // A file that never exists (git reads a missing one as empty);
        // Git for Windows refuses the null device here.
        GIT_CONFIG_GLOBAL: join(dir, '.git', 'no-global-config'),
        GIT_AUTHOR_NAME: AUTHOR.name,
        GIT_AUTHOR_EMAIL: AUTHOR.email,
        GIT_COMMITTER_NAME: AUTHOR.name,
        GIT_COMMITTER_EMAIL: AUTHOR.email,
      },
    }).trim();

/** Makes an empty commit in a throwaway repository and returns its id. */
const commitIn = (build: ReturnType<typeof throwaway>, message: string): string => {
  build(['commit', '--quiet', '--allow-empty', '-m', message]);
  return build(['rev-parse', 'HEAD']);
};

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

describe('checkTree, the push requirement, with real git (commits only in a throwaway repository, ADR-044)', () => {
  // The guard runs with its own runner, gitIn, as it does in the script;
  // only the setup uses `throwaway`. origin/main is set as a ref, with no
  // remote configured, as `git push` and `git fetch` would leave it.
  let dir: string;
  let build: ReturnType<typeof throwaway>;
  let plan: string;
  const setOriginMain = (id: string): void => void build(['update-ref', ORIGIN_MAIN, id]);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'live-run-guard-push-'));
    build = throwaway(dir);
    build(['init', '--quiet']);
    // Its own top level: git found no other repository around it.
    expect(realpathSync(build(['rev-parse', '--show-toplevel']))).toBe(realpathSync(dir));
    plan = commitIn(build, 'the plan');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('REFUSES a commit made after the last push: HEAD one ahead of origin/main', () => {
    setOriginMain(plan);
    const after = commitIn(build, 'made after the push');
    const reason = reasonOf(checkTree(gitIn(dir)));
    expect(reason).toContain(
      `HEAD ${after} is not an ancestor of the last known origin/main (${plan})`,
    );
  });

  it('REFUSES a pushed commit amended afterwards', () => {
    setOriginMain(plan);
    build(['commit', '--quiet', '--amend', '--allow-empty', '-m', 'the plan, amended']);
    const amended = build(['rev-parse', 'HEAD']);
    expect(amended).not.toBe(plan);
    expect(reasonOf(checkTree(gitIn(dir)))).toContain(`HEAD ${amended} is not an ancestor`);
  });

  it('allows HEAD equal to origin/main', () => {
    setOriginMain(plan);
    expect(checkTree(gitIn(dir))).toEqual({ ok: true, head: plan, remote: plan });
  });

  it('allows HEAD behind origin/main (pushed, and main has moved on)', () => {
    const next = commitIn(build, 'the next commit');
    setOriginMain(next);
    build(['checkout', '--quiet', '--detach', plan]);
    expect(checkTree(gitIn(dir))).toEqual({ ok: true, head: plan, remote: next });
  });

  it('refuses when nothing set origin/main', () => {
    expect(reasonOf(checkTree(gitIn(dir)))).toContain(`there is no ${ORIGIN_MAIN} here`);
  });

  it("meets ADR-044's conditions: no remote, no identity in any config, a synthetic author", () => {
    setOriginMain(plan);
    expect(build(['remote'])).toBe('');
    expect(() => build(['config', '--local', '--get', 'user.email'])).toThrow();
    expect(readFileSync(join(dir, '.git', 'config'), 'utf8')).not.toContain(AUTHOR.email);
    expect(build(['log', '-1', '--format=%an <%ae> / %cn <%ce>'])).toBe(
      `${AUTHOR.name} <${AUTHOR.email}> / ${AUTHOR.name} <${AUTHOR.email}>`,
    );
  });
});

describe('measure-gemini.ts', () => {
  // The script checks the repository it sits in, so it is run from a
  // throwaway repository: the script and the guard copied byte for byte at
  // test time (a change to either reaches this test), `src` linked to the
  // real one, and docs/decisions.md staged but not committed, Attempt 4's
  // case. The outcome no longer depends on the state of this repository.
  // The child starts in this repository only so that `--import tsx`
  // resolves; git never runs there (the guard checks the script's own
  // folder), and the child gets no GIT_* variable that could point it back.
  const root = join(import.meta.dirname, '..', '..', '..');
  let repo: string;
  let out: string;
  let build: ReturnType<typeof throwaway>;
  let linked: boolean;
  beforeEach(() => {
    linked = false;
    repo = mkdtempSync(join(tmpdir(), 'live-run-guard-repo-'));
    out = mkdtempSync(join(tmpdir(), 'live-run-guard-out-'));
    build = throwaway(repo);
    build(['init', '--quiet']);
    mkdirSync(join(repo, 'scripts'));
    for (const name of ['measure-gemini.ts', 'live-run-guard.ts']) {
      copyFileSync(join(root, 'scripts', name), join(repo, 'scripts', name));
    }
    symlinkSync(join(root, 'src'), join(repo, 'src'), 'junction');
    linked = true;
    writeFileSync(join(repo, 'package.json'), '{ "type": "module" }\n');
  });
  afterEach(() => {
    // The link first, so removing the repository can never reach the real src.
    if (linked) unlinkSync(join(repo, 'src'));
    rmSync(repo, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  /** Runs the copied script with no key: it can never get past the key check. */
  const runScript = async (): Promise<{ code: number | null; stdout: string; stderr: string }> => {
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
      { cwd: root, env: { ...withoutGitVariables(process.env), PSEUDONYM_PROVIDER_API_KEY: '' } },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number | null>((done) => child.on('close', done));
    return { code, stdout, stderr };
  };

  it('refuses a staged plan before anything else; with no key nothing could be sent anyway', async () => {
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, PLAN_FILE), '### 12. A plan\n');
    build(['add', '--', PLAN_FILE]);
    const { code, stdout, stderr } = await runScript();
    expect(code).toBe(1);
    expect(stderr).toContain('refusing to make a live call');
    expect(stderr).toContain(`${PLAN_FILE} among them`);
    expect(stderr).not.toContain('PSEUDONYM_PROVIDER_API_KEY');
    expect(stdout).not.toContain('working tree clean');
    expect(readdirSync(out)).toEqual([]); // no attempt folder was made
  });

  it('lets a clean, pushed tree through, names both commits, then stops at the key check', async () => {
    // The copies and the link are ignored, never committed: the commit is
    // empty, and git does not count ignored files.
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    writeFileSync(join(repo, '.git', 'info', 'exclude'), '/scripts/\n/src\n/package.json\n');
    const plan = commitIn(build, 'the plan');
    build(['update-ref', ORIGIN_MAIN, plan]);
    const { code, stdout, stderr } = await runScript();
    expect(code).toBe(1);
    // The throwaway repository's commit, so the guard read that repository.
    expect(stdout).toContain(
      `working tree clean at ${plan}, an ancestor of the last known origin/main (${plan})`,
    );
    expect(stderr).toContain('PSEUDONYM_PROVIDER_API_KEY must be set');
    expect(readdirSync(out)).toEqual([]); // stopped before any attempt folder
  });
});

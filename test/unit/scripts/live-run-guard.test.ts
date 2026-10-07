// The guard in front of every live call (ADR-041 section 11): a live run
// refuses unless the working tree is clean, docs/decisions.md included,
// staged or not. Attempt 4 ran with its plan staged but not committed; these
// tests show the guard fires on exactly that, with real git, and that the
// measuring script calls it before it could send anything.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/** A git that answers status and rev-parse from fixed text. */
const fakeGit =
  (status: string | Error, head: string | Error = `${HEAD}\n`): Git =>
  (args) => {
    const answer = args[0] === 'status' ? status : head;
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
  it('lets a run start on a clean tree and names the commit', () => {
    expect(checkTree(fakeGit(''))).toEqual({ ok: true, head: HEAD });
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
    expect(checkTree(fakeGit('', long))).toEqual({ ok: true, head: long });
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
  it('checks the tree before anything else; with no key nothing can be sent either way', async () => {
    const root = join(import.meta.dirname, '..', '..', '..');
    const out = mkdtempSync(join(tmpdir(), 'live-run-guard-out-'));
    try {
      // No key: if the guard lets the run start, the script stops at the key
      // check. No branch of this test can reach the network.
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'scripts/measure-gemini.ts', '--list-models', '--out', out],
        { cwd: root, env: { ...process.env, PSEUDONYM_PROVIDER_API_KEY: '' } },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      const code = await new Promise<number | null>((done) => child.on('close', done));
      expect(code).toBe(1);
      // The repository's own state decides the branch. While a change is
      // being written or a mutation is in place, the tree is dirty and the
      // guard must refuse; on a clean checkout (CI) it lets the run go on to
      // the key check.
      const tree = checkTree(gitIn(root));
      if (tree.ok) {
        expect(stdout).toContain(`working tree clean at ${tree.head}`);
        expect(stderr).toContain('PSEUDONYM_PROVIDER_API_KEY must be set');
      } else {
        expect(stderr).toContain(tree.reason.split('\n')[0]);
        expect(stderr).not.toContain('PSEUDONYM_PROVIDER_API_KEY');
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

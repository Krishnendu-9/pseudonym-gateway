// The file format of the held-out set (eval/HELD-OUT-FORMAT.md): plain text,
// so that nothing the author types needs escaping and no compiler or
// formatter ever prints a line of it.
//
//   %% a comment line, ignored anywhere
//   === H001 | line-break, aadhaar
//   @user
//   the message text, as many lines as it needs
//   @assistant
//   another message
//
// A problem is reported by case id, line number and rule, with a fixed
// description. It never quotes the file: the detector's author runs this
// code but must not read the cases.

import type { Role } from './types.js';

export interface Problem {
  /** The case the problem is in, or `-` for one outside any case. */
  readonly caseId: string;
  /** 1-based line in the file. */
  readonly line: number;
  readonly rule: string;
  readonly detail: string;
}

export interface RawMessage {
  readonly role: Role;
  /** The lines of the message joined with `\n`, blank lines at both ends dropped. */
  readonly text: string;
  /** The file line of each line of `text`. */
  readonly lines: readonly number[];
}

export interface RawCase {
  readonly id: string;
  readonly tags: readonly string[];
  readonly line: number;
  readonly messages: readonly RawMessage[];
}

const HEADER = /^===\s*(\S+)\s*\|(.*)$/;
const ROLE = /^@(system|user|assistant)\s*$/;
const ID = /^[A-Za-z][A-Za-z0-9-]*$/;
const TAG = /^[a-z0-9][a-z0-9-]*$/;

export function parseCases(source: string): { cases: RawCase[]; problems: Problem[] } {
  const cases: RawCase[] = [];
  const problems: Problem[] = [];
  const seen = new Set<string>();

  let current: { id: string; tags: string[]; line: number; messages: RawMessage[] } | undefined;
  let message: { role: Role; marker: number; lines: { text: string; line: number }[] } | undefined;

  const closeMessage = (): void => {
    if (!current || !message) return;
    let lines = message.lines;
    while (lines.length > 0 && lines[0]!.text.trim() === '') lines = lines.slice(1);
    while (lines.length > 0 && lines.at(-1)!.text.trim() === '') lines = lines.slice(0, -1);
    if (lines.length === 0) {
      problems.push({
        caseId: current.id,
        line: message.marker,
        rule: 'empty-message',
        detail: 'a role line with no text after it',
      });
    } else {
      current.messages.push({
        role: message.role,
        text: lines.map((l) => l.text).join('\n'),
        lines: lines.map((l) => l.line),
      });
    }
    message = undefined;
  };

  const closeCase = (): void => {
    closeMessage();
    if (!current) return;
    if (current.messages.length === 0) {
      problems.push({
        caseId: current.id,
        line: current.line,
        rule: 'no-messages',
        detail: 'a case needs at least one message (@user, @assistant or @system)',
      });
    }
    cases.push(current);
    current = undefined;
  };

  source.split(/\r\n|\n|\r/).forEach((text, index) => {
    const line = index + 1;
    // A comment, anywhere: dropped, and no part of a message.
    if (text.startsWith('%%')) return;

    if (text.startsWith('===')) {
      closeCase();
      const header = HEADER.exec(text);
      const id = header?.[1] ?? '';
      const valid = header !== null && ID.test(id);
      const caseId = valid ? id : `line-${line}`;
      const tags = (header?.[2] ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t !== '');
      if (!valid) {
        problems.push({
          caseId,
          line,
          rule: 'bad-header',
          detail: 'a case starts with "=== ID | tag, tag"; the id is letters, digits and hyphens',
        });
      } else if (seen.has(id)) {
        problems.push({
          caseId,
          line,
          rule: 'duplicate-id',
          detail: 'this case id was used before',
        });
      }
      if (valid && tags.length === 0) {
        problems.push({ caseId, line, rule: 'no-tags', detail: 'a case needs at least one tag' });
      }
      if (tags.some((t) => !TAG.test(t))) {
        problems.push({
          caseId,
          line,
          rule: 'bad-tag',
          detail: 'tags are lower-case letters, digits and hyphens, separated by commas',
        });
      }
      seen.add(id);
      current = { id: caseId, tags, line, messages: [] };
      return;
    }

    const role = ROLE.exec(text);
    if (role && current) {
      closeMessage();
      message = { role: role[1] as Role, marker: line, lines: [] };
      return;
    }

    if (message) {
      message.lines.push({ text, line });
    } else if (text.trim() !== '') {
      problems.push({
        caseId: current?.id ?? '-',
        line,
        rule: 'text-outside-message',
        detail: current
          ? 'text before the first role line (@user, @assistant or @system)'
          : 'text before the first case ("=== ID | tags"); comments start with %%',
      });
    }
  });
  closeCase();

  return { cases, problems };
}

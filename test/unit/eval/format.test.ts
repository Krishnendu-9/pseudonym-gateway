import { describe, expect, it } from 'vitest';
import { parseCases } from '../../../eval/format.js';

const rules = (source: string): string[] => parseCases(source).problems.map((p) => p.rule);

describe('parseCases', () => {
  it('reads cases, tags, roles and multi-line messages, with the file line of every line', () => {
    const { cases, problems } = parseCases(
      [
        '%% a comment', // 1
        '', // 2
        '=== H001 | line-break, aadhaar', // 3
        '@user', // 4
        'first line', // 5
        '', // 6
        'third line', // 7
        '@assistant', // 8
        'an answer', // 9
        '', // 10
        '=== H002|one-tag', // 11
        '@system', // 12
        '', // 13
        'be brief', // 14
        '', // 15
      ].join('\n'),
    );
    expect(problems).toEqual([]);
    expect(cases).toEqual([
      {
        id: 'H001',
        tags: ['line-break', 'aadhaar'],
        line: 3,
        messages: [
          { role: 'user', text: 'first line\n\nthird line', lines: [5, 6, 7] },
          { role: 'assistant', text: 'an answer', lines: [9] },
        ],
      },
      {
        id: 'H002',
        tags: ['one-tag'],
        line: 11,
        messages: [{ role: 'system', text: 'be brief', lines: [14] }],
      },
    ]);
  });

  it('drops comment lines anywhere, and keeps the line numbers of the rest', () => {
    const { cases } = parseCases('=== A | t\n@user\none\n%% not part of it\ntwo\n');
    expect(cases[0]!.messages).toEqual([{ role: 'user', text: 'one\ntwo', lines: [3, 5] }]);
  });

  it('reads Windows and old Mac line endings', () => {
    const { cases, problems } = parseCases('=== A | t\r\n@user\r\none\rtwo\r\n');
    expect(problems).toEqual([]);
    expect(cases[0]!.messages[0]!.text).toBe('one\ntwo');
  });

  it('keeps leading spaces and inner blank lines of a message', () => {
    const { cases } = parseCases('=== A | t\n@user\n\n  indented\n\n\nend  \n\n');
    expect(cases[0]!.messages[0]).toEqual({
      role: 'user',
      text: '  indented\n\n\nend  ',
      lines: [4, 5, 6, 7],
    });
  });

  it('an empty file has no cases and no problems', () => {
    expect(parseCases('')).toEqual({ cases: [], problems: [] });
    expect(parseCases('%% only comments\n\n')).toEqual({ cases: [], problems: [] });
  });

  it.each([
    ['bad-header', '=== no bar here\n@user\nx'],
    ['bad-header', '=== 1abc | t\n@user\nx'],
    ['bad-header', '===\n@user\nx'],
    ['duplicate-id', '=== A | t\n@user\nx\n=== A | t\n@user\ny'],
    ['no-tags', '=== A |\n@user\nx'],
    ['no-tags', '=== A | ,\n@user\nx'],
    ['bad-tag', '=== A | Line Break\n@user\nx'],
    ['no-messages', '=== A | t\n'],
    ['empty-message', '=== A | t\n@user\n\n@assistant\nx'],
    ['text-outside-message', '=== A | t\nstray\n@user\nx'],
    ['text-outside-message', 'stray before any case\n=== A | t\n@user\nx'],
  ])('%s', (rule, source) => {
    expect(rules(source)).toContain(rule);
  });

  it('reports a problem by case, line and rule, never quoting the file', () => {
    const { problems } = parseCases('=== A | t\n@user\nfine\n=== A | t\nSECRET-TEXT\n@user\nx');
    expect(problems).toEqual([
      { caseId: 'A', line: 4, rule: 'duplicate-id', detail: 'this case id was used before' },
      {
        caseId: 'A',
        line: 5,
        rule: 'text-outside-message',
        detail: 'text before the first role line (@user, @assistant or @system)',
      },
    ]);
    expect(JSON.stringify(problems)).not.toContain('SECRET-TEXT');
  });

  it('a role line outside any case is text outside a case', () => {
    expect(parseCases('@user\nhello').problems.map((p) => [p.caseId, p.line, p.rule])).toEqual([
      ['-', 1, 'text-outside-message'],
      ['-', 2, 'text-outside-message'],
    ]);
  });

  it('a case with a bad header is still read, under a line-based id', () => {
    const { cases, problems } = parseCases('=== bad id! | t\n@user\nx');
    expect(cases.map((c) => c.id)).toEqual(['line-1']);
    expect(problems.map((p) => p.caseId)).toEqual(['line-1']);
  });
});

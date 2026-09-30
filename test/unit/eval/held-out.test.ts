// The held-out file itself is only ever looked at through counts, case ids,
// line numbers and rule names (ADR-021): that is all these tests can print.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseCases } from '../../../eval/format.js';
import {
  checkHeldOut,
  HELD_OUT_PATH,
  loadHeldOut,
  maskedText,
  summarise,
} from '../../../eval/held-out.js';
import { CaseFileError, loadCases } from '../../../eval/render.js';

const dir = mkdtempSync(join(tmpdir(), 'pseudonym-eval-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const fileWith = (name: string, content: string): string => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

const SOURCE = [
  '=== A | line-break, aadhaar',
  '@user',
  '{{AADHAAR@a:#### ####}} and {{@a:####}} and {{EMAIL}}',
  '@assistant',
  'noted {{NOT:ORD-###}}',
  '=== B | aadhaar',
  '@user',
  '{{AADHAAR}} plain',
].join('\n');

describe('summarise', () => {
  it('counts cases, messages, values by type and cases by tag', () => {
    expect(summarise(parseCases(SOURCE).cases)).toEqual({
      cases: 2,
      messages: 3,
      values: { AADHAAR: 2, EMAIL: 1, NOT: 1 },
      tags: { 'line-break': 1, aadhaar: 2 },
    });
  });

  it('an empty set is all zeros', () => {
    expect(summarise([])).toEqual({ cases: 0, messages: 0, values: {}, tags: {} });
  });
});

describe('maskedText', () => {
  const masked = (text: string): string =>
    maskedText(loadCases(`=== A | t\n@user\n${text}`, 3)[0]!.messages[0]!);

  it('shows the layout of a value, never its characters', () => {
    expect(
      masked('pay {{CARD:####-####-####-####}} by {{NOT:ORD-##}} for {{PERSON=Priya S}}'),
    ).toBe('pay ••••-••••-••••-•••• by ORD-•• for ••••• •');
  });

  it('a digit outside the BMP is one mark', () => {
    expect(masked('{{PHONE|mathbold:##### #####}}!')).toBe('••••• •••••!');
  });

  it('text with no value is unchanged', () => {
    expect(masked('nothing here 😀')).toBe('nothing here 😀');
  });
});

describe('checkHeldOut and loadHeldOut', () => {
  it('read a file, check it and render it', () => {
    const path = fileWith('good.txt', SOURCE);
    expect(checkHeldOut(path).problems).toEqual([]);
    const cases = loadHeldOut(path);
    expect(cases.map((c) => [c.id, c.messages.length])).toEqual([
      ['A', 2],
      ['B', 1],
    ]);
  });

  it('render the same text on every load', () => {
    const path = fileWith('same.txt', SOURCE);
    const text = (): string => JSON.stringify(loadHeldOut(path));
    expect(text() === text()).toBe(true);
  });

  it('a file with a problem is reported, and does not load', () => {
    const path = fileWith('bad.txt', '=== A | t\n@user\n{{AADHAAR:####}}');
    expect(checkHeldOut(path).problems.map((p) => [p.caseId, p.line, p.rule])).toEqual([
      ['A', 3, 'too-few-marks'],
    ]);
    expect(() => loadHeldOut(path)).toThrow(CaseFileError);
  });
});

describe('eval/held-out.txt', () => {
  it('is where the code expects it', () => {
    expect(HELD_OUT_PATH.replace(/\\/g, '/').endsWith('eval/held-out.txt')).toBe(true);
  });

  it('passes the lint: no typed value, every slot well-formed', () => {
    const problems = checkHeldOut().problems.map((p) => `${p.caseId} line ${p.line}: ${p.rule}`);
    expect(problems).toEqual([]);
  });
});

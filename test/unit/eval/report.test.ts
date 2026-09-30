import { format } from 'prettier';
import { describe, expect, it } from 'vitest';
import type { StoredDataset } from '../../../eval/baseline.js';
import {
  overRedactionTable,
  README_END,
  README_START,
  readmeBlock,
  scoreTable,
  withReadmeBlock,
} from '../../../eval/report.js';
import type { DatasetScore, TypeScore } from '../../../eval/score.js';
import { PERSONAL_TYPES } from '../../../eval/types.js';

const empty: TypeScore = {
  values: 0,
  redacted: 0,
  typed: 0,
  partial: 0,
  missed: 0,
  detections: 0,
  rightType: 0,
  otherPersonal: 0,
  notPersonal: 0,
};

const dataset = (rows: Partial<Record<string, Partial<TypeScore>>>): StoredDataset => ({
  cases: 5,
  messages: 6,
  types: Object.fromEntries(
    PERSONAL_TYPES.map((type) => [type, { ...empty, ...rows[type] }]),
  ) as StoredDataset['types'],
});

const SCORE = dataset({
  AADHAAR: {
    values: 3,
    redacted: 2,
    typed: 2,
    partial: 1,
    detections: 4,
    rightType: 2,
    notPersonal: 1,
  },
  NUMBER: { detections: 7, otherPersonal: 1, notPersonal: 6 },
  PERSON: { values: 9, missed: 9 },
});

describe('scoreTable', () => {
  it('one row per type that has values or detections, counts beside cut percentages', () => {
    expect(scoreTable(SCORE).split('\n')).toEqual([
      '| Type    | Values | Redacted (any type) | Partly redacted | Recall (right type) | Precision (right type) | F1    | Over-redactions |',
      '| ------- | ------ | ------------------- | --------------- | ------------------- | ---------------------- | ----- | --------------- |',
      '| AADHAAR | 3      | 2/3 (66.6%)         | 1               | 2/3 (66.6%)         | 2/4 (50.0%)            | 57.1% | 1               |',
      '| NUMBER  | 0      | -                   | 0               | -                   | 0/7 (0.0%)             | -     | 6               |',
      '| PERSON  | 9      | 0/9 (0.0%)          | 0               | 0/9 (0.0%)          | -                      | -     | 0               |',
    ]);
  });

  it('is laid out exactly as Prettier would lay it out', async () => {
    const markdown = `${scoreTable(SCORE)}\n`;
    expect(await format(markdown, { parser: 'markdown' })).toBe(markdown);
  });
});

describe('overRedactionTable', () => {
  const withOver = (overRedactions: DatasetScore['overRedactions']): DatasetScore => ({
    ...SCORE,
    overRedactions,
  });

  it('kinds in rows, detection types in columns, a total', () => {
    const text = overRedactionTable(
      withOver({ 'plain text': { PHONE: 2 }, 'NOT.order': { NUMBER: 5, PHONE: 1 } }),
    );
    expect(text.split('\n')).toEqual([
      '| Redacted though not personal | PHONE | NUMBER | Total |',
      '| ---------------------------- | ----- | ------ | ----- |',
      '| NOT.order                    | 1     | 5      | 6     |',
      '| plain text                   | 2     |        | 2     |',
    ]);
  });

  it('says so when there are none', () => {
    expect(overRedactionTable(withOver({}))).toBe('No over-redactions.');
    expect(overRedactionTable(withOver({}), 'hidden')).toBe('No over-redactions.');
  });

  // A label is text the set's author typed; the held-out report never shows it.
  it('with labels hidden, every lookalike is one row and no label is printed', () => {
    const text = overRedactionTable(
      withOver({
        'plain text': { PHONE: 2 },
        'NOT.order': { NUMBER: 5, PHONE: 1 },
        'NOT.tracking': { PHONE: 3 },
        'NOT.unlabelled': { NUMBER: 1 },
      }),
      'hidden',
    );
    expect(text.split('\n')).toEqual([
      '| Redacted though not personal | PHONE | NUMBER | Total |',
      '| ---------------------------- | ----- | ------ | ----- |',
      '| lookalike                    | 4     | 6      | 10    |',
      '| plain text                   | 2     |        | 2     |',
    ]);
    expect(text).not.toMatch(/order|tracking|NOT\./);
  });
});

describe('readmeBlock', () => {
  const input = { measuredOn: '2026-09-30', generated: { ...SCORE, seed: 42 }, heldOut: null };

  it('says when and how it was measured, on how much, and that one author wrote both', () => {
    const block = readmeBlock(input);
    expect(block.startsWith(`${README_START}\n`)).toBe(true);
    expect(block.endsWith(`\n${README_END}`)).toBe(true);
    expect(block).toContain('_Measured on 2026-09-30 by `npm run eval`.');
    expect(block).toContain(
      '**Generated dataset** (seed 42; 6 messages in 5 cases, 12 labelled personal values). Its generator and the detectors share an author',
    );
    expect(block).toContain(scoreTable(SCORE));
  });

  it('says plainly when the held-out set has not been measured', () => {
    expect(readmeBlock(input)).toContain('**Held-out adversarial dataset:** not measured yet.');
  });

  it('shows the held-out table once there is one', () => {
    const heldOut = dataset({ PAN: { values: 2, redacted: 1, typed: 1, missed: 1 } });
    const block = readmeBlock({ ...input, heldOut });
    expect(block).toContain(
      '**Held-out adversarial dataset** (drafted with AI assistance in a separate session that did not write the detectors, then reviewed by the author; never run against the detectors before it was committed, and never used for tuning; 6 messages in 5 cases, 2 labelled personal values).',
    );
    // What the set is not, and must not be called.
    expect(block).not.toMatch(/hand-written|by hand|someone else/);
    expect(block).toContain(scoreTable(heldOut));
    expect(block).not.toContain('not measured yet');
  });

  it('is already in Prettier’s format, with and without the held-out table', async () => {
    for (const heldOut of [null, dataset({ PAN: { values: 2, redacted: 2, typed: 2 } })]) {
      const markdown = `# Title\n\n${readmeBlock({ ...input, heldOut })}\n\nAfter.\n`;
      expect(await format(markdown, { parser: 'markdown' })).toBe(markdown);
    }
  });
});

describe('withReadmeBlock', () => {
  const block = `${README_START}\nnew\n${README_END}`;

  it('replaces what is between the markers, markers included', () => {
    const readme = `before\n${README_START}\nold\n${README_END}\nafter\n`;
    expect(withReadmeBlock(readme, block)).toBe(`before\n${block}\nafter\n`);
  });

  it('changes nothing when the block is already current', () => {
    const readme = `before\n${block}\nafter\n`;
    expect(withReadmeBlock(readme, block)).toBe(readme);
  });

  it('returns undefined when the README has no markers, or has them the wrong way round', () => {
    expect(withReadmeBlock('no markers', block)).toBeUndefined();
    expect(withReadmeBlock(`${README_START} only`, block)).toBeUndefined();
    expect(withReadmeBlock(`${README_END} ${README_START}`, block)).toBeUndefined();
  });
});

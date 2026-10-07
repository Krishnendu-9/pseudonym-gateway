// The comparison behind `npm run eval:names` (Phase 6b step 4b): the hash
// formats must be exactly 6a's and D0's, or the check would compare the
// gateway with something that was never published.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  baselineFor,
  differences,
  exitCode,
  firstMessages,
  messageTexts,
  modelSpansSha256,
  nameSpansSha256,
  outcome,
  outcomeLines,
  parseIndex,
  textsSha256,
  type NamesBaseline,
} from '../../../../eval/names/gateway.js';
import type { Metrics } from '../../../../eval/names/measure.js';
import type { LabelledCase } from '../../../../eval/types.js';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const kase = (id: string, ...texts: string[]): LabelledCase =>
  ({
    id,
    tags: [],
    messages: texts.map((text) => ({ text, values: [] })),
  }) as unknown as LabelledCase;

describe('firstMessages', () => {
  const cases = [kase('a', 'one'), kase('b', 'two', 'three'), kase('c', 'four')];

  it('takes the cases that hold exactly the first n messages', () => {
    expect(firstMessages(cases, 3).map((c) => c.id)).toEqual(['a', 'b']);
    expect(firstMessages(cases, 4).map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(firstMessages(cases, 0)).toEqual([]);
  });

  it('refuses to cut a case, or to run past the set', () => {
    expect(() => firstMessages(cases, 2)).toThrow('does not end a case at message 2');
    expect(() => firstMessages(cases, 5)).toThrow('does not end a case at message 5');
  });

  it('messageTexts lists every message, in order', () => {
    expect(messageTexts(cases)).toEqual(['one', 'two', 'three', 'four']);
  });
});

describe('the hash formats', () => {
  it('texts: the JSON array of the texts', () => {
    expect(textsSha256(['a', 'b"'])).toBe(sha('["a","b\\""]'));
  });

  it("B's spans: 6a's runChild format, [start, end, score] per span, full precision", () => {
    const spans = [[{ start: 3, end: 7, score: 0.123456789012345 }], []];
    expect(modelSpansSha256(spans)).toBe(sha('[[[3,7,0.123456789012345]],[]]'));
  });

  it("the names: D0's format, {start, end} per span, whatever else a span carries", () => {
    const names = [[{ start: 1, end: 2 }], [{ end: 9, start: 5, extra: true } as never]];
    expect(nameSpansSha256(names)).toBe(sha('[[{"start":1,"end":2}],[{"start":5,"end":9}]]'));
  });
});

describe('differences', () => {
  const metrics: Metrics = {
    recall: { hit: 1, of: 2 },
    rows: { 'name-lang:en': { hit: 1, of: 2 } },
    main: { hit: 3, of: 4 },
    precision: { hit: 5, of: 6 },
    plainText: 7,
    words: 8,
    lookalikes: { 'NOT.month': 1, 'NOT.place': 2 },
  };
  const base: NamesBaseline = {
    dataset: { messages: 2, sha256: 'd' },
    spans: { model: 'm', names: 'n' },
    detections: 6,
    metrics,
  };

  it('none when everything agrees, whatever the key order', () => {
    const reordered: NamesBaseline = {
      ...base,
      metrics: { ...metrics, lookalikes: { 'NOT.place': 2, 'NOT.month': 1 } },
    };
    expect(differences(base, reordered)).toEqual([]);
  });

  it('names each field that differs', () => {
    const other: NamesBaseline = {
      dataset: { messages: 2, sha256: 'other' },
      spans: { model: 'other', names: 'n' },
      detections: 7,
      metrics: { ...metrics, recall: { hit: 2, of: 2 }, rows: {} },
    };
    expect(differences(base, other)).toEqual([
      'dataset',
      'spans.model',
      'detections',
      'metrics.recall',
      'metrics.rows',
    ]);
    expect(differences(base, { ...base, spans: { model: 'm', names: 'x' } })).toEqual([
      'spans.names',
    ]);
  });

  it('a metric only one side has is a difference', () => {
    const extra = { ...base, metrics: { ...metrics, newOne: 1 } as Metrics };
    expect(differences(base, extra)).toEqual(['metrics.newOne']);
  });
});

describe('one baseline per CPU model (option C1)', () => {
  const index = parseIndex({
    'Intel Thing A': { file: 'names-baseline.json', source: 'measured' },
    'AMD Thing B': { file: 'names-baseline.json', source: 'run #1' },
    'Intel Thing C': { file: 'names-baseline-thing-c.json', source: 'run #9' },
  });

  it('finds a baseline by the exact model string, only surrounding whitespace trimmed', () => {
    expect(baselineFor(index, 'Intel Thing A')).toEqual({
      file: 'names-baseline.json',
      source: 'measured',
    });
    expect(baselineFor(index, '  Intel Thing C \n')?.file).toBe('names-baseline-thing-c.json');
  });

  it('no baseline for a model never measured, however close its name (no family matching)', () => {
    expect(baselineFor(index, 'Intel Thing')).toBeUndefined();
    expect(baselineFor(index, 'intel thing a')).toBeUndefined();
    expect(baselineFor(index, 'Intel Thing A2')).toBeUndefined();
    // Not an object's own key, not a baseline.
    expect(baselineFor(index, 'toString')).toBeUndefined();
  });

  it('refuses an index that is not CPU model → { file, source }', () => {
    expect(() => parseIndex([])).toThrow('not an object of CPU models');
    expect(() => parseIndex(null)).toThrow('not an object of CPU models');
    expect(() => parseIndex('x')).toThrow('not an object of CPU models');
    expect(() => parseIndex({ ' padded': { file: 'names-baseline.json', source: 's' } })).toThrow(
      'empty or padded',
    );
    expect(() => parseIndex({ '': { file: 'names-baseline.json', source: 's' } })).toThrow(
      'empty or padded',
    );
    for (const bad of [
      null,
      { source: 's' },
      { file: 'names-baseline.json' },
      { file: '../names-baseline.json', source: 's' },
      { file: 'other.json', source: 's' },
      { file: 'names-baseline.txt', source: 's' },
    ]) {
      expect(() => parseIndex({ M: bad })).toThrow(
        'needs a names-baseline*.json file and a source',
      );
    }
  });

  it('the committed index: the i5-12450H and the EPYC 7763 share the published baseline; no Xeon yet', () => {
    const committed = parseIndex(JSON.parse(readFileSync('eval/names-baselines.json', 'utf8')));
    expect(Object.keys(committed).sort()).toEqual([
      '12th Gen Intel(R) Core(TM) i5-12450H',
      'AMD EPYC 7763 64-Core Processor',
    ]);
    for (const entry of Object.values(committed)) expect(entry.file).toBe('names-baseline.json');
    expect(baselineFor(committed, 'INTEL(R) XEON(R) PLATINUM 8573C')).toBeUndefined();
  });
});

describe('the outcome of a run (C1 and C3)', () => {
  const run: NamesBaseline = {
    dataset: { messages: 2, sha256: 'd' },
    spans: { model: 'm', names: 'n' },
    detections: 1,
    metrics: {
      recall: { hit: 1, of: 2 },
      rows: {},
      main: { hit: 1, of: 1 },
      precision: { hit: 1, of: 1 },
      plainText: 0,
      words: 9,
      lookalikes: {},
    },
  };
  const same = { model: 'm', names: 'n' };

  it('identical: the second pass agrees and so does every field of the baseline; exit 0', () => {
    const o = outcome(run, same, run);
    expect(o).toEqual({ kind: 'identical' });
    expect(exitCode(o)).toBe(0);
    expect(outcomeLines(o, 'CPU X', { file: 'names-baseline.json', source: 's' })).toEqual([
      "Identical to the baseline for CPU X (eval/names-baseline.json): messages, B's spans, the names, every metric.",
    ]);
  });

  it('different: the fields that differ are named; exit 1', () => {
    const other = { ...run, detections: 2, spans: { model: 'x', names: 'n' } };
    const o = outcome(other, { model: 'x', names: 'n' }, run);
    expect(o).toEqual({ kind: 'different', fields: ['spans.model', 'detections'] });
    expect(exitCode(o)).toBe(1);
    expect(outcomeLines(o, 'CPU X', { file: 'names-baseline.json', source: 's' })).toEqual([
      'DIFFERENT from the baseline for CPU X (eval/names-baseline.json): spans.model, detections',
    ]);
  });

  it('a new CPU: passes (exit 0) with a warning that its baseline needs a human commit', () => {
    const o = outcome(run, same, undefined);
    expect(o).toEqual({ kind: 'new-cpu' });
    expect(exitCode(o)).toBe(0);
    const lines = outcomeLines(o, 'CPU Y');
    expect(lines[0]).toContain('NEW CPU: no baseline for "CPU Y"');
    expect(lines[0]).toContain('names-result.json');
    expect(lines[1]).toContain('two separate runs on this CPU model that agree');
    expect(lines[1]).toContain('then a human commit');
  });

  it('two passes that disagree on either hash: not repeatable, exit 1, whatever the baseline says', () => {
    for (const repeat of [
      { model: 'other', names: 'n' },
      { model: 'm', names: 'other' },
    ]) {
      for (const baseline of [run, undefined]) {
        const o = outcome(run, repeat, baseline);
        expect(o).toEqual({ kind: 'not-repeatable' });
        expect(exitCode(o)).toBe(1);
      }
    }
    expect(outcomeLines({ kind: 'not-repeatable' }, 'CPU X')[0]).toMatch(/^NOT REPEATABLE/u);
  });
});

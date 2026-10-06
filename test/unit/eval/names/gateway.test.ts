// The comparison behind `npm run eval:names` (Phase 6b step 4b): the hash
// formats must be exactly 6a's and D0's, or the check would compare the
// gateway with something that was never published.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  differences,
  firstMessages,
  messageTexts,
  modelSpansSha256,
  nameSpansSha256,
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

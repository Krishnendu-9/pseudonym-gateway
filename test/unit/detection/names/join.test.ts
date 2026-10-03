import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GAZETTEER } from '../../../../src/detection/names/gazetteer.js';
import { joinDetections, NO_SCORE } from '../../../../src/detection/names/join.js';
import { detectionsAt } from '../../../../src/detection/names/spans.js';
import { WIKIDATA_NAMES } from '../../../../src/synthetic/wikidata-names.js';

describe('joinDetections: the B+F join (ADR-035)', () => {
  it('is the union of both lists, in text order', () => {
    expect(joinDetections([{ start: 10, end: 15 }], [{ start: 0, end: 4 }])).toEqual([
      { start: 0, end: 4 },
      { start: 10, end: 15 },
    ]);
  });

  it('joins a model span and a list span that overlap or touch', () => {
    expect(joinDetections([{ start: 0, end: 5 }], [{ start: 3, end: 9 }])).toEqual([
      { start: 0, end: 9 },
    ]);
    expect(joinDetections([{ start: 0, end: 5 }], [{ start: 5, end: 9 }])).toEqual([
      { start: 0, end: 9 },
    ]);
  });

  it('keeps what only one side found', () => {
    expect(joinDetections([], [{ start: 2, end: 6 }])).toEqual([{ start: 2, end: 6 }]);
    expect(joinDetections([{ start: 2, end: 6 }], [])).toEqual([{ start: 2, end: 6 }]);
    expect(joinDetections([], [])).toEqual([]);
  });
});

describe('NO_SCORE: the point F was measured at', () => {
  it('is high 0.5 with no mid', () => {
    expect(NO_SCORE).toEqual({ high: 0.5 });
  });

  it('keeps every span F gives (score 1), widened to whole words', () => {
    const text = 'Dear Asha and Ravi';
    const spans = [
      { start: 5, end: 8, score: 1 },
      { start: 14, end: 18, score: 1 },
    ];
    expect(detectionsAt(text, spans, NO_SCORE)).toEqual([
      { start: 5, end: 9 },
      { start: 14, end: 18 },
    ]);
  });
});

describe('GAZETTEER: the list the 6a figures describe (ADR-036)', () => {
  it('is the measured gazetteer half: 718 strings, by its canonical SHA-256', () => {
    // Canonical form: sorted by UTF-16 code unit (the default sort), LF-joined, UTF-8.
    const canonical = [...GAZETTEER].sort().join('\n');
    expect(GAZETTEER.size).toBe(718);
    expect(createHash('sha256').update(canonical).digest('hex')).toBe(
      '313b89ea3a88ba35265f8f8bf5d2022c8dd85e90cdff4744bc3bb388821f3951',
    );
  });

  it('holds no spelling of the eval half, which the names block draws from', () => {
    const evalLatin = Object.values(WIKIDATA_NAMES)
      .flatMap((r) => [...r.evalGiven, ...r.evalFamily])
      .map(([latin]) => latin.toLowerCase());
    expect(evalLatin.length).toBeGreaterThan(0);
    expect(evalLatin.filter((latin) => GAZETTEER.has(latin)).length).toBe(0);
  });
});

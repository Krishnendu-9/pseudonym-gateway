// measure() against fixtures worked out by hand (before step 4 uses the
// scorer again). Each expected count is typed below, computed from the
// definitions in ADR-021 (item 4: a value is redacted when every one of its
// own characters is inside some detection; one character out is partly
// redacted, not redacted) and ADR-035 ("Metrics": R over the names block,
// rows by language and script, FP = detections touching no labelled value
// and no NOT slot, per 1,000 words of the whole set, words being runs of
// non-space characters; lookalikes reported apart). Nothing expected here is
// produced by the code under test.

import { describe, expect, it } from 'vitest';
import { fpPer1000, measure } from '../../../../eval/names/measure.js';
import type { LabelledCase, TruthPiece } from '../../../../eval/types.js';
import type { Span } from '../../../../src/detection/normalise.js';

let counter = 0;

/** A labelled piece over `text`'s first occurrence of `what`; letters only are required. */
function piece(text: string, what: string, type: string, label?: string): TruthPiece {
  const start = text.indexOf(what);
  if (start < 0) throw new Error('fixture: text not found');
  const required = [...what].flatMap((ch, k) => (/\s/u.test(ch) ? [] : [start + k]));
  return {
    valueId: `hand#${counter++}`,
    type: type as TruthPiece['type'],
    ...(label === undefined ? {} : { label }),
    start,
    end: start + what.length,
    required,
  };
}

function labelled(tags: string[], text: string, pieces: TruthPiece[]): LabelledCase {
  return { id: `hand-${counter++}`, tags, messages: [{ role: 'user', text, pieces }] };
}

const NAMES_EN = ['shape:names', 'name-lang:en', 'name-script:latin', 'ticket'];

/** A detector that answers from a table of spans by text. */
const finder =
  (table: Record<string, Span[]>) =>
  (text: string): Span[] =>
    table[text] ?? [];

// "Please call Asha Rao today." Asha Rao is at 12..20; the space at 16 is
// not required. 5 words.
const TEXT_A = 'Please call Asha Rao today.';
const caseA = (): LabelledCase => labelled(NAMES_EN, TEXT_A, [piece(TEXT_A, 'Asha Rao', 'PERSON')]);

describe('measure(), worked by hand', () => {
  it('1. a name covered whole: R 1/1, precision 1/1, no false positive', () => {
    const m = measure([caseA()], finder({ [TEXT_A]: [{ start: 12, end: 20 }] }));
    expect(m).toEqual({
      recall: { hit: 1, of: 1 },
      rows: { 'name-lang:en': { hit: 1, of: 1 }, 'name-script:latin': { hit: 1, of: 1 } },
      main: { hit: 0, of: 0 },
      precision: { hit: 1, of: 1 },
      plainText: 0,
      words: 5,
      lookalikes: {},
    });
    expect(fpPer1000(m)).toBe(0);
  });

  it('2. one letter left out: not redacted (partly), but the detection still covers a name', () => {
    // 12..19 leaves the final "o" (19) outside.
    const m = measure([caseA()], finder({ [TEXT_A]: [{ start: 12, end: 19 }] }));
    expect(m.recall).toEqual({ hit: 0, of: 1 });
    expect(m.rows).toEqual({
      'name-lang:en': { hit: 0, of: 1 },
      'name-script:latin': { hit: 0, of: 1 },
    });
    expect(m.precision).toEqual({ hit: 1, of: 1 });
    expect(m.plainText).toBe(0);
  });

  it('3. two detections that cover a name between them: redacted; both count as right', () => {
    const m = measure(
      [caseA()],
      finder({
        [TEXT_A]: [
          { start: 12, end: 16 },
          { start: 17, end: 20 },
        ],
      }),
    );
    expect(m.recall).toEqual({ hit: 1, of: 1 });
    expect(m.precision).toEqual({ hit: 2, of: 2 });
  });

  it('4. a detection on plain text: one false positive in 5 words is 200 per 1,000', () => {
    const m = measure(
      [caseA()],
      finder({
        [TEXT_A]: [
          { start: 12, end: 20 },
          { start: 0, end: 6 },
        ],
      }),
    );
    expect(m.recall).toEqual({ hit: 1, of: 1 });
    expect(m.precision).toEqual({ hit: 1, of: 2 });
    expect(m.plainText).toBe(1);
    expect(m.words).toBe(5);
    expect(fpPer1000(m)).toBe(200);
  });

  it('5. a detection on a NOT slot: a lookalike, not a false positive, and not precise', () => {
    // "June" is a labelled lookalike; "Asha" the name. 5 words.
    const text = 'Meet in June with Asha.';
    const c = labelled(NAMES_EN, text, [
      piece(text, 'June', 'NOT', 'month'),
      piece(text, 'Asha', 'PERSON'),
    ]);
    const m = measure([c], finder({ [text]: [{ start: 8, end: 12 }] }));
    expect(m).toEqual({
      recall: { hit: 0, of: 1 },
      rows: { 'name-lang:en': { hit: 0, of: 1 }, 'name-script:latin': { hit: 0, of: 1 } },
      main: { hit: 0, of: 0 },
      precision: { hit: 0, of: 1 },
      plainText: 0,
      words: 5,
      lookalikes: { 'NOT.month': 1 },
    });
  });

  it('6. where a name sits decides what it counts for: the names block, the main cases, or neither', () => {
    // Main case (no shape tag): "Ravi" covered. Another shape: "Meena"
    // missed. The names block: "Asha" missed (in Devanagari script rows).
    const main = 'Ravi paid.';
    const other = 'Meena paid.';
    const block = 'Ask Asha.';
    const cases = [
      labelled(['ticket'], main, [piece(main, 'Ravi', 'PERSON')]),
      labelled(['shape:short-id', 'ticket'], other, [piece(other, 'Meena', 'PERSON')]),
      labelled(
        ['shape:names', 'name-lang:hi', 'name-script:devanagari', 'name-place:intro'],
        block,
        [piece(block, 'Asha', 'PERSON')],
      ),
    ];
    const m = measure(cases, finder({ [main]: [{ start: 0, end: 4 }] }));
    expect(m.recall).toEqual({ hit: 0, of: 1 });
    expect(m.main).toEqual({ hit: 1, of: 1 });
    // Rows come from the names block only, for every group in ROW_GROUPS.
    expect(m.rows).toEqual({
      'name-lang:hi': { hit: 0, of: 1 },
      'name-script:devanagari': { hit: 0, of: 1 },
      'name-place:intro': { hit: 0, of: 1 },
    });
    expect(m.precision).toEqual({ hit: 1, of: 1 });
    // 2 + 2 + 2 words.
    expect(m.words).toBe(6);
  });

  it('7. a detection on another type of value: neither precise nor a false positive', () => {
    // "12345" is labelled PHONE (the label is what counts, not the digits).
    const text = 'Asha 12345 here.';
    const c = labelled(NAMES_EN, text, [
      piece(text, 'Asha', 'PERSON'),
      piece(text, '12345', 'PHONE'),
    ]);
    const m = measure([c], finder({ [text]: [{ start: 5, end: 10 }] }));
    expect(m.recall).toEqual({ hit: 0, of: 1 });
    expect(m.precision).toEqual({ hit: 0, of: 1 });
    expect(m.plainText).toBe(0);
    expect(m.lookalikes).toEqual({});
  });

  it('8. words are runs of non-space characters across every message of every case; FP is per 1,000 of them', () => {
    // "a  b\nc d" has 4 words; "e\tf" has 2; "  g  " has 1: 7 words.
    // Two plain-text detections: 2 * 1000 / 7.
    const t1 = 'a  b\nc d';
    const t2 = 'e\tf';
    const t3 = '  g  ';
    const cases: LabelledCase[] = [
      {
        id: 'hand-words-1',
        tags: ['ticket'],
        messages: [
          { role: 'user', text: t1, pieces: [] },
          { role: 'assistant', text: t2, pieces: [] },
        ],
      },
      labelled(['ticket'], t3, []),
    ];
    const m = measure(
      cases,
      finder({ [t1]: [{ start: 0, end: 1 }], [t3]: [{ start: 2, end: 3 }] }),
    );
    expect(m.words).toBe(7);
    expect(m.plainText).toBe(2);
    expect(m.precision).toEqual({ hit: 0, of: 2 });
    expect(m.recall).toEqual({ hit: 0, of: 0 });
    expect(fpPer1000(m)).toBeCloseTo(285.714, 3);
    // No cases at all: everything zero, and FP is 0, not NaN.
    const none = measure([], finder({}));
    expect([none.words, none.plainText, fpPer1000(none)]).toEqual([0, 0, 0]);
  });
});

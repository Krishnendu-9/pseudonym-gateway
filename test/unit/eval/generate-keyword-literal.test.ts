// The generated set's keyword-in-literal shape (ADR-038): a value whose
// only keyword is the type word inside a placeholder-shaped text. Counts
// and where things sit only; no value is printed (ADR-009).

import { describe, expect, it } from 'vitest';
import { generateCases, SHAPE_VALUES } from '../../../eval/generate.js';
import { SHAPE_TAG } from '../../../eval/types.js';

const cases = generateCases().filter((c) => c.tags.includes(`${SHAPE_TAG}keyword-in-literal`));
const PLACEHOLDER = /\[([A-Za-z]+)[_ ][1-9]\]/gu;

describe('generated set, shape keyword-in-literal', () => {
  it('has 96 cases of one message, one value and one placeholder each, 12 per type', () => {
    expect(SHAPE_VALUES['keyword-in-literal']).toBe(96);
    expect(cases).toHaveLength(96);
    const byType: Record<string, number> = {};
    for (const c of cases) {
      expect(c.messages).toHaveLength(1);
      const m = c.messages[0]!;
      expect(m.pieces).toHaveLength(1);
      expect([...m.text.matchAll(PLACEHOLDER)]).toHaveLength(1);
      byType[m.pieces[0]!.type] = (byType[m.pieces[0]!.type] ?? 0) + 1;
    }
    expect(byType).toEqual({
      AADHAAR: 12,
      CARD: 12,
      PAN: 12,
      IFSC: 12,
      UPI: 12,
      PASSPORT: 12,
      VOTER: 12,
      DOB: 12,
    });
  });

  it("names the value's own type in the placeholder, in three spellings, never followed by a colon", () => {
    const spellings = new Set<string>();
    for (const c of cases) {
      const m = c.messages[0]!;
      const [match] = [...m.text.matchAll(PLACEHOLDER)];
      expect(match![1]!.toUpperCase()).toBe(m.pieces[0]!.type);
      expect(m.text[match!.index + match![0].length]).not.toBe(':');
      spellings.add(
        match![0].replace(/[A-Za-z]+/u, (tag) =>
          tag === tag.toUpperCase() ? 'TAG' : tag === tag.toLowerCase() ? 'tag' : 'Tag',
        ),
      );
    }
    expect([...spellings].sort()).toEqual(['[TAG_1]', '[Tag_3]', '[tag 2]']);
  });

  it('gives each type twelve different layout and spelling pairs', () => {
    for (const type of ['AADHAAR', 'CARD', 'PAN', 'IFSC', 'UPI', 'PASSPORT', 'VOTER', 'DOB']) {
      const shapes = cases
        .filter((c) => c.messages[0]!.pieces[0]!.type === type)
        .map((c) => {
          const m = c.messages[0]!;
          const p = m.pieces[0]!;
          // The text with the value and the placeholder's tag taken out.
          return (m.text.slice(0, p.start) + '<v>' + m.text.slice(p.end)).replace(
            /\[[A-Za-z]+([_ ][1-9])\]/u,
            '[<tag>$1]',
          );
        });
      expect(new Set(shapes).size).toBe(12);
    }
  });
});

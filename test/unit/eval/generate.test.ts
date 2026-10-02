// The generated dataset's shape. Its text holds generated values, so these
// tests count and compare; they never print a message.

import { describe, expect, it } from 'vitest';
import {
  CASES_BY_KIND,
  GENERATED_SEED,
  generateCases,
  generateRawCases,
  MAIN_TYPES,
  SHAPE_VALUES,
  SHAPES,
  SHARE_WITHOUT_VALUES,
  SHORT_ID_TYPES,
  VALUES_PER_TYPE,
} from '../../../eval/generate.js';
import { lintCases } from '../../../eval/lint.js';
import { PERSONAL_TYPES, SHAPE_TAG, type LabelledCase } from '../../../eval/types.js';

const shapeOf = (c: LabelledCase): string | undefined =>
  c.tags.find((tag) => tag.startsWith(SHAPE_TAG))?.slice(SHAPE_TAG.length);
const mainOf = (set: readonly LabelledCase[]): LabelledCase[] =>
  set.filter((c) => shapeOf(c) === undefined);

const all = generateCases();
// The 500 cases written the usual way; the shape block (Phase 5c) follows them.
const cases = mainOf(all);
const block = all.filter((c) => shapeOf(c) !== undefined);
const messages = cases.flatMap((c) => c.messages);

const tally = <T extends string>(items: readonly T[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item] = (counts[item] ?? 0) + 1;
  return counts;
};

/** Distinct personal values by type (a value in two pieces is one value). */
function valuesByType(set: readonly LabelledCase[]): Record<string, number> {
  const seen = new Map<string, string>();
  for (const c of set) {
    for (const m of c.messages) {
      for (const p of m.pieces) if (p.type !== 'NOT') seen.set(p.valueId, p.type);
    }
  }
  return tally([...seen.values()]);
}

describe('the generated dataset', () => {
  it('has 600 messages in 500 cases, then the shape block; ids numbered in order', () => {
    expect([cases.length, messages.length]).toEqual([500, 600]);
    expect(all.slice(0, 500)).toEqual(cases);
    expect(all.map((c) => c.id)).toEqual(all.map((_, i) => `G${String(i + 1).padStart(4, '0')}`));
  });

  it('mixes tickets, emails, chats and records as planned', () => {
    expect(tally(cases.map((c) => c.tags[0]!))).toEqual(CASES_BY_KIND);
    expect(cases.filter((c) => c.tags[0] === 'chat').every((c) => c.messages.length === 3)).toBe(
      true,
    );
    expect(cases.filter((c) => c.tags[0] !== 'chat').every((c) => c.messages.length === 1)).toBe(
      true,
    );
  });

  it('is half English, 30% Hinglish, 10% Hindi and 10% mixed', () => {
    expect(tally(cases.map((c) => c.tags[1]!))).toEqual({
      en: 250,
      hinglish: 150,
      hi: 50,
      mixed: 50,
    });
  });

  it('really is in those languages: Devanagari where it says Hindi, none where it says English', () => {
    // Letters only: a value may be written in Devanagari digits in any message.
    const devanagari = /[ऄ-ह]/;
    const has = (language: string): boolean[] =>
      cases
        .filter((c) => c.tags[1] === language && c.tags[0] !== 'record')
        .map((c) => c.messages.some((m) => devanagari.test(m.text)));
    expect(has('hi').every(Boolean)).toBe(true);
    expect(has('en').some(Boolean)).toBe(false);
    expect(has('mixed').some(Boolean)).toBe(true);
  });

  it(`plants every type but the short IDs exactly ${VALUES_PER_TYPE} times`, () => {
    expect(valuesByType(cases)).toEqual(
      Object.fromEntries(MAIN_TYPES.map((type) => [type, VALUES_PER_TYPE])),
    );
    expect([...MAIN_TYPES, ...SHORT_ID_TYPES].sort()).toEqual([...PERSONAL_TYPES].sort());
  });

  it('leaves one message in five without any personal value', () => {
    const without = messages.filter((m) => m.pieces.every((p) => p.type === 'NOT')).length;
    expect(without).toBe(600 * SHARE_WITHOUT_VALUES);
  });

  it('puts at most six values in a message, and at least one in every other message', () => {
    const counts = messages.map((m) => m.pieces.filter((p) => p.type !== 'NOT').length);
    expect(Math.max(...counts)).toBeLessThanOrEqual(6);
    expect(counts.filter((n) => n === 0)).toHaveLength(120);
  });

  it('contains lookalikes of every kind, and typos and variants', () => {
    const labels = new Set(
      messages.flatMap((m) => m.pieces.map((p) => `${p.type}.${p.label ?? ''}`)),
    );
    for (const expected of [
      'NOT.order',
      'NOT.tracking',
      'NOT.invoice',
      'NOT.ticket',
      'NOT.otp',
      'NOT.reference',
      'NOT.transaction',
      'NOT.timestamp',
      'NOT.sku',
      'NOT.version',
      'NOT.datetime',
      'NOT.product-code',
      'NOT.batch',
      'NOT.invoice-no',
      'NOT.private-ip',
      'NOT.loopback',
      'NOT.link-local',
      'NOT.version-build',
      'NOT.app-version',
      'NOT.time',
      'NOT.date',
      'NOT.mac',
      'NOT.eui-64',
      'NOT.netmask',
      'NOT.multicast',
      'AADHAAR.typo',
      'CARD.typo',
      'CARD.amex',
      'PAN.typo',
      'IFSC.unknown',
      'UPI.mobile',
      'UPI.unknown',
      'SECRET.password',
      'SECRET.jwt',
    ]) {
      expect([expected, labels.has(expected)]).toEqual([expected, true]);
    }
  });

  it('writes IP addresses bare, with a port, a prefix length, in a URL and in brackets', () => {
    const forms = messages.flatMap((m) =>
      m.pieces
        .filter((p) => p.type === 'IP')
        .map((p) => {
          const before = m.text.slice(0, p.start);
          const after = m.text.slice(p.end);
          if (before.endsWith('http://')) return 'url';
          if (before.endsWith('[') && after.startsWith(']:443')) return 'brackets';
          if (/^:[0-9]/.test(after)) return 'port';
          if (/^\/[0-9]/.test(after)) return 'prefix';
          return 'bare';
        }),
    );
    expect(Object.keys(tally(forms)).sort()).toEqual(['bare', 'brackets', 'port', 'prefix', 'url']);
    // The IP pieces are the addresses alone: no port, prefix or bracket inside.
    const pieces = messages.flatMap((m) =>
      m.pieces.filter((p) => p.type === 'IP').map((p) => m.text.slice(p.start, p.end)),
    );
    expect(pieces.filter((p) => /[[\]/]|\.[0-9]+:[0-9]/.test(p))).toEqual([]);
  });

  it('labels stay inside their message and never overlap', () => {
    const ok = messages.every((m) =>
      m.pieces.every(
        (p, i) =>
          p.start >= (i === 0 ? 0 : m.pieces[i - 1]!.end) &&
          p.end <= m.text.length &&
          p.required.length > 0 &&
          p.required.every((at) => at >= p.start && at < p.end),
      ),
    );
    expect(ok).toBe(true);
  });

  it('is the same on every run, and different for another seed', () => {
    const again = generateCases(GENERATED_SEED);
    const other = generateCases(GENERATED_SEED + 1);
    const text = (set: readonly LabelledCase[]): string =>
      set.map((c) => c.messages.map((m) => m.text).join('\n')).join('\n');
    expect([text(again) === text(all), text(other) === text(all)]).toEqual([true, false]);
    // Another seed is another dataset of the same shape.
    const otherBlock = other.filter((c) => shapeOf(c) !== undefined);
    expect([mainOf(other).length, valuesByType(mainOf(other)).AADHAAR]).toEqual([
      500,
      VALUES_PER_TYPE,
    ]);
    expect(valuesByType(otherBlock).PASSPORT).toBe(VALUES_PER_TYPE);
  });
});

describe('the shape block (Phase 5c)', () => {
  const ofShape = (shape: string): LabelledCase[] => block.filter((c) => shapeOf(c) === shape);
  const piecesOf = (set: readonly LabelledCase[]) =>
    set.flatMap((c) => c.messages.flatMap((m) => m.pieces.map((p) => ({ m, p }))));
  const labelsOf = (set: readonly LabelledCase[]): Set<string> =>
    new Set(piecesOf(set).map(({ p }) => `${p.type}.${p.label ?? ''}`));

  it('tags every case with one known shape, after a kind and a language', () => {
    const shapeTags = block.map((c) => c.tags.filter((t) => t.startsWith(SHAPE_TAG)).length);
    expect(new Set(shapeTags)).toEqual(new Set([1]));
    expect([...new Set(block.map(shapeOf))]).toEqual([...SHAPES]);
    expect(new Set(block.map((c) => c.tags[1]))).toEqual(new Set(['en', 'hinglish', 'hi']));
  });

  it('plants the planned number of values in each shape', () => {
    const planted = Object.fromEntries(
      SHAPES.map((shape) => {
        const ids = piecesOf(ofShape(shape))
          .filter(({ p }) => p.type !== 'NOT')
          .map(({ p }) => p.valueId);
        return [shape, new Set(ids).size];
      }),
    );
    expect(planted).toEqual(SHAPE_VALUES);
  });

  it('line-break: a line break inside every value, 40 each of Aadhaar, card and phone', () => {
    const values = piecesOf(ofShape('line-break')).filter(({ p }) => p.type !== 'NOT');
    // The whole stretch: in "+91", a line break, then 10 digits, the break
    // comes before the first digit of the value.
    const broken = values.filter(({ m, p }) => m.text.slice(p.start, p.end).includes('\n'));
    expect(broken).toHaveLength(values.length);
    expect(valuesByType(ofShape('line-break'))).toEqual({ AADHAAR: 40, CARD: 40, PHONE: 40 });
  });

  it('message-split: every value has one piece in each of two messages', () => {
    const ok = ofShape('message-split').every((c) => {
      const [first, second] = c.messages.map((m) => m.pieces.filter((p) => p.type !== 'NOT'));
      return (
        c.messages.length === 2 &&
        first!.length === 1 &&
        second!.length === 1 &&
        first![0]!.valueId === second![0]!.valueId
      );
    });
    expect(ok).toBe(true);
  });

  it('side-by-side: two values with only a separator between them', () => {
    const ok = ofShape('side-by-side').every((c) => {
      const m = c.messages[0]!;
      const [a, b] = m.pieces.filter((p) => p.type !== 'NOT');
      return b !== undefined && /^(?: | - |\. |-)$/.test(m.text.slice(a!.end, b.start));
    });
    expect(ok).toBe(true);
  });

  it('contained and joined-digits use their variants and masks', () => {
    const contained = [...labelsOf(ofShape('contained'))].filter((l) => !l.startsWith('NOT.'));
    expect(contained.sort()).toEqual([
      'EMAIL.ifsc',
      'EMAIL.mobile',
      'EMAIL.pan',
      'SECRET.ifsc-tail',
      'SECRET.ip-tail',
      'SECRET.mobile-tail',
      'UPI.mobile-name',
    ]);
    expect(valuesByType(ofShape('joined-digits'))).toEqual({ NUMBER: 30 });
  });

  // A sheet's rows: every line after the header, as the gaps between its
  // values ("" before the first, then the column gap) and how many it holds.
  const sheetRows = (
    c: LabelledCase,
  ): { values: number; plus91: boolean; spacesOnly: boolean }[] => {
    const m = c.messages[0]!;
    const lines = m.text.split('\n');
    let at = lines[0]!.length + 1;
    return lines.slice(1).map((line) => {
      const end = at + line.length;
      const pieces = m.pieces.filter((p) => p.type === 'PHONE' && p.start >= at && p.end <= end);
      const between = pieces.slice(1).map((p, i) => m.text.slice(pieces[i]!.end, p.start));
      at = end + 1;
      return {
        values: pieces.length,
        plus91: pieces.some((p) => m.text.slice(p.start, p.end).startsWith('+91')),
        spacesOnly: between.every((gap) => /^ {1,2}$/.test(gap)),
      };
    });
  };

  it('contact-sheet: a header, then 2 to 5 rows of two spaced mobiles, spaces between', () => {
    const sheets = ofShape('contact-sheet');
    expect(valuesByType(sheets)).toEqual({ PHONE: SHAPE_VALUES['contact-sheet'] });
    const rows = sheets.map(sheetRows);
    expect(
      rows.every((sheet) => sheet.every((r) => r.values === 2 && !r.plus91 && r.spacesOnly)),
    ).toBe(true);
    expect(tally(rows.map((sheet) => String(sheet.length)))).toEqual({ 2: 12, 3: 3, 4: 3, 5: 3 });
  });

  it('misaligned-sheet: one row with "+91" in front, or one row with a mobile missing', () => {
    const sheets = ofShape('misaligned-sheet');
    expect(valuesByType(sheets)).toEqual({ PHONE: SHAPE_VALUES['misaligned-sheet'] });
    const odd = sheets.map((c) => {
      const rows = sheetRows(c);
      const plus91 = rows.filter((r) => r.plus91).length;
      const short = rows.filter((r) => r.values === 1).length;
      const kind =
        plus91 === 1 && short === 0 ? 'plus91' : plus91 === 0 && short === 1 ? 'missing' : 'bad';
      return `${kind} ${rows.length}`;
    });
    expect(tally(odd)).toEqual(
      Object.fromEntries(
        ['plus91', 'missing'].flatMap((k) => [2, 3, 4].map((n) => [`${k} ${n}`, 4])),
      ),
    );
  });

  it('in-markup: one value per case, 9 in each of ten places in a URL, link or tag', () => {
    const cases = ofShape('in-markup');
    expect(valuesByType(cases)).toEqual({ EMAIL: 40, PHONE: 21, PAN: 11, UPI: 10, AADHAAR: 8 });
    // Where each value sits, read from the text just before and after it.
    const places: [string, RegExp][] = [
      ['url query', /track\?id=$/],
      ['url path', /\/users\/$/],
      ['link text', /\[$/],
      ['link target', /\[my profile\]\((?:mailto:|tel:|https:\/\/portal\.example\/kyc\?pan=)$/],
      ['image', /\?m=$/],
      ['mailto', /(?<!href=")mailto:$/],
      ['attribute', /(?:href="mailto:|value="|data-pan=')$/],
      ['element text', /<td>$/],
      ['reference definition', /\[profile\]: https:\/\/portal\.example\/\?u=$/],
      ['img src', /<img src="https:\/\/cdn\.example\/p\.png\?u=$/],
    ];
    const found = cases.map((c) => {
      const m = c.messages[0]!;
      const values = m.pieces.filter((p) => p.type !== 'NOT');
      if (c.messages.length !== 1 || values.length !== 1) return 'bad';
      const before = m.text.slice(0, values[0]!.start);
      return places.filter(([, pattern]) => pattern.test(before)).map(([name]) => name)[0] ?? '?';
    });
    expect(tally(found)).toEqual(Object.fromEntries(places.map(([name]) => [name, 9])));
  });

  it(`short-id: each short ID type ${VALUES_PER_TYPE} times, among lookalikes of its shape`, () => {
    expect(valuesByType(ofShape('short-id'))).toEqual(
      Object.fromEntries(SHORT_ID_TYPES.map((type) => [type, VALUES_PER_TYPE])),
    );
    const labels = labelsOf(ofShape('short-id'));
    for (const label of [
      'NOT.invoice-code',
      'NOT.order-code',
      'NOT.model-code',
      'NOT.ticket-code',
      'NOT.event-date',
    ]) {
      expect([label, labels.has(label)]).toEqual([label, true]);
    }
  });
});

describe('the generator’s templates', () => {
  it('pass the same lint as hand-written cases: nothing typed looks like a value', () => {
    for (const seed of [GENERATED_SEED, 1, 2, 3]) {
      const problems = lintCases(generateRawCases(seed)).map((p) => `${p.caseId}: ${p.rule}`);
      expect(problems).toEqual([]);
    }
  });
});

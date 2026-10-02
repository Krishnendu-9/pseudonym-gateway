// unsafeRegions: where restoration must not write a value back (restoration
// safety, CLAUDE.md). Conservative on purpose; the known gaps listed in the
// unsafe-regions.ts header are tested as negatives. Since Phase 4 (ADR-018)
// a left-to-right scanner finds the regions; the differential properties at
// the end check it against the rules written as regular expressions
// (test/support/restore-reference.ts).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  isInUnsafeRegion,
  isWhitespace,
  startsHost,
  unsafeRegions,
  UnsafeRegionScanner,
} from '../../../src/redaction/unsafe-regions.js';
import { assertPropertyQuietly } from '../../support/quiet-property.js';
import { legacyUnsafeRegions, oracleUnsafeRegions } from '../../support/restore-reference.js';
import { streamedAnswerArb } from '../../support/restoration-text.js';

const coversPlaceholder = (text: string, placeholder = '[AADHAAR_1]'): boolean => {
  const at = text.indexOf(placeholder);
  return isInUnsafeRegion(unsafeRegions(text), at, at + placeholder.length);
};

const regionText = (text: string, region: { start: number; end: number }): string =>
  text.slice(region.start, region.end);

describe('unsafeRegions: markdown link and image targets', () => {
  // A destination runs to the first whitespace, so the closing ")" is inside
  // the region too; that is the safe side.
  it('finds an image target, not the alt text', () => {
    const text = 'See ![a photo](https://example.com/x?d=1) here';
    const regions = unsafeRegions(text);
    expect(regions).toHaveLength(1);
    expect(regionText(text, regions[0]!)).toBe('https://example.com/x?d=1)');
  });

  it('finds a link target', () => {
    const text = 'See [here](https://example.com/x) now';
    expect(regionText(text, unsafeRegions(text)[0]!)).toBe('https://example.com/x)');
  });

  // Bug-log 13: CommonMark allows balanced parentheses in a destination.
  // Stopping at the first ")" left everything after it restorable.
  it.each([
    ['one level', '[a](https://example.com/x?y=(1)[AADHAAR_1])'],
    ['two levels', '[a](https://example.com/x?y=((1))[AADHAAR_1])'],
    ['space after "("', '[a]( https://example.com/x?y=[AADHAAR_1])'],
  ])('covers a destination with parentheses inside it (%s)', (_name, text) => {
    const placeholder = text.indexOf('[AADHAAR_1]');
    expect(isInUnsafeRegion(unsafeRegions(text), placeholder, placeholder + 11)).toBe(true);
  });

  it('covers an angle-bracket destination, which may contain spaces', () => {
    const text = '![x](<https://example.com/a b?d=[AADHAAR_1]>)';
    expect(regionText(text, unsafeRegions(text)[0]!)).toBe(
      '<https://example.com/a b?d=[AADHAAR_1]>',
    );
  });

  it('does not reach past the whitespace after a link into ordinary text', () => {
    const text = 'See [x](https://example.com/y). Your [AADHAAR_1] is on file.';
    const placeholder = text.indexOf('[AADHAAR_1]');
    expect(isInUnsafeRegion(unsafeRegions(text), placeholder, placeholder + 11)).toBe(false);
  });
});

describe('unsafeRegions: HTML attribute values', () => {
  it('finds a double-quoted href', () => {
    const text = '<a href="https://example.com/x">link</a>';
    expect(regionText(text, unsafeRegions(text)[0]!)).toBe('https://example.com/x');
  });

  it('finds a single-quoted src', () => {
    const text = "<img src='https://example.com/x'>";
    expect(regionText(text, unsafeRegions(text)[0]!)).toBe('https://example.com/x');
  });

  it('known limit: an unquoted attribute value is only covered as a bare scheme URL', () => {
    const text = '<a href=https://example.com/x>link</a>';
    expect(regionText(text, unsafeRegions(text)[0]!)).toBe('https://example.com/x');
  });
});

describe('unsafeRegions: bare URLs', () => {
  it('finds a scheme URL with no markup around it', () => {
    const text = 'Try https://example.com/x?d=1 directly';
    expect(regionText(text, unsafeRegions(text)[0]!)).toBe('https://example.com/x?d=1');
  });

  it('finds a mailto: URL', () => {
    const text = 'Mail mailto:someone@example.com?body=1 now';
    expect(regionText(text, unsafeRegions(text)[0]!)).toBe('mailto:someone@example.com?body=1');
  });

  it('a mailto: glued to a word before it is not a URL (it has no word boundary)', () => {
    expect(unsafeRegions('Mail xmailto:someone@example.com now')).toHaveLength(0);
    expect(legacyUnsafeRegions('Mail xmailto:someone@example.com now')).toHaveLength(0);
  });

  it('finds a bare host with a path, but not a bare host alone', () => {
    expect(unsafeRegions('Visit example.com for details')).toHaveLength(0);
    const text = 'Visit example.com/path for details';
    expect(regionText(text, unsafeRegions(text)[0]!)).toBe('example.com/path');
  });

  it.each([
    // A label cannot start or end with "-", and ".." is an empty label: the
    // host starts after the broken label, never before it.
    ['a label starting with "-"', 'Visit a.-b.example/p now', 'b.example/p'],
    ['a label ending with "-"', 'Visit a-.b.example/p now', 'b.example/p'],
    ['an empty label', 'Visit a..b.example/p now', 'b.example/p'],
    ['a label after "_"', 'Visit x_a.b.example/p now', 'b.example/p'],
    ['a label chain', 'Visit a-1.b2.example/p now', 'a-1.b2.example/p'],
  ])('a bare host starts at its first valid label: %s', (_name, text, expected) => {
    expect(regionText(text, unsafeRegions(text)[0]!)).toBe(expected);
    expect(regionText(text, oracleUnsafeRegions(text)[0]!)).toBe(expected);
  });

  it('does not treat ordinary prose with a full stop as a URL', () => {
    expect(unsafeRegions('See section 2.3 for details.')).toHaveLength(0);
    expect(unsafeRegions('Mr. Smith called.')).toHaveLength(0);
  });
});

// Documented gaps (unsafe-regions.ts header, CLAUDE.md Phase 8 notes). A
// client never fetches any of these on its own. If one starts being
// covered, update the docs with it.
describe('unsafeRegions: known gaps', () => {
  it.each([
    ['a bare host with a query but no "/"', 'Visit a.example?d=[AADHAAR_1] now'],
    ['a bare IP address with no scheme', 'Visit 203.0.113.9/?d=[AADHAAR_1] now'],
    ['an unquoted relative attribute', '<img src=a.example?d=[AADHAAR_1]>'],
  ])('does not cover %s', (_name, text) => {
    const placeholder = text.indexOf('[AADHAAR_1]');
    expect(isInUnsafeRegion(unsafeRegions(text), placeholder, placeholder + 11)).toBe(false);
  });
});

describe('isInUnsafeRegion', () => {
  it('is true only for a span overlapping a region', () => {
    const regions = [{ start: 10, end: 20 }];
    expect(isInUnsafeRegion(regions, 5, 10)).toBe(false); // touching, not overlapping
    expect(isInUnsafeRegion(regions, 9, 11)).toBe(true);
    expect(isInUnsafeRegion(regions, 20, 25)).toBe(false);
    expect(isInUnsafeRegion(regions, 12, 18)).toBe(true);
  });
});

// ADR-018: the rules changed so each is decided by the text on the left.
// Every change marks more than Phase 2 did, never less.
describe('unsafeRegions: rules decided from the left (ADR-018)', () => {
  it('an unclosed quoted value runs to the end of the text', () => {
    const text = '<img src="//a.example/?d= [AADHAAR_1] and more\n\ntext';
    expect(regionText(text, unsafeRegions(text)[0]!)).toBe(
      '//a.example/?d= [AADHAAR_1] and more\n\ntext',
    );
  });

  it('reads quoted values left to right: "=" inside an open value starts nothing', () => {
    // A URL ending in "=" and base64 padding: the closing quote is not an
    // opening one, so the prose after them still restores.
    for (const text of [
      '<a href="https://x.example/?ref=">link</a> Your Aadhaar is [AADHAAR_1].',
      '<p data-k="aGVsbG8=">hi</p> Your Aadhaar is [AADHAAR_1].',
    ]) {
      expect(coversPlaceholder(text)).toBe(false);
    }
  });

  it('an unclosed "<" destination runs to the end of the line, not the first space', () => {
    expect(coversPlaceholder('![x](<https://a.example/?d= [AADHAAR_1]')).toBe(true);
    expect(coversPlaceholder('![x](<https://a.example/?d=\n[AADHAAR_1]')).toBe(false);
  });

  it('every "](" counts, even inside an unclosed "<" destination', () => {
    // The second "](" is inside the first destination; its own destination
    // starts after the line breaks. Phase 2 found it too (its first match
    // stopped at the space); a left-to-right reading would not.
    expect(coversPlaceholder('![x](<a b ](\n\n//a.example?d=[AADHAAR_1]')).toBe(true);
  });

  it('every "[" starts a label, even inside another label', () => {
    expect(coversPlaceholder('[a [ref]: //a.example?d=[AADHAAR_1]')).toBe(true);
    expect(coversPlaceholder('[a\\]: //a.example?d=[AADHAAR_1]')).toBe(false); // "]" escaped
    expect(coversPlaceholder('[]: [AADHAAR_1]')).toBe(false); // empty label
  });

  it('a backslash escapes anything in a label but a line break', () => {
    expect(coversPlaceholder('[a\\\\]: [AADHAAR_1]')).toBe(true); // "\\" escapes "\"
    expect(coversPlaceholder('[a\r]: [AADHAAR_1]')).toBe(true); // a bare CR is allowed
    for (const lineBreak of ['\n', '\r', ' ', ' ']) {
      const text = `[a\\${lineBreak}]: [AADHAAR_1]`;
      expect(coversPlaceholder(text)).toBe(false);
      expect(oracleUnsafeRegions(text)).toEqual(unsafeRegions(text));
    }
  });
});

// Addition 1 (Phase 4 review): HTML allows whitespace around "=". The rule
// starts at "=", so whitespace before it never mattered and whitespace
// after it is skipped. Phase 2 already covered every one of these (probed
// 2026-09-29; not a bug); the destinations are protocol-relative so that
// no URL pattern can cover them by accident.
describe('unsafeRegions: whitespace around "=" in an HTML attribute', () => {
  it.each([
    ['="', '<img src="//a.example/?d= [AADHAAR_1]">'],
    ['= "', '<img src= "//a.example/?d= [AADHAAR_1]">'],
    [' = "', '<img src = "//a.example/?d= [AADHAAR_1]">'],
    [' ="', '<img src ="//a.example/?d= [AADHAAR_1]">'],
    ["='", "<img src='//a.example/?d= [AADHAAR_1]'>"],
    ["= '", "<img src= '//a.example/?d= [AADHAAR_1]'>"],
    ["tab = tab '", "<img src\t=\t'//a.example/?d= [AADHAAR_1]'>"],
    ['tab = tab "', '<img src\t=\t"//a.example/?d= [AADHAAR_1]">'],
    ['= line break "', '<img src=\n"//a.example/?d= [AADHAAR_1]">'],
    ['= spaces and tabs "', '<img src = \t "//a.example/?d= [AADHAAR_1]">'],
  ])('covers %s', (_name, text) => {
    expect(coversPlaceholder(text)).toBe(true);
    expect(
      isInUnsafeRegion(
        legacyUnsafeRegions(text),
        text.indexOf('[AADHAAR_1]'),
        text.indexOf('[AADHAAR_1]') + 11,
      ),
    ).toBe(true);
  });
});

describe('UnsafeRegionScanner.overlaps', () => {
  it('is true only for a span overlapping a region found so far', () => {
    const scanner = new UnsafeRegionScanner();
    scanner.feed('ab https://x.example/p cd https://y.example/q ef');
    // Regions: [3, 22) and [26, 45).
    expect(scanner.overlaps(0, 3)).toBe(false); // touching, before the first
    expect(scanner.overlaps(22, 26)).toBe(false); // between the two
    expect(scanner.overlaps(21, 23)).toBe(true);
    expect(scanner.overlaps(40, 48)).toBe(true);
    expect(scanner.overlaps(45, 48)).toBe(false);
    expect(new UnsafeRegionScanner().overlaps(0, 5)).toBe(false);
  });
});

describe('startsHost: the host rule (ADR-018)', () => {
  it('a bare placeholder before "." or "-" and a label character', () => {
    for (const after of ['.a', '.Z', '.9', '.-', '-a', '-9', '--']) {
      expect(startsHost(after, false)).toBe(true);
    }
  });

  it('a bracketed placeholder only before "."', () => {
    expect(startsHost('.attacker', true)).toBe(true);
    expect(startsHost('-linked', true)).toBe(false);
  });

  it('not before a sentence end, a space, or the end of the text', () => {
    for (const after of ['', '.', '. Next', '.\n', '-', '- x', ' .a', '._', '.é']) {
      expect(startsHost(after, false)).toBe(false);
      expect(startsHost(after, true)).toBe(false);
    }
  });
});

describe('isWhitespace', () => {
  it("is exactly JavaScript's \\s, for every UTF-16 code unit", () => {
    const differ: number[] = [];
    for (let c = 0; c <= 0xffff; c++) {
      if (isWhitespace(c) !== /\s/.test(String.fromCharCode(c))) differ.push(c);
    }
    expect(differ).toEqual([]);
  });
});

describe('unsafeRegions: differential properties (ADR-018)', () => {
  it('finds exactly the regions the rules written as regular expressions find', () => {
    assertPropertyQuietly(
      fc.property(streamedAnswerArb, ({ text }) => {
        const found = unsafeRegions(text);
        const expected = oracleUnsafeRegions(text);
        return (
          found.length === expected.length &&
          found.every((r, i) => r.start === expected[i]!.start && r.end === expected[i]!.end)
        );
      }),
      { numRuns: 5_000 },
    );
  });

  it('gives the same regions however the text is cut into pieces', () => {
    assertPropertyQuietly(
      fc.property(streamedAnswerArb, ({ text, chunks }) => {
        const scanner = new UnsafeRegionScanner();
        for (const chunk of chunks) scanner.feed(chunk);
        return JSON.stringify(scanner.regions()) === JSON.stringify(unsafeRegions(text));
      }),
      { numRuns: 5_000 },
    );
  });

  it('marks everything the Phase 2 rules marked', () => {
    assertPropertyQuietly(
      fc.property(streamedAnswerArb, ({ text }) => {
        const found = unsafeRegions(text);
        return legacyUnsafeRegions(text).every((old) =>
          found.some((r) => r.start <= old.start && old.end <= r.end),
        );
      }),
      { numRuns: 5_000 },
    );
  });
});

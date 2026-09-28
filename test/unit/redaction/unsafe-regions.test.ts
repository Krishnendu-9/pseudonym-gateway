// unsafeRegions: where restoration must not write a value back (restoration
// safety, CLAUDE.md). Conservative on purpose; the known gaps listed in the
// unsafe-regions.ts header are tested as negatives.

import { describe, expect, it } from 'vitest';
import { isInUnsafeRegion, unsafeRegions } from '../../../src/redaction/unsafe-regions.js';

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

  it('finds a bare host with a path, but not a bare host alone', () => {
    expect(unsafeRegions('Visit example.com for details')).toHaveLength(0);
    const text = 'Visit example.com/path for details';
    expect(regionText(text, unsafeRegions(text)[0]!)).toBe('example.com/path');
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

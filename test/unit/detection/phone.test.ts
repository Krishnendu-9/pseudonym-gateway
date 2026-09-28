// Indian mobile numbers have no fictional range, so they are generated at run
// time and never printed (ADR-009). International numbers written here come
// from ranges reserved for fiction: NANP 555-0100 to 555-0199, Ofcom's drama
// ranges (020 7946 0xxx, 07700 900xxx) and ACMA's 0491 570 xxx.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { detect } from '../../../src/detection/detect.js';
import { createRng } from '../../../src/synthetic/rng.js';
import { indianMobile } from '../../../src/synthetic/values.js';
import { compose } from '../../support/compose.js';
import { assertPropertyQuietly, seedArb } from '../../support/quiet-property.js';

const rng = createRng(9110);

const phoneAt = (span: { start: number; end: number }, validated = true, context = false) => ({
  type: 'PHONE',
  ...span,
  validated,
  context,
});

// Ways people write an Indian mobile number.
const FORMATS: readonly ((m: string) => string)[] = [
  (m) => m,
  (m) => `${m.slice(0, 5)} ${m.slice(5)}`,
  (m) => `+91 ${m}`,
  (m) => `+91 ${m.slice(0, 5)} ${m.slice(5)}`,
  (m) => `+91-${m.slice(0, 5)}-${m.slice(5)}`,
  (m) => `0${m}`,
  (m) => `0091 ${m}`,
  (m) => `(+91) ${m}`,
];

describe('phone detection', () => {
  it.each(FORMATS.map((format, i) => [i, format] as const))(
    'finds a generated Indian mobile in format %i',
    (_i, format) => {
      const { text, spans } = compose`Reach me at ${format(indianMobile(rng))} after six.`;
      expect(detect(text)).toEqual([phoneAt(spans[0]!)]);
    },
  );

  it('finds generated Indian mobiles in every format', () => {
    assertPropertyQuietly(
      fc.property(seedArb, fc.constantFrom(...FORMATS), (seed, format) => {
        const { text, spans } = compose`Reach me at ${format(indianMobile(createRng(seed)))} now`;
        const found = detect(text);
        return (
          found.length === 1 &&
          found[0]!.type === 'PHONE' &&
          found[0]!.validated &&
          found[0]!.start === spans[0]!.start &&
          found[0]!.end === spans[0]!.end
        );
      }),
      { numRuns: 500 },
    );
  });

  it.each([
    ['a US number', '+1 202-555-0143'],
    ['a Canadian number', '+1 (613) 555-0199'],
    ['a London number', '+44 20 7946 0123'],
    ['a Leeds number in national form after 0044', '0044 113 496 0123'],
    ['an Australian mobile', '+61 491 570 156'],
  ])('finds %s from a fictional range (%s)', (_name, number) => {
    const { text, spans } = compose`Office: ${number}.`;
    expect(detect(text)).toEqual([phoneAt(spans[0]!)]);
  });

  it('records context next to "call"', () => {
    const { text, spans } = compose`Call ${'+44 20 7946 0123'}`;
    expect(detect(text)).toEqual([phoneAt(spans[0]!, true, true)]);
  });

  describe('unvalidated: accepted only with a keyword', () => {
    // libphonenumber marks Ofcom's 07700 900xxx drama range as not valid, but
    // it is the right length for a UK mobile: a POSSIBLE number.
    it('a possible but invalid number is dropped without context ...', () => {
      expect(detect('Ref +44 7700 900123 ok')).toEqual([]);
    });

    it('... and kept, unvalidated, next to "mobile" or "फ़ोन"', () => {
      const english = compose`mobile ${'+44 7700 900123'}`;
      expect(detect(english.text)).toEqual([phoneAt(english.spans[0]!, false, true)]);
      const hindi = compose`फ़ोन: ${'+44 7700 900456'}`;
      expect(detect(hindi.text)).toEqual([phoneAt(hindi.spans[0]!, false, true)]);
    });
  });

  describe('tricky negatives', () => {
    it('ignores a valid number glued to letters', () => {
      expect(detect(`id=ab${indianMobile(rng)}cd`)).toEqual([]);
    });

    it('ignores a possible number glued to letters, even with context', () => {
      expect(detect('call x+44 7700 900123y')).toEqual([]);
    });

    it('leaves digits before an @ to the email detector', () => {
      const { text, spans } = compose`Mail ${`${indianMobile(rng)}@example.com`} now`;
      expect(detect(text)).toEqual([
        { type: 'EMAIL', ...spans[0]!, validated: false, context: false },
      ]);
      const dotted = compose`Mail ${`rahul.${indianMobile(rng)}@example.com`} now`;
      expect(detect(dotted.text).map((d) => d.type)).toEqual(['EMAIL']);
    });

    it.each([
      ['a date', 'Due 2024-05-01, thanks'],
      ['an IP address', 'Server 192.168.1.10 is down'],
      ['a short number', 'Room 4021'],
      ['a price', 'Total Rs 1,49,999.00'],
      ['a year range', 'From 1998 to 2024'],
    ])('ignores %s', (_name, text) => {
      expect(detect(text)).toEqual([]);
    });

    it('finds a number right after an emoji', () => {
      const { text, spans } = compose`\u{1F4DE}${'+44 20 7946 0123'}`;
      expect(detect(text)).toEqual([phoneAt(spans[0]!)]);
    });
  });

  it('labels 91 + a mobile number as an Aadhaar when it also passes the Aadhaar checks', () => {
    // Documented behaviour: without a "+", "91" + 10 digits is 12 digits.
    // When those also pass Verhoeff, both detections are validated and the
    // same length, and type priority (Aadhaar > Phone) decides. The value
    // is redacted either way; only the label differs.
    let found = 0;
    const r = createRng(5);
    for (let i = 0; i < 400 && found === 0; i++) {
      const digits = `91${indianMobile(r)}`;
      const types = detect(`no ${digits} ok`).map((d) => d.type);
      if (types.includes('AADHAAR')) {
        expect(types).toEqual(['AADHAAR']);
        found++;
      } else {
        expect(types).toEqual(['PHONE']);
      }
    }
    expect(found).toBe(1);
  });
});

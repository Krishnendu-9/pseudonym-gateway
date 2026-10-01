// Indian mobile numbers have no fictional range, so they are generated at run
// time and never printed (ADR-009). International numbers written here come
// from ranges reserved for fiction: NANP 555-0100 to 555-0199, Ofcom's drama
// ranges (020 7946 0xxx, 07700 900xxx) and ACMA's 0491 570 xxx.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { detect } from '../../../src/detection/detect.js';
import type { Span } from '../../../src/detection/normalise.js';
import { hideExtensionMarkers, phoneCandidates } from '../../../src/detection/phone.js';
import { createRng } from '../../../src/synthetic/rng.js';
import { groupDigits, indianMobile, ukDramaMobile } from '../../../src/synthetic/values.js';
import { compose } from '../../support/compose.js';
import { numberAt } from '../../support/number-at.js';
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
    it('is not a phone when glued to letters (the safety net takes the whole token, ADR-011)', () => {
      const { text, spans } = compose`id=${`ab${indianMobile(rng)}cd`}`;
      expect(detect(text)).toEqual([numberAt(spans[0]!)]);
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
      ['a short number', 'Room 4021'],
      ['a price', 'Total Rs 1,49,999.00'],
      ['a year range', 'From 1998 to 2024'],
    ])('ignores %s', (_name, text) => {
      expect(detect(text)).toEqual([]);
    });

    it('a spaced mobile after a lone digit and a space is found, keyword or not (bug-log 32, 34)', () => {
      // libphonenumber reads "<digit> <mobile>" as 11 digits, not valid, and
      // reports nothing; spaced-mobile.ts finds the 5 + 5 pair inside, and
      // the detection is widened over the digit run.
      const mobile = groupDigits(indianMobile(rng), [5, 5], ' ');
      for (const before of ['Room 3 ', 'item 1 ', 'mobile: Room 3 ']) {
        const { text } = compose`${before}${mobile}`;
        const digitsFrom = text.search(/[0-9]/);
        expect([before, detect(text).map((d) => [d.type, d.start, d.end])]).toEqual([
          before,
          [['PHONE', digitsFrom, text.length]],
        ]);
      }
    });

    it('an IP address is an IP, even one libphonenumber calls a valid phone number (ADR-026)', () => {
      // 2030113100 reads as a landline in Pune (area code 20): a validated
      // phone over exactly the address's text, so the type order decides.
      const tie = 'Server 203.0.113.100 down';
      expect([...phoneCandidates(tie)].map((c) => [c.start, c.end, c.validated])).toEqual([
        [7, 20, true],
      ]);
      for (const text of ['Server 10.0.0.1 down', tie]) {
        expect(detect(text).map((d) => d.type)).toEqual(['IP']);
      }
    });

    it('finds a number right after an emoji', () => {
      const { text, spans } = compose`\u{1F4DE}${'+44 20 7946 0123'}`;
      expect(detect(text)).toEqual([phoneAt(spans[0]!)]);
    });
  });

  // bug-log 7: libphonenumber read "<a>, <b>" as a number with an extension,
  // reported a match that stopped inside <b>, and that match was dropped, so
  // neither number was redacted.
  describe('lists of numbers (bug-log 7)', () => {
    // True if one detection covers the whole span.
    const covers = (found: readonly { start: number; end: number }[], span: Span): boolean =>
      found.some((d) => d.start <= span.start && d.end >= span.end);
    const SEPARATORS = [
      ', ',
      ',',
      ' , ',
      ',, ',
      '; ',
      ';',
      ' # ',
      '#',
      '~',
      ' ~ ',
      ' x ',
      ' X ',
      ' ext ',
      ' Ext. ',
      ' extn ',
      ' extension ',
      ' int ',
      ' доб ',
      ' anexo ',
    ];

    it.each(SEPARATORS.map((s) => [JSON.stringify(s), s] as const))(
      'finds both Indian mobiles in "<a>%s<b>", each exactly',
      (_name, separator) => {
        const r = createRng(700);
        let wrong = 0;
        for (let i = 0; i < 100; i++) {
          const { text, spans } =
            compose`Numbers ${indianMobile(r)}${separator}${indianMobile(r)} ok`;
          const numbers = [spans[0]!, spans[2]!]; // spans[1] is the separator
          const found = detect(text);
          const exact =
            found.length === 2 &&
            found.every(
              (d, j) =>
                d.type === 'PHONE' && d.start === numbers[j]!.start && d.end === numbers[j]!.end,
            );
          if (!exact) wrong++;
        }
        expect(wrong).toBe(0);
      },
    );

    it.each(SEPARATORS.map((s) => [JSON.stringify(s), s] as const))(
      'redacts both unvalidated UK drama numbers in "call <a>%s<b>"',
      (_name, separator) => {
        const r = createRng(701);
        let leaked = 0;
        for (let i = 0; i < 50; i++) {
          const { text, spans } =
            compose`call ${ukDramaMobile(r)}${separator}${ukDramaMobile(r)} ok`;
          const found = detect(text);
          if (!covers(found, spans[0]!) || !covers(found, spans[2]!)) leaked++;
        }
        expect(leaked).toBe(0);
      },
    );

    it('widens a match that stops inside a digit run instead of dropping it', () => {
      // In "<a>(<b>" libphonenumber reports a piece that starts or ends inside
      // one of the numbers. Keeping it and widening to the runs covers both.
      const r = createRng(702);
      let leaked = 0;
      for (let i = 0; i < 200; i++) {
        const { text, spans } = compose`Numbers ${indianMobile(r)}(${indianMobile(r)} ok`;
        const found = detect(text);
        if (!covers(found, spans[0]!) || !covers(found, spans[1]!)) leaked++;
      }
      expect(leaked).toBe(0);
    });

    it('still finds a number that has an extension; the extension stays visible', () => {
      const { text, spans } =
        compose`Office ${'+1 202-555-0143'} ext 12, or ${'+44 20 7946 0123'};4`;
      expect(detect(text)).toEqual([phoneAt(spans[0]!), phoneAt(spans[1]!)]);
    });

    it('hides standalone extension markers and ones right after a digit, keeping every offset', () => {
      const text = 'Text Alex next, mixture; x #1 ~ Ext. extn int доб anexo xt6 3x';
      const hidden = hideExtensionMarkers(text);
      expect(hidden).toHaveLength(text.length);
      expect(hidden).toBe(
        'Text Alex next\n mixture\n \n \n1 \n \n\n\n. \n\n\n\n \n\n\n \n\n\n \n\n\n\n\n xt6 3\n',
      );
      // After a digit (bug-log 36): blanked unless a letter or digit follows.
      expect(hideExtensionMarkers('1234X 9xt 5ext 7X- R2x 24x7 6789x123 3x_ 77xyz')).toBe(
        '1234\n 9\n\n 5\n\n\n 7\n- R2\n 24x7 6789x123 3x_ 77xyz',
      );
    });

    it('finds a spaced number after a word ending in a digit and "x" (bug-log 36)', () => {
      const formats: (() => string)[] = [
        () => groupDigits(indianMobile(rng), [5, 5], ' '),
        () => groupDigits(indianMobile(rng), [3, 3, 4], ' '),
        () => `022 ${rng.int(2, 6)}${rng.digits(3)} ${rng.digits(4)}`,
      ];
      for (const ending of ['1234X', '1234x', 'R2x', '9xt', '5ext', '7X-']) {
        for (const [i, format] of formats.entries()) {
          const { text, spans } = compose`Ref ${ending} ${format()} ok`;
          const found = detect(text).filter((d) => d.type === 'PHONE');
          const whole = found.some((d) => d.start <= spans[1]!.start && spans[1]!.end <= d.end);
          expect([ending, i, whole]).toEqual([ending, i, true]);
        }
      }
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

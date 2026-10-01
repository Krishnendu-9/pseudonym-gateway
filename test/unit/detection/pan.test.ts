// Valid PANs are generated at run time and never printed (ADR-009).
// Hand-written PAN-shaped strings in this file have a 4th letter that is not
// a holder-type code (D, E, X...), so none can be a real PAN.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { detect } from '../../../src/detection/detect.js';
import { isValidPan } from '../../../src/detection/pan.js';
import { UPI_HANDLES } from '../../../src/detection/upi.js';
import { createRng } from '../../../src/synthetic/rng.js';
import { pan, PAN_ENTITY_CODES } from '../../../src/synthetic/values.js';
import { compose } from '../../support/compose.js';
import { assertPropertyQuietly, seedArb } from '../../support/quiet-property.js';

const rng = createRng(4242);

const panAt = (span: { start: number; end: number }, validated = true, context = false) => ({
  type: 'PAN',
  ...span,
  validated,
  context,
});

describe('isValidPan', () => {
  it('accepts all ten holder-type codes as the 4th letter', () => {
    expect([...'PCHFATBLJG'].sort()).toEqual([...PAN_ENTITY_CODES].sort());
    for (const code of PAN_ENTITY_CODES) expect(isValidPan(`ABC${code}E1234F`)).toBe(true);
  });

  it.each([
    ['a 4th letter that is not a holder type', 'ABCDE1234F'],
    ['4 letters first', 'ABCP12345F'],
    ['5 digits', 'ABCPE12345'],
    ['a digit at the end', 'ABCPE12349'],
    ['too short', 'ABCPE1234'],
  ])('rejects %s (%s)', (_name, value) => {
    expect(isValidPan(value)).toBe(false);
  });

  it('accepts generated PANs in upper and lower case', () => {
    assertPropertyQuietly(
      fc.property(seedArb, (seed) => {
        const p = pan(createRng(seed));
        return isValidPan(p) && isValidPan(p.toLowerCase());
      }),
    );
  });
});

describe('PAN detection', () => {
  it('finds a valid PAN', () => {
    const { text, spans } = compose`Tax id ${pan(rng)} on file.`;
    expect(detect(text)).toEqual([panAt(spans[0]!)]);
  });

  it('finds one typed in lower case', () => {
    const { text, spans } = compose`tax id ${pan(rng).toLowerCase()} on file`;
    expect(detect(text)).toEqual([panAt(spans[0]!)]);
  });

  it('records context next to "PAN"', () => {
    const { text, spans } = compose`PAN: ${pan(rng)}`;
    expect(detect(text)).toEqual([panAt(spans[0]!, true, true)]);
  });

  it('finds one inside brackets, quotes or a URL path', () => {
    for (const [open, close] of [
      ['(', ')'],
      ['"', '"'],
      ['https://portal.example/u/', '/view'],
    ]) {
      const { text, spans } = compose`${open!}${pan(rng)}${close!}`;
      expect(detect(text)).toEqual([panAt(spans[1]!)]);
    }
  });

  describe('unvalidated: accepted only with a keyword', () => {
    it('an unknown 4th letter is dropped without context ...', () => {
      expect(detect('Code ABCDE1234F applied')).toEqual([]);
    });

    it('... and kept, unvalidated, next to "PAN" or "पैन"', () => {
      const english = compose`PAN ${'ABCDE1234F'}`;
      expect(detect(english.text)).toEqual([panAt(english.spans[0]!, false, true)]);
      const hindi = compose`पैन: ${'abcxe1234f'}`;
      expect(detect(hindi.text)).toEqual([panAt(hindi.spans[0]!, false, true)]);
    });
  });

  describe('tricky negatives', () => {
    it('ignores a PAN glued to letters, digits or an underscore', () => {
      const p = pan(rng);
      expect(detect(`X${p}`)).toEqual([]);
      expect(detect(`${p}9`)).toEqual([]);
      expect(detect(`key_${p}`)).toEqual([]);
    });

    it('ignores PAN-shaped pieces of longer tokens', () => {
      expect(detect('ref ABCDEF1234GH')).toEqual([]);
    });

    // Bug-log 27: a PAN glued to "@" won over the email (validated beats
    // unvalidated, ADR-003) and the domain was sent.
    it('a PAN glued to "@" is part of the address: the email or UPI ID is covered whole', () => {
      const handle = [...UPI_HANDLES][0]!;
      assertPropertyQuietly(
        fc.property(seedArb, (seed) => {
          const p = pan(createRng(seed));
          return [
            [`${p}@example.com`, 'EMAIL'],
            [`x.${p}@example.com`, 'EMAIL'],
            [`${p.toLowerCase()}@${handle}`, 'UPI'],
          ].every(([text, type]) => {
            const found = detect(`mail ${text!} now`);
            return (
              found.length === 1 &&
              found[0]!.type === type &&
              found[0]!.start === 5 &&
              found[0]!.end === 5 + text!.length
            );
          });
        }),
      );
    });

    // Mutation P1 (the "@" before a PAN) survived the test above: every
    // address there has the PAN before its "@". Here it comes after.
    it('a PAN right after "@" is part of the address: a domain label or a UPI handle', () => {
      assertPropertyQuietly(
        fc.property(seedArb, (seed) => {
          const p = pan(createRng(seed));
          return [
            [`x@${p}.example.com`, 'EMAIL', `mail x@${p}.example.com now`],
            [`me@${p.toLowerCase()}`, 'UPI', `UPI me@${p.toLowerCase()} now`],
          ].every(([value, type, text]) => {
            const found = detect(text!);
            const start = text!.indexOf(value!);
            return (
              found.length === 1 &&
              found[0]!.type === type &&
              found[0]!.start === start &&
              found[0]!.end === start + value!.length
            );
          });
        }),
      );
    });

    it('a PAN then a dot and more before the "@" is part of the email (ADR-029 containing span)', () => {
      const { text, spans } = compose`mail ${`${pan(rng)}.x@example.com`} now`;
      expect(detect(text)).toEqual([
        { type: 'EMAIL', ...spans[0]!, validated: false, context: false },
      ]);
    });
  });

  it('finds generated PANs', () => {
    assertPropertyQuietly(
      fc.property(seedArb, (seed) => {
        const { text, spans } = compose`Holder ${pan(createRng(seed))}, thanks`;
        const found = detect(text);
        return (
          found.length === 1 &&
          found[0]!.type === 'PAN' &&
          found[0]!.validated &&
          found[0]!.start === spans[0]!.start
        );
      }),
    );
  });
});

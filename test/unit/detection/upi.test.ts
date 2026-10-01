// UPI IDs (ADR-024): validated by a known handle, otherwise only with a
// keyword; never taking an email's text, never giving it away.
//
// No UPI ID is written whole in this file (ADR-021, ADR-009): one typed at a
// real handle could be somebody's. Every ID is put together at run time from
// a generated name and a handle, stays in memory, and is compared as offsets
// or booleans. repo-hygiene.test.ts checks that no file holds one.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { detect } from '../../../src/detection/detect.js';
import { UPI_HANDLES, upiCandidates } from '../../../src/detection/upi.js';
import { upiId } from '../../../src/synthetic/identifiers.js';
import { obfuscate, styleDigits } from '../../../src/synthetic/obfuscate.js';
import { createRng, type Rng } from '../../../src/synthetic/rng.js';
import { email, groupDigits, indianMobile } from '../../../src/synthetic/values.js';
import { compose } from '../../support/compose.js';
import { growthRatio, MAX_GROWTH_RATIO } from '../../support/linear-time.js';
import { assertPropertyQuietly, seedArb } from '../../support/quiet-property.js';

const rng = createRng(20261001);

/** A generated name part (what goes before the "@"). */
const nameOf = (r: Rng = rng): string => upiId(r, 'name').split('@')[0]!;
/** A generated name at `handle`. */
const at = (handle: string, r: Rng = rng): string => `${nameOf(r)}@${handle}`;
/** A handle that is on no list. */
const UNKNOWN = 'zzqpay';

const upi = (span: { start: number; end: number }, validated = true, context = false) => ({
  type: 'UPI',
  ...span,
  validated,
  context,
});

/** Full-width forms of printable ASCII (U+FF01 to U+FF5E). */
const fullWidth = (s: string): string =>
  s.replace(/[!-~]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0));

describe('UPI IDs at a known handle: validated, no keyword needed', () => {
  it('finds every generated name at a known handle, exactly where it is', () => {
    assertPropertyQuietly(
      fc.property(seedArb, (seed) => {
        const { text, spans } = compose`Send it to ${upiId(createRng(seed), 'name')} please`;
        const found = detect(text);
        return (
          found.length === 1 &&
          found[0]!.type === 'UPI' &&
          found[0]!.validated &&
          found[0]!.start === spans[0]!.start &&
          found[0]!.end === spans[0]!.end
        );
      }),
      { numRuns: 1000 },
    );
  });

  it('finds a mobile number at a known handle as one UPI ID: no phone, no safety-net number', () => {
    assertPropertyQuietly(
      fc.property(seedArb, (seed) => {
        const { text, spans } = compose`Refund ${upiId(createRng(seed), 'mobile')} today`;
        const found = detect(text);
        return (
          found.length === 1 &&
          found[0]!.type === 'UPI' &&
          found[0]!.validated &&
          found[0]!.start === spans[0]!.start &&
          found[0]!.end === spans[0]!.end
        );
      }),
      { numRuns: 1000 },
    );
  });

  it.each(['okaxis', 'okhdfcbank', 'ybl', 'ibl', 'axl', 'paytm', 'ptyes', 'apl', 'upi', 'sbi'])(
    'the handle %s is known',
    (handle) => {
      const { text, spans } = compose`to ${at(handle)} now`;
      expect(detect(text)).toEqual([upi(spans[0]!)]);
    },
  );

  it('every listed handle is one the pattern can match: lowercase, a letter, then letters or digits', () => {
    expect(UPI_HANDLES.size).toBeGreaterThan(40);
    for (const handle of UPI_HANDLES) expect(handle).toMatch(/^[a-z][a-z0-9]*$/);
  });

  it('knows a handle in any case', () => {
    for (const id of [at('OKAXIS').toUpperCase(), at('YbL'), at('Paytm')]) {
      const { text, spans } = compose`to ${id} now`;
      expect(detect(text)).toEqual([upi(spans[0]!)]);
    }
  });

  it('a handle is the whole word after the "@": one that only starts or ends like a known one is unknown', () => {
    for (const handle of ['yblx', 'ybl2', 'xybl', 'okaxisbank']) {
      expect(detect(`to ${at(handle)} now`)).toEqual([]);
    }
  });
});

describe('UPI IDs at an unknown handle: only with a keyword', () => {
  it('is not found with no keyword (user@localhost has the same shape)', () => {
    expect(detect(`Please refund to ${at(UNKNOWN)}.`)).toEqual([]);
  });

  it.each([
    ['UPI', (v: string) => `My UPI ID is ${v}.`],
    ['VPA', (v: string) => `VPA: ${v}`],
    ['BHIM', (v: string) => `BHIM app par ${v} hai`],
    ['GPay', (v: string) => `Pay me on GPay at ${v}.`],
    ['Google Pay', (v: string) => `Google Pay: ${v}`],
    ['PhonePe', (v: string) => `PhonePe par ${v} pe bhej dena.`],
    ['Paytm', (v: string) => `Paytm karo ${v} pe`],
    ['Amazon Pay', (v: string) => `Amazon Pay ID ${v}`],
    ['यूपीआई', (v: string) => `मेरा यूपीआई ${v} है।`],
    ['the keyword after the ID', (v: string) => `${v} is my UPI`],
  ])('is found, unvalidated, with %s nearby', (_name, sentence) => {
    const id = at(UNKNOWN);
    const text = sentence(id);
    const start = text.indexOf(id);
    expect(detect(text)).toEqual([upi({ start, end: start + id.length }, false, true)]);
  });

  it('a handle starts with a letter: prices written with "@" are not IDs, even after "UPI"', () => {
    expect(detect('UPI se pay kiya: tomatoes 2kg@40, onions 1kg@30')).toEqual([]);
  });

  it('a keyword further than 40 characters away does not count', () => {
    expect(detect(`UPI.${' '.repeat(45)}${at(UNKNOWN)}`)).toEqual([]);
  });

  it('"phone pe" is not a keyword: in Hinglish it also means "on the phone"', () => {
    expect(detect(`Phone pe ${at(UNKNOWN)} bata diya`)).toEqual([]);
  });
});

describe('UPI IDs and email addresses never take each other’s text', () => {
  it('a generated email is always one email, even right after "UPI"', () => {
    assertPropertyQuietly(
      fc.property(seedArb, (seed) => {
        const { text, spans } = compose`UPI ID or email: ${email(createRng(seed))}`;
        const found = detect(text);
        return (
          found.length === 1 &&
          found[0]!.type === 'EMAIL' &&
          found[0]!.start === spans[0]!.start &&
          found[0]!.end === spans[0]!.end
        );
      }),
      { numRuns: 1000 },
    );
  });

  it.each([
    ['a known handle as the domain', (n: string) => `${n}@okaxis.com`],
    ['a known handle with a country domain', (n: string) => `${n}@paytm.co.in`],
    ['a known handle with a hyphen in the label', (n: string) => `${n}@ybl-pay.example`],
    ['a known handle in upper case', (n: string) => `${n}@UPI.EXAMPLE`],
  ])('an address with %s is one email, whole', (_name, make) => {
    const { text, spans } = compose`Mail ${make(nameOf())} today`;
    expect(detect(text)).toEqual([
      { type: 'EMAIL', ...spans[0]!, validated: false, context: false },
    ]);
  });

  it('offers no candidate at all for an email address, whatever its first label', () => {
    // Checked on the detector itself: in detect() a longer email would win
    // the overlap anyway, so only here does a one-letter label show whether
    // the domain check starts at the right place.
    for (const domain of ['a.example', 'ybl.example', 'q1.b.example']) {
      expect([...upiCandidates(`UPI: ${nameOf()}@${domain}`)]).toEqual([]);
    }
  });

  it('a UPI ID before a full stop is a UPI ID, not an email: no top-level domain', () => {
    const { text, spans } = compose`My UPI ID is ${at('okaxis')}.`;
    expect(detect(text)).toEqual([upi(spans[0]!, true, true)]);
  });

  it('a UPI ID and an email in one sentence are one of each', () => {
    const { text, spans } = compose`Pay ${at('ybl')} and mail ${email(rng)} the receipt`;
    expect(detect(text)).toEqual([
      upi(spans[0]!),
      { type: 'EMAIL', ...spans[1]!, validated: false, context: false },
    ]);
  });

  it('a UPI ID glued to the next sentence reads as an email: covered whole, wrong type (known limit)', () => {
    const id = at('okaxis');
    const text = `Pay ${id}.In future use this.`;
    expect(detect(text)).toEqual([
      { type: 'EMAIL', start: 4, end: 4 + id.length + 3, validated: false, context: false },
    ]);
  });
});

describe('what a UPI ID is made of', () => {
  it('takes dots, hyphens, underscores and digits in the name', () => {
    const { text, spans } = compose`to ${`${nameOf()}_${nameOf()}-7.${nameOf()}`}@ybl now`;
    expect(detect(text)).toEqual([upi({ start: spans[0]!.start, end: spans[0]!.end + 4 })]);
  });

  it('takes a stray dot or hyphen before the name with it (never short)', () => {
    const id = at('ybl');
    expect(detect(`x .${id} y`)).toEqual([upi({ start: 2, end: 3 + id.length })]);
    expect(detect(`x -${id} y`)).toEqual([upi({ start: 2, end: 3 + id.length })]);
  });

  it('in a UPI payment link, takes the ID and nothing around it', () => {
    const { text, spans } = compose`upi://pay?pa=${at('okicici')}&am=100&cu=INR`;
    expect(detect(text)).toEqual([upi(spans[0]!, true, true)]);
  });

  it('needs a letter or digit in the name', () => {
    for (const name of ['.', '..', '-_.', '']) expect(detect(`to ${name}@ybl now`)).toEqual([]);
    expect(detect('see @ybl and @paytm')).toEqual([]);
  });

  it('finds a full-width UPI ID and covers it in the original text', () => {
    const { text, spans } = compose`to ${fullWidth(at('okaxis'))} now`;
    expect(detect(text)).toEqual([upi(spans[0]!)]);
  });

  it('finds a UPI ID split by invisible characters, with other scripts’ digits', () => {
    assertPropertyQuietly(
      fc.property(seedArb, (seed) => {
        const r = createRng(seed);
        const { text, spans } =
          compose`to ${obfuscate(upiId(r, r.pick(['name', 'mobile'] as const)), r)} now`;
        const found = detect(text);
        return (
          found.length === 1 &&
          found[0]!.type === 'UPI' &&
          found[0]!.start === spans[0]!.start &&
          found[0]!.end === spans[0]!.end
        );
      }),
      { numRuns: 500 },
    );
  });
});

describe('a mobile number inside a UPI ID', () => {
  it('a mobile written in two groups before the "@" is covered whole (widened to the digit run)', () => {
    const mobile = groupDigits(indianMobile(rng), [5, 5], ' ');
    const { text, spans } = compose`to ${`${mobile}@ybl`} now`;
    expect(detect(text)).toEqual([upi(spans[0]!)]);
  });

  it('a mobile in Devanagari digits at a known handle is one UPI ID', () => {
    const { text, spans } = compose`to ${styleDigits(upiId(rng, 'mobile'), 'devanagari')} now`;
    expect(detect(text)).toEqual([upi(spans[0]!)]);
  });

  it('a mobile then a name at a known handle is one UPI ID: the longer validated span wins', () => {
    const { text, spans } = compose`to ${`${indianMobile(rng)}.${nameOf()}@ybl`} now`;
    expect(detect(text)).toEqual([upi(spans[0]!)]);
  });

  it('a mobile then a name at an unknown handle is one UPI ID, near a keyword (ADR-029 containing span)', () => {
    const mobile = indianMobile(rng);
    const { text, spans } = compose`UPI: ${`${mobile}.${nameOf()}@${UNKNOWN}`} ok`;
    expect(detect(text)).toEqual([{ type: 'UPI', ...spans[0]!, validated: false, context: true }]);
  });

  it('a mobile at an unknown handle with no keyword: the safety net takes the digits, the handle is sent (known limit)', () => {
    const mobile = indianMobile(rng);
    const { text, spans } = compose`to ${mobile}@${UNKNOWN} now`;
    expect(detect(text)).toEqual([
      { type: 'NUMBER', ...spans[0]!, validated: false, context: false },
    ]);
  });
});

// Each case makes the input 4 times longer and checks the time grows about
// 4 times, not 16 (test/support/linear-time.ts).
describe('UPI IDs: linear time', () => {
  it.each([
    ['a long name with no "@"', (n: number) => 'a.'.repeat(n / 2)],
    ['names and "@" with no handle', (n: number) => 'a@-'.repeat(n / 3)],
    // Handles on no list: a known one would make these UPI IDs typed in a
    // file (repo-hygiene.test.ts; bug-log 26). Speed does not depend on it.
    ['IDs chained by "@"', (n: number) => 'a@zzq@'.repeat(n / 6)],
    ['IDs each followed by a dot', (n: number) => 'a@zzq.'.repeat(n / 6)],
    ['handles with short domain-like tails', (n: number) => 'a@b.cd.e '.repeat(n / 9)],
    ['one handle with a long domain-like tail', (n: number) => `a@${'b.'.repeat(n / 2)}`],
    ['one handle with a long hyphenated tail', (n: number) => `a@${'b-'.repeat(n / 2)}`],
  ])('scans %s in linear time', (_name, make) => {
    expect(growthRatio(make, 25_000, detect)).toBeLessThan(MAX_GROWTH_RATIO);
  });
});

// ADR-029: found at every "@", so two IDs glued by a hyphen are both found.
describe('UPI: glued IDs', () => {
  const handle = [...UPI_HANDLES][0]!;

  it('finds both IDs of "<name>@<handle>-<name>@<handle>"; every letter and digit is covered', () => {
    // Names without a dot: with one, the first handle and the second name
    // read as an email domain ("<handle>-a.b"), a reading tested elsewhere.
    const { text, spans } = compose`pay ${`asha@${handle}`}-${`ravi@${handle}`} now`;
    expect([...upiCandidates(text)]).toHaveLength(2);
    // The longer reading (the second name starts at the first handle) wins;
    // the first ID's name is kept as what is left over.
    const found = detect(text).filter((d) => d.type === 'UPI');
    const covered = spans.every((s) =>
      [...text.slice(s.start, s.end)].every(
        (ch, i) =>
          !/[a-z0-9]/i.test(ch) || found.some((d) => d.start <= s.start + i && s.start + i < d.end),
      ),
    );
    expect(covered).toBe(true);
  });

  it('reads glued IDs in linear time', () => {
    const unit = `ab@${handle}-`;
    const make = (n: number): string => unit.repeat(Math.ceil(n / unit.length));
    expect(growthRatio(make, 25_000, detect)).toBeLessThan(MAX_GROWTH_RATIO);
  });
});

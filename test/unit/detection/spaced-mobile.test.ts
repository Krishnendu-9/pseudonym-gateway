// Spaced mobiles beside other digit groups (bug-log 34 and 37, ADR-027).
//
// Indian mobiles have no fictional range, so they are generated at run time
// and never printed (ADR-009): every expectation compares offsets and flags.
// Amounts are 5-digit numbers starting 1-5, which can never be a mobile.

import { describe, expect, it } from 'vitest';
import { detect } from '../../../src/detection/detect.js';
import type { Span } from '../../../src/detection/normalise.js';
import { spacedMobileCandidates } from '../../../src/detection/spaced-mobile.js';
import { createRng } from '../../../src/synthetic/rng.js';
import { aadhaar, groupDigits, indianMobile } from '../../../src/synthetic/values.js';
import { compose } from '../../support/compose.js';

const rng = createRng(3434);
const mobile = (): string => groupDigits(indianMobile(rng), [5, 5], ' ');
const amount = (): string => String(rng.int(10000, 59999));

/** For each span: is it inside one PHONE detection? */
const inPhone = (text: string, spans: readonly Span[]): boolean[] => {
  const found = detect(text).filter((d) => d.type === 'PHONE');
  return spans.map((s) => found.some((d) => d.start <= s.start && s.end <= d.end));
};

/** The candidates as [start, end, validated]. */
const candidates = (text: string): [number, number, boolean][] =>
  [...spacedMobileCandidates(text)].map((c) => [c.start, c.end, c.validated]);

describe('a spaced mobile with digits beside it (bug-log 34)', () => {
  it.each([
    ['another spaced mobile, a space between', (a: string, b: string) => compose`${a} ${b}`],
    ['another spaced mobile, two spaces', (a: string, b: string) => compose`${a}  ${b}`],
    ['another spaced mobile, a hyphen', (a: string, b: string) => compose`${a}-${b}`],
    ['two more, all spaced', (a: string, b: string) => compose`${a} ${b} ${mobile()}`],
  ])('is found next to %s, without a keyword', (_name, make) => {
    const { text, spans } = make(mobile(), mobile());
    const shifted = spans.map((s) => ({ start: s.start + 9, end: s.end + 9 }));
    expect(inPhone(`Numbers: ${text}`, shifted)).toEqual(shifted.map(() => true));
  });

  it.each([
    ['a lone digit before it (bug-log 32)', (m: string) => compose`Room 3 ${m} is my number.`],
    ['a PIN code after it', (m: string) => compose`Contact ${m} 411038 Pune.`],
    ['a 5-digit group after it', (m: string) => compose`Shop ${m} ${amount()} Pune.`],
    ['"24x7" after it', (m: string) => compose`Helpline ${m} 24x7.`],
    ['"+91" before it and "24x7" after it', (m: string) => compose`Helpline +91 ${m} 24x7.`],
    ['a small number after it', (m: string) => compose`${m} 9 baje ke baad.`],
  ])('is found with %s, without a keyword', (_name, make) => {
    const { text, spans } = make(mobile());
    expect(inPhone(text, [spans[0]!])).toEqual([true]);
  });

  it('is a validated candidate on its own line, and so is each pair of a run', () => {
    const { text, spans } = compose`${mobile()} ${mobile()} ${mobile()}`;
    expect(candidates(text).filter((c) => c[2])).toEqual(
      expect.arrayContaining(spans.map((s) => [s.start, s.end, true])),
    );
  });

  it('a kept address before it goes with it: the run is widened as a whole', () => {
    // 127.0.0.1 is left as written on its own (ADR-026), but here it is
    // part of the same digit run as the mobile, and widening takes the run.
    const { text, spans } = compose`curl ${'127.0.0.1'} ${mobile()}`;
    expect(detect(text).map((d) => [d.type, d.start, d.end])).toEqual([
      ['PHONE', spans[0]!.start, spans[1]!.end],
    ]);
  });

  it.each([
    ['a pair starting 1-5', () => `${amount()} ${amount()} ${amount()}`],
    ['a mobile written alone (libphonenumber finds it)', () => mobile()],
    ['a pair glued to a letter before it', () => `x${mobile()} 7`],
    ['groups of 4 + 6 digits', () => `3 ${indianMobile(rng).replace(/^(.{4})/, '$1 ')}`],
  ])('yields nothing for %s', (_name, make) => {
    expect(candidates(make())).toEqual([]);
  });
});

describe('tables (ADR-027)', () => {
  const sheet = (rows: number, gap = ' '): { text: string; spans: Span[] } => {
    let text = 'Name | Phone | Other\n';
    const spans: Span[] = [];
    for (let r = 0; r < rows; r++) {
      const line = `${rng.pick(['Home', 'Office', 'Shop'])} `;
      const [a, b] = [mobile(), mobile()];
      spans.push({ start: text.length + line.length, end: text.length + line.length + a.length });
      const bAt = text.length + line.length + a.length + gap.length;
      spans.push({ start: bAt, end: bAt + b.length });
      text += `${line}${a}${gap}${b}\n`;
    }
    return { text, spans };
  };

  it.each([2, 3, 6])(
    'finds every mobile of a %i-row contact sheet, each pair validated',
    (rows) => {
      const { text, spans } = sheet(rows);
      expect(inPhone(text, spans)).toEqual(spans.map(() => true));
      const own = candidates(text).filter(([start]) => spans.some((s) => s.start === start));
      expect(own.map((c) => c[2])).toEqual(spans.map(() => true));
    },
  );

  it.each([
    ['CRLF', '\r\n'],
    ['CR', '\r'],
    ['U+2028', String.fromCharCode(0x2028)],
    ['U+2029', String.fromCharCode(0x2029)],
  ])('ends a row at a %s line break, like at LF', (_name, lineBreak) => {
    // Two rows: the mobile pair (a digit after it, so it is not a whole
    // run), and amounts in the same columns. Joined on one line the amounts
    // would sit at other positions and not count against it.
    const { text, spans } =
      compose`Home ${mobile()} 7${lineBreak}Shop ${amount()} ${amount()} ${amount()}`;
    expect(candidates(text)).toEqual([[spans[0]!.start, spans[0]!.end, false]]);
  });

  it('a pair in a table of numbers needs a keyword', () => {
    const { text, spans } =
      compose`Jan ${amount()} ${amount()} ${amount()}\nFeb ${mobile()} 7\nMar ${amount()} ${amount()} ${amount()}`;
    const pair = spans[3]!;
    expect(candidates(text)).toEqual([[pair.start, pair.end, false]]);
    expect(inPhone(text, [pair])).toEqual([false]);
    expect(inPhone(`Mobile:\n${text}`, [{ start: pair.start + 8, end: pair.end + 8 }])).toEqual([
      true,
    ]);
  });

  it('only lines with 5-digit groups at the same two positions count against a pair (bug-log 37)', () => {
    const notSame = compose`Room 3 ${mobile()} is the number.\nOrder ${amount()} ${amount()} placed.`;
    expect(candidates(notSame.text)).toEqual([
      [notSame.spans[0]!.start, notSame.spans[0]!.end, true],
    ]);
    const same = compose`Room 3 ${mobile()} is the number.\nRoom 4 ${amount()} ${amount()} too.`;
    expect(candidates(same.text)).toEqual([[same.spans[0]!.start, same.spans[0]!.end, false]]);
  });

  it('ordinary lines of numbers around it do not make a table (bug-log 37)', () => {
    const lines = [
      `Order ${amount()} placed on 2026-09-28.`,
      `Flat 101, Tower 3, Pune 411038`,
      `Paid Rs ${(1_25_000).toLocaleString('en-IN')} on 12/09/2026.`,
      `Aadhaar ${groupDigits(aadhaar(rng), [4, 4, 4], ' ')} verified.`,
    ].join('\n');
    const { text, spans } = compose`Hi team,\n${lines}\nRoom 3 ${mobile()} is the number.\nThanks`;
    expect(inPhone(text, [spans[1]!])).toEqual([true]);
  });

  it('finds every mobile when one row has "+91" in front (a misaligned row)', () => {
    const { text, spans } =
      compose`Home ${mobile()} ${mobile()}\nShop +91 ${mobile()} ${mobile()}\nClinic ${mobile()} ${mobile()}`;
    expect(inPhone(text, spans)).toEqual(spans.map(() => true));
  });

  it('validates the second column on its own when a row has only one mobile', () => {
    const { text, spans } =
      compose`Home ${mobile()} ${mobile()}\nShop ${mobile()}\nClinic ${mobile()} ${mobile()}`;
    const second = [spans[1]!, spans[4]!];
    expect(candidates(text).filter(([start]) => second.some((s) => s.start === start))).toEqual(
      second.map((s) => [s.start, s.end, true]),
    );
  });

  it('known cost: a ragged table row with a pair no other line has there is redacted', () => {
    // "Q1" adds a group, so the Q1 row's last pair sits where no other row
    // has two 5-digit groups; if it is a mobile, nothing contradicts it.
    const { text, spans } =
      compose`Jan ${amount()} ${amount()} ${amount()}\nQ1 ${amount()} ${mobile()}\nFeb ${amount()} ${amount()} ${amount()}`;
    expect(inPhone(text, [spans[4]!])).toEqual([true]);
  });

  it('known limit: amounts with commas are not digit groups of five', () => {
    const text = ['65,000 72,000 81,500', '1,25,000 2,40,000 95,000'].join('\n');
    expect(detect(text)).toEqual([]);
  });

  it('is found after a token ending in a digit and "x" (bug-log 36)', () => {
    const { text, spans } = compose`Ref Room1X ${mobile()} please.`;
    expect(inPhone(text, [spans[0]!])).toEqual([true]);
  });
});

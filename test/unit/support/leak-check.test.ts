// The no-leak and canary tests are only as strong as leakedForm(): these
// cases show it finds a value in each form, and does not invent a match
// from unrelated digits. Values here are hand-written or published test
// numbers (4111 1111 1111 1111), never generated.

import { describe, expect, it } from 'vitest';
import { expandCaptured, leakedForm } from '../../support/leak-check.js';

const CARD = '4111 1111 1111 1111';
const ZWSP = String.fromCharCode(0x200b);

describe('leakedForm', () => {
  it('raw: exactly as planted', () => {
    expect(leakedForm(`sent: ${CARD}.`, CARD)).toBe('raw');
  });

  it('lowercased', () => {
    expect(leakedForm('pan abcpe1234f here', 'ABCPE1234F')).toBe('lowercased');
  });

  it('normalised: planted in Devanagari digits, sent as ASCII', () => {
    const devanagari = CARD.replace(/[0-9]/g, (d) => String.fromCharCode(0x0966 + Number(d)));
    expect(leakedForm(`sent: ${CARD}.`, devanagari)).toBe('normalised');
  });

  it('normalised: planted with invisible characters, sent without them', () => {
    expect(leakedForm(`sent: ${CARD}.`, CARD.split('').join(ZWSP))).toBe('normalised');
  });

  it('squashed: separators removed or changed', () => {
    expect(leakedForm('sent: 4111111111111111.', CARD)).toBe('squashed');
    expect(leakedForm('sent: 4111-1111-1111-1111.', CARD)).toBe('squashed');
    expect(leakedForm('sent: 4111.1111.1111.1111', '4111-1111-1111-1111')).toBe('squashed');
    expect(leakedForm('ASHA.K@EXAMPLE.ORG', 'asha.k@example.org')).toBe('lowercased');
    expect(leakedForm('asha k @ example org', 'asha.k@example.org')).toBe('squashed');
  });

  it('JSON-escaped text is found once expanded', () => {
    const json = JSON.stringify({ content: `x ${CARD.split('').join(ZWSP)} y` }).replace(
      new RegExp(ZWSP, 'g'),
      '\\u200b',
    );
    expect(leakedForm(json, CARD)).toBeUndefined();
    expect(leakedForm(expandCaptured(json), CARD)).toBe('normalised');
  });

  it('placeholders and unrelated digits do not run together into a match', () => {
    const sent = '[CARD_4111] [CARD_1111] 1111 then [NUMBER_1111] and 1111';
    expect(leakedForm(sent, CARD)).toBeUndefined();
    expect(leakedForm('nothing here', CARD)).toBeUndefined();
  });

  it('an empty value matches trivially; a separators-only one squashes to nothing and never does', () => {
    expect(leakedForm('anything', '')).toBe('raw');
    expect(leakedForm('anything', ' - ')).toBeUndefined();
  });
});

describe('expandCaptured', () => {
  it('adds the decoded strings and keys of each JSON line; leaves other text as it is', () => {
    const text = '{"a":"x\\u0041","k\\u0042":1}\nnot json';
    const expanded = expandCaptured(text);
    expect(expanded.startsWith(text)).toBe(true);
    expect(expanded).toContain('xA');
    expect(expanded).toContain('kB');
  });
});

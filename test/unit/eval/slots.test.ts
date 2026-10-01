import { describe, expect, it } from 'vitest';
import { SECRET_KINDS } from '../../../src/synthetic/identifiers.js';
import {
  EMAIL_CONTAINING,
  maskMarks,
  MODIFIERS,
  parseSegments,
  SECRET_CONTAINING,
  TYPE_SPECS,
} from '../../../eval/slots.js';
import { PERSONAL_TYPES } from '../../../eval/types.js';

const slotsOf = (text: string): unknown[] =>
  parseSegments(text).flatMap((s) => (s.kind === 'slot' ? [s.slot] : []));
const kinds = (text: string): string[] => parseSegments(text).map((s) => s.kind);

describe('parseSegments', () => {
  it('splits text and slots in order, with offsets', () => {
    expect(parseSegments('a {{PAN}} b {{EMAIL=x@example.com}}')).toEqual([
      { kind: 'text', text: 'a ', offset: 0 },
      {
        kind: 'slot',
        slot: { type: 'PAN', typo: false, modifiers: [] },
        offset: 2,
        raw: '{{PAN}}',
      },
      { kind: 'text', text: ' b ', offset: 9 },
      {
        kind: 'slot',
        slot: { type: 'EMAIL', typo: false, modifiers: [], literal: 'x@example.com' },
        offset: 12,
        raw: '{{EMAIL=x@example.com}}',
      },
    ]);
  });

  it('text with no slot is one segment; empty text is none', () => {
    expect(parseSegments('plain')).toEqual([{ kind: 'text', text: 'plain', offset: 0 }]);
    expect(parseSegments('')).toEqual([]);
  });

  it.each([
    ['{{AADHAAR}}', { type: 'AADHAAR', typo: false, modifiers: [] }],
    [
      '{{AADHAAR:#### ####\n####}}',
      { type: 'AADHAAR', typo: false, modifiers: [], mask: '#### ####\n####' },
    ],
    ['{{AADHAAR!:####}}', { type: 'AADHAAR', typo: true, modifiers: [], mask: '####' }],
    [
      '{{CARD.amex:#### ###### #####}}',
      { type: 'CARD', variant: 'amex', typo: false, modifiers: [], mask: '#### ###### #####' },
    ],
    [
      '{{AADHAAR@a:####}}',
      { type: 'AADHAAR', typo: false, name: 'a', modifiers: [], mask: '####' },
    ],
    ['{{@a:####}}', { typo: false, name: 'a', modifiers: [], mask: '####' }],
    [
      '{{PHONE|devanagari|invisible:+91 #####}}',
      { type: 'PHONE', typo: false, modifiers: ['devanagari', 'invisible'], mask: '+91 #####' },
    ],
    ['{{PAN|lower}}', { type: 'PAN', typo: false, modifiers: ['lower'] }],
    [
      '{{NOT.order:ORD-??-###}}',
      { type: 'NOT', variant: 'order', typo: false, modifiers: [], mask: 'ORD-??-###' },
    ],
    ['{{SECRET.github}}', { type: 'SECRET', variant: 'github', typo: false, modifiers: [] }],
    [
      '{{PERSON=Priya Sharma}}',
      { type: 'PERSON', typo: false, modifiers: [], literal: 'Priya Sharma' },
    ],
    // The first sign decides; the rest is the body, signs and all.
    ['{{NOT=a:b=c}}', { type: 'NOT', typo: false, modifiers: [], literal: 'a:b=c' }],
    ['{{NOT:a=b:c}}', { type: 'NOT', typo: false, modifiers: [], mask: 'a=b:c' }],
    ['{{NUMBER:}}', { type: 'NUMBER', typo: false, modifiers: [], mask: '' }],
  ])('%s', (text, slot) => {
    expect(slotsOf(text)).toEqual([slot]);
  });

  it.each([
    ['an unknown type', '{{AADHAR}}'],
    ['a lower-case type', '{{pan}}'],
    ['nothing inside', '{{}}'],
    ['a space after the brackets', '{{ PAN }}'],
    ['a variant with no type', '{{.amex}}'],
    ['a bad name', '{{PAN@A1}}'],
    ['an upper-case modifier', '{{PAN|LOWER}}'],
  ])('%s is broken, not a slot', (_name, text) => {
    expect(parseSegments(text)).toEqual([{ kind: 'broken', offset: 0, raw: text }]);
  });

  it('an opening with no closing breaks the rest of the text', () => {
    expect(parseSegments('ok {{PAN and more')).toEqual([
      { kind: 'text', text: 'ok ', offset: 0 },
      { kind: 'broken', offset: 3, raw: '{{PAN and more' },
    ]);
    expect(kinds('{{PAN}} then {{')).toEqual(['slot', 'text', 'broken']);
    expect(kinds('{{ {{PAN}}')).toEqual(['broken']);
    expect(parseSegments('{{PAN')).toEqual([{ kind: 'broken', offset: 0, raw: '{{PAN' }]);
  });
});

describe('the type table', () => {
  it('covers every personal type and NOT', () => {
    expect(Object.keys(TYPE_SPECS).sort()).toEqual([...PERSONAL_TYPES, 'NOT'].sort());
  });

  it('knows how long each fixed-length value is', () => {
    const lengths = Object.fromEntries(
      Object.entries(TYPE_SPECS).flatMap(([type, spec]) =>
        spec.length ? [[type, spec.length(undefined)]] : [],
      ),
    );
    expect(lengths).toEqual({
      AADHAAR: 12,
      CARD: 16,
      PAN: 10,
      PHONE: 10,
      IFSC: 11,
      PASSPORT: 8,
      VOTER: 10,
    });
    expect(TYPE_SPECS.CARD.length!('amex')).toBe(15);
  });

  it('SECRET needs a kind, and knows every kind the generator has, and the containing ones', () => {
    expect(TYPE_SPECS.SECRET.variantRequired).toBe(true);
    expect(TYPE_SPECS.SECRET.variants).toEqual([...SECRET_KINDS, ...SECRET_CONTAINING]);
  });

  it('the containing variants (Phase 5c): EMAIL and UPI ones, DOB generated whole', () => {
    expect(TYPE_SPECS.EMAIL.variants).toEqual(EMAIL_CONTAINING);
    expect(TYPE_SPECS.UPI.variants).toContain('mobile-name');
    expect(TYPE_SPECS.DOB.generated).toEqual({ mask: 'never' });
  });

  it('only NOT reads "?" as a generated character', () => {
    expect('a#?'.replace(maskMarks('NOT'), '*')).toBe('a**');
    expect('a#?'.replace(maskMarks('NUMBER'), '*')).toBe('a*?');
  });

  it('lists the modifiers', () => {
    expect([...MODIFIERS].sort()).toEqual(
      [
        'arabic',
        'bengali',
        'devanagari',
        'fullwidth',
        'gujarati',
        'invisible',
        'lower',
        'mathbold',
        'tamil',
        'upper',
      ].sort(),
    );
  });
});

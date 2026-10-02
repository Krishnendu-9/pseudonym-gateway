// The lint for cases written in the held-out file's format. Two things matter most: nothing typed may
// look like a real personal value, and a problem never quotes the file.
//
// No test here contains a value either: typed-digit cases are built from
// repeated digits at run time, and literals use the ranges the lint allows.

import { describe, expect, it } from 'vitest';
import { parseCases } from '../../../eval/format.js';
import { isSafeIp, lintCases, MAX_TYPED_DIGITS } from '../../../eval/lint.js';

const problemsIn = (...messages: string[]) =>
  lintCases(parseCases(`=== T | t\n${messages.map((m) => `@user\n${m}`).join('\n')}`).cases);
const rules = (...messages: string[]): string[] => problemsIn(...messages).map((p) => p.rule);

const digits = (count: number): string => '1234567890'.repeat(3).slice(0, count);

describe('lintCases: slots that are fine', () => {
  it.each([
    'no slots at all, just text with a date 28/09/2026 and Rs 1,25,000',
    '{{AADHAAR}} {{CARD}} {{PAN}} {{PHONE}} {{EMAIL}} {{IFSC}} {{UPI}}',
    '{{AADHAAR:#### #### ####}} {{AADHAAR:####\n####\n####}}',
    '{{AADHAAR!:############}} {{CARD!}} {{PAN!:##### #### #}}',
    '{{CARD:####-####-####-####}} {{CARD.amex:#### ###### #####}}',
    '{{PHONE:+91 #####-#####}} {{PHONE|devanagari|invisible}}',
    '{{NUMBER:#########}} {{NUMBER:A/C ####-####-####}}',
    '{{IFSC.unknown}} {{IFSC:####-#######}} {{IFSC=SBIN0001234}}',
    '{{UPI.mobile}} {{UPI.unknown}} {{UPI|upper}}',
    '{{SECRET.github}} {{SECRET.password}} {{SECRET.jwt}}',
    '{{PERSON=Priya Sharma}} {{PERSON=प्रिया शर्मा}}',
    '{{EMAIL=priya.sharma@example.com}} {{EMAIL=a@b.example.org}} {{EMAIL=x@shop.test}}',
    '{{EMAIL=priya at example dot com}}',
    '{{IP=203.0.113.195}} {{IP=2001:db8::1}} {{IP=192.168.100.200}} {{IP=::1}}',
    `{{NOT=192.168.100.200}} {{NOT=noreply@example.com}} {{NOT=${[1, 2, 3, 4].join('.')}}}`,
    '{{NOT:ORD-######-##}} {{NOT.sku:?????####?}} {{NOT:2026-09-2# 14:30}}',
    '{{CARD=4111 1111 1111 1111}} {{CARD=4242-4242-4242-4242}} {{CARD|devanagari=4111111111111111}}',
    '{{PHONE=+1 202-555-0143}} {{PHONE=+44 7700 900123}} {{PHONE=020 7946 0123}} {{PHONE=0491 570 006}}',
    '{{AADHAAR@a:#### ####}} and later {{@a:####}}',
    '{{NUMBER@n:####}} {{@n:#####}}',
  ])('%s', (text) => {
    expect(problemsIn(text)).toEqual([]);
  });

  it('a value may continue in a later message of the same case', () => {
    expect(problemsIn('{{CARD@c:#### ####}}', 'and {{@c:#### ####}}')).toEqual([]);
  });
});

describe('lintCases: slots that are wrong', () => {
  it.each([
    ['bad-slot', '{{AADHAR}}'],
    ['bad-slot', 'never closed {{PAN'],
    ['unknown-variant', '{{CARD.visa}}'],
    ['unknown-variant', '{{AADHAAR.x}}'],
    ['unknown-variant', '{{SECRET.nope}}'],
    ['variant-required', '{{SECRET}}'],
    ['typo-not-supported', '{{PHONE!}}'],
    ['typo-not-supported', '{{CARD.amex!}}'],
    ['typo-not-supported', '{{CARD!=4111 1111 1111 1111}}'],
    ['unknown-modifier', '{{PAN|shouting}}'],
    ['literal-not-allowed', '{{AADHAAR=whatever}}'],
    ['literal-not-allowed', '{{SECRET.github=abc}}'],
    ['literal-not-allowed', '{{UPI=rahul@example}}'],
    ['literal-required', '{{IP}}'],
    ['literal-required', '{{PERSON}}'],
    ['literal-required', '{{IP:###.###}}'],
    ['empty-literal', '{{PERSON= }}'],
    ['mask-required', '{{NUMBER}}'],
    ['mask-required', '{{NOT}}'],
    ['mask-not-allowed', '{{EMAIL:####}}'],
    ['mask-not-allowed', '{{UPI:####}}'],
    ['empty-mask', '{{NUMBER:}}'],
    ['empty-mask', '{{NOT:ORD}}'],
    ['too-many-marks', '{{AADHAAR:#############}}'],
    ['too-many-marks', '{{CARD.amex:################}}'],
    ['too-few-marks', '{{AADHAAR:#### ####}}'],
    ['too-few-marks', '{{IFSC:####}}'],
    ['address-in-mask', '{{NUMBER:####@####}}'],
    ['name-not-supported', '{{EMAIL@a}}'],
    ['name-not-supported', '{{CARD@a=4111 1111 1111 1111}}'],
    ['duplicate-name', '{{PAN@a}} {{PAN@a}}'],
    ['unknown-name', '{{@a:####}}'],
    ['bad-continuation', '{{PAN@a:#####}} {{@a}}'],
    ['bad-continuation', '{{PAN@a:#####}} {{@a|lower:#####}}'],
    ['empty-mask', '{{PAN@a:#####}} {{@a:-}} {{@a:#####}}'],
    ['too-many-marks', '{{AADHAAR@a:########}} {{@a:#####}}'],
    ['unfinished-value', '{{AADHAAR@a:########}} {{@a:###}}'],
    ['unfinished-value', '{{AADHAAR@a:########}}'],
  ])('%s: %s', (rule, text) => {
    expect(rules(text)).toContain(rule);
  });

  it('a name belongs to its case: the next case cannot continue it', () => {
    const { cases } = parseCases(
      '=== A | t\n@user\n{{PAN@a:#####}} {{@a:#####}}\n=== B | t\n@user\n{{@a:#####}}',
    );
    expect(lintCases(cases).map((p) => [p.caseId, p.rule])).toEqual([['B', 'unknown-name']]);
  });
});

describe('lintCases: nothing typed may look like a personal value', () => {
  it(`allows ${MAX_TYPED_DIGITS} typed digits in a row and rejects one more`, () => {
    expect(rules(`ref ${digits(MAX_TYPED_DIGITS)} ok`)).toEqual([]);
    expect(rules(`ref ${digits(MAX_TYPED_DIGITS + 1)} ok`)).toEqual(['typed-digits']);
  });

  it.each([
    ['unbroken', digits(10)],
    ['grouped with spaces', `${digits(4)} ${digits(4)} ${digits(4)}`],
    ['grouped with hyphens', `${digits(5)}-${digits(5)}`],
    ['grouped with dots', `${digits(3)}.${digits(3)}.${digits(4)}`],
    ['with a country code', `+91 ${digits(5)} ${digits(5)}`],
    ['in brackets', `(${digits(3)}) ${digits(3)}-${digits(4)}`],
    ['with an en dash', `${digits(5)}–${digits(5)}`],
    ['with three separators', `${digits(5)} - ${digits(5)}`],
    ['in Devanagari digits', '१२३४५६७८९०'],
    ['in full-width digits', '１'.repeat(10)],
    ['inside a literal', `{{EMAIL=user.${digits(10)}@example.com}}`],
    ['inside a PERSON-free literal', `{{IFSC=SBIN${digits(11)}}}`],
    ['as the fixed part of a mask', `{{NOT:${digits(9)}-###}}`],
    ['across a mask, around its fixed text', `{{NUMBER:${digits(5)} ${digits(5)}#}}`],
  ])('rejects a long typed number: %s', (_name, text) => {
    expect(rules(text)).toContain('typed-digits');
  });

  it.each([
    ['a date and a time', '28/09/2026 14:30'],
    ['an ISO date', '2026-09-28'],
    ['an amount with commas', 'Rs 12,34,56,789'],
    ['numbers on two lines', `${digits(6)}\n${digits(6)}`],
    ['numbers four characters apart', `${digits(6)}    ${digits(6)}`],
    ['numbers with a word between', `${digits(6)} and ${digits(6)}`],
    ['typed digits broken by generated ones', `{{NOT:${digits(8)}#${digits(8)}}}`],
    ['typed digits on both sides of a slot', `${digits(8)}{{PAN}}${digits(8)}`],
    ['a version string', 'version 10.2.33.4'],
  ])('allows %s', (_name, text) => {
    expect(rules(text)).toEqual([]);
  });

  it('an ISO date with a time is a long typed number: break it with a #', () => {
    expect(rules('2026-09-28 14:30')).toEqual(['typed-digits']);
    expect(rules('{{NOT:2026-09-2# 14:30}}')).toEqual([]);
  });

  // D is not a holder type, so these are PAN-shaped without being PANs.
  it.each([
    'ABCDE1234F',
    'abcde1234f',
    'code: ABCDE1234F.',
    '{{NOT=ABCDE1234F}}',
    '{{NUMBER:ABCDE1234F ###}}',
  ])('rejects a typed PAN shape: %s', (text) => {
    expect(rules(text)).toContain('typed-pan');
  });

  // Built at run time: a passport or voter ID number has no check digit, so
  // any typed one could be somebody's.
  it.each([
    ['a passport shape', `K${digits(7)}`],
    ['a voter ID shape', `abc${digits(7)}`],
    ['one in a sentence', `ID: ABC${digits(7)}.`],
    ['one typed as a lookalike', `{{NOT=K${digits(7)}}}`],
  ])('rejects %s', (_name, text) => {
    expect(rules(text)).toContain('typed-id');
  });

  it('an ID shape inside a longer token, with 8 digits, or generated, is not one', () => {
    expect(
      rules(`XK${digits(7)} K${digits(8)} ABCD${digits(7)} {{NOT:?#######}} {{NOT:INV#######}}`),
    ).toEqual([]);
  });

  it('a PAN shape inside a longer token, or with generated characters, is not one', () => {
    expect(rules('XABCDE1234F and ABCDE1234F9 and {{NOT:ABCDE####F}}')).toEqual([]);
  });

  it.each(['mail priya@example.com now', 'pay rahul@zzbank', 'x@y', 'प्रिया@उदाहरण.भारत'])(
    'rejects an address outside a slot, even at a reserved domain: %s',
    (text) => {
      expect(rules(text)).toEqual(['address-outside-slot']);
    },
  );

  it('an @ with a space beside it, or at the start of a word, is not an address', () => {
    expect(rules('meet @ 5, ping @rahul, rate: 5 @ 10')).toEqual([]);
  });

  it.each([
    ['email-not-reserved', '{{EMAIL=priya@not-reserved.zz}}'],
    ['email-not-reserved', '{{EMAIL=priya@examples.zz}}'],
    ['email-not-reserved', '{{EMAIL=priya@contest}}'],
    ['address-not-reserved', '{{NOT=noreply@company.zz}}'],
    ['address-not-reserved', '{{IFSC=a@b}}'],
    ['bad-name', '{{PERSON=Agent 47}}'],
    ['bad-name', '{{PERSON=a@example.com}}'],
    ['card-not-published', '{{CARD=4111 1111 1111 1112}}'],
    ['card-not-published', '{{CARD=card 4111 1111 1111 1111}}'],
    ['phone-not-fictional', `{{PHONE=+1 ${digits(10)}}}`],
    ['phone-not-fictional', `{{PHONE=${digits(5)} ${digits(5)}}}`],
    ['phone-not-fictional', '{{PHONE=+44 7700 900123 ext 4}}'],
    // Public addresses, put together here rather than typed (repo-hygiene.test.ts).
    ['ip-not-reserved', `{{IP=${[8, 8, 8, 8].join('.')}}}`],
    ['ip-not-reserved', `{{IP=${['2606', '4700', '', '1111'].join(':')}}}`],
    ['ip-not-reserved', '{{IP=203.0.113.256}}'],
    ['ip-not-reserved', '{{IP=not an address}}'],
  ])('%s: %s', (rule, text) => {
    expect(rules(text)).toContain(rule);
  });

  it.each([
    'sk-' + 'a'.repeat(5),
    'sk_' + 'live_' + 'x',
    'rzp_' + 'test_' + 'x',
    'ghp' + '_abc',
    'github' + '_pat_abc',
    'AKIA' + 'ABCD',
    'xoxb' + '-1',
    'AIza' + 'Sy',
    'eyJ' + 'hbGci',
    '-----BEGIN' + ' RSA PRIVATE KEY-----',
  ])('rejects a typed key shape (built at run time here): %#', (text) => {
    expect(rules(`the key is ${text} ok`)).toEqual(['typed-secret']);
  });

  it('ordinary words that contain a key prefix are fine', () => {
    expect(rules('the task-force met at the desk-top; risk_live_ test')).toEqual([]);
  });

  it('a slot with a problem of its own is not read as typed text too', () => {
    expect(rules(`{{CARD=${digits(16)}}}`)).toEqual(['card-not-published']);
  });
});

describe('lintCases: what a problem says', () => {
  it('names the case, the line of the slot and the rule, and never quotes the text', () => {
    const { cases } = parseCases(
      ['=== H7 | t', '@user', 'line three is fine', 'MARKER {{PAN:###}} and', `${digits(12)}`].join(
        '\n',
      ),
    );
    const problems = lintCases(cases);
    expect(problems.map((p) => [p.caseId, p.line, p.rule])).toEqual([
      ['H7', 4, 'too-few-marks'],
      ['H7', 5, 'typed-digits'],
    ]);
    expect(JSON.stringify(problems)).not.toMatch(/MARKER|1234/);
  });

  it('reports a slot that spans lines at the line it starts on', () => {
    const { cases } = parseCases('=== A | t\n@user\nok\n{{AADHAAR:####\n####}}');
    expect(lintCases(cases).map((p) => [p.line, p.rule])).toEqual([[4, 'too-few-marks']]);
  });
});

describe('isSafeIp', () => {
  it.each([
    '192.0.2.1',
    '198.51.100.77',
    '203.0.113.255',
    '10.0.0.1',
    '10.255.255.255',
    '127.0.0.1',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '169.254.10.10',
    '::1',
    '2001:db8::1',
    '2001:DB8:0:0:0:0:0:1',
    'fe80::1',
    'fd12:3456::1',
    'fc00::1',
    // No single host owns these (ADR-026).
    '0.0.0.0',
    '0.0.0.255',
    '224.0.0.251',
    [239, 255, 255, 250].join('.'), // passes the Aadhaar checks: never typed
    '255.255.255.0',
    '255.255.255.255',
    '::',
    'ff02::1',
    // An IPv4 address written as IPv6, judged by its IPv4 part.
    '::ffff:203.0.113.5',
    '::FFFF:10.1.2.3',
    '64:ff9b::192.0.2.33',
  ])('%s is safe', (ip) => {
    expect(isSafeIp(ip)).toBe(true);
  });

  // Public addresses next to the reserved ranges are put together here, not
  // typed: a typed one could be somebody's (repo-hygiene.test.ts).
  const dotted = (...parts: number[]): string => parts.join('.');
  it.each([
    dotted(8, 8, 8, 8),
    dotted(192, 0, 3, 1),
    dotted(172, 15, 0, 1),
    dotted(172, 32, 0, 1),
    dotted(192, 169, 1, 1),
    dotted(11, 0, 0, 1),
    dotted(223, 255, 255, 255),
    '10.0.0.256',
    '10.0.0',
    '10.0.0.1.2',
    ['2001', 'db9', '', '1'].join(':'),
    ['2606', '4700', '', '1111'].join(':'),
    `${'::'}ffff:${dotted(8, 8, 8, 8)}`,
    `${'64:ff9b'}::${dotted(11, 0, 0, 1)}`,
    '::ffff:10.1.2.300',
    '::2',
    'fe80',
    'a:b',
    ['dead', 'beef'].join('::'),
    '',
  ])('%s is not', (ip) => {
    expect(isSafeIp(ip)).toBe(false);
  });
});

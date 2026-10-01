// IP addresses (ADR-026): one type for IPv4 and IPv6, parsed by hand; which
// ranges are redacted; the forms an address is written in and what of each
// is redacted; the lookalikes; how IP sits next to PHONE, AADHAAR, NUMBER,
// SECRET, EMAIL and UPI.
//
// Addresses typed here come from the documentation, private and link-local
// ranges, which belong to nobody (repo-hygiene.test.ts checks every file).
// The few others (a carrier-grade NAT address, a version that is also a
// public address, a dotted quad that passes the Aadhaar checks) are put
// together at run time.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isValidAadhaar } from '../../../src/detection/aadhaar.js';
import { detect } from '../../../src/detection/detect.js';
import { ipCandidates, ipValueKey } from '../../../src/detection/ip.js';
import { DETECTION_TYPES } from '../../../src/detection/types.js';
import { UPI_HANDLES } from '../../../src/detection/upi.js';
import { ipAddress } from '../../../src/synthetic/identifiers.js';
import { createRng } from '../../../src/synthetic/rng.js';
import { groupDigits, indianMobile } from '../../../src/synthetic/values.js';
import { compose } from '../../support/compose.js';
import { growthRatio, MAX_GROWTH_RATIO } from '../../support/linear-time.js';
import { assertPropertyQuietly, seedArb } from '../../support/quiet-property.js';

/** Every detection as [type, text]: typed addresses only, so safe to print. */
const found = (text: string): [string, string][] =>
  detect(text).map((d) => [d.type, text.slice(d.start, d.end)]);

/** The IP candidates to redact as [text, validated], before the context policy. */
const candidates = (text: string): [string, boolean][] =>
  [...ipCandidates(text)]
    .filter((c) => !c.keep)
    .map((c) => [text.slice(c.start, c.end), c.validated]);

/** The addresses the IP detector marks as kept (no single host owns them). */
const kept = (text: string): string[] =>
  [...ipCandidates(text)].filter((c) => c.keep).map((c) => text.slice(c.start, c.end));

/** Every IP candidate, kept ones too: "not an address" means none of either kind. */
const anyCandidates = (text: string): string[] =>
  [...ipCandidates(text)].map((c) => text.slice(c.start, c.end));

/** Every detection as [type, start, end]: for text holding a generated value. */
const spansOf = (text: string): [string, number, number][] =>
  detect(text).map((d) => [d.type, d.start, d.end]);

const phoneRng = createRng(20261001);
/** A generated Indian mobile written 5 + 5 (ADR-009: never typed). */
const spacedMobile = (): string => groupDigits(indianMobile(phoneRng), [5, 5], ' ');

/** A four-part version that is also a public address, never typed in a file. */
const VERSION = [1, 2, 3, 4].join('.');
/** The SSDP multicast address: it passes the Aadhaar checks, so it is never typed. */
const SSDP = [239, 255, 255, 250].join('.');
/** An address in 100.64/10, shared by a carrier's subscribers (RFC 6598). */
const CARRIER_NAT = [100, 64, 1, 2].join('.');

describe('IPv4 addresses', () => {
  it('finds every generated address, exactly where it is, validated', () => {
    assertPropertyQuietly(
      fc.property(seedArb, (seed) => {
        const { text, spans } = compose`Login from ${ipAddress(createRng(seed))} today`;
        const d = detect(text);
        return (
          d.length === 1 &&
          d[0]!.type === 'IP' &&
          d[0]!.validated &&
          d[0]!.start === spans[0]!.start &&
          d[0]!.end === spans[0]!.end
        );
      }),
      { numRuns: 1000 },
    );
  });

  it.each([
    ['documentation (RFC 5737)', '192.0.2.1'],
    ['documentation', '198.51.100.7'],
    ['documentation', '203.0.113.5'],
    ['private 10/8', '10.20.30.40'],
    ['private 172.16/12', '172.16.5.4'],
    ['private 192.168/16', '192.168.1.10'],
    ['link-local', '169.254.10.20'],
    ['shared, carrier-grade NAT', CARRIER_NAT],
    ['the top of an octet', '10.0.0.255'],
    ['leading zeros', '192.168.001.010'],
  ])('redacts %s: %s', (_range, address) => {
    expect(found(`Host ${address} down`)).toEqual([['IP', address]]);
  });

  it.each([
    ['unspecified', '0.0.0.0'],
    ['this network (0/8, and Cisco wildcard masks)', '0.0.0.255'],
    ['loopback', '127.0.0.1'],
    ['anywhere in 127/8', '127.8.9.10'],
    ['multicast', '224.0.0.251'],
    ['multicast (SSDP)', SSDP],
    ['reserved', '240.0.0.1'],
    ['broadcast', '255.255.255.255'],
    ['a netmask', '255.255.255.0'],
  ])('keeps an address no single host owns, %s: %s (ADR-026)', (_range, address) => {
    const text = `Host ${address} down`;
    expect([candidates(text), kept(text), found(text)]).toEqual([[], [address], []]);
  });

  it('a kept address is not typed as anything else either (it would be AADHAAR, PHONE or NUMBER)', () => {
    expect(found(`Send to ${SSDP} now`)).toEqual([]);
    expect(found('Mask 255.255.255.0 set')).toEqual([]);
    expect(found('Bcast 255.255.255.255 x')).toEqual([]);
  });

  it('a kept address never costs a neighbour its detection: a phone reaching into it is redacted, address and all', () => {
    // libphonenumber reads "0 <mobile>", taking the netmask's last digit.
    const { text } = compose`255.255.255.0 ${spacedMobile()}`;
    expect(spansOf(text)).toEqual([['PHONE', 0, text.length]]);
  });

  it('a kept address changes nothing about a detection reaching into it: the same as a lone digit there', () => {
    // An unvalidated phone reading (the keyword) starts at the last digit of
    // "::1". If the kept address won the overlap among the claimed spans, the
    // safety net would take the digits joined by "(" and replace the phone.
    expect(found('mobile,::1 12345678(12345')).toEqual(found('mobile,1 12345678(12345'));
    expect(found('mobile,1 12345678(12345')).toEqual([['PHONE', '1 12345678']]);
  });

  it.each([
    ['an octet over 255', '10.0.0.256'],
    ['four digits in the last part', '10.1.2.1000'],
    ['four digits in the first part, even with a value under 256', '0010.1.2.3'],
    ['three parts', '10.1.2'],
    ['five parts', '10.1.2.3.4'],
    ['an empty part', '10.1..3'],
  ])('is not an address: %s', (_name, text) => {
    expect(anyCandidates(`Host ${text} down`)).toEqual([]);
  });

  it('ignores one glued to a letter, digit, mark or underscore', () => {
    for (const text of ['x10.1.2.3', '10.1.2.3x', '_10.1.2.3', '10.1.2.3_', '10.1.2.3́']) {
      expect([text, candidates(text)]).toEqual([text, []]);
    }
  });

  it('finds one after "@" (root@host), but not one glued to "@" after it (an email)', () => {
    expect(found('ssh root@10.1.2.3 now')).toEqual([['IP', '10.1.2.3']]);
    expect(found('mail 10.1.2.3@example.com now')).toEqual([['EMAIL', '10.1.2.3@example.com']]);
  });

  it.each([
    ['(', ')'],
    ['"', '"'],
    ['IP: ', '.'],
    ['IP ', ': blocked'],
    ['src:', ' ok'],
    ['ip=', '&x=1'],
    ['add:', ' ok'],
    ['1:', ' ok'],
    ['Host ', '...'],
  ])('finds one between %j and %j', (before, after) => {
    expect(found(`${before}10.1.2.3${after}`)).toEqual([['IP', '10.1.2.3']]);
  });

  it('an address inside a host name is not found (known limit, ADR-026)', () => {
    expect(found('See 10.1.2.3.nip.io now')).toEqual([]);
  });
});

// Point 3 of the brief: the ways an address is written, and what of each
// is redacted. Only the address; the rest names nobody.
describe('forms: only the address is redacted', () => {
  it.each([
    ['with a port', 'connect 203.0.113.5:8080 now', '203.0.113.5'],
    ['with a port and more colons', 'at 203.0.113.5:22:x', '203.0.113.5'],
    ['a network (CIDR)', 'allow 10.0.0.0/8 only', '10.0.0.0'],
    ['an interface address with its prefix', 'inet 10.1.2.3/24 up', '10.1.2.3'],
    ['inside a URL', 'open http://203.0.113.5/login', '203.0.113.5'],
    ['inside a URL with a port', 'open https://203.0.113.5:8443/x?y=1', '203.0.113.5'],
    ['IPv6 in brackets with a port', 'open [2001:db8::1]:443 now', '2001:db8::1'],
    ['IPv6 in a URL', 'open http://[2001:db8::1]:8080/x', '2001:db8::1'],
    ['compressed IPv6', 'from 2001:db8::1 today', '2001:db8::1'],
    ['an IPv6 network prefix', 'route 2001:db8:: via', '2001:db8::'],
    [
      'IPv6 in full, in capitals',
      'from 2001:0DB8:85A3:0000:0000:8A2E:0370:7334 x',
      '2001:0DB8:85A3:0000:0000:8A2E:0370:7334',
    ],
    ['link-local IPv6 with a zone', 'ping fe80::1%eth0 now', 'fe80::1'],
    ['unique local IPv6', 'host fd12:3456::1 up', 'fd12:3456::1'],
    ['IPv4-mapped IPv6', 'from ::ffff:203.0.113.5 now', '::ffff:203.0.113.5'],
    ['NAT64, the well-known prefix', 'via 64:ff9b::192.0.2.33 now', '64:ff9b::192.0.2.33'],
    ['IPv6 after a closing bracket and a colon', 'Address (IPv6):2001:db8::1 ok', '2001:db8::1'],
    ['IPv6 before a sentence colon', 'Gateway 2001:db8::1: unreachable', '2001:db8::1'],
    // "ce" of "source" is hex: the run starts inside the word, so it is read
    // from its colon, never with the "ce" in front (that is a valid address).
    ['IPv6 after a word ending in hex letters and a colon', 'source:2001:db8::1 ok', '2001:db8::1'],
  ])('%s', (_form, text, address) => {
    expect(found(text)).toEqual([['IP', address]]);
  });

  it.each([
    ['IPv6 loopback', 'curl ::1 now'],
    ['IPv6 unspecified', 'listen :: now'],
    ['IPv6 multicast', 'join ff02::1 now'],
    ['an IPv4-compatible address in 0/8', 'from ::2 now'],
    ['IPv4-mapped loopback', 'from ::ffff:127.0.0.1 now'],
  ])('keeps %s, which no single host owns, even next to an IP keyword', (_form, text) => {
    // Short-group forms like these would be found near a keyword if they
    // were not kept: the keyword is what tells the two apart.
    expect(found(text)).toEqual([]);
    expect(found(`IPv6 ${text}`)).toEqual([]);
  });

  it('an address and prefix whose digits read as a valid phone number are typed PHONE, prefix and all (known limit, ADR-026)', () => {
    // 2030113924: a longer validated phone beats the address (rule 2). Still
    // redacted; 4 of the 153 generated addresses are written this way.
    expect(found('inet 203.0.113.9/24 up')).toEqual([['PHONE', '203.0.113.9/24']]);
  });

  it('an IPv6 address after a label is found; a hex word glued by a colon goes with it (over-redaction)', () => {
    expect(found('addr:2001:db8::1 up')).toEqual([['IP', '2001:db8::1']]);
    const hexWord = 'cafe';
    expect(found(`${hexWord}:2001:db8::1 up`)).toEqual([['IP', `${hexWord}:2001:db8::1`]]);
  });
});

describe('IPv6: short groups need a keyword', () => {
  it.each([
    ['two short groups', 'a::b'],
    ['numbers around "::"', '10::20'],
    ['eight one-digit groups', '1:2:3:4:5:6:7:8'],
    ['an EUI-64 interface id in pairs', '40:17:23:ff:fe:95:61:08'],
  ])('%s (%s): unvalidated, found only near an IP keyword', (_name, address) => {
    expect(candidates(`Id ${address} here`)).toEqual([[address, false]]);
    expect(found(`Id ${address} here`)).toEqual([]);
    expect(found(`IPv6 ${address} here`)).toEqual([['IP', address]]);
    expect(detect(`inet6 ${address}`)[0]!.context).toBe(true);
  });

  it('a group of three or four hex digits, or an IPv4 part, validates it', () => {
    expect(candidates('x 2001:db8::1 x')).toEqual([['2001:db8::1', true]]);
    const threeDigitGroup = ['abc', '', '1'].join(':');
    expect(candidates(`x ${threeDigitGroup} x`)).toEqual([[threeDigitGroup, true]]);
    expect(candidates('x ::ffff:10.1.2.3 x')).toEqual([['::ffff:10.1.2.3', true]]);
    // An IPv4 part validates it even after short groups only.
    const shortGroupsAndIpv4 = ['1', '', '10.1.2.3'].join(':');
    expect(candidates(`x ${shortGroupsAndIpv4} x`)).toEqual([[shortGroupsAndIpv4, true]]);
  });

  it.each([
    ['a MAC address (six groups)', '00:1A:2B:3C:4D:5E'],
    ['a time', '12:30:45'],
    ['a time with milliseconds', '12:30:45.123'],
    ['two "::"', '1::2::3'],
    ['a group of five', '12345::1'],
    ['nine groups', '1:2:3:4:5:6:7:8:9'],
    ['seven groups and no "::"', '1:2:3:4:5:6:7'],
    ['eight groups and a "::"', '2001:db8:1:2::3:4:5:6'],
    ['":::"', '1:::2'],
    ['a key fingerprint (sixteen pairs)', Array.from({ length: 16 }, () => 'ab').join(':')],
    ['a C++ name', 'std::vector'],
    ['a CSS pseudo-element', 'a::before'],
    ['a bad IPv4 part', '::ffff:10.1.2.300'],
  ])('is not an address: %s', (_name, text) => {
    expect(anyCandidates(`x ${text} y`)).toEqual([]);
  });

  it('a stretch longer than any address (45 characters) is none', () => {
    expect(candidates(`x ${'1:'.repeat(30)}1 y`)).toEqual([]);
  });
});

// Point 2 of the brief: text that looks like an address and is not.
describe('lookalikes', () => {
  it.each([
    'version ',
    'Version: ',
    'VERSION=',
    'ver. ',
    'v ',
    'v. ',
    'build ',
    'build #',
    'release ',
    'firmware ',
    'fw: ',
    'rev ',
    'revision ',
    'संस्करण ',
    'वर्जन ',
    'वर्ज़न ',
  ])(
    'a four-part version right after %j is not validated, and not redacted without a keyword',
    (word) => {
      const text = `App ${word}${VERSION} is out`;
      expect(candidates(text)).toEqual([[VERSION, false]]);
      expect(found(text)).toEqual([]);
    },
  );

  it('a version glued to "v" is no candidate at all', () => {
    expect(candidates(`App v${VERSION} is out`)).toEqual([]);
  });

  it('the version word must be a whole word right before it', () => {
    for (const text of [`the version is ${VERSION}`, `Dev ${VERSION}`, `prev ${VERSION}`]) {
      expect([text, candidates(text)]).toEqual([text, [[VERSION, true]]]);
    }
  });

  it('a version near an IP keyword is redacted (unvalidated, with context)', () => {
    const text = `Router IP firmware ${VERSION} ok`;
    expect(detect(text).map((d) => [d.type, d.validated, d.context])).toEqual([
      ['IP', false, true],
    ]);
  });

  it('a bare four-part version is redacted: it cannot be told from an address (the accepted cost)', () => {
    expect(found(`See ${VERSION} for details`)).toEqual([['IP', VERSION]]);
  });

  it('a Windows build number is not an address; the safety net takes it (ADR-011)', () => {
    expect(candidates('Windows 10.0.19045.3693 ok')).toEqual([]);
    expect(found('Windows 10.0.19045.3693 ok')).toEqual([['NUMBER', '10.0.19045.3693']]);
  });

  it.each([
    ['a time', 'At 12:30:45 today'],
    ['a time range', 'Open 10:00-12:30'],
    ['an ISO date and time', 'ts 2026-10-01T12:30:45Z'],
    ['a dotted date', 'On 28.09.2024 at 14:30'],
    ['a year-first dotted date', 'On 2024.09.28'],
    ['a MAC address with colons', 'HWaddr 00:1A:2B:3C:4D:5E'],
    ['a MAC address with hyphens', 'MAC 00-1A-2B-3C-4D-5E'],
    ['a MAC address in dotted quads', 'MAC 001a.2b3c.4d5e'],
    ['a Bible verse', 'John 3:16'],
    ['a score', 'won 2:1'],
  ])('%s is not an address', (_name, text) => {
    expect(candidates(text)).toEqual([]);
  });
});

// Point 4 of the brief: where IP meets the other types, and which one wins
// (ADR-026 lists these with the reasons).
describe('IP next to the other types', () => {
  it('priority: IP comes first (ADR-026)', () => {
    expect(DETECTION_TYPES[0]).toBe('IP');
  });

  it('AADHAAR: a 12-digit dotted quad that passes the Aadhaar checks is typed IP', () => {
    assertPropertyQuietly(
      fc.property(seedArb, (seed) => {
        const r = createRng(seed);
        let address: string;
        do {
          address = [r.int(200, 223), r.int(100, 255), r.int(100, 255), r.int(100, 255)].join('.');
        } while (!isValidAadhaar(address.replace(/\./g, '')));
        const d = detect(`Login from ${address} today`);
        return d.length === 1 && d[0]!.type === 'IP' && d[0]!.end - d[0]!.start === 15;
      }),
      { numRuns: 200 },
    );
  });

  it('PHONE: a dotted quad that is also a valid landline is typed IP (phone.test.ts pins the tie)', () => {
    expect(found('Server 203.0.113.100 down')).toEqual([['IP', '203.0.113.100']]);
  });

  it('NUMBER: an address of 9 or more digits is IP, never the safety net', () => {
    expect(found('Host 192.168.100.200 down')).toEqual([['IP', '192.168.100.200']]);
  });

  it('NUMBER: digits joined by a space are taken into the IP (over-redaction, ADR-010 widening)', () => {
    expect(found('Host 10.1.2.3 4567 down')).toEqual([['IP', '10.1.2.3 4567']]);
    expect(found('x 5 10.1.2.3')).toEqual([['IP', '5 10.1.2.3']]);
  });

  it('widening does not reach back over digits glued to a word: "IPv4", "IPv6", "Win10"', () => {
    expect(found('IPv4 10.1.2.3 ok')).toEqual([['IP', '10.1.2.3']]);
    expect(found('IPv6 2001:db8::1 ok')).toEqual([['IP', '2001:db8::1']]);
    expect(found('Win10 10.1.2.3')).toEqual([['IP', '10.1.2.3']]);
  });

  it('a long number glued to a word before an address is still the safety net’s', () => {
    expect(found('ref1234567890 10.1.2.3')).toEqual([
      ['NUMBER', 'ref1234567890'],
      ['IP', '10.1.2.3'],
    ]);
  });

  it('PHONE: a mobile after an address in the same digit run is its own detection (ADR-028)', () => {
    // One digit run ("10.1.2.3 <mobile>"): the address is widened only up
    // to where the mobile starts, so each keeps its own placeholder.
    const joined = compose`mobile 10.1.2.3 ${spacedMobile()}`;
    expect(spansOf(joined.text)).toEqual([
      ['IP', 7, 15],
      ['PHONE', joined.spans[0]!.start, joined.spans[0]!.end],
    ]);
    const colon = compose`mobile 10.1.2.3:${spacedMobile()}`;
    expect(spansOf(colon.text)).toEqual([
      ['IP', 7, 15],
      ['PHONE', colon.spans[0]!.start, colon.spans[0]!.end],
    ]);
  });

  it('two addresses joined by a space, a hyphen or a comma stay two detections (ADR-028)', () => {
    // Widening stops where the next detection starts, and the separator
    // between them stays text.
    expect(found('IPs 10.1.2.3 10.4.5.6 ok')).toEqual([
      ['IP', '10.1.2.3'],
      ['IP', '10.4.5.6'],
    ]);
    expect(found('range 10.1.2.3-10.1.2.9 ok')).toEqual([
      ['IP', '10.1.2.3'],
      ['IP', '10.1.2.9'],
    ]);
    expect(found('IPs 10.1.2.3, 10.4.5.6 ok')).toEqual([
      ['IP', '10.1.2.3'],
      ['IP', '10.4.5.6'],
    ]);
  });

  it('SECRET: an address after "password:" is typed IP and covered whole', () => {
    expect(found('password: 10.1.2.3')).toEqual([['IP', '10.1.2.3']]);
  });

  it('SECRET: a short-group IPv6 form after "token:" is the secret, whole', () => {
    expect(found('token: a::b')).toEqual([['SECRET', 'a::b']]);
  });

  it('SECRET: a secret made of an address, a hyphen and more keeps only the address (known limit, ADR-003 containing span)', () => {
    expect(found('api_key=10.1.2.3-x7')).toEqual([['IP', '10.1.2.3']]);
  });

  it("EMAIL: an address in an email is the email's; an IP-literal domain in brackets is an IP", () => {
    expect(found('mail x.10.1.2.3@example.com now')).toEqual([['EMAIL', 'x.10.1.2.3@example.com']]);
    expect(found('mail a@[203.0.113.5] now')).toEqual([['IP', '203.0.113.5']]);
  });

  it('UPI: an address glued to "@handle" is part of the UPI ID', () => {
    const id = `10.1.2.3@${[...UPI_HANDLES][0]!}`;
    expect(detect(`pay ${id} now`).map((d) => [d.type, d.start, d.end])).toEqual([
      ['UPI', 4, 4 + id.length],
    ]);
  });
});

describe('Unicode', () => {
  it('finds a full-width address and covers it in the original text', () => {
    const wide = '２０３．０．１１３．５';
    expect(found(`IP ${wide} ok`)).toEqual([['IP', wide]]);
  });

  it('finds one in Devanagari digits', () => {
    expect(found('IP २०३.०.११३.५ ok')).toEqual([['IP', '२०३.०.११३.५']]);
  });

  it('finds one split by invisible characters and covers every one of them', () => {
    const hidden = '203.0​.113­.5';
    expect(found(`IP ${hidden} ok`)).toEqual([['IP', hidden]]);
  });
});

describe('the value key: one address, one key', () => {
  it.each([
    ['leading zeros', '192.168.001.010', '192.168.1.10'],
    ['IPv6 case and compression', '2001:DB8::1', '2001:db8:0:0:0:0:0:1'],
    ['IPv6 leading zeros', '2001:0db8::0001', '2001:db8::1'],
    ['IPv4-mapped and plain', '::ffff:203.0.113.5', '203.0.113.5'],
    ['IPv4-mapped in hex', '::ffff:cb00:7105', '203.0.113.5'],
  ])('%s', (_name, a, b) => {
    expect(ipValueKey(a)).toBe(ipValueKey(b));
  });

  it('two different addresses have different keys', () => {
    expect(ipValueKey('10.1.2.3')).not.toBe(ipValueKey('10.1.2.4'));
    expect(ipValueKey('2001:db8::1')).not.toBe(ipValueKey('2001:db8::2'));
  });

  it('a detection widened past its address is keyed by its text, in lower case', () => {
    expect(ipValueKey('10.1.2.3 4567')).toBe('10.1.2.3 4567');
    expect(ipValueKey('CAFE:X')).toBe('cafe:x');
  });
});

// Each case makes the input 4 times longer and checks the time grows about
// 4 times, not 16 (test/support/linear-time.ts). Sizes are measured per
// input so that one run takes a few milliseconds (bug-log 28, 30): where
// digit groups sit next to each other the phone detector costs about 25 ms
// per 1,000 characters, so those inputs are small, and the IP detector is
// also timed on its own at full size.
describe('IP: linear time', () => {
  it.each([
    ['a long run of digits and dots', 500, (n: number) => '1.'.repeat(n / 2)],
    ['a long run of colons', 25_000, (n: number) => ':'.repeat(n)],
    ['hex and colons', 25_000, (n: number) => 'ab:'.repeat(n / 3)],
    ['addresses with ports, glued by colons', 500, (n: number) => '10.1.2.3:'.repeat(n / 9)],
    ['addresses after version words', 1_000, (n: number) => 'version 10.1.2.3 '.repeat(n / 17)],
    ['kept addresses', 1_000, (n: number) => '127.0.0.1 '.repeat(n / 10)],
    ['a long run glued to a word', 25_000, (n: number) => `x${'a:'.repeat(n / 2)}`],
  ])('detect() scans %s in linear time', (_name, size, make) => {
    expect(growthRatio(make, size, detect)).toBeLessThan(MAX_GROWTH_RATIO);
  });

  it.each([
    ['addresses with ports, glued by colons', (n: number) => '10.1.2.3:'.repeat(n / 9)],
    ['addresses after version words', (n: number) => 'version 10.1.2.3 '.repeat(n / 17)],
    ['kept addresses', (n: number) => '127.0.0.1 '.repeat(n / 10)],
  ])('the IP detector alone scans %s in linear time', (_name, make) => {
    const scan = (text: string): number => [...ipCandidates(text)].length;
    expect(growthRatio(make, 100_000, scan)).toBeLessThan(MAX_GROWTH_RATIO);
  });
});

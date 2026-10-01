// IP addresses, IPv4 and IPv6, as one type (ADR-026). Parsed by hand.
//
// Every address is a stretch of hex digits, colons and dots, so the text is
// cut into maximal stretches of those characters ("runs") and each run is
// read once, whole: a MAC address (six groups) or a key fingerprint
// (sixteen) is never an IPv6 address, and no IPv6 address is looked for
// inside them. A run is one of:
//
//   203.0.113.5            four decimal parts, each 0 to 255
//   2001:db8::1            IPv6 in an RFC 4291 text form: eight groups,
//   ::ffff:203.0.113.5     fewer with one "::", an IPv4 address as the last two
//
// or, if it is neither, colon-separated parts of which any IPv4 address is
// taken: 203.0.113.5:8080 (a port), add:203.0.113.5 (a label).
//
// Only the address is taken. A port, a prefix length (203.0.113.0/24), a
// zone (fe80::1%eth0), brackets ([2001:db8::1]:443) and the rest of a URL
// name nobody and stay as they are.
//
// - VALIDATED: an IPv4 address, unless a version word comes right before
//   it ("version 1.2.3.4", "build 1.2.3.4"): four small numbers is also how
//   software versions are written. An IPv6 address with a group of three or
//   four hex digits (2001:…, fe80:…) or an IPv4 part.
// - UNVALIDATED otherwise, accepted only with an IP keyword nearby
//   (context.ts): IPv6 forms made only of short groups (a::b, 10::20, eight
//   pairs of hex digits) are also what scoped names in code and EUI-64
//   interface ids look like.
//
// Addresses that no single host owns are kept (ADR-026, decided by
// measurement): unspecified (0.0.0.0/8, ::), loopback (127/8, ::1),
// multicast (224/4, ff00::/8) and reserved (240/4, which holds the
// broadcast address and every netmask from /4 up), with an IPv4 address in
// IPv6 judged by its IPv4 part. They are the same on every machine. Such an
// address is still reported, marked `keep`, and detect() makes sure no other
// type redacts exactly its text under a wrong name (the SSDP multicast
// address passes the Aadhaar checks; 255.255.255.0 reads as a phone number)
// without ever letting it cost a neighbouring value its detection. Private,
// shared (carrier-grade NAT), link-local and documentation addresses are
// redacted like public ones.
//
// Not glued to a letter, digit, mark or underscore on either side, nor to
// "@" after it (there it is the start of an email address or a UPI ID;
// "root@203.0.113.5" is an address). A run that starts inside a word
// ("src:203.0.113.5") is read from its first colon on. A run ending in a
// dot and then a letter or digit (203.0.113.5.nip.io) is part of a host
// name and is not an address: a known limit.
//
// This runs on normalised text: full-width digits and invisible characters
// are already dealt with.

import { charAt, charBefore } from './digit-runs.js';
import { normalise } from './normalise.js';
import type { Candidate } from './types.js';

const RUN = /[0-9A-Fa-f:.]+/g;
const GLUED_BEFORE = /[\p{L}\p{N}\p{M}_]/u;
const GLUED_AFTER = /[\p{L}\p{N}\p{M}_@]/u;
const IPV4 = /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/;
const HEX_GROUP = /^[0-9A-Fa-f]{1,4}$/;

// Words that make the four numbers after them a version. Whole words, then
// at most a dot, a few spaces and one of ":", "=" or "#". संस्करण and वर्जन
// are "version" in Hindi. Normalised like the text they are matched in.
const VERSION_WORDS = [
  'version',
  'ver',
  'v',
  'build',
  'release',
  'firmware',
  'fw',
  'rev',
  'revision',
  'संस्करण',
  'वर्जन',
  'वर्ज़न',
];
const VERSION_BEFORE = new RegExp(
  `(?<![\\p{L}\\p{N}\\p{M}_])(?:${VERSION_WORDS.map((w) => normalise(w).text).join('|')})\\.?[ \\t]{0,3}[:=#]?[ \\t]{0,3}$`,
  'iu',
);
// How much text before an address the version check reads: more than the
// longest match (a word and its punctuation), so the whole-word check always
// sees the character before the word.
const VERSION_WINDOW = 32;

type Octets = readonly [number, number, number, number];

function ipv4Octets(text: string): Octets | undefined {
  const m = IPV4.exec(text);
  if (!m) return undefined;
  const octets = m.slice(1).map(Number) as unknown as Octets;
  return octets.every((o) => o <= 255) ? octets : undefined;
}

interface Ipv6 {
  /** The eight 16-bit groups. */
  readonly groups: readonly number[];
  /** Written with a group of 3 or 4 hex digits, or an IPv4 part. */
  readonly wide: boolean;
}

function ipv6(text: string): Ipv6 | undefined {
  // An IPv4 part, if any, is the last thing and stands for two groups.
  let head = text;
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  if (text.includes('.', lastColon)) {
    const v4 = ipv4Octets(text.slice(lastColon + 1));
    if (!v4) return undefined;
    tail = [v4[0] * 256 + v4[1], v4[2] * 256 + v4[3]];
    head = text.slice(0, head.endsWith('::', lastColon + 1) ? lastColon + 1 : lastColon);
  }
  const halves = head.split('::');
  if (halves.length > 2) return undefined;
  const left = hexGroups(halves[0]!);
  const right = halves.length === 2 ? hexGroups(halves[1]!) : [];
  if (!left || !right) return undefined;
  const written = left.length + right.length + tail.length;
  // "::" stands for at least one group of zeros.
  if (halves.length === 1 ? written !== 8 : written > 7) return undefined;
  return {
    groups: [...left, ...Array<number>(8 - written).fill(0), ...right, ...tail],
    wide: tail.length > 0 || /[0-9A-Fa-f]{3}/.test(head),
  };
}

function hexGroups(part: string): number[] | undefined {
  if (part === '') return [];
  const groups: number[] = [];
  for (const group of part.split(':')) {
    if (!HEX_GROUP.test(group)) return undefined;
    groups.push(parseInt(group, 16));
  }
  return groups;
}

// Unspecified, loopback, multicast or reserved: no single host's address.
const noSingleHost4 = ([a]: Octets): boolean => a === 0 || a === 127 || a >= 224;

// An IPv4 address carried in IPv6: mapped (::ffff:0:0/96), or in the
// deprecated "IPv4-compatible" block of RFC 4291 (::/96), which also holds
// :: and ::1 (they read as 0.0.0.0 and 0.0.0.1, in 0/8).
const embeddedIpv4 = (g: readonly number[]): Octets | undefined =>
  g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)
    ? [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255]
    : undefined;

function noSingleHost6(g: readonly number[]): boolean {
  const v4 = embeddedIpv4(g);
  return v4 ? noSingleHost4(v4) : g[0]! >= 0xff00;
}

export function* ipCandidates(text: string): Generator<Candidate> {
  for (const m of text.matchAll(RUN)) yield* addressesIn(text, m.index, m[0]);
}

// The addresses in one run. The run is read whole first (an IPv4 or an IPv6
// address); if it is neither, each colon-separated part is tried as an IPv4
// address, which finds one with a port (203.0.113.5:8080) or after a label
// made of hex digits (add:203.0.113.5, 1:203.0.113.5).
function* addressesIn(text: string, runStart: number, run: string): Generator<Candidate> {
  let from = 0;
  if (GLUED_BEFORE.test(charBefore(text, runStart))) {
    // Inside a word: "src:203.0.113.5" holds an address after the colon;
    // "v1.2.3.4" holds none.
    const colon = run.indexOf(':');
    if (colon < 0) return;
    from = colon + 1;
  }
  // Punctuation around the address: dots or a label's colon before it, a
  // full stop or a colon after it. A "::" is part of the address.
  while (from < run.length && run[from] === '.') from++;
  if (run[from] === ':' && run[from + 1] !== ':') from++;
  let to = run.length;
  while (to > from && run[to - 1] === '.') to--;
  // Glued after: a letter right after the run, or after its final dots
  // (203.0.113.5.nip.io is a host name). A trailing colon separates.
  const gluedAfter = GLUED_AFTER.test(charAt(text, runStart + run.length));
  if (to > from + 1 && run[to - 1] === ':' && run[to - 2] !== ':') to--;
  const lastGlued = gluedAfter && !run.slice(to).includes(':');

  const value = run.slice(from, to);
  const start = runStart + from;
  if (!lastGlued) {
    const whole = ipv4Octets(value);
    if (whole) {
      yield* ipv4Candidate(text, start, value.length, whole);
      return;
    }
    const v6 = value.includes(':') ? ipv6(value) : undefined;
    if (v6) {
      const end = start + value.length;
      yield noSingleHost6(v6.groups)
        ? { type: 'IP', start, end, validated: true, keep: true }
        : { type: 'IP', start, end, validated: v6.wide };
      return;
    }
  }
  const parts = value.split(':');
  let at = start;
  for (const [i, part] of parts.entries()) {
    const octets = i === parts.length - 1 && lastGlued ? undefined : ipv4Octets(part);
    if (octets) yield* ipv4Candidate(text, at, part.length, octets);
    at += part.length + 1;
  }
}

function* ipv4Candidate(
  text: string,
  start: number,
  length: number,
  octets: Octets,
): Generator<Candidate> {
  const end = start + length;
  if (noSingleHost4(octets)) {
    yield { type: 'IP', start, end, validated: true, keep: true };
    return;
  }
  const before = text.slice(Math.max(0, start - VERSION_WINDOW), start);
  yield { type: 'IP', start, end, validated: !VERSION_BEFORE.test(before) };
}

/**
 * The address's identity (ADR-013): the same address written two ways
 * (`192.168.001.010` and `192.168.1.10`, `2001:DB8::1` and
 * `2001:db8:0:0:0:0:0:1`, `::ffff:203.0.113.5` and `203.0.113.5`) is one
 * key. A detection widened past its address (to digits joined by a space,
 * detect.ts) is keyed by its text.
 */
export function ipValueKey(text: string): string {
  const v4 = ipv4Octets(text);
  if (v4) return v4.join('.');
  const v6 = text.includes(':') ? ipv6(text) : undefined;
  if (!v6) return text.toLowerCase();
  const embedded = embeddedIpv4(v6.groups);
  return embedded ? embedded.join('.') : v6.groups.map((g) => g.toString(16)).join(':');
}

// Rule 4 and ADR-009, enforced: no file in the repo may contain an
// Aadhaar-shaped number that passes the Aadhaar checks, or a card number that
// passes the card checks unless it is a published test card. Such numbers
// could belong to a real person. Guards bug-log entry 4, where one slipped
// into a source comment. `eval/` is scanned too: the held-out set lives
// there as a file, behind its own stricter lint (eval/lint.ts). Nor may a
// file hold a UPI ID at a known handle (ADR-021, ADR-024): typed, it could
// be somebody's; tests put theirs together at run time. Nor an IP address
// outside the ranges nobody can be found at (ADR-026): documentation,
// private, loopback, link-local, and those no single host owns, by the
// held-out lint's own rule (eval/lint.ts, isSafeIp). The held-out file is
// left to that lint: its author may type a short dotted number, and a hit
// would point into a file the detectors' author must not look at. Nor a
// passport or voter ID number on the same line as its keyword (ADR-031):
// typed, it could be somebody's. A date of birth is not checked: a date
// with no name beside it identifies nobody, and the tests of its costs type
// ordinary dates next to birth words on purpose.
//
// Failures report file and line only, never the number.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isValidAadhaar } from '../../src/detection/aadhaar.js';
import { isValidCard } from '../../src/detection/card.js';
import { hasContext } from '../../src/detection/context.js';
import { ipCandidates, ipValueKey } from '../../src/detection/ip.js';
import { passportCandidates } from '../../src/detection/passport.js';
import { upiCandidates } from '../../src/detection/upi.js';
import { voterCandidates } from '../../src/detection/voter.js';
import { isSafeIp } from '../../eval/lint.js';
import { passportNumber, upiId, voterId } from '../../src/synthetic/identifiers.js';
import { createRng } from '../../src/synthetic/rng.js';
import { PUBLISHED_TEST_CARDS } from '../fixtures/published-test-cards.js';

const ROOT = join(import.meta.dirname, '..', '..');
// docs/ is public since 2026-10-03 (the decision record, bug log, testing
// guide and user manual), so it is held to the same rules.
const SCANNED = ['src', 'test', 'scripts', 'eval', 'docs', 'README.md'];
const TEXT_FILE = /\.(ts|js|mjs|cjs|json|md|txt)$/;

function* files(path: string): Generator<string> {
  const entries = readdirSync(path, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (TEXT_FILE.test(entry.name)) yield full;
  }
}

const allFiles = (): string[] =>
  SCANNED.flatMap((p) => (TEXT_FILE.test(p) ? [join(ROOT, p)] : [...files(join(ROOT, p))]));

// Digit sequences with optional single separators, not touching other digits.
const numbersIn = (line: string, digits: number): string[] =>
  [...line.matchAll(new RegExp(`(?<![0-9])[0-9](?:[ .-]?[0-9]){${digits - 1}}(?![0-9])`, 'g'))].map(
    (m) => m[0].replace(/[ .-]/g, ''),
  );

const PUBLISHED = PUBLISHED_TEST_CARDS.map((c) => c.number);
const isPublishedOrPartOfOne = (digits: string): boolean =>
  PUBLISHED.some((card) => card.includes(digits));

const hasKnownUpiId = (line: string): boolean =>
  [...upiCandidates(line)].some((candidate) => candidate.validated);

// Judged as written and in its canonical form (2001:0db8::1 is 2001:db8::1).
const hasPublicIp = (line: string): boolean =>
  [...ipCandidates(line)].some((candidate) => {
    if (!candidate.validated || candidate.keep) return false;
    const address = line.slice(candidate.start, candidate.end);
    return !isSafeIp(address) && !isSafeIp(ipValueKey(address));
  });

// The keyword is looked for on the same line only.
const hasIdWithKeyword = (line: string): boolean =>
  [...passportCandidates(line), ...voterCandidates(line)].some((candidate) =>
    hasContext(line, candidate, candidate.type),
  );

const HELD_OUT = join(ROOT, 'eval', 'held-out.txt');

function findings(check: (line: string) => boolean, skip: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const file of allFiles()) {
    if (skip.includes(file)) continue;
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (check(line)) out.push(`${relative(ROOT, file)}:${i + 1}`);
      });
  }
  return out;
}

describe('repo hygiene: no real-looking personal values in files', () => {
  it('scans a meaningful number of files', () => {
    expect(allFiles().length).toBeGreaterThan(30);
  });

  it('contains no Aadhaar-shaped number that passes the Aadhaar checks', () => {
    const found = findings((line) =>
      numbersIn(line, 12).some((n) => isValidAadhaar(n) && !isPublishedOrPartOfOne(n)),
    );
    expect(found).toEqual([]);
  });

  it('contains no valid card number other than published test cards', () => {
    const found = findings((line) =>
      [13, 14, 15, 16, 17, 18, 19].some((length) =>
        numbersIn(line, length).some((n) => isValidCard(n) && !PUBLISHED.includes(n)),
      ),
    );
    expect(found).toEqual([]);
  });

  it('contains no UPI ID at a known handle', () => {
    expect(findings(hasKnownUpiId)).toEqual([]);
  });

  it('the UPI check flags an ID put together at run time', () => {
    expect(hasKnownUpiId(`pay ${upiId(createRng(1), 'name')} now`)).toBe(true);
    expect(hasKnownUpiId(`pay ${upiId(createRng(1), 'mobile')} now`)).toBe(true);
  });

  it('contains no passport or voter ID number next to its keyword (the held-out file has its own lint)', () => {
    expect(findings(hasIdWithKeyword, [HELD_OUT])).toEqual([]);
  });

  it('the passport and voter ID check flags numbers put together at run time, only with a keyword', () => {
    const r = createRng(1);
    expect(hasIdWithKeyword(`passport ${passportNumber(r)}`)).toBe(true);
    expect(hasIdWithKeyword(`EPIC ${voterId(r)}`)).toBe(true);
    expect(hasIdWithKeyword(`model ${passportNumber(r)}`)).toBe(false);
  });

  it('contains no IP address outside the ranges nobody can be found at (the held-out file has its own lint)', () => {
    expect(findings(hasPublicIp, [HELD_OUT])).toEqual([]);
  });

  it('the IP check flags a public address put together at run time, and passes reserved ones', () => {
    expect(hasPublicIp(`from ${[8, 8, 4, 4].join('.')} today`)).toBe(true);
    expect(hasPublicIp(`from ${['2606', '4700', '', '1111'].join(':')} today`)).toBe(true);
    for (const reserved of ['203.0.113.5', '2001:0DB8::1', '::ffff:cb00:7105', '255.255.255.0']) {
      expect([reserved, hasPublicIp(`from ${reserved} today`)]).toEqual([reserved, false]);
    }
  });
});

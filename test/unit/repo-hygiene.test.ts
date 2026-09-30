// Rule 4 and ADR-009, enforced: no file in the repo may contain an
// Aadhaar-shaped number that passes the Aadhaar checks, or a card number that
// passes the card checks unless it is a published test card. Such numbers
// could belong to a real person. Guards bug-log entry 4, where one slipped
// into a source comment. `eval/` is scanned too: the held-out set lives
// there as a file, behind its own stricter lint (eval/lint.ts). Nor may a
// file hold a UPI ID at a known handle (ADR-021, ADR-024): typed, it could
// be somebody's; tests put theirs together at run time.
//
// Failures report file and line only, never the number.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isValidAadhaar } from '../../src/detection/aadhaar.js';
import { isValidCard } from '../../src/detection/card.js';
import { upiCandidates } from '../../src/detection/upi.js';
import { upiId } from '../../src/synthetic/identifiers.js';
import { createRng } from '../../src/synthetic/rng.js';
import { PUBLISHED_TEST_CARDS } from '../fixtures/published-test-cards.js';

const ROOT = join(import.meta.dirname, '..', '..');
const SCANNED = ['src', 'test', 'scripts', 'eval', 'README.md'];
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

function findings(check: (line: string) => boolean): string[] {
  const out: string[] = [];
  for (const file of allFiles()) {
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
});

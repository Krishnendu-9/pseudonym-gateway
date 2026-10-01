// Indian mobiles written 5 + 5 with other digit groups beside them
// (bug-log 34, ADR-027).
//
// libphonenumber reads a stretch of digit groups joined by spaces as one
// number. When the whole stretch is not a valid number it reports nothing
// and does not look inside it, so "<mobile> <mobile>", "Room 3 <mobile>"
// and "<mobile> 411001" sent the mobile as written, keyword or not. This
// detector looks inside: two neighbouring groups of five digits, inside a
// longer run, that make a valid Indian number starting 6-9 (the mobile
// ranges) are a phone candidate.
//
// Tables are where such pairs appear by accident: rows of 5-digit amounts
// ("12345 67890 23456") hold valid 6-9 pairs in about a third of their
// windows. So the pair is compared with every other line that has two
// 5-digit groups in the same two positions (counting every group of digits
// on the line, from its start): the same two columns of a table. If any of
// those is not such a mobile, the pair is in a table of numbers and counts
// only as an unvalidated candidate, accepted with a phone keyword nearby
// (ADR-010). A contact sheet has a mobile in every row of its columns, so it
// passes; an amount table almost never does. A line that does not have two
// 5-digit groups there (a date, an address, an Aadhaar, an Indian amount)
// is not part of that table and does not count against the pair.
//
// Linear time: every group is read once, and every pair of neighbouring
// 5-digit groups is checked once, and only when the text has a candidate.

import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { digitWindows } from './digit-runs.js';
import type { Candidate } from './types.js';

const DEFAULT_COUNTRY = 'IN';
const GROUP_OR_LINE_BREAK = /[0-9]+|[\n\r\v\f\u0085\p{Zl}\p{Zp}]/gu;

interface Group {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

const isFive = (group: Group): boolean => group.end - group.start === 5;

/** True if two groups of five digits make a valid Indian number starting 6-9. */
function isSpacedMobile(text: string, first: Group, second: Group): boolean {
  if (!/[6-9]/.test(text[first.start]!)) return false;
  const digits = text.slice(first.start, first.end) + text.slice(second.start, second.end);
  return parsePhoneNumberFromString(digits, DEFAULT_COUNTRY)?.isValid() === true;
}

/** Every digit group in `text`, by line, each with its position on the line. */
function groupsByLine(text: string): Group[][] {
  const lines: Group[][] = [[]];
  for (const match of text.matchAll(GROUP_OR_LINE_BREAK)) {
    const line = lines.at(-1)!;
    if (!/[0-9]/.test(match[0])) {
      lines.push([]);
      continue;
    }
    line.push({
      start: match.index,
      end: match.index + match[0].length,
      line: lines.length - 1,
      column: line.length,
    });
  }
  return lines;
}

/**
 * The columns (by the first of two positions) where some line has two
 * 5-digit groups that are not a mobile: a table of numbers.
 */
function numberColumns(text: string, lines: readonly (readonly Group[])[]): Set<number> {
  const columns = new Set<number>();
  for (const line of lines) {
    for (let column = 0; column + 1 < line.length; column++) {
      const [first, second] = [line[column]!, line[column + 1]!];
      if (isFive(first) && isFive(second) && !isSpacedMobile(text, first, second)) {
        columns.add(column);
      }
    }
  }
  return columns;
}

export function* spacedMobileCandidates(text: string): Generator<Candidate> {
  let lines: Group[][] | undefined;
  let groupAt: Map<number, Group> | undefined;
  let tableColumns: Set<number> | undefined;

  for (const window of digitWindows(text, 10, 10)) {
    if (window.wholeRun || window.groups.length !== 2 || window.groups[0] !== 5) continue;
    // Worked out only once a message has such a pair at all.
    lines ??= groupsByLine(text);
    groupAt ??= new Map(lines.flat().map((group) => [group.start, group]));
    const first = groupAt.get(window.start)!;
    const second = lines[first.line]![first.column + 1]!;
    if (!isSpacedMobile(text, first, second)) continue;
    tableColumns ??= numberColumns(text, lines);
    yield {
      type: 'PHONE',
      start: window.start,
      end: window.end,
      validated: !tableColumns.has(first.column),
    };
  }
}

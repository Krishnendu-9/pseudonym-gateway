// The evaluation's tables, as Markdown: what `npm run eval` prints and what
// the README shows between its eval markers. Counts first, percentages cut
// (never rounded up) to one decimal beside them.

import { rowOf, type StoredDataset } from './baseline.js';
import type { EchoScore } from './echo.js';
import { HELD_BACK_RULES, type HeldBackRule } from '../src/redaction/restore.js';
import { percent, prf, type DatasetScore, type ShapeScore, type TypeScore } from './score.js';
import { PERSONAL_TYPES } from './types.js';

const ratio = (part: number, whole: number): string =>
  whole === 0 ? '-' : `${part}/${whole} (${percent(part, whole)})`;

const fraction = (value: number | undefined): string =>
  value === undefined ? '-' : `${(Math.floor(value * 1000) / 10).toFixed(1)}%`;

// Laid out the way Prettier lays out a Markdown table (cells padded to the
// column's width), so that the README block passes the format check as
// generated. Cells here are ASCII, so length is width.
function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((cell, column) =>
    Math.max(3, cell.length, ...rows.map((row) => row[column]!.length)),
  );
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column]!)).join(' | ')} |`;
  return [line(header), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join(
    '\n',
  );
}

const hasData = (row: TypeScore): boolean => row.values > 0 || row.detections > 0;

/**
 * One row per data type. "Redacted" is the privacy number (any detection
 * type); precision, recall and F1 are for the right type.
 */
export function scoreTable(score: StoredDataset): string {
  const rows = PERSONAL_TYPES.filter((type) => hasData(rowOf(score, type))).map((type) => {
    const row = rowOf(score, type);
    const { precision, f1 } = prf(row);
    return [
      type,
      String(row.values),
      ratio(row.redacted, row.values),
      String(row.partial),
      ratio(row.typed, row.values),
      row.detections === 0 ? '-' : `${row.rightType}/${row.detections} (${fraction(precision)})`,
      fraction(f1),
      String(row.notPersonal),
    ];
  });
  return table(
    [
      'Type',
      'Values',
      'Redacted (any type)',
      'Partly redacted',
      'Recall (right type)',
      'Precision (right type)',
      'F1',
      'Over-redactions',
    ],
    rows,
  );
}

/**
 * One row per way of writing values: the generated set's shape block
 * (Phase 5c), scored apart from its main cases.
 */
export function shapeTable(shapes: Readonly<Record<string, ShapeScore>>): string {
  return table(
    [
      'Written as',
      'Values',
      'Redacted (any type)',
      'Partly redacted',
      'Recall (right type)',
      'Over-redactions',
    ],
    Object.entries(shapes).map(([shape, row]) => [
      shape,
      String(row.values),
      ratio(row.redacted, row.values),
      String(row.partial),
      ratio(row.typed, row.values),
      String(row.overRedactions),
    ]),
  );
}

/** Every lookalike row (`NOT.order`, `NOT.tracking`…) added up into one, `lookalike`. */
function foldLabels(
  overRedactions: DatasetScore['overRedactions'],
): Record<string, Record<string, number>> {
  const folded: Record<string, Record<string, number>> = {};
  for (const [kind, byType] of Object.entries(overRedactions)) {
    const row = (folded[kind.startsWith('NOT.') ? 'lookalike' : kind] ??= {});
    for (const [type, count] of Object.entries(byType)) row[type] = (row[type] ?? 0) + count;
  }
  return folded;
}

/**
 * What was redacted though it is not personal, by kind and by detection
 * type. A lookalike's label is text its author typed: for the held-out set
 * it is `hidden` (one `lookalike` row), so that the report never shows what
 * that file says.
 */
export function overRedactionTable(
  score: DatasetScore,
  labels: 'shown' | 'hidden' = 'shown',
): string {
  const overRedactions =
    labels === 'shown' ? score.overRedactions : foldLabels(score.overRedactions);
  const kinds = Object.keys(overRedactions).sort();
  if (kinds.length === 0) return 'No over-redactions.';
  const types = PERSONAL_TYPES.filter((type) =>
    kinds.some((kind) => overRedactions[kind]![type] !== undefined),
  );
  return table(
    ['Redacted though not personal', ...types, 'Total'],
    kinds.map((kind) => {
      const counts = types.map((type) => overRedactions[kind]![type] ?? 0);
      return [
        kind,
        ...counts.map((n) => (n === 0 ? '' : String(n))),
        String(counts.reduce((a, b) => a + b, 0)),
      ];
    }),
  );
}

// What each echo row says, in the README's words.
const HELD_BACK_NAMES: Readonly<Record<HeldBackRule, string>> = {
  'markdown-destination': 'Left: in a markdown link or image target',
  'reference-label': 'Left: after "[label]:"',
  'html-attribute': 'Left: in a quoted HTML attribute value',
  url: 'Left: in a URL (scheme, `mailto:` or host and path)',
  'unclosed-angle': 'Left: rest of a line after an unclosed "<" target',
  'unclosed-quote': 'Left: rest of the text after an unclosed `="`',
  host: 'Left: host rule (`[TYPE_N].x`)',
  'bare-space': '`Type N` text, never restored (ADR-013)',
};

/** Several echo parts added up into one. */
export function sumEcho(parts: readonly EchoScore[]): EchoScore {
  const add = (of: (score: EchoScore) => number): number =>
    parts.reduce((n, score) => n + of(score), 0);
  return {
    messages: add((s) => s.messages),
    placeholders: add((s) => s.placeholders),
    restored: add((s) => s.restored),
    heldBack: Object.fromEntries(
      HELD_BACK_RULES.map((rule) => [rule, add((s) => s.heldBack[rule])]),
    ) as Record<HeldBackRule, number>,
    exact: add((s) => s.exact),
    firstForm: add((s) => s.firstForm),
    broken: add((s) => s.broken),
  };
}

/**
 * The echo measurement (ADR-033), one column per part: what restoration did
 * with each of Pseudonym's placeholders when the model repeated the
 * redacted messages unchanged, and whether every message came back.
 */
export function echoTable(columns: readonly (readonly [string, EchoScore])[]): string {
  const row = (name: string, of: (score: EchoScore) => number): string[] => [
    name,
    ...columns.map(([, score]) => String(of(score))),
  ];
  return table(
    ['Echoed unchanged', ...columns.map(([name]) => name)],
    [
      row('Messages', (s) => s.messages),
      row('Placeholders', (s) => s.placeholders),
      ['Restored', ...columns.map(([, s]) => ratio(s.restored, s.placeholders))],
      ...HELD_BACK_RULES.map((rule) => row(HELD_BACK_NAMES[rule], (s) => s.heldBack[rule])),
      row('Messages back exactly', (s) => s.exact),
      row('Messages back with a later mention as first written', (s) => s.firstForm),
      row('Messages not restored correctly', (s) => s.broken),
    ],
  );
}

/**
 * The echo table's columns: the generated set's main cases, its `in-markup`
 * shape, the rest of its shape block added up, and the held-out set.
 */
export function echoColumns(
  generated: Readonly<Record<string, EchoScore>>,
  heldOut: EchoScore | undefined,
): [string, EchoScore][] {
  const columns: [string, EchoScore][] = [];
  const { main, 'in-markup': inMarkup, ...rest } = generated;
  if (main) columns.push(['Generated, main', main]);
  if (inMarkup) columns.push(['Shape block: in-markup', inMarkup]);
  const others = Object.values(rest);
  if (others.length > 0) columns.push(['Shape block: other shapes', sumEcho(others)]);
  if (heldOut) columns.push(['Held-out', heldOut]);
  return columns;
}

export interface ReportInput {
  readonly measuredOn: string;
  readonly generated: StoredDataset & { readonly seed: number };
  /** Null until the held-out set has cases. */
  readonly heldOut: StoredDataset | null;
}

export const README_START = '<!-- eval:start -->';
export const README_END = '<!-- eval:end -->';

const size = (score: StoredDataset): string => {
  const values = PERSONAL_TYPES.reduce((n, type) => n + rowOf(score, type).values, 0);
  return `${score.messages} messages in ${score.cases} cases, ${values} labelled personal values`;
};

/** The block the README carries between README_START and README_END. */
export function readmeBlock(input: ReportInput): string {
  const lines = [
    README_START,
    '',
    `_Measured on ${input.measuredOn} (UTC date) by \`npm run eval\`. This block is generated, and the run fails if it is out of date._`,
    '',
    `**Generated dataset, main cases** (seed ${input.generated.seed}; ${size(input.generated)}). Its generator and the detectors share an author, so it mostly shows regressions.`,
    '',
    scoreTable(input.generated),
    '',
  ];
  const shapes = input.generated.shapes ?? {};
  if (Object.keys(shapes).length > 0) {
    const values = Object.values(shapes).reduce((n, row) => n + row.values, 0);
    lines.push(
      `**Generated dataset, shape block** (${values} labelled personal values, in cases apart from the main ones). Each row is a way of writing values that is hard on purpose: a line break inside a value, a value split across two messages, two values side by side, digits beside a mobile, a checked value inside an address or key, digits joined by a bracket, passport and voter ID numbers and dates of birth, contact sheets of mobiles in columns (aligned, and with one row out of line), values inside markup (a URL, a markdown link or image, an HTML tag), and person names written the ways people write them, beside words that are not names (Phase 6). These rows measure hard layouts one at a time; they are not part of the numbers above.`,
      '',
      shapeTable(shapes),
      '',
    );
  }
  const heldOutEcho = input.heldOut?.echo?.all;
  if (input.heldOut) {
    lines.push(
      `**Held-out adversarial dataset** (drafted with AI assistance in a separate session that did not write the detectors, then reviewed by the author; never run against the detectors before it was committed, and never used for tuning; ${size(input.heldOut)}).`,
      '',
      scoreTable(input.heldOut),
    );
  } else {
    lines.push('**Held-out adversarial dataset:** not measured yet.');
  }
  if (input.generated.echo) {
    lines.push(
      '',
      `**Echo** (ADR-033): every message redacted, then restored as if the model had repeated it unchanged. A placeholder in a URL, a link or image target, or an HTML attribute value stays a placeholder (restoration safety); each one left is counted under the rule that held it. "Back exactly" restores with those rules off and compares with the original message.`,
      '',
      echoTable(echoColumns(input.generated.echo, heldOutEcho)),
    );
  }
  lines.push('', README_END);
  return lines.join('\n');
}

/** The README with its eval block replaced; undefined if it has no markers. */
export function withReadmeBlock(readme: string, block: string): string | undefined {
  const start = readme.indexOf(README_START);
  const end = readme.indexOf(README_END);
  if (start < 0 || end < start) return undefined;
  return readme.slice(0, start) + block + readme.slice(end + README_END.length);
}

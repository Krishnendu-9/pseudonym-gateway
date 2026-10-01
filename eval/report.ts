// The evaluation's tables, as Markdown: what `npm run eval` prints and what
// the README shows between its eval markers. Counts first, percentages cut
// (never rounded up) to one decimal beside them.

import { rowOf, type StoredDataset } from './baseline.js';
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
 * One row per way of writing values (the generated set's shape block,
 * Phase 5c). Each value also counts in its type's row of scoreTable.
 */
export function shapeTable(shapes: Readonly<Record<string, ShapeScore>>): string {
  return table(
    ['Written as', 'Values', 'Redacted (any type)', 'Partly redacted'],
    Object.entries(shapes).map(([shape, row]) => [
      shape,
      String(row.values),
      ratio(row.redacted, row.values),
      String(row.partial),
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
    `**Generated dataset** (seed ${input.generated.seed}; ${size(input.generated)}). Its generator and the detectors share an author, so it mostly shows regressions.`,
    '',
    scoreTable(input.generated),
    '',
  ];
  const shapes = input.generated.shapes ?? {};
  if (Object.keys(shapes).length > 0) {
    lines.push(
      'The same values by the way they are written: the main cases (`main`), then one row per way that is hard on purpose (a line break inside a value, a value split across two messages, two values side by side, digits beside a mobile, a checked value inside an address or key, digits joined by a bracket, passport and voter ID numbers and dates of birth). Each value also counts in the table above.',
      '',
      shapeTable(shapes),
      '',
    );
  }
  if (input.heldOut) {
    lines.push(
      `**Held-out adversarial dataset** (drafted with AI assistance in a separate session that did not write the detectors, then reviewed by the author; never run against the detectors before it was committed, and never used for tuning; ${size(input.heldOut)}).`,
      '',
      scoreTable(input.heldOut),
    );
  } else {
    lines.push('**Held-out adversarial dataset:** not measured yet.');
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

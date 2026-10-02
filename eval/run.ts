// `npm run eval`: measures the detectors on both datasets, and what
// restoration does with an unchanged echo of every message (ADR-033),
// prints the tables, and compares the counts with eval/baseline.json
// (ADR-021).
//
//   npm run eval                          fails if any count differs from the
//                                         baseline, or the README block is stale
//   npx tsx eval/run.ts --update          accepts better counts: rewrites the
//                                         baseline and the README block
//   npx tsx eval/run.ts --update --accept "ADR-0xx: why"
//                                         accepts worse counts or a changed
//                                         dataset, and records the note
//   npx tsx eval/run.ts --update --with-held-out
//                                         takes the first measurement of the
//                                         held-out set; from then on it is
//                                         part of every run
//   npx tsx eval/run.ts --by-tag          for the held-out set's author only:
//                                         results per tag, and lookalikes by
//                                         the labels the file gives them
//
// Flags go to tsx directly: PowerShell drops the "--" in
// "npm run eval -- --update", and npm then keeps the flag for itself.
//
// Wiring only (files in, text out); every decision is in a tested module.
// For the held-out set it prints counts per data type and nothing the file
// says: no text, no tag, no label (unless --by-tag asks for the last two).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  compareAll,
  nextBaseline,
  scoresHeldOut,
  verdict,
  type Baseline,
  type Measurement,
} from './baseline.js';
import { echo, echoByShape, type EchoScore } from './echo.js';
import { GENERATED_SEED, generateCases } from './generate.js';
import { checkHeldOut, loadHeldOut } from './held-out.js';
import {
  echoColumns,
  echoTable,
  overRedactionTable,
  readmeBlock,
  scoreTable,
  shapeTable,
  withReadmeBlock,
} from './report.js';
import { percent, score, scoreByTag, type DatasetScore } from './score.js';
import { PERSONAL_TYPES, SHAPE_TAG, type LabelledCase } from './types.js';
import { leftoverMutation } from '../scripts/mutation-marker.js';

const BASELINE_PATH = join(import.meta.dirname, 'baseline.json');
const README_PATH = join(import.meta.dirname, '..', 'README.md');

// Never measure, or write a baseline, while a source file may be mutated.
const refusal = leftoverMutation(join(import.meta.dirname, '..'), process.env);
if (refusal) {
  process.stderr.write(`REFUSED. ${refusal}\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
const update = args.includes('--update');
const accept = args.includes('--accept') ? args[args.indexOf('--accept') + 1] : undefined;
const write = (line = ''): void => void process.stdout.write(`${line}\n`);

const previous = existsSync(BASELINE_PATH)
  ? (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline)
  : undefined;

// The main cases give the headline numbers; the shape block (Phase 5c) is
// scored apart, by shape, so that its hard layouts never read as a drop in
// the main ones.
const generatedCases = generateCases();
const shaped = (c: LabelledCase): boolean => c.tags.some((tag) => tag.startsWith(SHAPE_TAG));
const main = score(generatedCases.filter((c) => !shaped(c)));
const blockCases = generatedCases.filter(shaped);
const block = score(blockCases, undefined, { byShape: true });
const generated: DatasetScore = { ...main, shapes: block.shapes };
write(`## Generated dataset, main cases (seed ${GENERATED_SEED}, ${main.messages} messages)`);
write();
write(scoreTable(main));
write();
write(overRedactionTable(main));
write();
write(
  `## Generated dataset, shape block (${block.cases} cases, ${block.messages} messages; not part of the numbers above)`,
);
write();
write(shapeTable(block.shapes));
write();
write(overRedactionTable(block));
write();

const held = checkHeldOut();
const measured = scoresHeldOut(previous, args.includes('--with-held-out'));
let heldOut: Measurement['heldOut'];
let heldOutEcho: EchoScore | undefined;
if (!measured) {
  write(
    `## Held-out dataset: ${held.cases.length} cases, ${held.problems.length} lint problem(s); not measured yet`,
  );
  write(
    '   (first measurement, once it is complete: npx tsx eval/run.ts --update --with-held-out)',
  );
  write();
} else if (held.problems.length > 0) {
  write(
    `eval/held-out.txt has ${held.problems.length} problem(s): "npm run eval:lint" lists them.`,
  );
  process.exit(1);
} else {
  const cases = loadHeldOut();
  heldOut = cases.length > 0 ? score(cases) : undefined;
  heldOutEcho = cases.length > 0 ? echo(cases) : undefined;
  // Tags and lookalike labels are text from the file: shown only on request.
  const authorView = args.includes('--by-tag');
  write(`## Held-out dataset (${cases.length} cases)`);
  write();
  if (heldOut) {
    write(scoreTable(heldOut));
    write();
    write(overRedactionTable(heldOut, authorView ? 'shown' : 'hidden'));
    write();
  }
  if (authorView) {
    for (const [tag, tagScore] of scoreByTag(cases)) {
      const values = PERSONAL_TYPES.reduce((n, type) => n + tagScore.types[type].values, 0);
      const redacted = PERSONAL_TYPES.reduce((n, type) => n + tagScore.types[type].redacted, 0);
      write(
        `${tag}: ${tagScore.cases} cases, redacted ${redacted}/${values} (${percent(redacted, values)})`,
      );
    }
    write();
  }
}

// The echo: counts by rule only; the held-out set as one total.
const generatedEcho = echoByShape(generatedCases);
write('## Echo: each message restored as if the model repeated it unchanged');
write();
write(echoTable(echoColumns(generatedEcho, heldOutEcho)));
write();

const now: Measurement = {
  // The UTC date, and the README says so: a run before 05:30 in India
  // records the day before.
  date: new Date().toISOString().slice(0, 10),
  generated: { score: generated, seed: GENERATED_SEED, echo: generatedEcho },
  heldOut,
  ...(heldOutEcho ? { heldOutEcho } : {}),
};
const comparison = compareAll(previous, now);
for (const line of comparison.worse) write(`WORSE    ${line}`);
for (const line of comparison.changed) write(`CHANGED  ${line}`);
for (const line of comparison.better) write(`BETTER   ${line}`);

const readme = readFileSync(README_PATH, 'utf8');

if (update) {
  // nextBaseline refuses a worse count or a changed dataset without a note.
  let next: Baseline;
  try {
    next =
      verdict(comparison) === 'same' && previous ? previous : nextBaseline(previous, now, accept);
  } catch (error) {
    write((error as Error).message);
    process.exit(1);
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
  const updated = withReadmeBlock(readme, readmeBlock(next));
  if (updated === undefined) {
    write('README.md has no eval markers; baseline written, README left alone.');
    process.exit(1);
  }
  writeFileSync(README_PATH, updated);
  write('Baseline and README block written.');
} else {
  const state = verdict(comparison);
  if (state === 'needs-note') {
    write('FAIL: worse than the baseline, or the dataset changed. If that is a decision,');
    write('      record it: npx tsx eval/run.ts --update --accept "ADR-0xx: why"');
    process.exit(1);
  }
  if (state === 'better') {
    write('FAIL: better than the baseline. Make it the new floor: npx tsx eval/run.ts --update');
    process.exit(1);
  }
  if (withReadmeBlock(readme, readmeBlock(previous!)) !== readme) {
    write('FAIL: the README evaluation block is out of date: npx tsx eval/run.ts --update');
    process.exit(1);
  }
  write('OK: every count matches the baseline, and the README block is current.');
}

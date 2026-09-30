// `npm run eval`: measures the detectors on both datasets, prints the
// tables, and compares the counts with eval/baseline.json (ADR-021).
//
//   npm run eval                          fails if any count differs from the
//                                         baseline, or the README block is stale
//   npm run eval -- --update              accepts better counts: rewrites the
//                                         baseline and the README block
//   npm run eval -- --update --accept "ADR-0xx: why"
//                                         accepts worse counts or a changed
//                                         dataset, and records the note
//   npm run eval -- --update --with-held-out
//                                         takes the first measurement of the
//                                         held-out set; from then on it is
//                                         part of every run
//   npm run eval -- --by-tag              also: held-out results per tag
//
// Wiring only (files in, text out); every decision is in a tested module.
// For the held-out set it prints counts, never text.

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
import { GENERATED_SEED, generateCases } from './generate.js';
import { checkHeldOut, loadHeldOut } from './held-out.js';
import { overRedactionTable, readmeBlock, scoreTable, withReadmeBlock } from './report.js';
import { percent, score, scoreByTag } from './score.js';
import { PERSONAL_TYPES } from './types.js';

const BASELINE_PATH = join(import.meta.dirname, 'baseline.json');
const README_PATH = join(import.meta.dirname, '..', 'README.md');

const args = process.argv.slice(2);
const update = args.includes('--update');
const accept = args.includes('--accept') ? args[args.indexOf('--accept') + 1] : undefined;
const write = (line = ''): void => void process.stdout.write(`${line}\n`);

const previous = existsSync(BASELINE_PATH)
  ? (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline)
  : undefined;

const generated = score(generateCases());
write(`## Generated dataset (seed ${GENERATED_SEED}, ${generated.messages} messages)`);
write();
write(scoreTable(generated));
write();
write(overRedactionTable(generated));
write();

const held = checkHeldOut();
const measured = scoresHeldOut(previous, args.includes('--with-held-out'));
let heldOut: Measurement['heldOut'];
if (!measured) {
  write(
    `## Held-out dataset: ${held.cases.length} cases, ${held.problems.length} lint problem(s); not measured yet`,
  );
  write('   (first measurement, once it is complete: npm run eval -- --update --with-held-out)');
  write();
} else if (held.problems.length > 0) {
  write(`eval/held-out.txt has ${held.problems.length} problem(s); run "npm run eval:lint".`);
  process.exit(1);
} else {
  const cases = loadHeldOut();
  heldOut = cases.length > 0 ? score(cases) : undefined;
  write(`## Held-out dataset (${cases.length} cases)`);
  write();
  if (heldOut) {
    write(scoreTable(heldOut));
    write();
    write(overRedactionTable(heldOut));
    write();
  }
  if (args.includes('--by-tag')) {
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

const now: Measurement = {
  date: new Date().toISOString().slice(0, 10),
  generated: { score: generated, seed: GENERATED_SEED },
  heldOut,
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
    write('      record it: npm run eval -- --update --accept "ADR-0xx: why"');
    process.exit(1);
  }
  if (state === 'better') {
    write('FAIL: better than the baseline. Make it the new floor: npm run eval -- --update');
    process.exit(1);
  }
  if (withReadmeBlock(readme, readmeBlock(previous!)) !== readme) {
    write('FAIL: the README evaluation block is out of date: npm run eval -- --update');
    process.exit(1);
  }
  write('OK: every count matches the baseline, and the README block is current.');
}

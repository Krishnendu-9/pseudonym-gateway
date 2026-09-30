// `npm run eval:lint`: checks eval/held-out.txt and prints what is wrong
// with it, by case id, line and rule, then a summary in counts. It never
// prints a line of the file, a tag or a label.
//
// Two flags are for the file's author, who may see what the file says:
//
//   npx tsx eval/check-held-out.ts --tags        how many cases carry each tag
//   npx tsx eval/check-held-out.ts --show H012   how that one case renders,
//                                                every character of a value
//                                                shown as "•"
//
// (Flags go to tsx directly: PowerShell drops the "--" in
// "npm run eval:lint -- --show H012".)

import { checkHeldOut, HELD_OUT_PATH, loadHeldOut, maskedText, summarise } from './held-out.js';

const write = (line: string): void => void process.stdout.write(`${line}\n`);
const counts = (record: Readonly<Record<string, number>>): string =>
  Object.entries(record)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, n]) => `${key} ${n}`)
    .join(', ') || 'none';

const { cases, problems } = checkHeldOut();
for (const p of problems) write(`${p.caseId} line ${p.line}: ${p.rule} - ${p.detail}`);

const summary = summarise(cases);
write('');
write(HELD_OUT_PATH);
write(`cases: ${summary.cases}   messages: ${summary.messages}`);
write(`values by type: ${counts(summary.values)}`);
write(
  process.argv.includes('--tags')
    ? `cases by tag: ${counts(summary.tags)}`
    : `tags: ${Object.keys(summary.tags).length}`,
);
write(problems.length === 0 ? 'no problems' : `${problems.length} problem(s)`);

const show = process.argv.indexOf('--show');
if (show >= 0) {
  const id = process.argv[show + 1];
  write('');
  if (problems.length > 0) {
    write('--show needs a file with no problems');
  } else {
    const found = loadHeldOut().find((c) => c.id === id);
    if (!found) write(`no case with the id ${id}`);
    for (const message of found?.messages ?? []) {
      write(`@${message.role}`);
      write(maskedText(message));
    }
  }
}

process.exitCode = problems.length === 0 ? 0 : 1;

// Vitest reporter for the mutation runner (scripts/mutate.ts): one line per
// finished test, "state<TAB>full name", appended as it happens, so a run
// stopped at its time limit still has counts. Names only, never failure
// messages: those can quote a value.

import { appendFileSync } from 'node:fs';
import type { Reporter, TestCase, TestModule } from 'vitest/node';

const out = process.env.MUT_PROGRESS ?? '';

export default class MutationReporter implements Reporter {
  onTestCaseResult(testCase: TestCase): void {
    appendFileSync(out, `${testCase.result().state}\t${testCase.fullName}\n`);
  }

  onTestModuleEnd(module: TestModule): void {
    if (module.state() === 'failed' && module.errors().length > 0) {
      appendFileSync(out, `module-error\t${module.moduleId.split(/[\\/]/).at(-1)}\n`);
    }
  }
}

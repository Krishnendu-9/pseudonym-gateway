// Mutations of the ONNX Runtime telemetry switch (ADR-046), for
// scripts/mutate.ts:
//
//   npx tsx scripts/mutate.ts --out <dir outside the repo> scripts/mutations/runtime-telemetry.ts
//
// Written with the change they check, on 2026-10-10. That the runtime's
// native code honours the switch is shown on the image, not here: with it,
// no telemetry files are written (ADR-046).

import type { Mutation } from '../mutate.js';

const WORKER = 'src/gateway/name-worker.ts';
const TESTS = ['test/unit/gateway/name-worker.test.ts'];

export const MUTATIONS: readonly Mutation[] = [
  {
    id: 'OT1',
    what: 'the thread is started without turning telemetry off',
    file: WORKER,
    tests: TESTS,
    find: '    disableRuntimeTelemetry();\n',
    replace: '',
  },
  {
    id: 'OT2',
    what: 'the switch is set to a value the runtime reads as on',
    file: WORKER,
    tests: TESTS,
    find: "env.ORT_DISABLE_TELEMETRY = '1';",
    replace: "env.ORT_DISABLE_TELEMETRY = '0';",
  },
  {
    id: 'OT3',
    what: 'an existing value is kept instead of overridden',
    file: WORKER,
    tests: TESTS,
    find: "env.ORT_DISABLE_TELEMETRY = '1';",
    replace: "env.ORT_DISABLE_TELEMETRY ??= '1';",
  },
  // Added the same day, with the Windows start-up line (ADR-046 amendment D).
  {
    id: 'OT4',
    what: 'the Windows line is never printed',
    file: WORKER,
    tests: TESTS,
    find: "return platform === 'win32'",
    replace: "return platform === 'none'",
  },
  {
    id: 'OT5',
    what: 'the line is printed everywhere but Linux (macOS included, where it is untrue)',
    file: WORKER,
    tests: TESTS,
    find: "return platform === 'win32'",
    replace: "return platform !== 'linux'",
  },
  {
    id: 'OT6',
    what: 'the line is printed on every platform',
    file: WORKER,
    tests: TESTS,
    find: "return platform === 'win32'",
    replace: 'return platform === platform',
  },
];

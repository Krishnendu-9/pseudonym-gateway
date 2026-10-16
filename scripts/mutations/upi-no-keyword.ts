// Mutation of the UPI test for `<mobile>.<name>@<unknown handle>` with no
// keyword (ADR-049, 2026-10-16), for scripts/mutate.ts:
//
//   npx tsx scripts/mutate.ts --out <dir outside the repo> scripts/mutations/upi-no-keyword.ts
//
// Written with the change it checks. U1 trusts exactly that shape: an
// unknown handle counts as validated when its name is a digit run and a
// dot, so the whole ID is redacted with no keyword, and the user manual's
// "only the mobile is replaced" stops being true. U1 also flips the
// ADR-029 keyword test (it asserts validated: false), so U2 makes the same
// shape count as if a keyword were near, validation unchanged: only the
// new test can catch that.

import type { Mutation } from '../mutate.js';

export const MUTATIONS: readonly Mutation[] = [
  {
    id: 'U1',
    what: 'an unknown handle is trusted when its name is a digit run and a dot',
    file: 'src/detection/upi.ts',
    tests: ['test/unit/detection/upi.test.ts'],
    find: '      validated: UPI_HANDLES.has(handle.toLowerCase()),',
    replace:
      '      validated: UPI_HANDLES.has(handle.toLowerCase()) || /^[0-9]+\\./.test(text.slice(start, at)),',
  },
  {
    id: 'U2',
    what: 'the same shape counts as if a keyword were near, validation unchanged',
    file: 'src/detection/upi.ts',
    tests: ['test/unit/detection/upi.test.ts'],
    find: '      validated: UPI_HANDLES.has(handle.toLowerCase()),',
    replace:
      '      validated: UPI_HANDLES.has(handle.toLowerCase()),\n      ...(!UPI_HANDLES.has(handle.toLowerCase()) && /^[0-9]+\\./.test(text.slice(start, at)) ? { context: true } : {}),',
  },
];

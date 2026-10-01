// Vitest global setup: no test runs while a mutation may still be written
// into a source file (bug-log 24, scripts/mutation-marker.ts). Throwing here
// stops the whole run before any test file is loaded.

import { join } from 'node:path';
import { leftoverMutation } from '../../scripts/mutation-marker.js';

export default function refuseLeftoverMutation(): void {
  const refusal = leftoverMutation(join(import.meta.dirname, '..', '..'), process.env);
  if (refusal) throw new Error(refusal);
}

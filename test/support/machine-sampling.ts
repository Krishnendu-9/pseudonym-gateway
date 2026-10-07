// Vitest global setup: samples the machine for the whole run (free memory,
// CPU, processes; scripts/machine-sampler.ts) into .machine-samples/, and
// prints one line about it at the end, so that a slow or failing run
// arrives with evidence (bug-log 57; testing guide, step 5's unexplained
// gate run). In CI the line is in the job's log.

import { join } from 'node:path';
import { startSampling } from '../../scripts/machine-sampler.js';

export default function sampleTheMachine(): () => Promise<void> {
  // PSEUDONYM_MACHINE_SAMPLES=off: no sampling (to measure what the sampler
  // itself costs, Phase 6c).
  if (process.env.PSEUDONYM_MACHINE_SAMPLES === 'off') return () => Promise.resolve();
  const sampler = startSampling(join(import.meta.dirname, '..', '..'));
  return async () => {
    process.stdout.write(`\n${await sampler.stop()}\n`);
  };
}

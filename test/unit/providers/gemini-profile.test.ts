// Gemini's measured refusals (ADR-041 section 16, decisions C and D) are
// checked against the recordings they cite, so that an entry cannot rest on
// anything but a measurement. For every probe an entry cites: the recording
// exists, was sent to the entry's model, differs from s1 only by the entry's
// field, and has the status the rule predicts (400 where the rule refuses the
// value sent, 200 where it does not). Every entry cites at least one refusal.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GEMINI_PROFILE } from '../../../src/providers/gemini.js';
import type { RefusalRule } from '../../../src/providers/openai-compatible.js';

const RECORDINGS = join(import.meta.dirname, '..', '..', 'fixtures', 'gemini-7b');

interface Meta {
  readonly model: string;
  readonly status: number;
  readonly sentBody: Record<string, unknown>;
}

const meta = (probe: string): Meta =>
  JSON.parse(readFileSync(join(RECORDINGS, `${probe}.meta.json`), 'utf8')) as Meta;

// What the rule says about the value the probe sent.
function refuses(rule: RefusalRule, value: unknown): boolean {
  switch (rule.kind) {
    case 'any':
      return true;
    case 'nonzero':
      return value !== 0;
    case 'values':
      return (rule.values as readonly unknown[]).includes(value);
  }
}

const S1_KEYS = ['messages', 'model', 'stream'];

const entries = Object.entries(GEMINI_PROFILE.refusals ?? {}).flatMap(([model, rules]) =>
  Object.entries(rules).map(([field, rule]) => [model, field, rule] as const),
);

describe("Gemini's refusals, checked against their recordings", () => {
  it('there are entries to check', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)('%s %s: every cited probe agrees with the rule', (model, field, rule) => {
    expect(rule.probes.length).toBeGreaterThan(0);
    let refusedProbes = 0;
    for (const probe of rule.probes) {
      expect(existsSync(join(RECORDINGS, `${probe}.meta.json`)), probe).toBe(true);
      const m = meta(probe);
      expect([probe, m.model]).toEqual([probe, model]);
      expect([probe, Object.keys(m.sentBody).sort()]).toEqual([probe, [...S1_KEYS, field].sort()]);
      const expected = refuses(rule!, m.sentBody[field]) ? 400 : 200;
      expect([probe, m.status]).toEqual([probe, expected]);
      if (m.status === 400) refusedProbes++;
    }
    expect(refusedProbes).toBeGreaterThan(0);
  });

  it('reasoning_effort "none" is not listed until the s1/p09 pair settles it (decision D)', () => {
    for (const rules of Object.values(GEMINI_PROFILE.refusals ?? {})) {
      const rule = rules.reasoning_effort;
      if (rule?.kind === 'values') expect(rule.values).not.toContain('none');
    }
  });
});

// Gemini's measured refusals (ADR-041 section 16, decisions C and D) are
// checked against the recordings they cite, so that an entry cannot rest on
// anything but a measurement. For every probe an entry cites: the recording
// exists, was sent to the entry's model, differs from s1 only by the entry's
// field, and has the status the rule predicts (400 where the rule refuses the
// value sent, 200 where it does not). Every entry cites at least one refusal.
// A `values` rule that lists `accepted` must cover the field's whole enum,
// with every value measured by a cited probe, since its message then names
// the accepted values (ADR-041, result of the s1/p09 pair).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REASONING_EFFORTS } from '../../../src/gateway/schema.js';
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

  // The fields whose every accepted value the schema lists.
  const ENUMS: Readonly<Record<string, readonly unknown[]>> = {
    reasoning_effort: REASONING_EFFORTS,
  };

  it.each(entries)(
    '%s %s: accepted values, if listed, complete the enum and are each measured',
    (_model, field, rule) => {
      if (rule.kind !== 'values' || rule.accepted === undefined) return;
      const accepted = rule.accepted as readonly unknown[];
      const refused = rule.values as readonly unknown[];
      expect(accepted.filter((value) => refused.includes(value))).toEqual([]);
      expect(ENUMS[field], field).toBeDefined();
      expect([...refused, ...accepted].sort()).toEqual([...ENUMS[field]!].sort());
      const sent = rule.probes.map((probe) => meta(probe).sentBody[field]);
      for (const value of [...refused, ...accepted]) {
        expect([value, sent.includes(value)]).toEqual([value, true]);
      }
    },
  );

  it('reasoning_effort "none" is listed, resting on the s1/p09 pair (decision D, Attempt 7)', () => {
    const rule = GEMINI_PROFILE.refusals?.['gemini-3.5-flash-lite']?.reasoning_effort;
    expect(rule?.kind === 'values' && rule.values.includes('none')).toBe(true);
    expect(rule?.probes).toContain('attempt-7/p09');
    // The pair's control: s1 from the same run, answered 200, the same
    // request as p09 without the field.
    const s1 = meta('attempt-7/s1');
    const p09 = meta('attempt-7/p09');
    expect(s1.status).toBe(200);
    expect(p09.status).toBe(400);
    expect(s1.model).toBe(p09.model);
    const withoutField = Object.fromEntries(
      Object.entries(p09.sentBody).filter(([key]) => key !== 'reasoning_effort'),
    );
    expect(withoutField).toEqual(s1.sentBody);
  });
});

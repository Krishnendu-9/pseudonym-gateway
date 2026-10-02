// The model-rewrite tasks (ADR-017). Their text holds generated values, so
// these tests count and compare; they never print a message.

import { describe, expect, it } from 'vitest';
import { lintCases } from '../../../eval/lint.js';
import {
  REWRITE_SEED,
  REWRITE_TASKS,
  rewriteCases,
  rewriteRawCases,
} from '../../../eval/rewrite-tasks.js';
import { sentValues } from '../../../eval/rewrites.js';
import { detect } from '../../../src/detection/detect.js';
import { PlaceholderMapping } from '../../../src/redaction/mapping.js';
import { redactMessage } from '../../../src/redaction/redact.js';

describe('the rewrite tasks', () => {
  it('are 15, with unique ids', () => {
    expect(REWRITE_TASKS).toHaveLength(15);
    expect(new Set(REWRITE_TASKS.map((t) => t.id)).size).toBe(15);
  });

  it('pass the held-out lint: nothing typed looks like a value', () => {
    expect(lintCases(rewriteRawCases()).map((p) => `${p.caseId}: ${p.rule}`)).toEqual([]);
  });

  it('every planted value is redacted with its own type, one placeholder each, 34 in all', () => {
    let placeholders = 0;
    const ok = rewriteCases().every((c) => {
      const mapping = new PlaceholderMapping();
      let pieces = 0;
      const typed = c.messages.every((m) => {
        redactMessage(m.text, mapping);
        const found = detect(m.text);
        pieces += m.pieces.length;
        return m.pieces.every((p) =>
          found.some(
            (d) => d.type === p.type && p.required.every((at) => at >= d.start && at < d.end),
          ),
        );
      });
      placeholders += sentValues(mapping).length;
      return typed && sentValues(mapping).length === pieces;
    });
    expect([ok, placeholders]).toEqual([true, 34]);
  });

  it('render the same values from the same seed, and others from another', () => {
    const text = (seed: number): string =>
      rewriteCases(seed)
        .flatMap((c) => c.messages.map((m) => m.text))
        .join('\n');
    expect(text(REWRITE_SEED) === text(REWRITE_SEED)).toBe(true);
    expect(text(REWRITE_SEED) === text(REWRITE_SEED + 1)).toBe(false);
  });
});

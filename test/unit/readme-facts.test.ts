// The README's numbers that come from the code or from a stored result, read
// from the README and compared with their source, so that a published
// number cannot drift from what it describes (bug-log 52: the README said
// 54 UPI handles for a list of 51, from the day the list was written).
// The evaluation block is checked by `npm run eval` itself.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { IFSC_BANK_CODES } from '../../src/detection/ifsc.js';
import { UPI_HANDLES } from '../../src/detection/upi.js';
import { MAX_HELD_BACK } from '../../src/redaction/variants.js';

const ROOT = join(import.meta.dirname, '..', '..');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ');

/** The number captured by `pattern`'s first group, or NaN if the README lacks it. */
const numberIn = (pattern: RegExp): number => Number(pattern.exec(README)?.[1]);

describe('the README says what the code does', () => {
  it('the number of UPI handles and IFSC bank codes on the lists', () => {
    expect(numberIn(/list of (\d+) app and bank handles/)).toBe(UPI_HANDLES.size);
    expect(numberIn(/list of (\d+) \(every bank/)).toBe(IFSC_BANK_CODES.size);
  });

  it('how much a stream holds back', () => {
    expect(numberIn(/holding back at most (\d+) characters/)).toBe(MAX_HELD_BACK);
  });

  it('the size limits, as the defaults set them', () => {
    const env = loadEnv({ PSEUDONYM_MODEL: 'm' });
    expect(numberIn(/bodies over (\d+) KiB/) * 1024).toBe(env.PSEUDONYM_MAX_BODY_BYTES);
    expect(numberIn(/reads at most (\d+) MiB of a provider's response/) * 1024 ** 2).toBe(
      env.PSEUDONYM_MAX_RESPONSE_BYTES,
    );
    expect(numberIn(/and at most (\d+) MiB of a streamed one/) * 1024 ** 2).toBe(
      env.PSEUDONYM_MAX_STREAM_BYTES,
    );
  });

  it('the placeholder instruction is off by default, as the README says', () => {
    expect(README).toContain('Off by default (`PSEUDONYM_PLACEHOLDER_INSTRUCTION`)');
    expect(loadEnv({ PSEUDONYM_MODEL: 'm' }).PSEUDONYM_PLACEHOLDER_INSTRUCTION).toBe(false);
  });
});

describe('the README says what the model measurement stored', () => {
  const stored = JSON.parse(readFileSync(join(ROOT, 'eval', 'model-rewrites.json'), 'utf8')) as {
    model: string;
    tasks: unknown[];
    totals: Record<'on' | 'off', Record<string, number>>;
    decision: string;
  };

  it('its table rows', () => {
    for (const [condition, label] of [
      ['on', 'On'],
      ['off', 'Off'],
    ] as const) {
      const t = stored.totals[condition]!;
      const row = `| ${label} | ${t.values} | ${t.restored} | ${t.held} | ${t.rewritten} | ${t.dropped} | ${t.invented} |`;
      expect(README.replace(/ +/g, ' ')).toContain(row);
    }
  });

  it('its size, model and decision', () => {
    expect(README).toContain(
      `**${stored.tasks.length} tasks, ${stored.totals.on!.values} values per setting, one run**`,
    );
    expect(README).toContain(`\`${stored.model}\``);
    expect(stored.decision).toBe('off');
  });
});

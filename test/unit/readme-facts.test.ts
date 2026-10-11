// The README's numbers that come from the code or from a stored result, read
// from the README and compared with their source, so that a published
// number cannot drift from what it describes (bug-log 52: the README said
// 54 UPI handles for a list of 51, from the day the list was written).
// The evaluation block is checked by `npm run eval` itself.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fpPer1000, share, type Metrics } from '../../eval/names/measure.js';
import { loadEnv } from '../../src/config/env.js';
import { NAMES_TIMEOUT_MS_DEFAULT } from '../../src/config/wiring.js';
import { CONTEXT_WINDOW } from '../../src/detection/context.js';
import { IFSC_BANK_CODES } from '../../src/detection/ifsc.js';
import { MIN_NUMBER_DIGITS } from '../../src/detection/number.js';
import { UPI_HANDLES } from '../../src/detection/upi.js';
import { PROVIDER_RETRY_AFTER_SECONDS } from '../../src/gateway/errors.js';
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

  it('the Retry-After sent with a provider 429', () => {
    expect(numberIn(/`Retry-After: (\d+)`/)).toBe(PROVIDER_RETRY_AFTER_SECONDS);
  });

  it("the safety net's digits and the keyword window", () => {
    expect(numberIn(/Any other number of (\d+)\+ digits/)).toBe(MIN_NUMBER_DIGITS);
    expect(numberIn(/naming them within (\d+) characters/)).toBe(CONTEXT_WINDOW);
  });

  it("the name detector's default timeout", () => {
    expect(numberIn(/The timeout's default, (\d+) s/) * 1000).toBe(NAMES_TIMEOUT_MS_DEFAULT);
  });
});

// The person-name figures measured without AVX-512 (Phase 6a, reproduced by
// `npm run eval:names`), read from the baseline that check compares with.
// Not checked here, because no stored file holds them: the AVX-512 column
// (502, 934, 662/934) and the held-out 41 of 45.
describe('the README says what the names baseline stored', () => {
  const baseline = JSON.parse(readFileSync(join(ROOT, 'eval', 'names-baseline.json'), 'utf8')) as {
    dataset: { messages: number };
    detections: number;
    metrics: Metrics;
  };
  const m = baseline.metrics;
  // Percentages are cut to one decimal, as the measurement printed them.
  const pct = (c: { hit: number; of: number }): string =>
    `${(Math.floor(share(c) * 1000) / 10).toFixed(1)}%`;
  const fp = fpPer1000(m).toFixed(2);

  it('names found on the generated set', () => {
    const { hit, of } = m.recall;
    expect(README).toContain(`**${hit}/${of} (${pct(m.recall)})**`);
    expect(README).toContain(`${hit} of ${of} names (${pct(m.recall)})`);
    expect(README).toContain(`| Names found (${of}) | ${hit} (${pct(m.recall)})`);
    expect(README).toContain(`| **B and F together** | **${hit} (${pct(m.recall)})**`);
    expect(README).toContain(`with names on, ${hit} are found`);
    expect(README).toContain(`miss: ${of - hit} of ${of} on the generated set`);
  });

  it('precision, detections and false positives', () => {
    const { hit, of } = m.precision;
    expect(of).toBe(baseline.detections);
    expect(README).toContain(`${hit}/${of} (${pct(m.precision)})`);
    expect(README).toContain(`| Detections, precision | ${of}, ${pct(m.precision)}`);
    expect(README).toContain(`one detection in ${of}`);
    expect(README).toContain(`about ${fp} words in 1,000`);
    expect(README).toContain(`**${fp}**`);
  });

  it('the main cases, lower-case names and the message count', () => {
    expect(README).toContain(`| Main cases, PERSON | ${m.main.hit}/${m.main.of}`);
    const lower = m.rows['name-form:lower']!;
    expect(README).toContain(`names in all lower case (${lower.hit} of ${lower.of} found`);
    expect(README).toContain(
      `sends the ${baseline.dataset.messages.toLocaleString('en-US')} measured messages`,
    );
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

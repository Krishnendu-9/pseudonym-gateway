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
import { NAME_MODEL } from '../../src/gateway/name-model.js';
import { redactRequest } from '../../src/gateway/redact-request.js';
import { parseChatRequest } from '../../src/gateway/schema.js';
import { PlaceholderMapping } from '../../src/redaction/mapping.js';
import { MAX_HELD_BACK } from '../../src/redaction/variants.js';
import vitestConfig from '../../vitest.config.js';
import { MAX_GROWTH_RATIO } from '../support/linear-time.js';
import { assertTextEqualQuietly } from '../support/quiet-text.js';

const ROOT = join(import.meta.dirname, '..', '..');
const RAW_README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const README = RAW_README.replace(/\s+/g, ' ');

/** The status box: the block quote that starts "**Status", as one line. */
const statusBox = (): string => {
  const lines = RAW_README.split('\n');
  const start = lines.findIndex((line) => line.startsWith('> **Status'));
  if (start === -1) return '';
  const box: string[] = [];
  for (let i = start; i < lines.length && lines[i]!.startsWith('>'); i++) {
    box.push(lines[i]!.replace(/^>\s?/, ''));
  }
  return box.join(' ').replace(/\s+/g, ' ');
};

// A tripwire, not proof (ADR-049): no test can tell whether the project is
// ready for production, but neither sentence can now vanish in an edit
// without this test changing too. "Phase N of 8" is not pinned: nothing in
// the repository holds the phase count to compare with. Since Phase 8 was
// ruled done (2026-10-16) the box joins the two in one sentence, "Not ready
// for production use: every figure here is measured on synthetic data", so
// the second check ignores case; both must still be inside the box, not
// merely somewhere in the README (mutations S3 and S4).
describe("the README's status box", () => {
  it('says the project is not ready for production use', () => {
    expect(statusBox()).toContain('Not ready for production use');
  });

  it('says every figure is measured on synthetic data', () => {
    expect(statusBox()).toMatch(/every figure here is measured on synthetic data/i);
  });
});

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

  // ADR-049: these two were pinned nowhere, so the class C ruling ("already
  // pinned once") did not cover them.
  it("the timing tests' growth limit", () => {
    expect(numberIn(/fails if the time grows (\d+) times or more/)).toBe(MAX_GROWTH_RATIO);
  });

  it("CI's coverage threshold, as vitest.config.ts sets it", () => {
    const coverage = vitestConfig.test?.coverage as { thresholds?: unknown } | undefined;
    expect(coverage?.thresholds).toEqual({ 100: true });
    expect(README).toContain('fails below 100% of lines, branches, functions and statements');
  });

  it("the name detector's default timeout", () => {
    expect(numberIn(/The timeout's default, (\d+) s/) * 1000).toBe(NAMES_TIMEOUT_MS_DEFAULT);
  });

  // The download is every pinned file, the model file only one of them: the
  // manual once gave the model file's size as the download's.
  // A size is a cost, so it is rounded up to the precision shown, never
  // down (ADR-049): a ceiling at one decimal, not toFixed's nearest.
  it('what fetch:model downloads, and the model file within it', () => {
    const mb = (bytes: number): string => (Math.ceil(bytes / 1e5) / 10).toFixed(1);
    const total = NAME_MODEL.files.reduce((sum, file) => sum + file.bytes, 0);
    const model = NAME_MODEL.files.find((file) => file.path.endsWith('.onnx'))!;
    expect(NAME_MODEL.files).toHaveLength(4);
    expect(README).toContain(
      `(four files, ${mb(total)} MB, of which the model file is ${mb(model.bytes)} MB)`,
    );
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

// The threat model's free-tier figures: how many labelled personal values
// the generated main cases send as written with names off (ADR-040), read
// from the baseline `npm run eval` compares with. The stored sent count is
// a total per part, not per type, so the split into names and the rest is
// checked two ways: every PERSON value is missed by detection (so none is
// redacted, and all are among those sent), and the rest of the sent count
// equals the other types' values that detection left unredacted.
describe('the README says what the evaluation baseline stored', () => {
  const baseline = JSON.parse(readFileSync(join(ROOT, 'eval', 'baseline.json'), 'utf8')) as {
    measuredOn: string;
    generated: {
      cases: number;
      types: Record<string, { values: number; redacted: number; missed: number }>;
      sent: Record<string, { values: number; sent: number }>;
    };
  };
  const { cases, types, sent } = baseline.generated;
  const main = sent.main!;
  const names = types.PERSON!;
  const n = (x: number): string => x.toLocaleString('en-US');

  it('the number of main cases', () => {
    expect(README).toContain(`**${n(cases)} main cases**`);
  });

  it('values sent as written in the main cases, names off', () => {
    expect(README).toContain(
      `${n(main.sent)} of ${n(main.values)} labelled personal values are sent as written`,
    );
    expect(README).toContain(`(the results block above, ${baseline.measuredOn})`);
  });

  it('every person name among them, and the rest', () => {
    expect(names.missed).toBe(names.values);
    expect(README).toContain(`all ${n(names.values)} person names`);
    const otherSent = main.sent - names.values;
    const otherValues = main.values - names.values;
    const otherUnredacted = Object.entries(types)
      .filter(([type]) => type !== 'PERSON')
      .reduce((sum, [, t]) => sum + t.values - t.redacted, 0);
    expect(otherSent).toBe(otherUnredacted);
    expect(README).toContain(`${n(otherSent)} of the other ${n(otherValues)} values`);
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

// The demo recording's caption (2026-10-16). The GIF's third command prints
// the request recorded on its way to Gemini on 2026-10-15 (attempt-8, e1),
// not the one sent on camera, and the caption says today's code redacts the
// demo request to the same text. That holds only while the fixture carries
// e1's messages and detection, numbering and the default placeholder
// instruction stay as they were, so the fixture is redacted here as
// `npm run dev` would and compared with the recording. Compared quietly: the
// values are synthetic, but a failure means one may not have been redacted.
describe("the README's demo recording", () => {
  interface Body {
    messages: { role: string; content: string }[];
  }
  const body = (path: string): Body =>
    JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', path), 'utf8')) as Body;
  const demo = body('demo-request.json');
  const recordedRequest = body('gemini-7b/attempt-8/e1.request.json');
  const recordedSent = body('gemini-7b/attempt-8/e1.sent.json');

  it('the caption makes the claim this checks', () => {
    expect(README).toContain(
      "today's code redacts the same message to the same text, byte for byte",
    );
  });

  it("the demo request carries the recorded request's messages", () => {
    assertTextEqualQuietly(JSON.stringify(demo.messages), JSON.stringify(recordedRequest.messages));
  });

  it("today's code redacts it to what the provider received, with the default settings", () => {
    const { PSEUDONYM_PLACEHOLDER_INSTRUCTION } = loadEnv({ PSEUDONYM_MODEL: 'm' });
    const sent = redactRequest(parseChatRequest(demo), new PlaceholderMapping(), {
      placeholderInstruction: PSEUDONYM_PLACEHOLDER_INSTRUCTION,
    });
    expect(sent.messages.map((m) => m.role)).toEqual(recordedSent.messages.map((m) => m.role));
    sent.messages.forEach((m, i) =>
      assertTextEqualQuietly(m.content, recordedSent.messages[i]!.content),
    );
  });
});

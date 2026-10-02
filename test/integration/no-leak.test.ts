// The no-leak test (CLAUDE.md, "How we prove it works"): hundreds of
// synthetic messages full of personal data go through the real gateway
// (Fastify, allowlist, redaction, the Ollama adapter) to a mock provider
// that records the raw bytes it receives. No planted value may appear in
// any outgoing request in any form: raw, lowercased, normalised, or with
// its separators removed (test/support/leak-check.ts).
//
// Values are placed everywhere client text can travel: system, user and
// assistant messages, text-part arrays, `stop`, and the dropped `user`
// field; written plainly, grouped with spaces or hyphens, and disguised
// (digits in other scripts, invisible characters between them).
//
// Every planted value is generated in memory from a seed (ADR-009). A
// failure reports the history, the value's type and the form it leaked in,
// never the value. How this test is shown to be able to fail (disabling a
// detector) is recorded in dev_docs/testing-guide.md.
//
// The second block does it all again with stream: true (ADR-019), and
// checks the streamed answer restores exactly what the user wrote.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dateOfBirth,
  ifsc,
  ipAddress,
  passportNumber,
  secret,
  upiId,
  voterId,
  type SecretKind,
} from '../../src/synthetic/identifiers.js';
import { obfuscate } from '../../src/synthetic/obfuscate.js';
import { createRng, type Rng } from '../../src/synthetic/rng.js';
import {
  aadhaar,
  cardNumber,
  email,
  groupDigits,
  indianMobile,
  pan,
} from '../../src/synthetic/values.js';
import {
  chatBody,
  post,
  readStreamed,
  startTestGateway,
  TEST_MODEL,
  type TestGateway,
} from '../support/gateway.js';
import { echoLastUserMessage, echoLastUserMessageStreamed } from '../support/mock-provider.js';
import { expandCaptured, leakedForm } from '../support/leak-check.js';
import { assertTextEqualQuietly } from '../support/quiet-text.js';

type PlantedType =
  | 'AADHAAR'
  | 'CARD'
  | 'PAN'
  | 'EMAIL'
  | 'PHONE'
  | 'NUMBER'
  | 'SECRET'
  | 'UPI'
  | 'IFSC'
  | 'IP'
  | 'PASSPORT'
  | 'VOTER'
  | 'DOB';

interface Planted {
  readonly type: PlantedType;
  readonly value: string;
}

const PLANTED_TYPES: readonly PlantedType[] = [
  'AADHAAR',
  'CARD',
  'PAN',
  'EMAIL',
  'PHONE',
  'NUMBER',
  'SECRET',
  'UPI',
  'IFSC',
  'IP',
  'PASSPORT',
  'VOTER',
  'DOB',
];

// The keyword-only types (ADR-031) are written after one of their keywords:
// without one they are not personal by design. The keyword is text around
// the value, not part of it: only the value is looked for in what was sent.
const KEYWORDS: Partial<Record<PlantedType, readonly string[]>> = {
  PASSPORT: ['Passport no: ', 'passport ', 'पासपोर्ट '],
  VOTER: ['Voter ID: ', 'EPIC ', 'मतदाता पहचान पत्र '],
  DOB: ['DOB: ', 'born on ', 'Date of birth ', 'जन्म तिथि '],
};

// Secrets in a known format: the ones found without a keyword, which the
// sentences below do not have.
const SECRET_KINDS: readonly SecretKind[] = [
  'openai',
  'anthropic',
  'github',
  'aws',
  'stripe',
  'razorpay',
  'slack',
  'google',
  'jwt',
];

// A value in one of the ways real text writes it. Every form here is one the
// detectors are specified to catch (validated values; NUMBER is 9+ digits).
// Aadhaar, card and phone numbers are sometimes wrapped onto the next line
// (ADR-030); a wrapped phone needs its keyword, so it is planted with one.
// Not an Aadhaar wrapped as two unbroken groups (6 / 6): with a number beside
// it, which the histories add, that is a known gap (ADR-030).
function plantValue(rng: Rng, type: PlantedType): string {
  const disguise = (text: string): string => (rng.chance(0.25) ? obfuscate(text, rng) : text);
  const lineBreak = (): string => rng.pick(['\n', '\r\n', ' \n']);
  switch (type) {
    case 'AADHAAR': {
      const v = aadhaar(rng);
      return disguise(
        rng.pick([
          v,
          groupDigits(v, [4, 4, 4], ' '),
          groupDigits(v, [4, 4, 4], '-'),
          `${groupDigits(v.slice(0, 8), [4, 4], ' ')}${lineBreak()}${v.slice(8)}`,
        ]),
      );
    }
    case 'CARD': {
      const v = cardNumber(rng);
      const sizes = v.length === 15 ? [4, 6, 5] : [4, 4, 4, 4];
      const wrapAt = v.length === 15 ? 10 : 8;
      const wrapped = `${groupDigits(v.slice(0, wrapAt), sizes.slice(0, 2), ' ')}${lineBreak()}${groupDigits(v.slice(wrapAt), sizes.slice(2), ' ')}`;
      return disguise(
        rng.pick([v, groupDigits(v, sizes, ' '), groupDigits(v, sizes, '-'), wrapped]),
      );
    }
    case 'PAN': {
      const v = pan(rng);
      return rng.chance(0.2) ? v.toLowerCase() : v;
    }
    case 'EMAIL':
      return disguise(email(rng));
    case 'PHONE': {
      const v = indianMobile(rng);
      return disguise(
        rng.pick([
          v,
          groupDigits(v, [5, 5], ' '),
          `+91 ${groupDigits(v, [5, 5], ' ')}`,
          `+91-${v}`,
          `0${v}`,
          `+91${v}`,
          `Mobile: ${v.slice(0, 5)}${lineBreak()}${v.slice(5)}`,
        ]),
      );
    }
    case 'NUMBER':
      // A bank-account-like number, 9-16 digits, no checks to pass.
      return disguise(String(rng.int(1, 9)) + rng.digits(rng.int(8, 15)));
    case 'SECRET':
      return disguise(secret(rng, rng.pick(SECRET_KINDS)));
    case 'UPI': {
      // At a known handle: the sentences below have no UPI keyword.
      const v = upiId(rng, rng.pick(['name', 'mobile'] as const));
      return disguise(rng.chance(0.2) ? v.toUpperCase() : v);
    }
    case 'IP':
      // A documentation address standing in for a public one (ADR-026),
      // IPv4 or IPv6: the sentences below have no IP keyword.
      return disguise(ipAddress(rng, rng.pick(['v4', 'v6'] as const)));
    case 'IFSC': {
      // With a known bank code: the sentences below have no IFSC keyword.
      const v = ifsc(rng);
      return disguise(rng.chance(0.2) ? v.toLowerCase() : v);
    }
    case 'PASSPORT': {
      const v = passportNumber(rng);
      return disguise(rng.chance(0.2) ? v.toLowerCase() : v);
    }
    case 'VOTER': {
      const v = voterId(rng);
      return disguise(rng.chance(0.2) ? v.toLowerCase() : v);
    }
    case 'DOB':
      return disguise(dateOfBirth(rng));
  }
}

const TEMPLATES: readonly ((v: string) => string)[] = [
  (v) => `Please update my records, the value is ${v} as discussed.`,
  (v) => `Customer wrote: ${v}. Can you check this today?`,
  (v) => `Mera detail ${v} hai, kripya jaldi check karein.`,
  (v) => `Forwarding from the ticket: "${v}" (see attachment).`,
  (v) => `${v} is what they gave us on the call.`,
  (v) => `Details below:\n- ${v}\n- nothing else on file`,
];

interface History {
  readonly body: Record<string, unknown>;
  readonly planted: readonly Planted[];
  /** The last user message's text as the client wrote it (parts joined). */
  readonly lastUserText: string;
  /** Values written with a digit beside them, and pairs of numbers side by side. */
  readonly neighbours: { readonly beside: number; readonly pairs: number };
}

// Neighbours (bug-log 34): a digit, a digit group or a digit-led token right
// before or after a value; or two values of any types, with only a space,
// " - ", ". " or a hyphen between them (bug-log 35, ADR-029). No pair is
// left out.
const BESIDE: readonly ((v: string, rng: Rng) => string)[] = [
  (v, rng) => `${rng.int(1, 9)} ${v}`,
  (v, rng) => `${v} ${rng.int(1, 9)}`,
  (v, rng) => `${v} ${rng.int(10000, 99999)}`,
  (v) => `${v} 24x7`,
];
const PAIR_SEPARATORS = [' ', ' - ', '. ', '-'] as const;

function makeHistory(rng: Rng): History {
  const planted: Planted[] = [];
  const neighbours = { beside: 0, pairs: 0 };
  const plant = (types: readonly PlantedType[]): string => {
    const type = rng.pick(types);
    const value = plantValue(rng, type);
    planted.push({ type, value });
    const keywords = KEYWORDS[type];
    return keywords ? `${rng.pick(keywords)}${value}` : value;
  };
  const text = (): string => {
    const count = rng.int(1, 3);
    const sentences: string[] = [];
    for (let i = 0; i < count; i++) {
      let written: string;
      if (rng.chance(0.15)) {
        written = `${plant(PLANTED_TYPES)}${rng.pick(PAIR_SEPARATORS)}${plant(PLANTED_TYPES)}`;
        neighbours.pairs++;
      } else {
        written = plant(PLANTED_TYPES);
        if (rng.chance(0.15)) {
          written = rng.pick(BESIDE)(written, rng);
          neighbours.beside++;
        }
      }
      sentences.push(rng.pick(TEMPLATES)(written));
    }
    return sentences.join(' ');
  };

  const messages: Record<string, unknown>[] = [];
  if (rng.chance(0.3)) messages.push({ role: 'system', content: `Account context: ${text()}` });
  const turns = rng.int(1, 3);
  let lastUserText = '';
  for (let turn = 0; turn < turns; turn++) {
    if (turn > 0) messages.push({ role: 'assistant', content: text() });
    if (rng.chance(0.3)) {
      const parts = [text(), text()];
      lastUserText = parts.join(' ');
      messages.push({ role: 'user', content: parts.map((p) => ({ type: 'text', text: p })) });
    } else {
      lastUserText = text();
      messages.push({ role: 'user', content: lastUserText });
    }
  }

  const body: Record<string, unknown> = { model: TEST_MODEL, messages };
  if (rng.chance(0.2)) body.stop = [text()];
  if (rng.chance(0.2)) {
    const value = email(rng);
    planted.push({ type: 'EMAIL', value });
    body.user = value;
  }
  return { body, planted, lastUserText, neighbours };
}

/** Histories totalling at least 300 messages, from one seed. */
function makeHistories(seed: number): History[] {
  const rng = createRng(seed);
  const histories: History[] = [];
  let messageCount = 0;
  while (messageCount < 300) {
    const history = makeHistory(rng);
    histories.push(history);
    messageCount += (history.body.messages as unknown[]).length;
  }
  return histories;
}

/**
 * Sends every history (its body shaped by `bodyOf`) and fails if any
 * planted value reached the provider in any form. The failure counts leaked
 * values by "TYPE form" (e.g. "CARD squashed") and names the first few
 * histories: small enough to print in full, and never a value.
 */
async function expectNoLeaks(
  gateway: TestGateway,
  histories: readonly History[],
  bodyOf: (history: History) => Record<string, unknown>,
): Promise<void> {
  const leaks: Record<string, number> = {};
  const firstLeaks: string[] = [];
  const statuses: number[] = [];
  const sentBefore = gateway.provider.requests.length;
  for (const [i, history] of histories.entries()) {
    const before = gateway.provider.requests.length;
    const response = await post(gateway, bodyOf(history));
    statuses.push(response.statusCode);
    const sent = gateway.provider.requests.slice(before);
    const captured = expandCaptured(sent.map((r) => r.body).join('\n'));
    for (const planted of history.planted) {
      const form = leakedForm(captured, planted.value);
      if (!form) continue;
      const key = `${planted.type} ${form}`;
      leaks[key] = (leaks[key] ?? 0) + 1;
      if (firstLeaks.length < 5) firstLeaks.push(`history ${i}: ${key}`);
    }
  }

  expect(statuses.filter((s) => s !== 200)).toEqual([]);
  expect(gateway.provider.requests.length - sentBefore).toBe(histories.length);
  expect(histories.length).toBeGreaterThan(50);
  expect(histories.reduce((n, h) => n + h.planted.length, 0)).toBeGreaterThan(500);
  // Thrown rather than compared: Vitest truncates objects in its failure
  // messages, and the full breakdown is what the mutation record needs.
  if (firstLeaks.length > 0) {
    throw new Error(
      `Leaks by type and form: ${JSON.stringify(leaks)}; first: ${firstLeaks.join(', ')}`,
    );
  }
}

describe('no-leak: nothing planted reaches the provider', () => {
  let gateway: TestGateway;
  const histories = makeHistories(20_260_929);

  beforeAll(async () => {
    gateway = await startTestGateway();
    gateway.provider.respondWith(echoLastUserMessage);
  });

  afterAll(async () => {
    await gateway.close();
  });

  it('sends every history, and no planted value in any form', async () => {
    await expectNoLeaks(gateway, histories, (h) => h.body);
  });

  it('restores every value in the answer (the provider echoes the last user message)', async () => {
    for (const history of histories.slice(0, 40)) {
      const response = await post(gateway, history.body);
      const answer = (response.json() as { choices: { message: { content: string } }[] })
        .choices[0]!.message.content;
      assertTextEqualQuietly(answer, history.lastUserText);
    }
  });

  it('covers every planted type and every position', () => {
    const types = new Set(histories.flatMap((h) => h.planted.map((p) => p.type)));
    expect([...types].sort()).toEqual([...PLANTED_TYPES].sort());
    const besides = histories.reduce((n, h) => n + h.neighbours.beside, 0);
    const pairs = histories.reduce((n, h) => n + h.neighbours.pairs, 0);
    expect(besides).toBeGreaterThan(50);
    expect(pairs).toBeGreaterThan(50);
    const wrapped = histories.flatMap((h) => h.planted).filter((p) => p.value.includes('\n'));
    expect(new Set(wrapped.map((p) => p.type))).toEqual(new Set(['AADHAAR', 'CARD', 'PHONE']));
    expect(wrapped.length).toBeGreaterThan(30);
    const bodies = histories.map((h) => h.body);
    expect(bodies.some((b) => b.stop !== undefined)).toBe(true);
    expect(bodies.some((b) => b.user !== undefined)).toBe(true);
    const messages = bodies.flatMap((b) => b.messages as { role: string; content: unknown }[]);
    expect(messages.some((m) => m.role === 'system')).toBe(true);
    expect(messages.some((m) => m.role === 'assistant')).toBe(true);
    expect(messages.some((m) => Array.isArray(m.content))).toBe(true);
  });

  it('a minimal request with nothing personal is forwarded unchanged', async () => {
    const before = gateway.provider.requests.length;
    await post(gateway, chatBody('What is the capital of France?'));
    const sent = JSON.parse(gateway.provider.requests[before]!.body) as {
      messages: { content: string }[];
    };
    expect(sent.messages.map((m) => m.content)).toEqual(['What is the capital of France?']);
  });
});

// Streaming (ADR-019): another set of histories, sent with stream: true.
// The provider streams the redacted last user message back cut into pieces,
// inside most placeholders and at a few other places, so the round trip
// also shows that the stream restorer never loses, doubles or garbles a
// placeholder split across chunks.

const PLACEHOLDER = /\[[A-Z]+_\d+\]/g;

let cutsInsidePlaceholders = 0;

/** Cuts `text` inside most of its placeholders, and at up to 4 other places. */
function cutPieces(text: string, rng: Rng): string[] {
  const cuts = new Set<number>();
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (rng.chance(0.8)) {
      cuts.add(match.index + rng.int(1, match[0].length - 1));
      cutsInsidePlaceholders++;
    }
  }
  const extra = rng.int(0, 4);
  for (let i = 0; i < extra && text.length > 1; i++) cuts.add(rng.int(1, text.length - 1));
  const pieces: string[] = [];
  let from = 0;
  for (const at of [...cuts].sort((a, b) => a - b)) {
    pieces.push(text.slice(from, at));
    from = at;
  }
  pieces.push(text.slice(from));
  return pieces;
}

describe('no-leak: streaming', () => {
  let gateway: TestGateway;
  const histories = makeHistories(20_260_930);

  beforeAll(async () => {
    gateway = await startTestGateway();
    const cutRng = createRng(4_040);
    gateway.provider.respondWith(
      echoLastUserMessageStreamed((text) => cutPieces(text, cutRng), { usage: true }),
    );
  });

  afterAll(async () => {
    await gateway.close();
  });

  it('sends every history with stream: true, and no planted value in any form', async () => {
    await expectNoLeaks(gateway, histories, (h) => ({ ...h.body, stream: true }));
    const streamedFlags = gateway.provider.requests.map(
      (r) => (JSON.parse(r.body) as { stream: unknown }).stream,
    );
    expect(new Set(streamedFlags)).toEqual(new Set([true]));
  });

  it('restores every value in the streamed answer, however it was cut', async () => {
    cutsInsidePlaceholders = 0;
    for (const history of histories) {
      const response = await post(gateway, {
        ...history.body,
        stream: true,
        stream_options: { include_usage: true },
      });
      const streamed = readStreamed(response.body);
      if (!streamed.done || streamed.error) throw new Error('a stream did not finish cleanly');
      assertTextEqualQuietly(streamed.content, history.lastUserText);
    }
    // The cuts really did land inside placeholders, many times over (233
    // with these seeds).
    expect(cutsInsidePlaceholders).toBeGreaterThan(150);
  });
});

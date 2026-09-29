// redactRequest: every piece of client text goes through redactMessage()
// against one mapping, in a fixed order, and the result is the only thing a
// provider can be given (RedactedText, checked at compile time below).

import { describe, expect, it } from 'vitest';
import { detect } from '../../../src/detection/detect.js';
import { PLACEHOLDER_INSTRUCTION } from '../../../src/gateway/instruction.js';
import { PART_SEPARATOR, redactRequest } from '../../../src/gateway/redact-request.js';
import { parseChatRequest } from '../../../src/gateway/schema.js';
import type { ProviderChatRequest } from '../../../src/providers/provider.js';
import { PlaceholderMapping } from '../../../src/redaction/mapping.js';
import { restore } from '../../../src/redaction/restore.js';

const CARD = '4111 1111 1111 1111';
const OTHER_CARD = '5555 5555 5555 4444';

const run = (body: Record<string, unknown>, placeholderInstruction = false) => {
  const mapping = new PlaceholderMapping();
  const request = redactRequest(parseChatRequest({ model: 'm', ...body }), mapping, {
    placeholderInstruction,
  });
  return { request, mapping };
};

describe('redactRequest', () => {
  it('numbers values across the history in conversation order, then stop', () => {
    const { request } = run({
      messages: [
        { role: 'system', content: `Known card ${CARD}` },
        { role: 'user', content: [{ type: 'text', text: `New card ${OTHER_CARD}` }] },
        { role: 'assistant', content: `Noted ${CARD}` },
      ],
      stop: ['asha@example.org'],
    });
    expect(request.messages).toEqual([
      { role: 'system', content: 'Known card [CARD_1]' },
      { role: 'user', content: 'New card [CARD_2]' },
      { role: 'assistant', content: 'Noted [CARD_1]' },
    ]);
    expect(request.stop).toEqual(['[EMAIL_1]']);
  });

  it('joins text parts with a space, detection seeing the joined text', () => {
    expect(PART_SEPARATOR).toBe(' ');
    const { request } = run({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'card 4111 1111' },
            { type: 'text', text: '1111 1111' },
            { type: 'text', text: 'end' },
          ],
        },
      ],
    });
    expect(request.messages[0]!.content).toBe('card [CARD_1] end');
  });

  it('a stop string becomes a one-element array; no stop, no key', () => {
    expect(run({ messages: [{ role: 'user', content: 'x' }], stop: 'END' }).request.stop).toEqual([
      'END',
    ]);
    expect(run({ messages: [{ role: 'user', content: 'x' }] }).request).not.toHaveProperty('stop');
  });

  it('forwards only the sampling settings, never user or safety_identifier', () => {
    const { request } = run({
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0,
      max_tokens: 9,
      user: 'asha@example.org',
      safety_identifier: 'id',
      reasoning_effort: null,
    });
    expect(request.options).toEqual({ temperature: 0, max_tokens: 9 });
    expect(JSON.stringify(request)).not.toContain('asha');
  });

  it('adds the instruction first, only when enabled and a placeholder was assigned', () => {
    const withValue = { messages: [{ role: 'user', content: `Card ${CARD}` }] };
    const without = { messages: [{ role: 'user', content: 'Hello' }] };
    expect(run(withValue, true).request.messages[0]).toEqual({
      role: 'system',
      content: PLACEHOLDER_INSTRUCTION,
    });
    expect(run(withValue, false).request.messages).toHaveLength(1);
    expect(run(without, true).request.messages).toHaveLength(1);
    // A value only in `stop` counts too: the model may still write it.
    expect(run({ ...without, stop: ['asha@example.org'] }, true).request.messages[0]!.content).toBe(
      PLACEHOLDER_INSTRUCTION,
    );
  });
});

describe('the placeholder instruction text (ADR-017)', () => {
  it('contains nothing restoration would touch, even with every namespace assigned', () => {
    const { mapping } = run({
      messages: [
        {
          role: 'user',
          content: `${CARD}, asha@example.org, ABCPE1234F, call 98765 43210, a/c 1234567890123, [PAN_1], [TYPE_1]`,
        },
      ],
    });
    expect(mapping.size).toBeGreaterThanOrEqual(6);
    expect(restore(PLACEHOLDER_INSTRUCTION, mapping, { restoreInUnsafeRegions: true })).toBe(
      PLACEHOLDER_INSTRUCTION,
    );
  });

  it('contains nothing detection would redact', () => {
    expect(detect(PLACEHOLDER_INSTRUCTION)).toEqual([]);
  });
});

describe('RedactedText at compile time', () => {
  it('a provider request cannot be built from a plain string', () => {
    const plain: string = 'raw text';
    // Checked by `npm run typecheck`: if a plain string were accepted, the
    // expect-error directive below would itself be reported as unused.
    const request: ProviderChatRequest = {
      // @ts-expect-error a plain string is not RedactedText
      messages: [{ role: 'user', content: plain }],
      options: {},
    };
    expect(request.messages).toHaveLength(1);
  });
});

// requestTexts and redactRequest with names (ADR-037): the name finder runs
// on exactly the texts redactRequest() redacts, in the same order, and each
// text's names are refused unless they carry that text.

import { describe, expect, it } from 'vitest';
import {
  PART_SEPARATOR,
  redactRequest,
  requestTexts,
} from '../../../src/gateway/redact-request.js';
import { parseChatRequest } from '../../../src/gateway/schema.js';
import { PlaceholderMapping } from '../../../src/redaction/mapping.js';
import { NameTextMismatchError, type NameSpans } from '../../../src/redaction/redact.js';

const parse = (body: Record<string, unknown>) => parseChatRequest({ model: 'm', ...body });

/** The names in each text: every occurrence of `name`. */
const namesOf = (texts: readonly string[], name: string): NameSpans[] =>
  texts.map((text) => {
    const spans = [];
    for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
      spans.push({ start: at, end: at + name.length });
    }
    return { text, spans };
  });

describe('requestTexts', () => {
  it('is each message, its parts joined as redactRequest joins them, then stop', () => {
    const request = parse({
      messages: [
        { role: 'system', content: 'one' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'two' },
            { type: 'text', text: 'parts' },
          ],
        },
      ],
      stop: ['x', 'y'],
    });
    expect(requestTexts(request)).toEqual(['one', `two${PART_SEPARATOR}parts`, 'x', 'y']);
  });

  it('takes a single stop string, and nothing for no stop or a null one', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    expect(requestTexts(parse({ messages, stop: 'end' }))).toEqual(['hi', 'end']);
    expect(requestTexts(parse({ messages, stop: '' }))).toEqual(['hi', '']);
    expect(requestTexts(parse({ messages }))).toEqual(['hi']);
    expect(requestTexts(parse({ messages, stop: null }))).toEqual(['hi']);
  });
});

describe('redactRequest with names', () => {
  const body = {
    messages: [
      { role: 'system', content: 'Asha Rao is the customer.' },
      { role: 'user', content: 'Did Asha Rao pay? Card 4111 1111 1111 1111.' },
    ],
    stop: ['Asha Rao:'],
  };

  it('redacts each text with its own names, numbered across the whole request', () => {
    const request = parse(body);
    const names = namesOf(requestTexts(request), 'Asha Rao');
    const out = redactRequest(request, new PlaceholderMapping(), {
      placeholderInstruction: false,
      names,
    });
    expect(out.messages).toEqual([
      { role: 'system', content: '[PERSON_1] is the customer.' },
      { role: 'user', content: 'Did [PERSON_1] pay? Card [CARD_1].' },
    ]);
    expect(out.stop).toEqual(['[PERSON_1]:']);
  });

  it('without names is what it always was', () => {
    const request = parse(body);
    const out = redactRequest(request, new PlaceholderMapping(), { placeholderInstruction: false });
    expect(out.messages[0]!.content).toBe('Asha Rao is the customer.');
    expect(out.stop).toEqual(['Asha Rao:']);
  });

  it('refuses names for a different number of texts', () => {
    const request = parse(body);
    const names = namesOf(requestTexts(request), 'Asha Rao');
    for (const wrong of [names.slice(1), [...names, { text: '', spans: [] }], []]) {
      expect(() =>
        redactRequest(request, new PlaceholderMapping(), {
          placeholderInstruction: false,
          names: wrong,
        }),
      ).toThrow(NameTextMismatchError);
    }
  });

  it('refuses names handed to the wrong text, as when two are swapped', () => {
    const request = parse(body);
    const names = namesOf(requestTexts(request), 'Asha Rao');
    const swapped = [names[1]!, names[0]!, names[2]!];
    expect(() =>
      redactRequest(request, new PlaceholderMapping(), {
        placeholderInstruction: false,
        names: swapped,
      }),
    ).toThrow(NameTextMismatchError);
  });
});

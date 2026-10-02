import { describe, expect, it } from 'vitest';
import { locate, namesMessages, NAMES_PROMPT, parseNames } from '../../../../eval/names/llm.js';

describe('namesMessages', () => {
  it('sends the prompt as a system message and the text as the user message', () => {
    expect(namesMessages('hello')).toEqual([
      { role: 'system', content: NAMES_PROMPT },
      { role: 'user', content: 'hello' },
    ]);
  });
});

describe('parseNames', () => {
  it('reads a JSON array of strings, bare, fenced or with prose around it', () => {
    expect(parseNames('["Kavya", "Arjun"]')).toEqual(['Kavya', 'Arjun']);
    expect(parseNames('```json\n["Kavya"]\n```')).toEqual(['Kavya']);
    expect(parseNames('The names are: ["Kavya"].')).toEqual(['Kavya']);
    expect(parseNames('[]')).toEqual([]);
  });

  it('gives undefined for anything else', () => {
    for (const answer of [
      'none',
      '] [',
      '["Kavya"',
      '[Kavya]',
      '{"names": 1}',
      '[1, 2]',
      '["Kavya", null]',
    ]) {
      expect([answer, parseNames(answer)]).toEqual([answer, undefined]);
    }
  });
});

describe('locate', () => {
  it('finds every whole-word occurrence of each name', () => {
    const text = 'Kavya met Kavyashree; Kavya left. ok';
    expect(locate(text, ['Kavya', ' Kavya ', 'Kavya'])).toEqual({
      spans: [
        { start: 0, end: 5, score: 1 },
        { start: 22, end: 27, score: 1 },
      ],
      invented: 0,
    });
  });

  it('counts a name that is nowhere in the text, or only inside a longer word, as invented', () => {
    expect(locate('MiniKavya said ok', ['Kavya'])).toEqual({ spans: [], invented: 1 });
    expect(locate('Kavyashree said ok', ['Kavya', 'Arjun', '', '  '])).toEqual({
      spans: [],
      invented: 2,
    });
  });
});

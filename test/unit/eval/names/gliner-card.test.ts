// On a made-up card in the real card's layout: the real one is fetched only
// when the check runs, never stored.

import { describe, expect, it } from 'vitest';
import { compareCard, parseCard } from '../../../../eval/names/gliner-card.js';

const CARD = [
  '# Model card',
  '',
  '```python',
  'text = """',
  'Zorvan Quellik runs Quellik Works at 12 Example Lane.',
  '"""',
  '',
  'labels = ["person", "company", "full address"]',
  'entities = model.predict_entities(text, labels)',
  '```',
  '',
  '```',
  'Zorvan Quellik => person',
  'Quellik Works => company',
  '```',
].join('\n');

describe('parseCard', () => {
  it("reads the example's text, labels and expected output", () => {
    expect(parseCard(CARD)).toEqual({
      text: '\nZorvan Quellik runs Quellik Works at 12 Example Lane.\n',
      labels: ['person', 'company', 'full address'],
      expected: [
        { text: 'Zorvan Quellik', label: 'person' },
        { text: 'Quellik Works', label: 'company' },
      ],
    });
  });

  it('gives undefined when a part is missing or malformed', () => {
    expect(parseCard('no example here')).toBeUndefined();
    // The Python block, and no output block after it.
    expect(
      parseCard(CARD.slice(0, CARD.lastIndexOf('```', CARD.lastIndexOf('```') - 1))),
    ).toBeUndefined();
    expect(
      parseCard(
        CARD.replace('labels = ["person", "company", "full address"]', 'labels = [person]'),
      ),
    ).toBeUndefined();
    expect(parseCard(CARD.replace('"company"', '3'))).toBeUndefined();
    expect(
      parseCard(CARD.replace('Zorvan Quellik => person\nQuellik Works => company\n', '')),
    ).toBeUndefined();
  });
});

describe('compareCard', () => {
  const expected = [
    { text: 'Zorvan Quellik', label: 'person' },
    { text: 'Quellik Works', label: 'company' },
  ];

  it('is reproduced only when every entity is found with its label and nothing else is', () => {
    const exact = compareCard(expected, [
      { text: 'Quellik Works', label: 'company' },
      { text: 'Zorvan Quellik', label: 'person' },
    ]);
    expect(exact).toEqual({
      rows: [
        { label: 'person', result: 'reproduced' },
        { label: 'company', result: 'reproduced' },
      ],
      extra: [],
      reproduced: true,
    });
  });

  it('tells a wrong label from a miss, and lists extras by label', () => {
    const verdict = compareCard(expected, [
      { text: 'Quellik Works', label: 'person' },
      { text: '12 Example Lane', label: 'full address' },
    ]);
    expect(verdict).toEqual({
      rows: [
        { label: 'person', result: 'missing' },
        { label: 'company', result: 'other label' },
      ],
      extra: ['full address'],
      reproduced: false,
    });
  });
});

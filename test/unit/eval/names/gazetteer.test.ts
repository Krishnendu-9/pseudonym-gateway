// Candidate F's rules, on made-up names (a list of its own, so no real
// name list is needed and no full name is written here).

import { describe, expect, it } from 'vitest';
import { listSpans, words } from '../../../../eval/names/gazetteer.js';

const LIST: ReadonlySet<string> = new Set(['zorvan', 'quellik', 'तारोमी']);
const found = (text: string): string[] =>
  listSpans(text, LIST).map((s) => text.slice(s.start, s.end));

describe('words', () => {
  it('marks listed, initial and name-shaped words', () => {
    expect(words('Zorvan k. Q zorvan है तारोमी', LIST)).toEqual([
      { start: 0, end: 6, listed: true, initial: false, nameShaped: true },
      { start: 7, end: 8, listed: false, initial: false, nameShaped: false },
      { start: 10, end: 11, listed: false, initial: true, nameShaped: true },
      { start: 12, end: 18, listed: true, initial: false, nameShaped: false },
      { start: 19, end: 21, listed: false, initial: false, nameShaped: false },
      { start: 22, end: 28, listed: true, initial: false, nameShaped: true },
    ]);
  });
});

describe('listSpans: list runs', () => {
  it('takes listed names written with a capital, with initials, adjacent ones together', () => {
    expect(found('Ask Zorvan Quellik today')).toEqual(['Zorvan Quellik']);
    expect(found('Ask Q. Zorvan today')).toEqual(['Q. Zorvan']);
    expect(found('Ask Q.Zorvan today')).toEqual(['Q.Zorvan']);
    expect(found('Ask ZORVAN today')).toEqual(['ZORVAN']);
    expect(found('कल तारोमी से बात हुई')).toEqual(['तारोमी']);
  });

  it('leaves listed names in lower case, and runs of initials alone', () => {
    expect(found('ask zorvan today')).toEqual([]);
    expect(found('Plan A. B is fine')).toEqual([]);
  });

  it('breaks runs at anything but one space (or an initial and its full stop)', () => {
    expect(found('Zorvan, Quellik')).toEqual(['Zorvan', 'Quellik']);
    expect(found('Zorvan. Quellik')).toEqual(['Zorvan', 'Quellik']);
    expect(found('Zorvan  Quellik')).toEqual(['Zorvan', 'Quellik']);
  });

  it('cuts a run at four words', () => {
    expect(found('Zorvan Quellik Zorvan Quellik Zorvan')).toEqual([
      'Zorvan Quellik Zorvan Quellik',
      'Zorvan',
    ]);
  });
});

describe('listSpans: cue runs', () => {
  it('takes capitalised words right after a cue that comes before a name', () => {
    expect(found('My name is Brelt Ommar.')).toEqual(['Brelt Ommar']);
    expect(found('Name: Brelt')).toEqual(['Brelt']);
    expect(found('Dear Brelt,')).toEqual(['Brelt']);
    expect(found('Regards,\nBrelt')).toEqual(['Brelt']);
    expect(found('Mr K. Brelt called')).toEqual(['K. Brelt']);
  });

  it('takes Devanagari words after a cue, up to a function word', () => {
    expect(found('मेरा नाम ब्रेल्ट ओम्मार है।')).toEqual(['ब्रेल्ट ओम्मार']);
  });

  it('takes capitalised words right before a cue that comes after a name', () => {
    expect(found('ask Brelt ji today')).toEqual(['Brelt']);
    expect(found('ask Brelt Sir today')).toEqual(['Brelt']);
  });

  it('takes a run whole, a capitalised first word of a sentence and all', () => {
    expect(found('Ask Brelt ji today')).toEqual(['Ask Brelt']);
  });

  it('never puts a cue word into a run', () => {
    expect(found('Dear Mr Brelt,')).toEqual(['Brelt']);
  });

  it('needs the cue as a whole word, right before or after the run', () => {
    expect(found('Surname Brelt')).toEqual([]);
    expect(found('Ask Brelt jiva today')).toEqual([]);
    expect(found('Ask Brelt-ji today')).toEqual([]);
    expect(found('Hello there, Brelt')).toEqual([]);
    expect(found('My name, as I said before, is Brelt')).toEqual([]);
  });

  it('never takes initials alone after a cue', () => {
    expect(found('Dear A. B')).toEqual([]);
  });

  it('ignores lower-case words after a cue', () => {
    expect(found('Dear brelt,')).toEqual([]);
  });
});

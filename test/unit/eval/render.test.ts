// Rendering cases into labelled text. Rendered values are generated and may
// coincide with real ones (ADR-009), so assertions compare booleans, counts
// and `masked` text, in which every character of a value is replaced by "•".

import { describe, expect, it } from 'vitest';
import { isValidAadhaar } from '../../../src/detection/aadhaar.js';
import { isValidCard } from '../../../src/detection/card.js';
import { normalise } from '../../../src/detection/normalise.js';
import { isValidPan } from '../../../src/detection/pan.js';
import { INVISIBLES } from '../../../src/synthetic/obfuscate.js';
import { parseCases } from '../../../eval/format.js';
import { CaseFileError, checkCaseFile, loadCases, renderCase } from '../../../eval/render.js';
import type { LabelledMessage, TruthPiece } from '../../../eval/types.js';

const SEED = 7;
const caseFile = (...messages: string[]): string =>
  `=== T | t\n${messages.map((m) => `@user\n${m}`).join('\n')}`;
const render = (...messages: string[]): readonly LabelledMessage[] =>
  loadCases(caseFile(...messages), SEED)[0]!.messages;

/** The message with every character of a value replaced by "•". */
function masked(message: LabelledMessage): string {
  const required = new Set(message.pieces.flatMap((p) => p.required));
  return [...message.text].map((ch, i) => (required.has(i) ? '•' : ch)).join('');
}
// For text where every character is one UTF-16 unit, offsets and [...text] agree.

/** The characters of a value, separators left out. */
const valueOf = (message: LabelledMessage, piece: TruthPiece): string =>
  piece.required.map((i) => message.text[i]).join('');
const only = (text: string): { message: LabelledMessage; piece: TruthPiece; value: string } => {
  const [message] = render(text);
  const [piece] = message!.pieces;
  return { message: message!, piece: piece!, value: valueOf(message!, piece!) };
};

describe('renderCase: text and labels', () => {
  it('leaves a message with no slots as it is', () => {
    expect(render('plain text, 12 March')).toEqual([
      { role: 'user', text: 'plain text, 12 March', pieces: [] },
    ]);
  });

  it('lays a value out by its mask and records where it is', () => {
    const [message] = render('my aadhaar {{AADHAAR:#### ####\n####}} please');
    expect(masked(message!)).toBe('my aadhaar •••• ••••\n•••• please');
    expect(message!.pieces).toEqual([
      {
        valueId: 'T#1',
        type: 'AADHAAR',
        start: 11,
        end: 25,
        required: [11, 12, 13, 14, 16, 17, 18, 19, 21, 22, 23, 24],
      },
    ]);
  });

  it('keeps the fixed text of a mask, and does not count it as the value', () => {
    const { message, piece } = only('{{PHONE:+91 (#####) #####}}');
    expect(masked(message)).toBe('+91 (•••••) •••••');
    expect([piece.start, piece.end, piece.required.length]).toEqual([0, 17, 10]);
  });

  it('a literal is copied as typed; its spaces are not part of the value', () => {
    const [message] = render('from {{PERSON=Priya Sharma}} at {{EMAIL=priya@example.com}}');
    expect(message!.text).toBe('from Priya Sharma at priya@example.com');
    expect(message!.pieces.map((p) => [p.type, p.start, p.end, p.required.length])).toEqual([
      ['PERSON', 5, 17, 11],
      ['EMAIL', 21, 38, 17],
    ]);
  });

  it('numbers the values of a case, and labels variants, typos and NOT', () => {
    const [message] = render(
      '{{CARD.amex}} {{PAN!}} {{NOT.order:ORD-####}} {{NOT=10.0.0.1}} {{UPI.mobile}} {{IFSC}}',
    );
    expect(message!.pieces.map((p) => [p.valueId, p.type, p.label])).toEqual([
      ['T#1', 'CARD', 'amex'],
      ['T#2', 'PAN', 'typo'],
      ['T#3', 'NOT', 'order'],
      ['T#4', 'NOT', undefined],
      ['T#5', 'UPI', 'mobile'],
      ['T#6', 'IFSC', undefined],
    ]);
  });

  it('pieces are in text order and never overlap', () => {
    const [message] = render('{{PAN}}{{PAN}} x {{EMAIL}}\n{{NUMBER:###-###}}');
    const { pieces } = message!;
    expect(pieces).toHaveLength(4);
    expect(pieces.every((p, i) => i === 0 || pieces[i - 1]!.end <= p.start)).toBe(true);
    expect(pieces.every((p) => p.required.every((at) => at >= p.start && at < p.end))).toBe(true);
  });
});

describe('renderCase: what each type generates', () => {
  it('AADHAAR: a valid number; with "!" the same shape failing its check', () => {
    expect(isValidAadhaar(only('{{AADHAAR}}').value)).toBe(true);
    expect(isValidAadhaar(only('{{AADHAAR:#### #### ####}}').value)).toBe(true);
    const typo = only('{{AADHAAR!}}').value;
    expect([/^[2-9][0-9]{11}$/.test(typo), isValidAadhaar(typo)]).toEqual([true, false]);
  });

  it('CARD: 16 valid digits, 15 for amex; with "!" failing Luhn', () => {
    const card = only('{{CARD:####-####-####-####}}').value;
    const amex = only('{{CARD.amex}}').value;
    const typo = only('{{CARD!}}').value;
    expect([card.length, isValidCard(card)]).toEqual([16, true]);
    expect([amex.length, isValidCard(amex), /^3[47]/.test(amex)]).toEqual([15, true, true]);
    expect([typo.length, isValidCard(typo)]).toEqual([16, false]);
  });

  it('PAN: valid; with "!" PAN-shaped but not valid', () => {
    expect(isValidPan(only('{{PAN:##### #### #}}').value)).toBe(true);
    const typo = only('{{PAN!}}').value;
    expect([/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(typo), isValidPan(typo)]).toEqual([true, false]);
  });

  it('PHONE: a 10-digit Indian mobile', () => {
    expect(/^[6-9][0-9]{9}$/.test(only('{{PHONE:+91 ##########}}').value)).toBe(true);
  });

  it('NUMBER: as many digits as the mask has marks, not starting with 0', () => {
    for (let i = 0; i < 40; i++) {
      const value = only(`${'x'.repeat(i)} {{NUMBER:###-###-###}}`).value;
      expect(/^[1-9][0-9]{8}$/.test(value)).toBe(true);
    }
  });

  it('NOT: "#" is a digit and "?" a letter; elsewhere "?" is just text', () => {
    const not = only('{{NOT:??-###?}}');
    expect(masked(not.message)).toBe('••-••••');
    expect(/^[A-Z]{2}[0-9]{3}[A-Z]$/.test(not.value)).toBe(true);
    expect(masked(only('{{NUMBER:###?}}').message)).toBe('•••?');
  });

  it('EMAIL, UPI, IFSC and SECRET are generated whole', () => {
    expect(/^[a-z0-9._+-]+@[a-z.]+$/.test(only('{{EMAIL}}').value)).toBe(true);
    expect(/^[a-z.0-9]+@[a-z]+$/.test(only('{{UPI}}').value)).toBe(true);
    expect(/^[6-9][0-9]{9}@[a-z]+$/.test(only('{{UPI.mobile}}').value)).toBe(true);
    expect(/@zz[a-z]{4}$/.test(only('{{UPI.unknown}}').value)).toBe(true);
    expect(/^[A-Z]{4}0[A-Z0-9]{6}$/.test(only('{{IFSC:#### #######}}').value)).toBe(true);
    expect(/^XX/.test(only('{{IFSC.unknown}}').value)).toBe(true);
    expect(/^ghp_[A-Za-z0-9]{36}$/.test(only('{{SECRET.github}}').value)).toBe(true);
    expect(masked(only('{{SECRET.aws}}').message)).toBe('•'.repeat(20));
  });
});

describe('renderCase: one value in several pieces', () => {
  it('continues a named value where the first slot stopped', () => {
    const [message] = render('{{AADHAAR@a:#### ####}} then {{@a:####}}');
    expect(masked(message!)).toBe('•••• •••• then ••••');
    const [first, second] = message!.pieces;
    expect([first!.valueId, second!.valueId, second!.type]).toEqual(['T#1', 'T#1', 'AADHAAR']);
    expect(isValidAadhaar(valueOf(message!, first!) + valueOf(message!, second!))).toBe(true);
  });

  it('across messages, and other values keep their own numbers', () => {
    const [one, two] = render('{{CARD@c:#### ####}} {{PAN}}', 'rest {{@c:#### ####}} {{PAN}}');
    expect(one!.pieces.map((p) => p.valueId)).toEqual(['T#1', 'T#2']);
    expect(two!.pieces.map((p) => p.valueId)).toEqual(['T#1', 'T#3']);
    const card = valueOf(one!, one!.pieces[0]!) + valueOf(two!, two!.pieces[0]!);
    expect(isValidCard(card)).toBe(true);
  });

  it('a NUMBER keeps producing digits for its continuations', () => {
    const [message] = render('{{NUMBER@n:####}}-{{@n:#####}}');
    expect(masked(message!)).toBe('••••-•••••');
    expect(message!.pieces.map((p) => p.valueId)).toEqual(['T#1', 'T#1']);
  });

  it('a continuation is written with the first slot’s modifiers', () => {
    const [message] = render('{{PAN@p|lower:#####}} {{@p:#####}}');
    const { text } = message!;
    expect([text === text.toLowerCase(), isValidPan(text.replace(' ', ''))]).toEqual([true, true]);
  });
});

describe('renderCase: modifiers', () => {
  it('writes the digits in another script, still the same number', () => {
    const { message, value } = only('{{AADHAAR|devanagari:#### #### ####}}');
    expect(/^[०-९]{12}$/.test(value)).toBe(true);
    expect(isValidAadhaar(normalise(value).text)).toBe(true);
    expect(masked(message)).toBe('•••• •••• ••••');
  });

  it.each(['bengali', 'gujarati', 'tamil', 'arabic', 'fullwidth', 'mathbold'])(
    '%s digits normalise back to a valid number',
    (script) => {
      const { value } = only(`{{AADHAAR|${script}}}`);
      expect(/[0-9]/.test(value)).toBe(false);
      expect(isValidAadhaar(normalise(value).text)).toBe(true);
    },
  );

  it('a digit outside the BMP takes two offsets, both required', () => {
    const { piece, message } = only('{{PHONE|mathbold}}');
    expect([message.text.length, piece.required.length, piece.end]).toEqual([20, 20, 20]);
  });

  it('also rewrites the digits of a literal and of a mask’s fixed text', () => {
    expect(only('{{CARD|fullwidth=4111 1111 1111 1111}}').message.text).toBe(
      '４１１１ １１１１ １１１１ １１１１',
    );
    expect(only('{{PHONE|devanagari:+91 ##########}}').message.text.startsWith('+९१ ')).toBe(true);
  });

  it('lower and upper change the case', () => {
    const lower = only('{{PAN|lower}}').value;
    expect([lower === lower.toLowerCase(), isValidPan(lower)]).toEqual([true, true]);
    const upper = only('{{EMAIL|upper=priya@example.com}}').message.text;
    expect(upper).toBe('PRIYA@EXAMPLE.COM');
  });

  it('invisible: hidden characters between the slot’s characters, never required, never at its ends', () => {
    const invisible = new Set<string>(INVISIBLES);
    for (let i = 0; i < 50; i++) {
      const { message, piece, value } = only(
        `${'x'.repeat(i)} {{AADHAAR|invisible:#### #### ####}}`,
      );
      const slotText = message.text.slice(piece.start, piece.end);
      const hidden = [...slotText].filter((ch) => invisible.has(ch));
      const ok =
        hidden.length >= 1 &&
        !invisible.has(slotText[0]!) &&
        !invisible.has(slotText.at(-1)!) &&
        isValidAadhaar(value) &&
        [...slotText].filter((ch) => !invisible.has(ch)).join('').length === 14;
      expect(ok).toBe(true);
    }
  });

  it('invisible on a one-character slot changes nothing', () => {
    expect(only('{{NOT|invisible:#}}').message.text).toHaveLength(1);
  });

  it('applies several modifiers in the order written', () => {
    const { value, message } = only('{{AADHAAR|invisible|tamil}}');
    expect(isValidAadhaar(normalise(value).text)).toBe(true);
    expect(message.text.length).toBeGreaterThan(12);
  });
});

describe('renderCase: the same every time', () => {
  const file = [
    '=== A | t',
    '@user',
    '{{AADHAAR}} {{EMAIL}} {{SECRET.jwt}}',
    '=== B | t',
    '@user',
    '{{CARD}} {{UPI}} {{NUMBER|invisible:#########}}',
  ].join('\n');
  const texts = (source: string, seed: number): string[] =>
    loadCases(source, seed).map((c) => c.messages[0]!.text);

  it('the same seed gives the same text; another seed does not', () => {
    const [a1, b1] = texts(file, 1);
    const [a2, b2] = texts(file, 1);
    const [a3, b3] = texts(file, 2);
    expect([a1 === a2, b1 === b2, a1 === a3, b1 === b3]).toEqual([true, true, false, false]);
  });

  it('a case does not change when another case is edited or added', () => {
    const edited = file.replace('{{AADHAAR}} {{EMAIL}}', '{{PAN}} extra {{PAN}}');
    const added = `=== NEW | t\n@user\n{{PHONE}}\n${file}`;
    const b = texts(file, 1)[1];
    expect([texts(edited, 1)[1] === b, texts(added, 1)[2] === b]).toEqual([true, true]);
  });

  it('different cases get different values from the same slot', () => {
    const two = '=== A | t\n@user\n{{AADHAAR}}\n=== B | t\n@user\n{{AADHAAR}}';
    const [a, b] = texts(two, 1);
    expect(a === b).toBe(false);
  });
});

describe('loadCases and checkCaseFile', () => {
  it('collect format problems and slot problems together', () => {
    const source = '=== A |\n@user\n{{AADHAR}} MARKER';
    expect(checkCaseFile(source).problems.map((p) => p.rule)).toEqual(['no-tags', 'bad-slot']);
  });

  it('loadCases throws, naming cases, lines and rules but never the text', () => {
    const source = '=== A | t\n@user\nMARKER {{AADHAR}}\n=== B | t\n@user\n{{PAN:#}}';
    let thrown: unknown;
    try {
      loadCases(source, SEED);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CaseFileError);
    const error = thrown as CaseFileError;
    expect(error.message).toBe(
      '2 problem(s) in the case file: A line 3: bad-slot; B line 6: too-few-marks',
    );
    expect(error.problems).toHaveLength(2);
    expect(`${error.message}${JSON.stringify(error.problems)}`).not.toContain('MARKER');
  });

  it('the message lists at most five problems', () => {
    const source = `=== A | t\n@user\n${'{{X}} '.repeat(8)}`;
    const message = (() => {
      try {
        loadCases(source, SEED);
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(message.startsWith('8 problem(s)')).toBe(true);
    expect(message.split(';')).toHaveLength(5);
  });

  it('renderCase refuses a case that did not pass the lint', () => {
    const broken = parseCases(caseFile('{{AADHAR}}')).cases[0]!;
    const orphan = parseCases(caseFile('{{@a:####}}')).cases[0]!;
    expect(() => renderCase(broken, SEED)).toThrow('did not pass the lint');
    expect(() => renderCase(orphan, SEED)).toThrow('did not pass the lint');
    // A type with nothing to generate and nothing typed.
    const bare = parseCases(caseFile('{{NUMBER}}')).cases[0]!;
    expect(() => renderCase(bare, SEED)).toThrow('did not pass the lint');
  });

  it('an empty file loads as no cases', () => {
    expect(loadCases('%% nothing yet\n', SEED)).toEqual([]);
  });
});

// The echo measurement (ADR-033). The texts hold synthetic addresses at
// example.com and the published Visa test card only, so plain assertions
// are safe here.

import { describe, expect, it } from 'vitest';
import {
  echo,
  echoByShape,
  filled,
  restoresWithLaterForms,
  type Redactor,
  type Restorer,
} from '../../../eval/echo.js';
import { redactMessage } from '../../../src/redaction/redact.js';
import { SHAPE_TAG, type LabelledCase } from '../../../eval/types.js';
import { restore } from '../../../src/redaction/restore.js';

const labelled = (id: string, texts: readonly string[], tags: readonly string[] = []) =>
  ({
    id,
    tags,
    messages: texts.map((text) => ({ role: 'user', text, pieces: [] })),
  }) satisfies LabelledCase;

describe('restoresWithLaterForms', () => {
  // A first mention with its value, or a later one (any value will do).
  const at = (redacted: string, placeholder: string, value: string | undefined) => {
    const start = redacted.indexOf(placeholder);
    return {
      start,
      end: start + placeholder.length,
      value: value ?? '?',
      first: value !== undefined,
    };
  };

  it('with no placeholder: the texts must be equal', () => {
    expect(restoresWithLaterForms('same', 'same', [])).toBe(true);
    expect(restoresWithLaterForms('same', 'other', [])).toBe(false);
  });

  it('a first mention must come back as its value', () => {
    const redacted = 'Mail [EMAIL_1] now';
    const slot = at(redacted, '[EMAIL_1]', 'a@example.com');
    expect(restoresWithLaterForms('Mail a@example.com now', redacted, [slot])).toBe(true);
    expect(restoresWithLaterForms('Mail b@example.com now', redacted, [slot])).toBe(false);
  });

  it('a later mention may come back as any text, but not as none', () => {
    const redacted = 'Mail [EMAIL_1] now';
    const slot = at(redacted, '[EMAIL_1]', undefined);
    expect(restoresWithLaterForms('Mail A@EXAMPLE.COM now', redacted, [slot])).toBe(true);
    expect(restoresWithLaterForms('Mail  now', redacted, [slot])).toBe(false);
    expect(restoresWithLaterForms('Mail x now!', redacted, [slot])).toBe(false);
  });

  it('tries every split: the text after a later mention may also occur inside it', () => {
    // "-" follows the slot, and the value read for it contains "-" too.
    const redacted = '[PHONE_1]-x';
    const slot = at(redacted, '[PHONE_1]', undefined);
    expect(restoresWithLaterForms('98-76-x', redacted, [slot])).toBe(true);
    expect(restoresWithLaterForms('98-76-y', redacted, [slot])).toBe(false);
  });

  it('two later mentions side by side', () => {
    const redacted = '[EMAIL_1][EMAIL_2].';
    const slots = [at(redacted, '[EMAIL_1]', undefined), at(redacted, '[EMAIL_2]', undefined)];
    expect(restoresWithLaterForms('ab.', redacted, slots)).toBe(true);
    expect(restoresWithLaterForms('a.', redacted, slots)).toBe(false);
  });
});

describe('filled', () => {
  it('replaces every slot by its value, first mention or not', () => {
    const redacted = 'A [EMAIL_1], B [EMAIL_1].';
    const slots = [
      { start: 2, end: 11, value: 'a@example.com', first: true },
      { start: 15, end: 24, value: 'a@example.com', first: false },
    ];
    expect(filled(redacted, slots)).toBe('A a@example.com, B a@example.com.');
    expect(filled('none', [])).toBe('none');
  });
});

describe('echo', () => {
  it('restores every placeholder of an ordinary message, exactly', () => {
    const score = echo([
      labelled('A', ['Mail priya@example.com or pay with 4111 1111 1111 1111.']),
    ]);
    expect(score).toMatchObject({ messages: 1, placeholders: 2, restored: 2, exact: 1 });
    expect(score.firstForm + score.broken).toBe(0);
  });

  it('counts a placeholder a safety rule left, and still finds the message back exactly', () => {
    const score = echo([
      labelled('A', [
        'See https://portal.example/u?id=4111111111111111 or <a href="mailto:priya@example.com">me</a>',
      ]),
    ]);
    expect(score).toMatchObject({ placeholders: 2, restored: 0, exact: 1, broken: 0 });
    expect(score.heldBack).toMatchObject({ url: 1, 'html-attribute': 1 });
  });

  it('one mapping per case: a later mention written another way comes back as first written', () => {
    const score = echo([
      labelled('A', ['Mail PRIYA@EXAMPLE.COM please.', 'Or priya@example.com, same one.']),
      labelled('B', ['Mail priya@example.com please.']),
    ]);
    expect(score).toMatchObject({ messages: 3, placeholders: 3, exact: 2, firstForm: 1 });
  });

  it('counts "Type N" text the mapping has a placeholder for, and leaves it as written', () => {
    const score = echo([labelled('A', ['Card 1 is 4111 1111 1111 1111.'])]);
    expect(score).toMatchObject({ restored: 1, exact: 1 });
    expect(score.heldBack['bare-space']).toBe(1);
  });

  describe('a restorer that is wrong is caught', () => {
    const text = 'Mail priya@example.com today.';
    const broken = (restorer: Restorer): number =>
      echo([labelled('A', [text])], { restorer }).broken;

    it('when counting changes the output', () => {
      expect(broken((t, m, o, c) => restore(t, m, o, c) + (c ? '!' : ''))).toBe(1);
    });

    it('when a placeholder is neither restored nor left by a rule', () => {
      expect(broken((t, m, o) => restore(t, m, o))).toBe(1);
    });

    it('when the message does not come back', () => {
      expect(broken((t, m, o, c) => (o?.restoreInUnsafeRegions ? t : restore(t, m, o, c)))).toBe(1);
    });

    it('when a later mention does not come back as first written', () => {
      const twice = [labelled('A', ['Mail PRIYA@EXAMPLE.COM.', 'Or priya@example.com.'])];
      const wrong: Restorer = (t, m, o, c) =>
        o?.restoreInUnsafeRegions ? restore(t, m, o, c).toLowerCase() : restore(t, m, o, c);
      expect(echo(twice, { restorer: wrong })).toMatchObject({ exact: 0, firstForm: 0, broken: 2 });
      expect(echo(twice)).toMatchObject({ exact: 1, firstForm: 1, broken: 0 });
    });

    it('when redaction lost text that restoration then cannot bring back', () => {
      // Restoration is right about what it was given; the original differs.
      const lossy: Redactor = (t, m) => redactMessage(t.replace(' today', ''), m);
      expect(echo([labelled('A', [text])], { redactor: lossy }).broken).toBe(1);
    });

    it('and the real one is not', () => {
      expect(broken(restore)).toBe(0);
    });
  });
});

describe('echoByShape', () => {
  it('one part for the cases with no shape tag, then one per shape, in order of appearance', () => {
    const parts = echoByShape([
      labelled('A', ['Mail priya@example.com.'], ['ticket', `${SHAPE_TAG}in-markup`]),
      labelled('B', ['Nothing here.'], ['ticket']),
      labelled('C', ['https://a.example/?u=4111111111111111', 'ok'], [`${SHAPE_TAG}in-markup`]),
    ]);
    expect(Object.keys(parts)).toEqual(['in-markup', 'main']);
    expect(parts['in-markup']).toMatchObject({ messages: 3, placeholders: 2, restored: 1 });
    expect(parts.main).toMatchObject({ messages: 1, placeholders: 0, exact: 1 });
  });
});

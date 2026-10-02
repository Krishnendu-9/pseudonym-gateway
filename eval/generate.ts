// The generated dataset: 600 synthetic messages of the kinds Pseudonym's
// users send (support tickets, emails, chat logs, pasted records), in
// English, Hinglish, Hindi and a mix, with every personal value labelled.
//
// It is built from one seed, in memory, on every run (ADR-009): messages
// are written with the same slots as the held-out set and rendered by the
// same code, so nothing here contains a value either.
//
// Honest limits, stated in the README too: these templates and the
// detectors share an author, so this set mostly measures regressions. The
// held-out set is the one written apart from the detectors.

import {
  ipAddress,
  personName,
  SECRET_KINDS,
  type SecretKind,
} from '../src/synthetic/identifiers.js';
import { createRng, type Rng } from '../src/synthetic/rng.js';
import type { RawCase, RawMessage } from './format.js';
import { renderCase } from './render.js';
import {
  PERSONAL_TYPES,
  SHAPE_TAG,
  type LabelledCase,
  type PersonalType,
  type Role,
} from './types.js';

export const GENERATED_SEED = 20_260_930;

export type Kind = 'ticket' | 'email' | 'chat' | 'record';
export type Language = 'en' | 'hinglish' | 'hi' | 'mixed';
type Tongue = Exclude<Language, 'mixed'>;

// 600 messages: one per ticket, email and record, three per chat.
export const CASES_BY_KIND: Readonly<Record<Kind, number>> = {
  ticket: 210,
  email: 150,
  record: 90,
  chat: 50,
};
const MESSAGES_PER_CHAT = 3;
// Shares of cases, in tenths.
const LANGUAGE_TENTHS: Readonly<Record<Language, number>> = { en: 5, hinglish: 3, hi: 1, mixed: 1 };

/** One message in five has no personal value at all. */
export const SHARE_WITHOUT_VALUES = 0.2;
/** Every type is planted this many times, so each has the same weight in the report. */
export const VALUES_PER_TYPE = 153;
const MAX_VALUES_PER_MESSAGE = 6;

// ---------------------------------------------------------------------------
// Small helpers

function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Picks by weight: `[[5, a], [1, b]]` gives `a` five times in six. */
function weighted<T>(rng: Rng, choices: readonly (readonly [number, T])[]): T {
  let roll = rng.int(
    1,
    choices.reduce((sum, [weight]) => sum + weight, 0),
  );
  // The roll is at most the sum of the weights, so one choice always takes it.
  return choices.find(([weight]) => (roll -= weight) <= 0)![1];
}

const marks = (count: number): string => '#'.repeat(count);

// ---------------------------------------------------------------------------
// How each type is written: mostly the usual way, sometimes awkwardly,
// sometimes with a typo, sometimes disguised.

const SLOT: Readonly<Record<PersonalType, (rng: Rng, tongue: Tongue) => string>> = {
  AADHAAR: (rng) =>
    weighted(rng, [
      [10, '{{AADHAAR:#### #### ####}}'],
      [5, '{{AADHAAR}}'],
      [2, '{{AADHAAR:####-####-####}}'],
      [1, '{{AADHAAR:####.####.####}}'],
      [1, '{{AADHAAR!:#### #### ####}}'],
      [1, rng.pick(['{{AADHAAR|devanagari:#### #### ####}}', '{{AADHAAR|invisible}}'])],
    ]),
  CARD: (rng) =>
    weighted(rng, [
      [9, '{{CARD:#### #### #### ####}}'],
      [5, '{{CARD}}'],
      [2, '{{CARD:####-####-####-####}}'],
      [1, '{{CARD.amex:#### ###### #####}}'],
      [1, '{{CARD!:#### #### #### ####}}'],
      [1, rng.pick(['{{CARD|fullwidth}}', '{{CARD|invisible:#### #### #### ####}}'])],
      [1, '{{CARD:######## ########}}'],
    ]),
  PAN: (rng) =>
    weighted(rng, [
      [15, '{{PAN}}'],
      [2, '{{PAN|lower}}'],
      [1, '{{PAN!}}'],
      [1, '{{PAN:##### #### #}}'],
      [1, '{{PAN|invisible}}'],
    ]),
  PHONE: (rng) =>
    weighted(rng, [
      [6, '{{PHONE}}'],
      [4, '{{PHONE:+91 ##########}}'],
      [3, '{{PHONE:+91 ##### #####}}'],
      [2, '{{PHONE:+91-#####-#####}}'],
      [2, '{{PHONE:0##########}}'],
      [1, '{{PHONE:(+91) ##########}}'],
      [1, rng.pick(['{{PHONE|devanagari}}', '{{PHONE|invisible:+91 ##########}}'])],
      // Numbers from the ranges reserved for fiction (NANP 555-01xx, Ofcom).
      [
        1,
        rng.pick([
          `{{PHONE=+1 202-555-01${rng.digits(2)}}}`,
          `{{PHONE=+44 20 7946 0${rng.digits(3)}}}`,
        ]),
      ],
    ]),
  EMAIL: (rng) =>
    weighted(rng, [
      [18, '{{EMAIL}}'],
      [1, '{{EMAIL|upper}}'],
      [1, '{{EMAIL|invisible}}'],
    ]),
  // A bank account or customer number: 9 to 16 digits, no check to pass.
  NUMBER: (rng) =>
    weighted(rng, [
      [14, `{{NUMBER:${marks(rng.int(9, 16))}}}`],
      [3, '{{NUMBER:####-####-####}}'],
      [2, '{{NUMBER:#### #### ###}}'],
      [1, '{{NUMBER:########}}'],
    ]),
  IFSC: (rng) =>
    weighted(rng, [
      [16, '{{IFSC}}'],
      [3, '{{IFSC.unknown}}'],
      [1, '{{IFSC|lower}}'],
    ]),
  UPI: (rng) =>
    weighted(rng, [
      [12, '{{UPI}}'],
      [5, '{{UPI.mobile}}'],
      [2, '{{UPI.unknown}}'],
      [1, '{{UPI|upper}}'],
    ]),
  // Mostly a bare address; sometimes with a port, a prefix length, inside a
  // URL, or in brackets with a port, the ways logs and tickets write one
  // (ADR-026). Only the address is labelled: a port or a prefix length
  // names nobody.
  IP: (rng) => {
    const v4 = (): string => `{{IP=${ipAddress(rng, 'v4')}}}`;
    const v6 = (): string => `{{IP=${ipAddress(rng, 'v6')}}}`;
    return weighted<() => string>(rng, [
      [10, v4],
      [4, v6],
      [2, () => `${v4()}:${rng.pick(['22', '443', '8080', '3389'])}`],
      [1, () => `${v4()}/${rng.pick(['24', '32'])}`],
      [1, () => `http://${v4()}/login`],
      [1, () => `[${v6()}]:443`],
    ])();
  },
  SECRET: (rng) => `{{SECRET.${rng.pick(SECRET_KINDS)}}}`,
  PERSON: (rng, tongue) =>
    `{{PERSON=${personName(rng, tongue === 'hi' && rng.chance(0.7) ? 'devanagari' : 'latin')}}}`,
  // Phase 5c: only in the shape block below.
  PASSPORT: (rng) =>
    weighted(rng, [
      [17, '{{PASSPORT}}'],
      [2, '{{PASSPORT|lower}}'],
      [1, '{{PASSPORT|invisible}}'],
    ]),
  VOTER: (rng) =>
    weighted(rng, [
      [17, '{{VOTER}}'],
      [2, '{{VOTER|lower}}'],
      [1, '{{VOTER|invisible}}'],
    ]),
  DOB: () => '{{DOB}}',
};

// ---------------------------------------------------------------------------
// Sentences around a value. Some name the type ("my Aadhaar is…"), some do
// not ("please match it against…"): the context rule (ADR-010) needs both.

type Sentence = (slot: string) => string;
type ByTongue = Readonly<Record<Tongue, readonly Sentence[]>>;

const SENTENCES: Readonly<Record<Exclude<PersonalType, 'SECRET'>, ByTongue>> = {
  AADHAAR: {
    en: [
      (s) => `My Aadhaar number is ${s}.`,
      (s) => `Aadhaar: ${s}`,
      (s) => `The UID on the form is ${s}.`,
      (s) => `Please match it against ${s} before closing this.`,
    ],
    hinglish: [
      (s) => `Mera aadhaar number ${s} hai.`,
      (s) => `Aadhar card ka number ${s} hai, please check kar lijiye.`,
      (s) => `${s} ye number form mein likha tha.`,
    ],
    hi: [(s) => `मेरा आधार नंबर ${s} है।`, (s) => `आधार: ${s}`, (s) => `फ़ॉर्म में ${s} लिखा है।`],
  },
  CARD: {
    en: [
      (s) => `I paid with card ${s}.`,
      (s) => `Card number: ${s}`,
      (s) => `My Visa ${s} was declined.`,
      (s) => `The charge was made on ${s} twice.`,
    ],
    hinglish: [
      (s) => `Maine card ${s} se payment kiya tha.`,
      (s) => `Credit card number ${s} hai.`,
      (s) => `${s} se do baar paise kat gaye.`,
    ],
    hi: [(s) => `मेरा कार्ड नंबर ${s} है।`, (s) => `भुगतान ${s} से किया गया था।`],
  },
  PAN: {
    en: [(s) => `My PAN is ${s}.`, (s) => `PAN: ${s}`, (s) => `Tax ID on file: ${s}.`],
    hinglish: [
      (s) => `Mera PAN number ${s} hai.`,
      (s) => `PAN card ${s} update karna hai.`,
      (s) => `${s} galat print hua hai.`,
    ],
    hi: [(s) => `मेरा पैन ${s} है।`, (s) => `पैन कार्ड नंबर: ${s}`, (s) => `उसमें ${s} छपा है।`],
  },
  PHONE: {
    en: [
      (s) => `Call me on ${s}.`,
      (s) => `My mobile number is ${s}.`,
      (s) => `Phone: ${s}`,
      (s) => `Reach me at ${s} after 6 pm.`,
    ],
    hinglish: [
      (s) => `Mujhe ${s} par call kar lena.`,
      (s) => `Mera mobile number ${s} hai.`,
      (s) => `${s} pe WhatsApp kar dijiye.`,
      (s) => `${s} par baat ho sakti hai.`,
    ],
    hi: [
      (s) => `मेरा मोबाइल नंबर ${s} है।`,
      (s) => `कृपया ${s} पर फ़ोन करें।`,
      (s) => `${s} पर बात हो सकती है।`,
    ],
  },
  EMAIL: {
    en: [
      (s) => `My email is ${s}.`,
      (s) => `Please send the invoice to ${s}.`,
      (s) => `Email: ${s}`,
    ],
    hinglish: [(s) => `Mera email ${s} hai.`, (s) => `Invoice ${s} par bhej dijiye.`],
    hi: [(s) => `मेरा ईमेल ${s} है।`, (s) => `रसीद ${s} पर भेज दें।`],
  },
  NUMBER: {
    en: [
      (s) => `My account number is ${s}.`,
      (s) => `A/c no ${s} was debited.`,
      (s) => `Customer ID ${s}.`,
      (s) => `Loan account ${s} shows the wrong balance.`,
    ],
    hinglish: [
      (s) => `Mera account number ${s} hai.`,
      (s) => `Khata number ${s} se paise kate hain.`,
    ],
    hi: [(s) => `मेरा खाता संख्या ${s} है।`, (s) => `खाता ${s} से पैसे कट गए।`],
  },
  IFSC: {
    en: [
      (s) => `The IFSC code is ${s}.`,
      (s) => `Branch IFSC: ${s}`,
      (s) => `Transfer it by NEFT to ${s}.`,
      (s) => `The branch is ${s}.`,
    ],
    hinglish: [(s) => `IFSC code ${s} hai.`, (s) => `Branch ka IFSC ${s} daal dena.`],
    hi: [(s) => `IFSC कोड ${s} है।`, (s) => `शाखा ${s} है।`],
  },
  UPI: {
    en: [
      (s) => `My UPI ID is ${s}.`,
      (s) => `Pay me on GPay at ${s}.`,
      (s) => `Please refund to ${s}.`,
    ],
    hinglish: [
      (s) => `Mera UPI ID ${s} hai.`,
      (s) => `PhonePe par ${s} pe bhej dena.`,
      (s) => `Refund ${s} par bhej do.`,
    ],
    hi: [(s) => `मेरा UPI आईडी ${s} है।`, (s) => `रिफ़ंड ${s} पर भेज दें।`],
  },
  IP: {
    en: [
      (s) => `The login came from IP ${s}.`,
      (s) => `My IP address is ${s}.`,
      (s) => `Requests from ${s} are being blocked.`,
    ],
    hinglish: [(s) => `Login IP ${s} se hua tha.`, (s) => `Mera IP address ${s} hai.`],
    hi: [(s) => `लॉगिन ${s} से हुआ था।`, (s) => `मेरा IP पता ${s} है।`],
  },
  PERSON: {
    en: [
      (s) => `My name is ${s}.`,
      (s) => `This is ${s} from the billing team.`,
      (s) => `Please contact ${s} about this.`,
    ],
    hinglish: [(s) => `Mera naam ${s} hai.`, (s) => `Main ${s} bol raha hoon.`],
    hi: [(s) => `मेरा नाम ${s} है।`, (s) => `मैं ${s} बोल रही हूँ।`],
  },
  // Phase 5c. The last sentences of each language name no type.
  PASSPORT: {
    en: [
      (s) => `My passport number is ${s}.`,
      (s) => `Passport no: ${s}`,
      (s) => `Please verify ${s} for my visa.`,
      (s) => `Document ${s} expired last month.`,
    ],
    hinglish: [(s) => `Mera passport ${s} hai.`, (s) => `${s} wala document upload kiya.`],
    hi: [(s) => `मेरा पासपोर्ट नंबर ${s} है।`, (s) => `दस्तावेज़ ${s} की अवधि ख़त्म हो गई।`],
  },
  VOTER: {
    en: [
      (s) => `Voter ID: ${s}`,
      (s) => `My EPIC number is ${s}.`,
      (s) => `ID card ${s} is attached.`,
    ],
    hinglish: [(s) => `Mera voter card ${s} hai.`, (s) => `${s} wala card upload kiya.`],
    hi: [(s) => `मतदाता पहचान पत्र ${s} है।`, (s) => `पहचान पत्र ${s} संलग्न है।`],
  },
  DOB: {
    en: [
      (s) => `DOB: ${s}`,
      (s) => `My date of birth is ${s}.`,
      (s) => `I was born on ${s}.`,
      (s) => `The age proof says ${s}.`,
    ],
    hinglish: [(s) => `Meri janm tithi ${s} hai.`, (s) => `Age proof mein ${s} likha hai.`],
    hi: [(s) => `जन्म तिथि: ${s}`, (s) => `आयु प्रमाण में ${s} लिखा है।`],
  },
};

// A password reads differently from a key or token.
const SECRET_SENTENCES: Readonly<Record<'password' | 'key', ByTongue>> = {
  password: {
    en: [
      (s) => `My password is ${s}`,
      (s) => `password: ${s}`,
      (s) => `I tried logging in with ${s} and it failed.`,
    ],
    hinglish: [(s) => `Mera password ${s} hai.`, (s) => `Login ${s} se nahi ho raha.`],
    hi: [(s) => `मेरा पासवर्ड ${s} है।`],
  },
  key: {
    en: [
      (s) => `Here is my API key: ${s}`,
      (s) => `api_key=${s}`,
      (s) => `Authorization: Bearer ${s}`,
      (s) => `I pasted ${s} into the chat by mistake.`,
    ],
    hinglish: [(s) => `Ye meri API key hai: ${s}`, (s) => `Token ${s} kaam nahi kar raha.`],
    hi: [(s) => `मेरी API key ${s} है।`, (s) => `टोकन ${s} काम नहीं कर रहा।`],
  },
};

const secretKindOf = (slot: string): SecretKind => slot.slice('{{SECRET.'.length, -2) as SecretKind;

function valueSentence(type: PersonalType, tongue: Tongue, rng: Rng): string {
  const slot = SLOT[type](rng, tongue);
  if (type !== 'SECRET') return rng.pick(SENTENCES[type][tongue])(slot);
  const family = secretKindOf(slot) === 'password' ? 'password' : 'key';
  return rng.pick(SECRET_SENTENCES[family][tongue])(slot);
}

// Field names for a pasted record.
const FIELD: Readonly<Record<PersonalType, Readonly<Record<Tongue, string>>>> = {
  AADHAAR: { en: 'Aadhaar', hinglish: 'Aadhaar no', hi: 'आधार' },
  CARD: { en: 'Card no', hinglish: 'Card number', hi: 'कार्ड' },
  PAN: { en: 'PAN', hinglish: 'PAN no', hi: 'पैन' },
  PHONE: { en: 'Mobile', hinglish: 'Mobile no', hi: 'मोबाइल' },
  EMAIL: { en: 'Email', hinglish: 'Email id', hi: 'ईमेल' },
  NUMBER: { en: 'A/c no', hinglish: 'Khata no', hi: 'खाता संख्या' },
  IFSC: { en: 'IFSC', hinglish: 'IFSC code', hi: 'IFSC' },
  UPI: { en: 'UPI ID', hinglish: 'UPI id', hi: 'UPI आईडी' },
  IP: { en: 'Last login IP', hinglish: 'Login IP', hi: 'IP पता' },
  SECRET: { en: 'API key', hinglish: 'Password', hi: 'पासवर्ड' },
  PERSON: { en: 'Name', hinglish: 'Naam', hi: 'नाम' },
  PASSPORT: { en: 'Passport no', hinglish: 'Passport', hi: 'पासपोर्ट' },
  VOTER: { en: 'Voter ID', hinglish: 'Voter card', hi: 'मतदाता पहचान पत्र' },
  DOB: { en: 'DOB', hinglish: 'Janm tithi', hi: 'जन्म तिथि' },
};

// ---------------------------------------------------------------------------
// Text that is not personal: plain sentences, and lookalikes in NOT slots
// (a 12-digit reference in Aadhaar's grouping, a 16-digit transaction id, a
// PAN-shaped product code, a private IP address, a version like an IP).

const day = (rng: Rng): string => String(rng.int(1, 28)).padStart(2, '0');
const month = (rng: Rng): string => String(rng.int(1, 12)).padStart(2, '0');
const amount = (rng: Rng): string =>
  rng.pick([
    `${rng.int(1, 9)},${rng.digits(3)}`,
    `${rng.int(1, 9)},${rng.digits(2)},${rng.digits(3)}`,
  ]);

// The SSDP multicast address. It passes the Aadhaar checks, so it is put
// together here rather than typed (repo-hygiene.test.ts).
const SSDP = [239, 255, 255, 250].join('.');

const LOOKALIKES: readonly ((rng: Rng) => string)[] = [
  () => '{{NOT.order:OD#########}}',
  () => '{{NOT.tracking:##########}}',
  () => '{{NOT.invoice:INV-2026-######}}',
  () => '{{NOT.ticket:#######}}',
  () => '{{NOT.otp:######}}',
  () => '{{NOT.reference:#### #### ####}}',
  () => '{{NOT.transaction:################}}',
  () => '{{NOT.timestamp:17########}}',
  () => '{{NOT.sku:?????####?}}',
  () => '{{NOT.version:#.#.##.#}}',
  () => '{{NOT.datetime:2026-0#-1# 1#:4#}}',
  // 11-character codes (ADR-025): the first has an IFSC's exact shape (four
  // letters, a zero, six digits) with letters that are almost never a bank
  // code; the other two miss it by one character (the fifth is not a zero;
  // three letters, not four).
  () => '{{NOT.product-code:????0######}}',
  () => '{{NOT.batch:????#######}}',
  () => '{{NOT.invoice-no:INV000#####}}',
  (rng) => `{{NOT.private-ip=${ipAddress(rng, 'private')}}}`,
  (rng) => `{{NOT.loopback=${ipAddress(rng, 'loopback')}}}`,
  // IP lookalikes (ADR-026). A link-local address, a policy question like
  // the two above (an IPv6 one sometimes with its zone). A Windows build
  // number, and a four-part version after a version word or glued to a
  // "v"; NOT.version above is one with no word at all. A time, a dotted
  // date, a MAC address, and eight groups of two hex digits (an EUI-64
  // interface id), which is also a well-formed IPv6 address.
  (rng) => {
    const address = ipAddress(rng, 'link-local');
    const zone = address.includes(':') && rng.chance(0.5) ? '%eth0' : '';
    return `{{NOT.link-local=${address}}}${zone}`;
  },
  (rng) => `${rng.pick(['build', 'Windows'])} {{NOT.version-build:10.0.#####.####}}`,
  (rng) => `${rng.pick(['version ', 'ver. ', 'app version ', 'v'])}{{NOT.app-version:#.#.#.##}}`,
  () => '{{NOT.time:1#:3#:4#}}',
  () => '{{NOT.date:1#.0#.2026}}',
  () => '{{NOT.mac:##:A#:#B:##:C#:#E}}',
  () => '{{NOT.eui-64:##:##:##:FF:FE:##:##:##}}',
  // Addresses no single host owns, which other detectors can read as a
  // value: a netmask, a multicast group (ADR-026, second dataset step).
  (rng) =>
    `{{NOT.netmask=${rng.pick(['255.255.255.0', '255.255.0.0', '255.255.255.252', '255.255.255.128'])}}}`,
  (rng) => `{{NOT.multicast=${rng.pick([SSDP, '224.0.0.251', '224.0.0.1', 'ff02::1'])}}}`,
];

const NAMED: Readonly<Record<Tongue, readonly Sentence[]>> = {
  en: [
    (s) => `The reference is ${s}.`,
    (s) => `It shows ${s} on my screen.`,
    (s) => `See ${s} for the details.`,
    (s) => `Status for ${s} is still pending.`,
  ],
  hinglish: [
    (s) => `Reference ${s} hai.`,
    (s) => `Screen par ${s} dikh raha hai.`,
    (s) => `${s} abhi tak pending hai.`,
  ],
  hi: [(s) => `संदर्भ ${s} है।`, (s) => `स्क्रीन पर ${s} दिख रहा है।`],
};

const PLAIN: Readonly<Record<Tongue, readonly ((rng: Rng) => string)[]>> = {
  en: [
    (rng) => `The amount was Rs ${amount(rng)}.`,
    (rng) =>
      `I ordered it on ${day(rng)}/${month(rng)}/2026 at ${rng.int(10, 23)}:${rng.int(10, 59)}.`,
    (rng) => `I have been a customer for ${rng.int(2, 15)} years.`,
    (rng) => `This is the ${rng.pick(['second', 'third', 'fourth'])} time I am writing about it.`,
    () => 'Nobody has replied so far.',
    (rng) => `The delivery was promised within ${rng.int(2, 9)} working days.`,
  ],
  hinglish: [
    (rng) => `Amount Rs ${amount(rng)} kat gaya tha.`,
    (rng) => `Ye ${day(rng)}/${month(rng)}/2026 ko hua tha.`,
    (rng) => `Main ${rng.int(2, 9)} baar call kar chuka hoon.`,
    () => 'Abhi tak koi jawab nahi aaya.',
    (rng) => `Delivery ${rng.int(2, 9)} din mein aani thi.`,
  ],
  hi: [
    (rng) => `राशि ₹${amount(rng)} थी।`,
    (rng) => `यह ${day(rng)}/${month(rng)}/2026 को हुआ था।`,
    () => 'अभी तक कोई जवाब नहीं आया।',
    (rng) => `मैं ${rng.int(2, 9)} बार फ़ोन कर चुकी हूँ।`,
  ],
};

type Lookalike = (rng: Rng) => string;

function otherSentence(tongue: Tongue, rng: Rng, lookalikes: readonly Lookalike[]): string {
  return rng.chance(0.5)
    ? rng.pick(NAMED[tongue])(rng.pick(lookalikes)(rng))
    : rng.pick(PLAIN[tongue])(rng);
}

// ---------------------------------------------------------------------------
// Putting a message together, by kind.

const SUBJECTS: Readonly<Record<Tongue, readonly string[]>> = {
  en: ['Refund not received', 'Wrong charge on my account', 'KYC update', 'Cannot log in'],
  hinglish: ['Refund nahi mila', 'Account se galat paise kate', 'KYC update karna hai'],
  hi: ['रिफ़ंड नहीं मिला', 'खाते से गलत पैसे कटे', 'केवाईसी अपडेट'],
};
const GREETINGS: Readonly<Record<Tongue, readonly string[]>> = {
  en: ['Hi team,', 'Dear Support,', 'Hello,'],
  hinglish: ['Hello team,', 'Namaste,', 'Hi,'],
  hi: ['नमस्ते,', 'महोदय,'],
};
const CLOSINGS: Readonly<Record<Tongue, readonly string[]>> = {
  en: ['Thanks.', 'Please help.', 'Regards'],
  hinglish: ['Please jaldi dekh lijiye.', 'Dhanyavaad.'],
  hi: ['धन्यवाद।', 'कृपया जल्दी देखें।'],
};

interface Plan {
  /** The types to plant in this message, in order. */
  readonly types: readonly PersonalType[];
  /** How many non-personal sentences to add. */
  readonly others: number;
}

function sentences(
  plan: Plan,
  language: Language,
  rng: Rng,
  lookalikes: readonly Lookalike[],
): string[] {
  const tongue = (): Tongue =>
    language === 'mixed' ? rng.pick(['en', 'hinglish', 'hi'] as const) : language;
  return shuffle(
    [
      ...plan.types.map((type) => valueSentence(type, tongue(), rng)),
      ...Array.from({ length: plan.others }, () => otherSentence(tongue(), rng, lookalikes)),
    ],
    rng,
  );
}

function record(
  plan: Plan,
  language: Language,
  rng: Rng,
  lookalikes: readonly Lookalike[],
): string {
  const tongue: Tongue =
    language === 'mixed' ? rng.pick(['en', 'hinglish', 'hi'] as const) : language;
  const fields = plan.types.map((type) => ({
    name: FIELD[type][tongue],
    value: SLOT[type](rng, tongue),
  }));
  const extra = Array.from({ length: plan.others }, () => ({
    name: rng.pick(['Ref', 'Order', 'Txn', 'Ticket']),
    value: rng.pick(lookalikes)(rng),
  }));
  const all = shuffle([...fields, ...extra], rng);
  return weighted(rng, [
    // One field per line; a row with no names at all; a header and a row.
    [6, all.map((f) => `${f.name}: ${f.value}`).join('\n')],
    [2, all.map((f) => f.value).join(' | ')],
    [2, `${all.map((f) => f.name).join(',')}\n${all.map((f) => f.value).join(',')}`],
  ]);
}

function messageText(
  kind: Kind,
  plan: Plan,
  language: Language,
  rng: Rng,
  lookalikes: readonly Lookalike[] = LOOKALIKES,
): string {
  if (kind === 'record') return record(plan, language, rng, lookalikes);
  const body = sentences(plan, language, rng, lookalikes);
  const frame: Tongue =
    language === 'mixed' ? rng.pick(['en', 'hinglish', 'hi'] as const) : language;
  switch (kind) {
    case 'chat':
      return body.join(rng.pick([' ', '\n']));
    case 'ticket':
      return `Subject: ${rng.pick(SUBJECTS[frame])}\n\n${body.join(' ')}`;
    case 'email':
      return `${rng.pick(GREETINGS[frame])}\n\n${body.join('\n')}\n\n${rng.pick(CLOSINGS[frame])}`;
  }
}

// ---------------------------------------------------------------------------
// The dataset

/** The raw cases (slots, no values), for the generator's own tests. */
export function generateRawCases(seed = GENERATED_SEED): RawCase[] {
  const rng = createRng(seed);

  const kinds = shuffle(
    (Object.keys(CASES_BY_KIND) as Kind[]).flatMap((kind) =>
      Array.from({ length: CASES_BY_KIND[kind] }, () => kind),
    ),
    rng,
  );
  const languages = shuffle(
    (Object.keys(LANGUAGE_TENTHS) as Language[]).flatMap((language) =>
      Array.from({ length: (kinds.length * LANGUAGE_TENTHS[language]) / 10 }, () => language),
    ),
    rng,
  );

  // Which messages carry values, and how many each.
  const messageCount = kinds.reduce((n, kind) => n + (kind === 'chat' ? MESSAGES_PER_CHAT : 1), 0);
  const withValues = shuffle(
    Array.from({ length: messageCount }, (_, i) => i),
    rng,
  ).slice(Math.round(messageCount * SHARE_WITHOUT_VALUES));
  const deck = shuffle(
    MAIN_TYPES.flatMap((type) => Array.from({ length: VALUES_PER_TYPE }, () => type)),
    rng,
  );
  const sizes = new Map(withValues.map((index) => [index, 0]));
  for (let dealt = 0; dealt < deck.length;) {
    // One value for everyone first, then at random, up to the cap.
    const index = dealt < withValues.length ? withValues[dealt]! : rng.pick(withValues);
    if (sizes.get(index)! >= MAX_VALUES_PER_MESSAGE) continue;
    sizes.set(index, sizes.get(index)! + 1);
    dealt++;
  }

  let nextMessage = 0;
  let nextType = 0;
  const planFor = (): Plan => {
    const size = sizes.get(nextMessage++) ?? 0;
    const types = deck.slice(nextType, nextType + size);
    nextType += size;
    return { types, others: size === 0 ? rng.int(1, 3) : rng.int(0, 2) };
  };

  const main = kinds.map((kind, i) => {
    const language = languages[i]!;
    const roles: Role[] = kind === 'chat' ? ['user', 'assistant', 'user'] : ['user'];
    const messages: RawMessage[] = roles.map((role) => {
      const text = messageText(kind, planFor(), language, rng);
      return { role, text, lines: text.split('\n').map(() => 0) };
    });
    return rawCase(i + 1, [kind, language], messages);
  });
  return [...main, ...shapeCases(seed, main.length + 1)];
}

function rawCase(
  number: number,
  tags: readonly string[],
  messages: readonly RawMessage[],
): RawCase {
  return { id: `G${String(number).padStart(4, '0')}`, tags, line: 0, messages };
}

const message = (text: string, role: Role = 'user'): RawMessage => ({
  role,
  text,
  lines: text.split('\n').map(() => 0),
});

// ---------------------------------------------------------------------------
// The shape block (Phase 5c): ways of writing values that the cases above
// never use, each case tagged `shape:<name>`, so that their recall is
// published on its own (report.ts) as well as in the per-type table. It has
// its own random stream, so the 500 cases above render exactly as before.

/** Types planted only in the shape block. */
export const SHORT_ID_TYPES = ['PASSPORT', 'VOTER', 'DOB'] as const;
/** Types planted in the main cases, VALUES_PER_TYPE times each. */
export const MAIN_TYPES = PERSONAL_TYPES.filter(
  (type) => !(SHORT_ID_TYPES as readonly string[]).includes(type),
);

export const SHAPES = [
  'line-break',
  'message-split',
  'side-by-side',
  'digit-beside',
  'contained',
  'joined-digits',
  'short-id',
  'contact-sheet',
  'misaligned-sheet',
  'in-markup',
] as const;
export type Shape = (typeof SHAPES)[number];

/** Personal values planted per shape (short-id: VALUES_PER_TYPE of each short ID type). */
export const SHAPE_VALUES: Readonly<Record<Shape, number>> = {
  'line-break': 120,
  'message-split': 60,
  'side-by-side': 80,
  'digit-beside': 40,
  contained: 70,
  'joined-digits': 30,
  'short-id': 3 * VALUES_PER_TYPE,
  'contact-sheet': 120,
  'misaligned-sheet': 132,
  'in-markup': 90,
};

const SHAPE_SALT = 0x5c5c5c5c;
const BROKEN_TYPES = ['AADHAAR', 'CARD', 'PHONE'] as const;
type BrokenType = (typeof BROKEN_TYPES)[number];

// One line break inside the value: in place of a space, inside a group,
// after a separator, with CRLF; some with a typo, so only a keyword helps.
const LINE_BROKEN: Readonly<Record<BrokenType, readonly string[]>> = {
  AADHAAR: [
    '{{AADHAAR:#### ####\n####}}',
    '{{AADHAAR:####\n#### ####}}',
    '{{AADHAAR:######\n######}}',
    '{{AADHAAR:#### ####\r\n####}}',
    '{{AADHAAR!:#### ####\n####}}',
  ],
  CARD: [
    '{{CARD:#### ####\n#### ####}}',
    '{{CARD:#### #### ####\n####}}',
    '{{CARD:########\n########}}',
    '{{CARD:####-####-\n####-####}}',
    '{{CARD.amex:#### ######\n#####}}',
    '{{CARD!:#### ####\n#### ####}}',
  ],
  PHONE: [
    '{{PHONE:+91 #####\n#####}}',
    '{{PHONE:#####\n#####}}',
    '{{PHONE:+91\n##########}}',
    '{{PHONE:##### \n#####}}',
    '{{PHONE:#####\r\n#####}}',
  ],
};

// A value sent in two messages: the masks of its two pieces.
const SPLIT: Readonly<Record<BrokenType, readonly (readonly [string, string])[]>> = {
  AADHAAR: [
    ['#### ####', '####'],
    ['####', '#### ####'],
  ],
  CARD: [
    ['#### ####', '#### ####'],
    ['#### #### ####', '####'],
  ],
  PHONE: [
    ['#####', '#####'],
    ['+91 #####', '#####'],
  ],
};
const SENT_EARLY: Readonly<Record<Tongue, string>> = {
  en: '(sorry, it got sent too early)',
  hinglish: '(galti se send ho gaya)',
  hi: '(गलती से भेज दिया)',
};

// Two values with only a separator between them.
const PAIRS: readonly (readonly [string, string])[] = [
  ['{{PHONE:##### #####}}', '{{PHONE:##### #####}}'],
  ['{{PHONE}}', '{{PHONE}}'],
  ['{{AADHAAR:#### #### ####}}', '{{AADHAAR:#### #### ####}}'],
  ['{{CARD:#### #### #### ####}}', '{{CARD:#### #### #### ####}}'],
  ['{{AADHAAR:#### #### ####}}', '{{PHONE:##### #####}}'],
  ['{{PHONE:##### #####}}', '{{NUMBER:############}}'],
];
const PAIR_SEPARATORS = [' ', ' - ', '. ', '-'] as const;
const PAIR_FRAMES: ByTongue = {
  en: [
    (p) => `Numbers on file: ${p}.`,
    (p) => `Please update ${p} in my profile.`,
    (p) => `Mobile numbers: ${p}`,
  ],
  hinglish: [(p) => `${p} dono number band hain.`, (p) => `Mere number ${p} hain.`],
  hi: [(p) => `मेरे नंबर ${p} हैं।`],
};

// A spaced mobile with a digit group or a digit-led token beside it (bug-log
// 32 and 34); the last of each language works today and guards against a
// regression.
type Beside = (mobile: string, rng: Rng) => string;
const DIGIT_BESIDE: Readonly<Record<Tongue, readonly Beside[]>> = {
  en: [
    (m, rng) => `Room ${rng.int(1, 9)} ${m} is my number.`,
    (m) => `Contact ${m} {{NOT.pincode:4#####}} Pune.`,
    (m) => `Helpline ${m} 24x7.`,
    (m, rng) => `Call ${m} after ${rng.int(2, 9)} pm.`,
  ],
  hinglish: [
    (m, rng) => `Flat ${rng.int(1, 9)} ${m} pe call karo.`,
    (m) => `Address Kothrud ${m} {{NOT.pincode:4#####}}`,
    (m) => `Helpline ${m} 24x7 chalu hai.`,
    (m, rng) => `${m} ${rng.int(1, 9)} baje ke baad call karo.`,
  ],
  hi: [
    (m, rng) => `कमरा ${rng.int(1, 9)} ${m} मेरा नंबर है।`,
    (m) => `हेल्पलाइन ${m} 24x7 चालू है।`,
    (m, rng) => `${m} पर ${rng.int(1, 9)} बजे के बाद फ़ोन करें।`,
  ],
};

// A checked value inside a longer one, one frame per language (ADR-003).
const CONTAINED: readonly (readonly [string, Readonly<Record<Tongue, Sentence>>])[] = [
  [
    '{{EMAIL.pan}}',
    {
      en: (s) => `Email: ${s}`,
      hinglish: (s) => `Mera email ${s} hai.`,
      hi: (s) => `मेरा ईमेल ${s} है।`,
    },
  ],
  [
    '{{EMAIL.ifsc}}',
    {
      en: (s) => `Email: ${s}`,
      hinglish: (s) => `Mera email ${s} hai.`,
      hi: (s) => `मेरा ईमेल ${s} है।`,
    },
  ],
  [
    '{{EMAIL.mobile}}',
    {
      en: (s) => `Email: ${s}`,
      hinglish: (s) => `Mera email ${s} hai.`,
      hi: (s) => `मेरा ईमेल ${s} है।`,
    },
  ],
  [
    '{{SECRET.ifsc-tail}}',
    {
      en: (s) => `api_key=${s}`,
      hinglish: (s) => `API key: ${s}`,
      hi: (s) => `मेरी API key ${s} है।`,
    },
  ],
  [
    '{{SECRET.ip-tail}}',
    {
      en: (s) => `api_key=${s}`,
      hinglish: (s) => `API key: ${s}`,
      hi: (s) => `मेरी API key ${s} है।`,
    },
  ],
  [
    '{{SECRET.mobile-tail}}',
    {
      en: (s) => `token: ${s}`,
      hinglish: (s) => `Token ${s} kaam nahi kar raha.`,
      hi: (s) => `टोकन ${s} काम नहीं कर रहा।`,
    },
  ],
  [
    '{{UPI.mobile-name}}',
    {
      en: (s) => `UPI: ${s}`,
      hinglish: (s) => `PhonePe par ${s} pe bhej dena.`,
      hi: (s) => `मेरा UPI आईडी ${s} है।`,
    },
  ],
];

// Digits joined to a number by a bracket or "+", too few to be a number on
// their own (Phase 5b probe P9). Labelled as one number.
const JOINED = [
  '{{NUMBER:##########(#####}}',
  '{{NUMBER:# ########(#####}}',
  '{{NUMBER:##########+###}}',
];
const JOINED_FRAMES: ByTongue = {
  en: [(s) => `Account ${s} is pending.`, (s) => `mobile ${s}`],
  hinglish: [(s) => `A/c no ${s} band hai.`],
  hi: [(s) => `खाता ${s} बंद है।`],
};

// Codes and dates shaped like the short IDs, that are not personal.
const SHORT_ID_LOOKALIKES: readonly Lookalike[] = [
  () => '{{NOT.invoice-code:INV#######}}',
  (rng) => `{{NOT.order-code:${rng.pick(['ORD', 'TXN', 'REF'])}#######}}`,
  () => '{{NOT.model-code:?#######}}',
  () => '{{NOT.ticket-code:T#######}}',
  () => '{{NOT.event-date:1#/0#/19##}}',
];

// Contact sheets (bug-log 34, ADR-027): a header, then one row per contact:
// a label and two mobiles written 5 + 5, with only spaces between the
// columns. Aligned sheets of 2 to 5 rows; misaligned ones have one row
// with "+91" in front of its first mobile, or with one mobile missing.
const SHEET_HEADERS: Readonly<Record<Tongue, readonly string[]>> = {
  en: ['Name | Mobile | Alternate mobile', 'Staff list', 'Society numbers'],
  hinglish: ['Naam | Mobile | Doosra mobile', 'Sabke number'],
  hi: ['नाम | मोबाइल | दूसरा मोबाइल', 'नाम और नंबर'],
};
const SHEET_LABELS: Readonly<Record<Tongue, readonly string[]>> = {
  en: ['Home', 'Office', 'Driver', 'Plumber', 'Electrician', 'Watchman', 'Shop', 'Clinic'],
  hinglish: ['Ghar', 'Dukaan', 'Driver bhaiya', 'Doodhwala', 'Office', 'Society'],
  hi: ['घर', 'दुकान', 'दफ़्तर', 'ड्राइवर', 'चौकीदार'],
};
const SHEET_COLUMN_GAPS = [' ', '  '] as const;
// Rows per sheet, in turn: 4 of every 7 aligned sheets have two rows.
const SHEET_ROWS = [2, 3, 2, 4, 2, 5, 2] as const;
// Three sizes against two kinds of misalignment: each kind gets every size.
const MISALIGNED_ROWS = [2, 3, 4] as const;
const SPACED_MOBILE = '{{PHONE:##### #####}}';

type Misalignment = 'aligned' | 'plus91' | 'missing';

/** A contact sheet with `rows` rows; returns the text and the values planted. */
function contactSheet(
  rows: number,
  misalignment: Misalignment,
  tongue: Tongue,
  rng: Rng,
): { text: string; planted: number } {
  const gap = rng.pick(SHEET_COLUMN_GAPS);
  const odd = rng.int(0, rows - 1);
  const lines = [rng.pick(SHEET_HEADERS[tongue])];
  let planted = 0;
  for (let row = 0; row < rows; row++) {
    let cells = [SPACED_MOBILE, SPACED_MOBILE];
    if (row === odd && misalignment === 'plus91') {
      cells = ['{{PHONE:+91 ##### #####}}', SPACED_MOBILE];
    }
    if (row === odd && misalignment === 'missing') {
      // Left out at the end of the row, or marked "-" in either column.
      cells = rng.pick([[SPACED_MOBILE], [SPACED_MOBILE, '-'], ['-', SPACED_MOBILE]]);
    }
    planted += cells.filter((cell) => cell !== '-').length;
    lines.push(`${rng.pick(SHEET_LABELS[tongue])} ${cells.join(gap)}`);
  }
  return { text: lines.join('\n'), planted };
}

// Values inside markup (Phase 5d, the echo measurement): a URL's query or
// path, a markdown link's text or target, an image, `mailto:`, an HTML
// attribute or an element's text, a reference definition. Restoration
// leaves a placeholder in a URL, a destination or an attribute value
// unrestored (restoration safety), and restores one in link or element
// text; each placement gets the same number of values, of the types people
// put there.
type Placement = readonly [markup: (slot: string) => string, slots: readonly string[]];
const IN_MARKUP: readonly Placement[] = [
  [
    (s) => `https://support.example/track?id=${s}`,
    ['{{EMAIL}}', '{{PHONE}}', '{{PAN}}', '{{AADHAAR}}'],
  ],
  [(s) => `https://portal.example/users/${s}/orders`, ['{{EMAIL}}', '{{PAN}}', '{{UPI}}']],
  [(s) => `[${s}](https://portal.example/profile)`, ['{{EMAIL}}', '{{PHONE}}', '{{UPI}}']],
  [
    (s) => `[my profile](${s})`,
    ['mailto:{{EMAIL}}', 'tel:{{PHONE:+91##########}}', 'https://portal.example/kyc?pan={{PAN}}'],
  ],
  [
    (s) => `![receipt](https://cdn.example/receipt.png?m=${s})`,
    ['{{EMAIL}}', '{{PHONE}}', '{{AADHAAR}}'],
  ],
  [(s) => `mailto:${s}`, ['{{EMAIL}}']],
  [
    (s) => s,
    [
      '<a href="mailto:{{EMAIL}}">write to me</a>',
      '<input type="tel" value="{{PHONE}}">',
      "<div data-pan='{{PAN}}'>KYC</div>",
    ],
  ],
  [(s) => `<td>${s}</td>`, ['{{EMAIL}}', '{{PHONE}}', '{{AADHAAR}}']],
  [(s) => `[profile]: https://portal.example/?u=${s}`, ['{{EMAIL}}', '{{PHONE}}']],
  [(s) => `<img src="https://cdn.example/p.png?u=${s}" alt="photo">`, ['{{EMAIL}}', '{{UPI}}']],
];
const MARKUP_FRAMES: ByTongue = {
  en: [(m) => `Details: ${m}`, (m) => `Please check ${m} and reply.`],
  hinglish: [(m) => `Details yahan hain: ${m}`, (m) => `${m} dekh lijiye.`],
  hi: [(m) => `विवरण: ${m}`, (m) => `कृपया ${m} देखें।`],
};

const pickTongue = (rng: Rng): Tongue =>
  weighted<Tongue>(rng, [
    [5, 'en'],
    [3, 'hinglish'],
    [2, 'hi'],
  ]);

function shapeCases(seed: number, firstNumber: number): RawCase[] {
  const rng = createRng((seed ^ SHAPE_SALT) >>> 0);
  const out: RawCase[] = [];
  const add = (kind: Kind, tongue: Tongue, shape: Shape, messages: readonly RawMessage[]): void => {
    out.push(rawCase(firstNumber + out.length, [kind, tongue, SHAPE_TAG + shape], messages));
  };
  const ticket = (tongue: Tongue, sentence: string): string => {
    const body = rng.chance(0.5) ? [sentence, otherSentence(tongue, rng, LOOKALIKES)] : [sentence];
    return `Subject: ${rng.pick(SUBJECTS[tongue])}\n\n${shuffle(body, rng).join(' ')}`;
  };

  for (let i = 0; i < SHAPE_VALUES['line-break']; i++) {
    const type = BROKEN_TYPES[i % BROKEN_TYPES.length]!;
    const tongue = pickTongue(rng);
    const sentence = rng.pick(SENTENCES[type][tongue])(rng.pick(LINE_BROKEN[type]));
    add('ticket', tongue, 'line-break', [message(ticket(tongue, sentence))]);
  }
  for (let i = 0; i < SHAPE_VALUES['message-split']; i++) {
    const type = BROKEN_TYPES[i % BROKEN_TYPES.length]!;
    const tongue = pickTongue(rng);
    const [first, rest] = rng.pick(SPLIT[type]);
    add('chat', tongue, 'message-split', [
      message(`${FIELD[type][tongue]}: {{${type}@v:${first}}}`),
      message(`{{@v:${rest}}} ${SENT_EARLY[tongue]}`),
    ]);
  }
  for (let i = 0; i < SHAPE_VALUES['side-by-side'] / 2; i++) {
    const tongue = pickTongue(rng);
    const [a, b] = PAIRS[i % PAIRS.length]!;
    const pair = `${a}${rng.pick(PAIR_SEPARATORS)}${b}`;
    add('ticket', tongue, 'side-by-side', [
      message(ticket(tongue, rng.pick(PAIR_FRAMES[tongue])(pair))),
    ]);
  }
  for (let i = 0; i < SHAPE_VALUES['digit-beside']; i++) {
    const tongue = pickTongue(rng);
    const mobile = rng.chance(0.8) ? '{{PHONE:##### #####}}' : '{{PHONE:+91 ##### #####}}';
    add('ticket', tongue, 'digit-beside', [
      message(ticket(tongue, rng.pick(DIGIT_BESIDE[tongue])(mobile, rng))),
    ]);
  }
  for (let i = 0; i < SHAPE_VALUES.contained; i++) {
    const tongue = pickTongue(rng);
    const [slot, frames] = CONTAINED[i % CONTAINED.length]!;
    add('ticket', tongue, 'contained', [message(ticket(tongue, frames[tongue](slot)))]);
  }
  for (let i = 0; i < SHAPE_VALUES['joined-digits']; i++) {
    const tongue = pickTongue(rng);
    const slot = JOINED[i % JOINED.length]!;
    add('ticket', tongue, 'joined-digits', [
      message(ticket(tongue, rng.pick(JOINED_FRAMES[tongue])(slot))),
    ]);
  }

  // Short IDs: every one of them VALUES_PER_TYPE times, one to three to a
  // message, among lookalikes of the same shape.
  const deck = shuffle(
    SHORT_ID_TYPES.flatMap((type) => Array.from({ length: VALUES_PER_TYPE }, () => type)),
    rng,
  );
  for (let at = 0; at < deck.length;) {
    const size = Math.min(rng.int(1, 3), deck.length - at);
    const tongue = pickTongue(rng);
    const kind = weighted<Kind>(rng, [
      [5, 'ticket'],
      [3, 'email'],
      [2, 'record'],
    ]);
    const plan: Plan = { types: deck.slice(at, at + size), others: rng.int(0, 2) };
    at += size;
    add(kind, tongue, 'short-id', [
      message(messageText(kind, plan, tongue, rng, SHORT_ID_LOOKALIKES)),
    ]);
  }

  // Contact sheets come last, so that every shape above renders as before.
  for (let i = 0, planted = 0; planted < SHAPE_VALUES['contact-sheet']; i++) {
    const tongue = pickTongue(rng);
    const sheet = contactSheet(SHEET_ROWS[i % SHEET_ROWS.length]!, 'aligned', tongue, rng);
    planted += sheet.planted;
    add('record', tongue, 'contact-sheet', [message(sheet.text)]);
  }
  for (let i = 0, planted = 0; planted < SHAPE_VALUES['misaligned-sheet']; i++) {
    const tongue = pickTongue(rng);
    const rows = MISALIGNED_ROWS[i % MISALIGNED_ROWS.length]!;
    const sheet = contactSheet(rows, i % 2 === 0 ? 'plus91' : 'missing', tongue, rng);
    planted += sheet.planted;
    add('record', tongue, 'misaligned-sheet', [message(sheet.text)]);
  }
  // Markup comes after the sheets, for the same reason.
  for (let i = 0; i < SHAPE_VALUES['in-markup']; i++) {
    const tongue = pickTongue(rng);
    const [markup, slots] = IN_MARKUP[i % IN_MARKUP.length]!;
    const slot = slots[Math.floor(i / IN_MARKUP.length) % slots.length]!;
    const sentence = rng.pick(MARKUP_FRAMES[tongue])(markup(slot));
    add('ticket', tongue, 'in-markup', [message(ticket(tongue, sentence))]);
  }
  return out;
}

/** The generated dataset, rendered: the same messages for the same seed. */
export function generateCases(seed = GENERATED_SEED): LabelledCase[] {
  return generateRawCases(seed).map((raw) => renderCase(raw, seed));
}

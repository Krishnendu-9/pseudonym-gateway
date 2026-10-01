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
import { PERSONAL_TYPES, type LabelledCase, type PersonalType, type Role } from './types.js';

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

function otherSentence(tongue: Tongue, rng: Rng): string {
  return rng.chance(0.5)
    ? rng.pick(NAMED[tongue])(rng.pick(LOOKALIKES)(rng))
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

function sentences(plan: Plan, language: Language, rng: Rng): string[] {
  const tongue = (): Tongue =>
    language === 'mixed' ? rng.pick(['en', 'hinglish', 'hi'] as const) : language;
  return shuffle(
    [
      ...plan.types.map((type) => valueSentence(type, tongue(), rng)),
      ...Array.from({ length: plan.others }, () => otherSentence(tongue(), rng)),
    ],
    rng,
  );
}

function record(plan: Plan, language: Language, rng: Rng): string {
  const tongue: Tongue =
    language === 'mixed' ? rng.pick(['en', 'hinglish', 'hi'] as const) : language;
  const fields = plan.types.map((type) => ({
    name: FIELD[type][tongue],
    value: SLOT[type](rng, tongue),
  }));
  const extra = Array.from({ length: plan.others }, () => ({
    name: rng.pick(['Ref', 'Order', 'Txn', 'Ticket']),
    value: rng.pick(LOOKALIKES)(rng),
  }));
  const all = shuffle([...fields, ...extra], rng);
  return weighted(rng, [
    // One field per line; a row with no names at all; a header and a row.
    [6, all.map((f) => `${f.name}: ${f.value}`).join('\n')],
    [2, all.map((f) => f.value).join(' | ')],
    [2, `${all.map((f) => f.name).join(',')}\n${all.map((f) => f.value).join(',')}`],
  ]);
}

function messageText(kind: Kind, plan: Plan, language: Language, rng: Rng): string {
  if (kind === 'record') return record(plan, language, rng);
  const body = sentences(plan, language, rng);
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
    PERSONAL_TYPES.flatMap((type) => Array.from({ length: VALUES_PER_TYPE }, () => type)),
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

  return kinds.map((kind, i) => {
    const language = languages[i]!;
    const roles: Role[] = kind === 'chat' ? ['user', 'assistant', 'user'] : ['user'];
    const messages: RawMessage[] = roles.map((role) => {
      const text = messageText(kind, planFor(), language, rng);
      return { role, text, lines: text.split('\n').map(() => 0) };
    });
    return {
      id: `G${String(i + 1).padStart(4, '0')}`,
      tags: [kind, language],
      line: 0,
      messages,
    };
  });
}

/** The generated dataset, rendered: the same 600 messages for the same seed. */
export function generateCases(seed = GENERATED_SEED): LabelledCase[] {
  return generateRawCases(seed).map((raw) => renderCase(raw, seed));
}

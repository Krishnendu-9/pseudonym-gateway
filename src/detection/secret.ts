// Secrets: API keys, tokens, private keys and passwords (ADR-022).
//
// Two ways of finding one, and no third:
//
// 1. A KNOWN FORMAT: a provider's published prefix, followed by its alphabet,
//    at least as long as the provider makes it ("ghp_" and 36 letters and
//    digits). These are validated (ADR-003): the shape alone is the evidence.
//    A key longer than its format says is taken whole.
// 2. A KEYWORD ASSIGNMENT: a credential word ("password", "api key", "token",
//    "OTP"…) directly followed by a value: `password: …`, `api_key=…`,
//    `Mera password … hai`. Unvalidated, with context by construction.
//
// There is no entropy scanning (ADR-021): a random-looking string with no
// known prefix and no credential word before it is NOT found. That is a
// stated limit, measured in the evaluation, not an oversight.
//
// The hard part of (2) is prose: "my password is wrong" has the same shape
// as "my password is hunter2". So a value is taken only when the way it is
// written says it is one:
//   - after "=" (`password=…`): always;
//   - in quotes: always;
//   - after ":" when it is the last thing on its line (`Password: …`);
//   - anywhere else, only if it looks like a secret: 6 or more characters
//     with a digit or one of @ # $ % ^ & * ! + = ~ | < >;
//   - after a word for a numeric code (OTP, PIN, CVV): 3 to 8 digits.
// A password made only of letters, written in a sentence, is therefore
// missed, and so is any value that does not directly follow its keyword.
//
// Everything here takes time linear in the text: a known format starts only
// where no part of a longer token precedes it, and a keyword's value is
// judged from facts worked out once per stretch of non-blank text.
//
// This runs on normalised text. Lists here are the detector's own, from the
// providers' documentation; the generator keeps its own (ADR-008).

import { charBefore } from './digit-runs.js';
import { normalise, type Span } from './normalise.js';
import type { Candidate } from './types.js';

// ---------------------------------------------------------------------------
// 1. Known formats

const ALNUM = 'A-Za-z0-9';

// Prefix, alphabet, minimum length. Sources: each provider's documentation
// of its key format, cross-checked against the gitleaks default rules
// (2026-09-30). Minimums are the documented lengths or shorter: providers
// change their lengths, and a long prefix needs little after it to be
// unmistakable.
const PREFIXED = [
  // OpenAI (sk-, sk-proj-, sk-svcacct-, sk-admin-), Anthropic (sk-ant-) and
  // the providers that copied the prefix. "sk-" is short, so these also
  // need a digit or a capital letter (checked below):
  // "sk-learn-based-text-classification" is not a key.
  `(?<sk>sk-[${ALNUM}_-]{20,})`,
  // GitHub: personal, OAuth, user-to-server, server-to-server, refresh.
  `gh[pousr]_[${ALNUM}]{36,}`,
  `github_pat_[${ALNUM}_]{22,}`,
  `glpat-[${ALNUM}_-]{20,}`,
  // AWS access key IDs (long-term and temporary).
  `(?:AKIA|ASIA)[${ALNUM}]{16,}`,
  // Stripe secret and restricted keys, webhook signing secrets.
  `[sr]k_(?:live|test|prod)_[${ALNUM}]{10,}`,
  `whsec_[${ALNUM}]{24,}`,
  `rzp_(?:live|test)_[${ALNUM}]{14,}`,
  // Slack bot, user, app, refresh and legacy tokens.
  `xox[abeoprs]-[${ALNUM}-]{10,}`,
  `xapp-[${ALNUM}-]{10,}`,
  // Google API keys.
  `AIza[${ALNUM}_-]{35,}`,
  `npm_[${ALNUM}]{36,}`,
  `hf_[${ALNUM}]{30,}`,
].join('|');

// A PEM private key block, to its END line; with no END line, to the end of
// the text (fail closed: a key cut off by a length limit is still a key).
const PEM_LABEL = '[A-Z0-9 ]{0,100}PRIVATE KEY(?: BLOCK)?-----';
const PEM = `-----BEGIN${PEM_LABEL}[\\s\\S]*?(?:-----END${PEM_LABEL}|$)`;

// Not glued to a letter, digit, mark or underscore: "ask-…" and
// "Xghp_…" are parts of other tokens.
const KNOWN_FORMAT = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_])(?:${PREFIXED})|${PEM}`, 'gu');

// A key takes the rest of the token it is glued to (ADR-029, like the safety
// net's whole-token rule, ADR-011): letters, digits, marks, "_" and "-", and
// parts joined by single dots. A key whose alphabet has "-" can run into the
// next key's prefix ("sk-…-ghp_…"), and that key is then never matched; the
// two become one secret rather than half of the second being sent.
const REST_OF_TOKEN = /[\p{L}\p{N}\p{M}_-]*(?:\.[\p{L}\p{N}\p{M}_-]+)*/uy;

function restOfToken(text: string, at: number): number {
  REST_OF_TOKEN.lastIndex = at;
  REST_OF_TOKEN.exec(text);
  return REST_OF_TOKEN.lastIndex;
}

function* knownFormats(text: string): Generator<Candidate> {
  KNOWN_FORMAT.lastIndex = 0;
  for (let m = KNOWN_FORMAT.exec(text); m; m = KNOWN_FORMAT.exec(text)) {
    if (m.groups!.sk !== undefined && !/[0-9A-Z]/.test(m[0])) continue;
    const end = restOfToken(text, m.index + m[0].length);
    yield { type: 'SECRET', start: m.index, end, validated: true };
    // Whatever the token held is covered: go on after it, so a long chain
    // of keys is read once.
    KNOWN_FORMAT.lastIndex = end;
  }
  yield* jsonWebTokens(text);
}

// A JSON Web Token: two base64url parts that each start with `{"` encoded
// ("eyJ") and have at least 8 more characters, then an optional signature.
// It starts where no letter, digit, mark or "_" precedes it, or right after
// a "-" (ADR-029: `<value>-eyJ…`), never after a dot. Its alphabet includes
// "-", so a pattern search would start again at every hyphen of a long
// dotless "eyJ…-eyJ…" chain; instead each run of base64url characters and
// dots is split at its dots once, and a header start is looked for in each
// part, left to right.
const JWT_RUN = /[A-Za-z0-9_.-]+/g;
const JWT_PART_MIN = 11; // "eyJ" and 8 more
const GLUED_BEFORE = /[\p{L}\p{N}\p{M}_]/u;

function* jsonWebTokens(text: string): Generator<Candidate> {
  for (const run of text.matchAll(JWT_RUN)) {
    const parts: Span[] = [];
    let at = run.index;
    for (const piece of run[0].split('.')) {
      parts.push({ start: at, end: at + piece.length });
      at += piece.length + 1;
    }
    const runGlued = GLUED_BEFORE.test(charBefore(text, run.index));
    let coveredTo = run.index;
    for (let k = 0; k + 1 < parts.length; k++) {
      const header = parts[k]!;
      if (header.start < coveredTo) continue;
      const start = headerStart(text, header, k === 0 && !runGlued);
      const payload = parts[k + 1]!;
      if (start < 0 || !isJwtPart(text, payload.start, payload.end)) continue;
      // A signature, even an empty one ("header.payload."), then the rest.
      const end = restOfToken(text, parts[k + 2]?.end ?? payload.end);
      yield { type: 'SECRET', start, end, validated: true };
      coveredTo = end;
    }
  }
}

/** The first allowed header start in `part`, or -1. */
function headerStart(text: string, part: Span, mayStartAtPart: boolean): number {
  if (mayStartAtPart && isJwtPart(text, part.start, part.end)) return part.start;
  // Searched within the part only, so every part is read once. The earliest
  // start is the longest; if it is too short, so is every later one.
  const hyphen = text.slice(part.start, part.end).indexOf('-eyJ');
  const start = part.start + hyphen + 1;
  return hyphen >= 0 && isJwtPart(text, start, part.end) ? start : -1;
}

const isJwtPart = (text: string, start: number, end: number): boolean =>
  end - start >= JWT_PART_MIN && text.startsWith('eyJ', start);

// ---------------------------------------------------------------------------
// 2. Keyword assignment

// Words for a numeric code. Their value may also be 3 to 8 digits.
const CODE_WORDS = ['otp', 'm?pin', 'cvv2?', 'cvc', 'passcode', 'ओटीपी', 'पिन'];
// Longer forms first: "secret key" must not stop at "secret".
const SECRET_WORDS = [
  'pass(?:word|wd|phrase)',
  'pwd',
  '(?:secret[ _-]?)?access[ _-]?key',
  'secret[ _-]?key',
  'private[ _-]?key',
  'api[ _-]?(?:key|secret|token)',
  'auth[ _-]?token',
  'secret',
  'token',
  'bearer',
  'पासवर्ड',
  'टोकन',
];

// Keywords are normalised exactly like the text they are matched in.
const words = (list: readonly string[]): string =>
  list.map((word) => normalise(word).text).join('|');

const BLANK = '[^\\S\\n]';
const NOT_IN_WORD = '(?![\\p{L}\\p{M}])';

// First: the keyword, not inside a longer word; it may be part of an
//        identifier (DB_PASSWORD, secret_access_key, token-value).
// link:  after a closing quote (`"password": …`): blanks on the same line,
//        a linking word (is, was, hai, है, a spaced dash), and ":" or "=".
// open:  quotes and brackets before the value. The value itself is not
//        matched here: see stretchAt().
const ASSIGNMENT = new RegExp(
  `(?<![\\p{L}\\p{M}])(?:(?<code>${words(CODE_WORDS)})|${words(SECRET_WORDS)})${NOT_IN_WORD}(?:[_-][${ALNUM}_-]*)?` +
    '["\'`”’]?' +
    `(?<link>${BLANK}*(?:(?:is|was|hai|tha|है|था|[-–—])(?![\\p{L}\\p{N}\\p{M}])${BLANK}*)?(?<assign>(?::=|=>|[:=])\\s*)?)` +
    '(?<open>["\'`“‘(\\[{<]*)(?=\\S)',
  'giu',
);

const QUOTE = /["'`“‘]/;
// Punctuation that ends a sentence or closes a bracket or quote. "!" and
// "?" are not here: passwords end in them far more often than sentences do
// right after a password.
const CLOSER = /[.,;:)\]}>"'`”’।]/;
const EVIDENCE = /[0-9@#$%^&*!+=~|<>]/;
const BLANKS_TO_LINE_END = /[^\S\n]*(?:\n|$)/y;
const WHITESPACE = /\s/g;

/** A keyword-assigned value must be at least this long to count on its looks alone. */
export const MIN_SECRET_LOOKING_LENGTH = 6;

/** What is known about the stretch of non-blank text a value sits in. */
interface Stretch {
  /** The first whitespace after it, or the end of the text. */
  readonly end: number;
  /** `end` without the closing punctuation. */
  readonly valueEnd: number;
  /** The last digit or symbol before `valueEnd`; before the stretch if it has none. */
  readonly lastEvidence: number;
  /** Nothing but blanks follows on its line. */
  readonly lastOnLine: boolean;
}

function stretchAt(text: string, from: number): Stretch {
  WHITESPACE.lastIndex = from;
  const end = WHITESPACE.exec(text)?.index ?? text.length;
  let valueEnd = end;
  while (valueEnd > from && CLOSER.test(text[valueEnd - 1]!)) valueEnd--;
  let lastEvidence = valueEnd - 1;
  while (lastEvidence >= from && !EVIDENCE.test(text[lastEvidence]!)) lastEvidence--;
  BLANKS_TO_LINE_END.lastIndex = end;
  return { end, valueEnd, lastEvidence, lastOnLine: BLANKS_TO_LINE_END.test(text) };
}

function* keywordAssignments(text: string): Generator<Candidate> {
  let stretch: Stretch | undefined;
  // Its own copy: the search position lives in the pattern, and this
  // generator may be paused between two values.
  const assignment = new RegExp(ASSIGNMENT);
  for (let m = assignment.exec(text); m !== null; m = assignment.exec(text)) {
    const { code, link, assign, open } = m.groups as {
      code?: string;
      link: string;
      assign?: string;
      open: string;
    };
    const start = m.index + m[0].length;
    // Many keywords can sit in one long stretch ("pin:pin:pin:…"): its facts
    // are worked out once, at the first of them, and hold for every later
    // start in it, so that each keyword costs a fixed amount.
    if (!stretch || start >= stretch.end) stretch = stretchAt(text, start);
    const { valueEnd, lastEvidence, lastOnLine } = stretch;
    const length = valueEnd - start;

    const accepted =
      link.length > 0 &&
      length > 0 &&
      (assign?.includes('=') === true ||
        QUOTE.test(open) ||
        (assign !== undefined && lastOnLine) ||
        (length >= MIN_SECRET_LOOKING_LENGTH && lastEvidence >= start) ||
        (code !== undefined && length <= 8 && /^[0-9]{3,8}$/.test(text.slice(start, valueEnd))));

    // A keyword turned down costs nothing: the search goes on from where its
    // value would have started, so "secret token: …" is found at "token".
    if (!accepted) continue;
    yield { type: 'SECRET', start, end: valueEnd, validated: false, context: true };
    // One value, one candidate: keywords inside it are not looked at.
    assignment.lastIndex = valueEnd;
  }
}

export function* secretCandidates(text: string): Generator<Candidate> {
  yield* knownFormats(text);
  yield* keywordAssignments(text);
}

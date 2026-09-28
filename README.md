# Pseudonym

**An OpenAI-compatible privacy gateway that pseudonymises personal data before it
reaches an LLM, and restores it in the reply.**

> **Status: work in progress.** Not ready for production use. The design below is
> being built; the [supported data types](#supported-data-types) table shows what
> is available today. Built so far: Unicode normalisation with an offset map, and
> detectors for email, phone, Aadhaar, PAN and card numbers, as a library with
> unit tests. Nothing is replaced or sent anywhere yet: placeholders, the gateway
> and provider adapters come next. Detection accuracy has not been measured yet.

---

## The idea in 30 seconds

Apps increasingly send user text (support tickets, emails, chat logs) to hosted
AI models. That text is full of personal data. Pseudonym sits between your app and
the AI provider:

```
Your app ──► Pseudonym ──► AI provider
                │               │
   detects personal data   sees only placeholders
   swaps it for placeholders
                │               │
Your app ◄── Pseudonym ◄── AI answer
   real values restored in the answer
```

**What the user sends:**

> Hi, I'm Priya Sharma (priya.sharma@example.com). My card 4111 1111 1111 1111
> was charged twice. Can you help?

**What the AI provider receives:**

> Hi, I'm [PERSON_1] ([EMAIL_1]). My card [CARD_1] was charged twice. Can you help?

**What the user gets back:**

> Sorry about that, Priya Sharma. I've flagged the duplicate charge on card
> 4111 1111 1111 1111 and we'll email priya.sharma@example.com within 24 hours.

To adopt it, an app only changes its API base URL. No code changes.

_(All example data in this repo is synthetic. 4111 1111 1111 1111 is a published
test card number. Person-name detection is planned; emails and card numbers come
first.)_

## The promise

> Every personal value Pseudonym detects is replaced before the request leaves
> your network, and the answer the user receives still reads naturally. How much
> Pseudonym detects is measured and published, per data type.

No detector catches everything, so this project doesn't claim to. Instead, it
proves that everything it detects is replaced, and it publishes measured
detection rates instead of marketing numbers.

## Design

What Pseudonym is being built to do:

- **OpenAI-compatible API.** `POST /v1/chat/completions`; switch by changing the
  base URL.
- **Stateless by design.** Chat APIs resend the full history on every request, so
  Pseudonym re-pseudonymises it deterministically each time. The same person is
  always `[PERSON_1]`, without storing anything between requests.
- **India-aware detection.** Aadhaar (Verhoeff check digit), PAN, IFSC and UPI IDs
  alongside emails, phone numbers and card numbers (Luhn check).
- **Unicode-hardened.** Digits in any script (full-width, mathematical,
  Devanagari, Bengali, Tamil and every other Unicode decimal digit) are
  normalised, and invisible characters that can hide data (zero-width spaces,
  soft hyphens, direction marks) are removed before detection. Values are still
  replaced in the original text, so a hidden value is replaced completely.
- **Streaming-safe restoration.** Placeholders split across streamed chunks
  (`[PER` + `SON_1]`) are restored correctly with minimal buffering.
- **Injection-aware.** Values are not restored inside URLs or links, blocking a
  known data-exfiltration trick.
- **Proof plan.** A no-leak test, property-based streaming tests, and an
  evaluation suite with a held-out, hand-written adversarial dataset.

## Supported data types

**Detection only, so far.** The detectors below find values and report where
they are, and they are unit-tested. **Nothing is redacted end to end yet:**
replacing values with placeholders and restoring them (Phase 2) and the gateway
that forwards requests to a provider (Phase 3) are not built. Do not rely on
Pseudonym to protect data today.

| Type                               | Validation                                                                            | Status                       |
| ---------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------- |
| Email                              | pattern (Unicode addresses included)                                                  | detection only (unit-tested) |
| Phone (India + international)      | libphonenumber-js, full metadata                                                      | detection only (unit-tested) |
| Aadhaar                            | Verhoeff check digit, first digit 2–9                                                 | detection only (unit-tested) |
| PAN                                | format + holder-type letter                                                           | detection only (unit-tested) |
| Card number                        | Luhn + issuer prefix (Visa, Mastercard, Amex, Discover, RuPay, Diners, JCB, UnionPay) | detection only (unit-tested) |
| IFSC, UPI ID, IP address, API keys | pattern + context                                                                     | planned                      |
| Person names                       | local NER model                                                                       | planned                      |

Which detected matches count (and will be redacted once Phases 2–3 exist):

- **Validated** (passes the checks above): always.
- **Right shape, failed checks** (for example an Aadhaar with a typo in its
  check digit): only if a keyword for that type is nearby ("Aadhaar", "UID",
  "card", "PAN", "call", "mobile", and Hindi आधार, कार्ड, पैन, फ़ोन, मोबाइल).
- **Email:** on the pattern alone.

This leans towards redacting: a check digit passes about 1 in 10 random
numbers, so some ordinary numbers (order IDs, invoice numbers) will be
replaced too; the user will still see the real number in the reply. Digits in any
script (Devanagari, Bengali, Tamil, full-width…) and numbers split by invisible
characters are detected. Detection fails closed: a value found inside a longer
number takes the whole number with it, and no input is skipped for being too
long.

Known gaps in the built detectors: values glued to letters (`UID234…`) are
not detected, so that hashes and API keys are not cut up; nor are emails
written as "name at example dot com", quoted or IP-literal addresses, or the
16-digit Aadhaar Virtual ID.

Measured precision and recall will be published here once the evaluation suite
exists. Until then, no accuracy numbers are claimed.

## Unsupported input

Pseudonym will handle text chat messages (system, user and assistant roles),
streamed and non-streamed. Tool/function calls, image or audio content,
embeddings and other endpoints are out of scope at first: they will be
**rejected with a 4xx error**, never forwarded unredacted.

## Threat model (summary)

**Protects against:** the AI provider seeing detected personal values, and
provider-side logging or training on them.

**Does not protect against:** values the detectors miss; anything your application
logs before calling Pseudonym; a compromised Pseudonym host; prompt injection that
manipulates answers (only the URL-exfiltration path is mitigated).

The full threat model will be documented as the project matures.

## Running locally

Requires Node.js 22+.

```bash
npm install
npm test            # run the test suite
npm run lint        # lint
npm run typecheck   # type-check
```

The gateway server is not built yet.

## Tech stack

Installed today: TypeScript (strict) · Node.js 22 · Zod · libphonenumber-js
(phone validation) · Vitest · fast-check · ESLint · Prettier

Chosen but not yet installed: Fastify (HTTP server, added in Phase 3)

## License

[MIT](LICENSE)

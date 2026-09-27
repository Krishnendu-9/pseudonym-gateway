# Pseudonym

**An OpenAI-compatible privacy gateway that pseudonymises personal data before it
reaches an LLM, and restores it in the reply.**

> **Status: work in progress.** Not ready for production use. The design below is
> being built; the [supported data types](#supported-data-types) table shows what
> is available today.

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
- **Unicode-hardened.** Full-width and Devanagari digits, and zero-width characters
  used to hide data, are normalised before detection.
- **Streaming-safe restoration.** Placeholders split across streamed chunks
  (`[PER` + `SON_1]`) are restored correctly with minimal buffering.
- **Injection-aware.** Values are not restored inside URLs or links, blocking a
  known data-exfiltration trick.
- **Proof plan.** A no-leak test, property-based streaming tests, and an
  evaluation suite with a held-out, hand-written adversarial dataset.

## Supported data types

| Type                               | Validation                     | Status  |
| ---------------------------------- | ------------------------------ | ------- |
| Email                              | pattern                        | planned |
| Phone (India + international)      | libphonenumber                 | planned |
| Aadhaar                            | Verhoeff check digit + context | planned |
| PAN                                | format + entity-type letter    | planned |
| Card number                        | Luhn + issuer prefix           | planned |
| IFSC, UPI ID, IP address, API keys | pattern + context              | planned |
| Person names                       | local NER model                | planned |

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

Installed today: TypeScript (strict) · Node.js 22 · Zod · Vitest · fast-check ·
ESLint · Prettier

Chosen but not yet installed: Fastify (HTTP server, added in Phase 3) ·
libphonenumber-js (phone validation, added in Phase 1b)

## License

[MIT](LICENSE)
# Pseudonym

**An OpenAI-compatible privacy gateway that pseudonymises personal data before it
reaches an LLM, and restores it in the reply.**

> **Status: work in progress (Phase 3 of 8 done; Phase 4 half done: streaming
> restoration is built and tested, the streaming endpoint is not).** Not ready
> for production use.
> Pseudonym now runs as a gateway: `POST /v1/chat/completions` (OpenAI format,
> **non-streaming only**) redacts emails, phone numbers, Aadhaar, PAN, card
> numbers and any other number of 9+ digits, forwards the request to a local
> [Ollama](https://ollama.com) model, and restores the values in the answer.
> A no-leak test sends 737 planted values through it and checks none reaches
> the provider. **Person names and API keys are not detected yet** (they are
> sent as written), streaming is rejected, and detection accuracy has not
> been measured yet.

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

To adopt it, an app changes its API base URL and sets the model name to the one
Pseudonym is configured for. No other code changes.

_(All example data in this repo is synthetic. 4111 1111 1111 1111 is a published
test card number. Person-name detection is planned (Phase 6): today, the name in
this example would be sent as written; the email and card number would not.)_

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
  base URL and the model name. Every request field is on an allowlist:
  message text and `stop` are redacted, numeric settings are forwarded,
  `user` is dropped, and anything else is rejected rather than forwarded.
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
- **Placeholder instruction.** When a request contains placeholders,
  Pseudonym adds one short system message asking the model to copy them
  exactly, since a placeholder the model rewrites ("email 1") cannot be
  restored. On by default and switchable (`PSEUDONYM_PLACEHOLDER_INSTRUCTION`);
  whether it helps will be measured, and the default will follow.
- **Streaming-safe restoration** (engine built; endpoint planned, Phase 4b).
  Placeholders split across streamed chunks (`[CAR` + `D_1]`) are restored
  correctly, holding back at most 15 characters and only while the text
  could still become a placeholder. A property test checks that any way of
  cutting an answer gives exactly the same result as restoring it whole.
  Until the endpoint exists, streaming requests are rejected.
- **Injection-aware.** Values are not restored inside URLs, markdown links or
  HTML attributes, or where they would become part of a hostname
  (`CARD_1.attacker.example`), blocking a known image-URL exfiltration trick.
  This covers that one path, not prompt injection in general.
- **Proof.** Built: a no-leak test (737 planted values through the real gateway
  to a recording mock provider; none may arrive in any form) and a canary test
  (every error path forced; no planted value in any response, log line or
  error), each shown able to fail by switching off one detector or check at a
  time; property-based streaming restoration tests. Planned: streaming
  no-leak and canary tests, and an evaluation suite with
  a held-out, hand-written adversarial dataset.

## Supported data types

The types marked "redacted" below are replaced before a request leaves
Pseudonym, in every message and in `stop`. Everything else in a message is
sent as written: a person's name or an API key typed into a message **goes to
the provider today**. Accuracy has not been measured yet (Phase 5), so do not
rely on Pseudonym to protect real data.

| Type                               | Validation                                                                            | Status   |
| ---------------------------------- | ------------------------------------------------------------------------------------- | -------- |
| Email                              | pattern (Unicode addresses included)                                                  | redacted |
| Phone (India + international)      | libphonenumber-js, full metadata                                                      | redacted |
| Aadhaar                            | Verhoeff check digit, first digit 2–9                                                 | redacted |
| PAN                                | format + holder-type letter                                                           | redacted |
| Card number                        | Luhn + issuer prefix (Visa, Mastercard, Amex, Discover, RuPay, Diners, JCB, UnionPay) | redacted |
| Any other number of 9+ digits      | none: a safety net for numbers no detector claimed (bank accounts, odd layouts)       | redacted |
| IFSC, UPI ID, IP address, API keys | pattern + context                                                                     | planned  |
| Person names                       | local NER model                                                                       | planned  |

Which detected matches count:

- **Validated** (passes the checks above): always.
- **Right shape, failed checks** (for example an Aadhaar with a typo in its
  check digit): only if a keyword for that type is nearby ("Aadhaar", "UID",
  "card", "PAN", "call", "mobile", and Hindi आधार, कार्ड, पैन, फ़ोन, मोबाइल).
- **Email:** on the pattern alone.
- **Any stretch of 9 or more digits that no detector claimed**, counted across
  dots, hyphens, dashes, brackets and `+` but not spaces: always, as a generic
  number. Dates such as `2024-09-28 14:30` and amounts such as `1,25,000` stay
  below that and are not touched.

This leans towards redacting: a check digit passes about 1 in 10 random
numbers, and every number of 9+ digits is caught, so ordinary numbers (order
IDs, tracking numbers, build numbers, digit stretches inside hashes) will be
replaced too; the user will still see the real number in the reply. Digits in any
script (Devanagari, Bengali, Tamil, full-width…) and numbers split by invisible
characters are detected. Detection fails closed: a value found inside a longer
number takes the whole number with it, and no input is skipped for being too
long.

Known gaps in the built detectors: values glued to letters (`UID234…`) are
not recognised as their type, so that hashes and API keys are not cut up
(numbers of 9+ digits are still caught as generic numbers); a number written
in space-separated groups that fails its checks (an Aadhaar or card with a
typo) is caught only with a keyword nearby, because spaces do not join digits
for the safety net; a number with a **line break** between its digit groups
(or split across two messages) is not caught at all, since each part is too
short for the safety net; nor are emails written as "name at example dot com",
quoted or IP-literal addresses, or the 16-digit Aadhaar Virtual ID.

Measured precision and recall will be published here once the evaluation suite
exists. Until then, no accuracy numbers are claimed.

## Unsupported input

Pseudonym handles text chat messages (system, user and assistant roles),
non-streamed. Everything else is **rejected with a 4xx error**, never
forwarded unredacted:

- `stream: true` (the streaming endpoint comes in Phase 4b);
- a message `name` (names cannot be redacted until Phase 6);
- tool/function calls and tool messages, the `developer` role;
- image, audio and file content parts;
- `metadata`/`store`, logprobs, `n` other than 1, `json_schema` response
  formats;
- a `model` other than the one Pseudonym is configured for;
- **any request field Pseudonym does not know**;
- other endpoints (embeddings, `/v1/models`, …), bodies over 256 KiB, and
  anything that is not `application/json`.

The `user` and `safety_identifier` fields are accepted and dropped: they
exist to identify the end user to the provider. Error messages never repeat
what was sent, and a provider's own error message is never passed on (it can
echo the prompt): the client gets a 502 with the provider's status code.

## Threat model (summary)

**Protects against:** the AI provider seeing detected personal values, and
provider-side logging or training on them.

**Does not protect against:** values the detectors miss (today that includes
every person's name and API key); anything your application logs before
calling Pseudonym; a compromised Pseudonym host; prompt injection that
manipulates answers (only the URL-exfiltration path is mitigated).

**Inside Pseudonym:** the mapping from placeholders back to real values
exists only in memory for one request, and is never logged, stored or put in
an error. It is not encrypted (the key would sit in the same process), and
JavaScript strings cannot be reliably wiped, so someone who can read the
process's memory can read values. In production (`NODE_ENV=production`)
Pseudonym refuses to start if the debugger, heap snapshots or diagnostic
reports could be switched on, or, on Linux, if core dumps are enabled or
`--disable-sigusr1` is missing. It cannot stop a host that pipes core dumps
to a handler (the kernel then ignores the limit; Pseudonym warns), and it can
verify none of this on Windows or macOS. Production means Linux.

Logs contain the method, route, status and timing of each request, never a
body, a URL or an error message.

The full threat model will be documented as the project matures.

## Running locally

Requires Node.js 22.20+ and, to actually talk to a model,
[Ollama](https://ollama.com) with a model pulled (for example
`ollama pull qwen3:8b`). The tests do not need Ollama.

```bash
npm install
npm test            # run the test suite
npm run lint        # lint
npm run typecheck   # type-check

cp .env.example .env    # then set PSEUDONYM_MODEL to your Ollama model
npm run dev             # gateway on http://127.0.0.1:3000/v1
```

Point your OpenAI client at `http://127.0.0.1:3000/v1` and use the same model
name as `PSEUDONYM_MODEL`; requests naming any other model are rejected.
`.env.example` lists every setting (body limit, timeout, restoration safety,
the placeholder instruction).

## Tech stack

TypeScript (strict) · Node.js 22 · Fastify (with its Pino logger) · Zod ·
libphonenumber-js (phone validation) · Vitest · fast-check · ESLint · Prettier.
The provider is called with Node's built-in `fetch`.

## License

[MIT](LICENSE)

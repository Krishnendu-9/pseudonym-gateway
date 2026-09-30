# Pseudonym

**An OpenAI-compatible privacy gateway that pseudonymises personal data before it
reaches an LLM, and restores it in the reply.**

> **Status: work in progress (Phase 4 of 8 done; Phase 5, evaluation, under
> way).** Not ready for production use.
> Pseudonym runs as a gateway: `POST /v1/chat/completions` (OpenAI format,
> streaming and non-streaming) redacts emails, phone numbers, Aadhaar, PAN,
> card numbers and any other number of 9+ digits, forwards the request to a
> local [Ollama](https://ollama.com) model, and restores the values in the
> answer, including when it arrives as a stream. No-leak tests send planted
> values through both paths and check none reaches the provider. **Person
> names, API keys, UPI IDs and IFSC codes are not detected yet** (they are
> sent as written). Detection is measured on a generated dataset (see
> [Measured results](#measured-results)); the hand-written held-out dataset
> is still being written, so there are no numbers from it yet. Pseudonym has
> been tested against a mock of Ollama built from Ollama's documentation and
> source, not yet against a running Ollama.

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
- **Streaming.** `stream: true` returns OpenAI-style server-sent events
  (with `stream_options.include_usage` if asked). Placeholders split across
  streamed chunks (`[CAR` + `D_1]`) are restored correctly, holding back
  at most 15 characters and only while the text could still become a
  placeholder. A property test checks that any way of cutting an answer
  gives exactly the same result as restoring it whole. If the provider
  fails after the stream has started, the client gets what was already
  decided, then an `error` event (the same fixed messages as an HTTP
  error) and no `[DONE]`.
- **Injection-aware.** Values are not restored inside URLs, markdown links or
  HTML attributes, or where they would become part of a hostname
  (`CARD_1.attacker.example`), blocking a known image-URL exfiltration trick.
  This covers that one path, not prompt injection in general.
- **Proof.** Built: no-leak tests, streaming and non-streaming (seeded
  histories full of planted values through the real gateway to a recording
  mock provider; none may arrive in any form), and canary tests (every error
  path forced, before and during a stream; no planted value in any
  response, log line or error), each shown able to fail by switching off
  one detector or check at a time; property-based streaming restoration
  tests; an evaluation (`npm run eval`) that scores the detectors on a
  seeded, generated dataset and fails if any count differs from the recorded
  baseline. Being written: a held-out adversarial dataset, by hand, by
  someone who did not write the detectors.

## Supported data types

The types marked "redacted" below are replaced before a request leaves
Pseudonym, in every message and in `stop`. Everything else in a message is
sent as written: a person's name or an API key typed into a message **goes to
the provider today**. The measurements below are from a generated dataset
only, so do not rely on Pseudonym to protect real data.

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

## Measured results

Two datasets, reported separately. Every number below is produced by
`npm run eval` and nothing else.

How to read a row:

- **Redacted (any type)** is the number the promise is about: the share of
  labelled personal values of which every character was inside a detection,
  whatever type the detection had. A value with even one character left out
  counts as **partly redacted**, not as redacted.
- **Recall, precision and F1 (right type)** ask the stricter question of
  whether the value was recognised as what it is. An Aadhaar caught only by
  the generic-number safety net is redacted, but not with the right type.
- **Over-redactions** are detections that covered nothing personal (an order
  number, a timestamp). They cost no privacy; they replace text that was
  fine to send. The user still sees the original in the reply.
- Percentages are cut to one decimal, never rounded up.

IFSC, UPI, IP, SECRET and PERSON have no detector yet. They are labelled and
measured from the start so that the "before" is on record; what is redacted
in those rows today is digits the existing detectors happened to catch,
mostly the generic-number safety net.

<!-- eval:start -->

_Measured on 2026-09-30 by `npm run eval`. This block is generated, and the run fails if it is out of date._

**Generated dataset** (seed 20260930; 600 messages in 500 cases, 1683 labelled personal values). Its generator and the detectors share an author, so it mostly shows regressions.

| Type    | Values | Redacted (any type) | Partly redacted | Recall (right type) | Precision (right type) | F1     | Over-redactions |
| ------- | ------ | ------------------- | --------------- | ------------------- | ---------------------- | ------ | --------------- |
| AADHAAR | 153    | 151/153 (98.6%)     | 0               | 151/153 (98.6%)     | 151/166 (90.9%)        | 94.6%  | 3               |
| CARD    | 153    | 149/153 (97.3%)     | 0               | 145/153 (94.7%)     | 145/150 (96.6%)        | 95.7%  | 0               |
| PAN     | 153    | 139/153 (90.8%)     | 0               | 139/153 (90.8%)     | 139/156 (89.1%)        | 89.9%  | 17              |
| PHONE   | 153    | 153/153 (100.0%)    | 0               | 153/153 (100.0%)    | 153/276 (55.4%)        | 71.3%  | 86              |
| EMAIL   | 153    | 153/153 (100.0%)    | 0               | 153/153 (100.0%)    | 153/153 (100.0%)       | 100.0% | 0               |
| NUMBER  | 153    | 128/153 (83.6%)     | 0               | 104/153 (67.9%)     | 104/310 (33.5%)        | 44.9%  | 112             |
| IFSC    | 153    | 0/153 (0.0%)        | 0               | 0/153 (0.0%)        | -                      | -      | 0               |
| UPI     | 153    | 0/153 (0.0%)        | 38              | 0/153 (0.0%)        | -                      | -      | 0               |
| IP      | 153    | 71/153 (46.4%)      | 0               | 0/153 (0.0%)        | -                      | -      | 0               |
| SECRET  | 153    | 0/153 (0.0%)        | 11              | 0/153 (0.0%)        | -                      | -      | 0               |
| PERSON  | 153    | 0/153 (0.0%)        | 0               | 0/153 (0.0%)        | -                      | -      | 0               |

**Held-out adversarial dataset:** not measured yet. It is being written by hand, before the Phase 5 detectors exist.

<!-- eval:end -->

The PHONE and NUMBER rows over-redact on purpose: a 10-digit tracking number
or timestamp is a valid phone number as far as any check can tell, and the
safety net takes every number of 9 or more digits. `npm run eval` also
prints which kinds of lookalike were redacted.

The counts are recorded in `eval/baseline.json` and act as thresholds: both
datasets are deterministic, so `npm run eval` fails if any count is worse
than recorded, and also if one is better until the record is updated. A
worse count can only be accepted with a written reason, which is kept in
that file.

The held-out set is described in
[eval/HELD-OUT-FORMAT.md](eval/HELD-OUT-FORMAT.md): hand-written, by someone
who did not write the detectors, committed before the detectors it tests,
and never used to tune them.

## Unsupported input

Pseudonym handles text chat messages (system, user and assistant roles),
streamed or not. Everything else is **rejected with a 4xx error**, never
forwarded unredacted:

- a message `name` (names cannot be redacted until Phase 6);
- tool/function calls and tool messages, the `developer` role;
- image, audio and file content parts;
- `metadata`/`store`, logprobs, `n` other than 1, `json_schema` response
  formats; `stream_options` other than `include_usage`, or without
  `stream: true`;
- a `model` other than the one Pseudonym is configured for;
- **any request field Pseudonym does not know**;
- other endpoints (embeddings, `/v1/models`, …), bodies over 256 KiB, and
  anything that is not `application/json`.

The `user` and `safety_identifier` fields are accepted and dropped: they
exist to identify the end user to the provider. Error messages never repeat
what was sent, and a provider's own error message is never passed on (it can
echo the prompt): the client gets a 502 with the provider's status code.
Pseudonym reads at most 1 MiB of a provider's response when not streaming
(`PSEUDONYM_MAX_RESPONSE_BYTES`) and at most 32 MiB of a streamed one
(`PSEUDONYM_MAX_STREAM_BYTES`); beyond that the answer fails with
`provider_response_too_large`. The stream limit is larger because it counts
bytes on the wire, and every streamed token, a thinking model's reasoning
tokens included, arrives in its own chunk of about 200 to 250 bytes. 32 MiB
is about 130,000 to 160,000 tokens: room for a 32,768-token answer after as
many reasoning tokens (13.4 to 16.3 MiB, depending on the model name and
the script). These figures are computed from Ollama's chunk format, not
recorded from a running Ollama.

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
`.env.example` lists every setting (body and response limits, timeout,
restoration safety, the placeholder instruction). The timeout covers the
whole call when not streaming; when streaming it applies to each wait (for
the first chunk, then between chunks), so a long answer that keeps arriving
is never cut off by it.

## Tech stack

TypeScript (strict) · Node.js 22 · Fastify (with its Pino logger) · Zod ·
libphonenumber-js (phone validation) · Vitest · fast-check · ESLint · Prettier.
The provider is called with Node's built-in `fetch`.

## License

[MIT](LICENSE)

# Pseudonym

**An OpenAI-compatible privacy gateway that pseudonymises personal data before it
reaches an LLM, and restores it in the reply.**

> **Status: work in progress (Phase 4 of 8 done; Phase 5, evaluation, under
> way).** Not ready for production use.
> Pseudonym runs as a gateway: `POST /v1/chat/completions` (OpenAI format,
> streaming and non-streaming) redacts emails, phone numbers, Aadhaar, PAN,
> card numbers, UPI IDs, API keys in known formats, secrets written after a
> keyword (`password: …`) and any other number of 9+ digits, forwards the
> request to a local [Ollama](https://ollama.com) model, and restores the
> values in the answer, including when it arrives as a stream. No-leak tests
> send planted values through both paths and check none reaches the
> provider. **Person names, IFSC codes and IP addresses are not detected
> yet** (they are sent as written), and neither is a password or token with
> no keyword before it and no known format, nor a UPI ID at an app or bank
> handle Pseudonym does not know with no word such as "UPI" near it.
> Detection is measured on two datasets, a generated one and a small
> held-out adversarial one (see [Measured results](#measured-results)). Pseudonym has been tested against
> a mock of Ollama built from Ollama's documentation and source, not yet
> against a running Ollama.

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
- **India-aware detection.** Aadhaar (Verhoeff check digit), PAN and UPI IDs
  (known app and bank handles) alongside emails, phone numbers and card numbers
  (Luhn check). IFSC codes are planned.
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
  seeded, generated dataset and on a held-out adversarial one, and fails if
  any count differs from the recorded baseline.

## Supported data types

The types marked "redacted" below are replaced before a request leaves
Pseudonym, in every message and in `stop`. Everything else in a message is
sent as written: a person's name or an IFSC code typed into a message
**goes to the provider today**. The measurements below come from
synthetic datasets, one of them small, so do not rely on Pseudonym to
protect real data.

| Type                                | Validation                                                                                                                                                                        | Status   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Email                               | pattern (Unicode addresses included)                                                                                                                                              | redacted |
| Phone (India + international)       | libphonenumber-js, full metadata                                                                                                                                                  | redacted |
| Aadhaar                             | Verhoeff check digit, first digit 2–9                                                                                                                                             | redacted |
| PAN                                 | format + holder-type letter                                                                                                                                                       | redacted |
| Card number                         | Luhn + issuer prefix (Visa, Mastercard, Amex, Discover, RuPay, Diners, JCB, UnionPay)                                                                                             | redacted |
| API keys, tokens, private keys      | a known format: prefix, alphabet and length (OpenAI, Anthropic, GitHub, GitLab, AWS, Stripe, Razorpay, Slack, Google, npm, Hugging Face), JSON Web Tokens, PEM private key blocks | redacted |
| Passwords and codes after a keyword | none possible: the value directly after "password", "api key", "token", "secret", "OTP", "PIN", "CVV" and similar, in English and Hindi                                           | redacted |
| Any other number of 9+ digits       | none: a safety net for numbers no detector claimed (bank accounts, odd layouts)                                                                                                   | redacted |
| UPI ID                              | a handle on Pseudonym's list of 54 app and bank handles (Google Pay, PhonePe, Paytm, BHIM, banks' own…); any other handle only near a keyword                                     | redacted |
| IFSC, IP address                    | pattern + context                                                                                                                                                                 | planned  |
| Person names                        | local NER model                                                                                                                                                                   | planned  |

Which detected matches count:

- **Validated** (passes the checks above): always.
- **Right shape, failed checks** (for example an Aadhaar with a typo in its
  check digit): only if a keyword for that type is nearby ("Aadhaar", "UID",
  "card", "PAN", "call", "mobile", and Hindi आधार, कार्ड, पैन, फ़ोन, मोबाइल).
- **Email:** on the pattern alone.
- **UPI ID** (`<name>@<handle>`, `<mobile>@<handle>`): always when the
  handle is on the list; with any other handle only if "UPI", "VPA",
  "BHIM", "GPay", "Google Pay", "PhonePe", "Paytm", "Amazon Pay" or
  यूपीआई is nearby. If what follows the `@` is an email domain
  (`<name>@paytm.com`), it is an email, not a UPI ID.
- **A secret after a keyword** (`password: …`, `api_key=…`, `Mera password …
hai`): when the way it is written says it is a value. That is: after `=`;
  in quotes; after `:` when it is the last thing on its line; or when it
  looks like a secret, meaning 6 or more characters with a digit or one of
  `@ # $ % ^ & * ! + = ~ | < >`. After a word for a numeric code (OTP, PIN,
  CVV), 3 to 8 digits are enough. "My password is wrong" is left alone.
- **Any stretch of 9 or more digits that no detector claimed**, counted across
  dots, hyphens, dashes, brackets and `+` but not spaces: always, as a generic
  number, together with the letters, digits and underscores it is glued to
  (the whole of `UID234567890123` or of a hexadecimal token, never a piece
  cut out of it). Dates such as `2024-09-28 14:30` and amounts such as
  `1,25,000` stay below 9 digits and are not touched.

This leans towards redacting: a check digit passes about 1 in 10 random
numbers, and every number of 9+ digits is caught, so ordinary numbers (order
IDs, tracking numbers, build numbers, hashes with a long stretch of digits)
will be replaced too; the user will still see the real number in the reply.
Digits in any script (Devanagari, Bengali, Tamil, full-width…) and numbers
split by invisible characters are detected. Detection fails closed: a value
found inside a longer number takes the whole number with it, and no input is
skipped for being too long.

**Secrets are found in two ways and no third.** There is no entropy
scanning: a random-looking string with no known prefix and no credential
word directly before it is sent as written. So are a password made only of
letters when it is written in a sentence ("my password is sunshine"), a
password named after the fact ("… is my password") or several words later
("the password for the portal is …"), a passphrase after its first word, and
credentials inside a URL (`scheme://user:password@host`). Numeric codes
after "OTP", "PIN" and "CVV" are redacted but are in neither dataset, so
they are not measured; nor is how often a keyword in ordinary prose is
followed by something that gets redacted by mistake (the unit tests list 27
ordinary sentences with such a word in which nothing is, and one form in
which a word is: `Token: expired` alone on a line).

Known gaps in the built detectors: values glued to letters (`UID234…`) are
not recognised as their type, so that hashes and API keys are not read as
Aadhaar or phone numbers (with 9+ digits the whole token is still caught, as
a generic number); a number written
in space-separated groups that fails its checks (an Aadhaar or card with a
typo) is caught only with a keyword nearby, because spaces do not join digits
for the safety net; a number with a **line break** between its digit groups
(or split across two messages) is not caught at all, since each part is too
short for the safety net; nor are emails written as "name at example dot com",
quoted or IP-literal addresses, or the 16-digit Aadhaar Virtual ID. **Short
personal identifiers are not caught either:** a passport or voter ID number
with 7 digits, or a date of birth, has no detector of its own and is below
the 9 digits the safety net needs (the held-out NUMBER row shows it).

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

IFSC, IP and PERSON have no detector yet. They are labelled and
measured from the start so that the "before" is on record; what is redacted
in those rows today is digits the existing detectors happened to catch,
mostly the generic-number safety net. The SECRET row counts eleven kinds
of secret in equal shares: nine known key formats, passwords and bare
40-character tokens. The last two are found only after a keyword, and some
of the generated sentences deliberately have none ("I pasted … into the
chat by mistake"): those are the misses in that row. The same holds for
UPI: the four misses are IDs at a handle on no list, in sentences with no
UPI keyword. Every handle the generator uses is on the detector's list, so
the UPI row does not measure how complete that list is.

<!-- eval:start -->

_Measured on 2026-09-30 by `npm run eval`. This block is generated, and the run fails if it is out of date._

**Generated dataset** (seed 20260930; 600 messages in 500 cases, 1683 labelled personal values). Its generator and the detectors share an author, so it mostly shows regressions.

| Type    | Values | Redacted (any type) | Partly redacted | Recall (right type) | Precision (right type) | F1     | Over-redactions |
| ------- | ------ | ------------------- | --------------- | ------------------- | ---------------------- | ------ | --------------- |
| AADHAAR | 153    | 151/153 (98.6%)     | 0               | 151/153 (98.6%)     | 151/165 (91.5%)        | 94.9%  | 3               |
| CARD    | 153    | 149/153 (97.3%)     | 0               | 145/153 (94.7%)     | 145/149 (97.3%)        | 96.0%  | 0               |
| PAN     | 153    | 139/153 (90.8%)     | 0               | 139/153 (90.8%)     | 139/156 (89.1%)        | 89.9%  | 17              |
| PHONE   | 153    | 153/153 (100.0%)    | 0               | 153/153 (100.0%)    | 153/276 (55.4%)        | 71.3%  | 86              |
| EMAIL   | 153    | 153/153 (100.0%)    | 0               | 153/153 (100.0%)    | 153/153 (100.0%)       | 100.0% | 0               |
| NUMBER  | 153    | 128/153 (83.6%)     | 0               | 104/153 (67.9%)     | 104/263 (39.5%)        | 50.0%  | 111             |
| IFSC    | 153    | 0/153 (0.0%)        | 0               | 0/153 (0.0%)        | -                      | -      | 0               |
| UPI     | 153    | 149/153 (97.3%)     | 0               | 149/153 (97.3%)     | 149/149 (100.0%)       | 98.6%  | 0               |
| IP      | 153    | 71/153 (46.4%)      | 0               | 0/153 (0.0%)        | -                      | -      | 0               |
| SECRET  | 153    | 144/153 (94.1%)     | 0               | 143/153 (93.4%)     | 143/143 (100.0%)       | 96.6%  | 0               |
| PERSON  | 153    | 0/153 (0.0%)        | 0               | 0/153 (0.0%)        | -                      | -      | 0               |

**Held-out adversarial dataset** (drafted with AI assistance in a separate session that did not write the detectors, then reviewed by the author; never run against the detectors before it was committed, and never used for tuning; 58 messages in 54 cases, 79 labelled personal values).

| Type    | Values | Redacted (any type) | Partly redacted | Recall (right type) | Precision (right type) | F1     | Over-redactions |
| ------- | ------ | ------------------- | --------------- | ------------------- | ---------------------- | ------ | --------------- |
| AADHAAR | 9      | 8/9 (88.8%)         | 0               | 7/9 (77.7%)         | 7/7 (100.0%)           | 87.5%  | 0               |
| CARD    | 7      | 4/7 (57.1%)         | 0               | 4/7 (57.1%)         | 4/4 (100.0%)           | 72.7%  | 0               |
| PAN     | 8      | 7/8 (87.5%)         | 0               | 7/8 (87.5%)         | 7/7 (100.0%)           | 93.3%  | 0               |
| PHONE   | 19     | 18/19 (94.7%)       | 0               | 18/19 (94.7%)       | 17/18 (94.4%)          | 94.5%  | 1               |
| EMAIL   | 7      | 6/7 (85.7%)         | 0               | 6/7 (85.7%)         | 6/6 (100.0%)           | 92.3%  | 0               |
| NUMBER  | 6      | 3/6 (50.0%)         | 0               | 3/6 (50.0%)         | 3/9 (33.3%)            | 40.0%  | 4               |
| IFSC    | 3      | 0/3 (0.0%)          | 0               | 0/3 (0.0%)          | -                      | -      | 0               |
| UPI     | 3      | 3/3 (100.0%)        | 0               | 3/3 (100.0%)        | 3/3 (100.0%)           | 100.0% | 0               |
| IP      | 2      | 1/2 (50.0%)         | 0               | 0/2 (0.0%)          | -                      | -      | 0               |
| SECRET  | 5      | 5/5 (100.0%)        | 0               | 5/5 (100.0%)        | 5/5 (100.0%)           | 100.0% | 0               |
| PERSON  | 10     | 0/10 (0.0%)         | 0               | 0/10 (0.0%)         | -                      | -      | 0               |

<!-- eval:end -->

The PHONE and NUMBER rows over-redact on purpose: a 10-digit tracking number
or timestamp is a valid phone number as far as any check can tell, and the
safety net takes every number of 9 or more digits. For the generated
dataset `npm run eval` also prints which kinds of lookalike were redacted.

The counts are recorded in `eval/baseline.json` and act as thresholds: both
datasets are deterministic, so `npm run eval` fails if any count is worse
than recorded, and also if one is better until the record is updated. A
worse count can only be accepted with a written reason, which is kept in
that file.

How the held-out set was made, stated exactly: it was drafted with AI
assistance in a separate session that did not write the detectors, and then
reviewed by the author of this project. It is blind (no case was run against
the detectors before the set was committed) and it is never used for tuning:
whoever works on the detectors does not read the file, and the evaluation
prints counts per data type, never a case's text, so a detector cannot be
adjusted to a case it missed. It is small, so one value moves a row by
several points. Its format is described in
[eval/HELD-OUT-FORMAT.md](eval/HELD-OUT-FORMAT.md). That format cannot yet
express some things people really write: numbers spelled out in words, letters
standing in for digits in scanned text (O for 0, l for 1), postal addresses
and vehicle numbers. None of those is measured, and none is detected.

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
every person's name and IFSC code, any secret with neither a known format
nor a keyword directly before it, and a UPI ID at an unknown handle with no
keyword nearby); anything your application
logs before
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

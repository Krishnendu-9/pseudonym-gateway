# Pseudonym

**An OpenAI-compatible privacy gateway that pseudonymises personal data before it
reaches an LLM, and restores it in the reply.**

> **Status: Phase 8 of 8 done (2026-10-16). Not ready for production use:
> every figure here is measured on synthetic data.** Detection, the
> gateway, streaming, the evaluation, person names (off by default), a
> second provider (Gemini's OpenAI-compatible endpoint) and a Docker image
> are built. CI runs the checks, tests and evaluation, and checks what the
> image contains and that it serves.

---

## The idea in 30 seconds

Apps increasingly send user text (support tickets, emails, chat logs) to hosted
AI models. That text is full of personal data. Pseudonym sits between your app and
the AI provider:

```
Your app ──► Pseudonym ──► AI provider
                │               │
   detects personal data   sees a placeholder for
   swaps it for            each detected value,
   placeholders            the rest as written
                │               │
Your app ◄── Pseudonym ◄── AI answer
   real values restored in the answer
```

**What the user sends:**

> Hi, I'm Priya Sharma (priya.sharma@example.com). My card 4111 1111 1111 1111
> was charged twice. Can you help?

**What the AI provider receives, out of the box:**

> Hi, I'm Priya Sharma ([EMAIL_1]). My card [CARD_1] was charged twice. Can you help?

The email address and the card number are replaced. The name is sent as
written: person names are off by default (below).

**What the user gets back:**

> Sorry about that, Priya Sharma. I've flagged the duplicate charge on card
> 4111 1111 1111 1111 and we'll email priya.sharma@example.com within 24 hours.

**With person names switched on** (`PSEUDONYM_NAMES=true`), the provider
receives:

> Hi, I'm [PERSON_1] ([EMAIL_1]). My card [CARD_1] was charged twice. Can you help?

Names are found by a local model and a name list: 501 of 612 names (81.8%)
in the generated set and 41 of 45 in the held-out set (measured 2026-10-03
on an Intel Core i5-12450H). A name it misses is sent as written. It is
off by default because it is slow and takes some ordinary words for names
(see [Person names](#person-names)).

To adopt it, an app changes its API base URL and sets the model name to the one
Pseudonym is configured for. No other code changes.

_(All example data in this repo is synthetic. 4111 1111 1111 1111 is a published
test card number. Both outputs above were produced by the gateway itself on
2026-10-11, the second with the model on that CPU.)_

## The promise

> Every personal value Pseudonym detects is replaced before the request leaves
> your network, and the answer the user receives still reads naturally. How much
> Pseudonym detects is measured and published, per data type.

No detector catches everything, so this project doesn't claim to. Instead, it
proves that everything it detects is replaced, and it publishes measured
detection rates instead of marketing numbers.

## Proof

- **No-leak tests**, streaming and non-streaming: seeded histories full of
  planted values go through the real gateway to a recording mock
  provider, and none may arrive in any form.
- **Canary tests:** every error path is forced, before and during a
  stream; no planted value, and not the provider's own API key, may appear
  in any response, log line or error.
- **Shown able to fail:** each of those fails when one detector or check
  is switched off at a time ([testing guide](docs/testing-guide.md)).
- **Property-based streaming tests:** any way of cutting a streamed answer
  gives exactly the same result as restoring it whole.
- **An evaluation** (`npm run eval`) scores the detectors on a seeded,
  generated dataset and on a held-out adversarial one, counts what is
  still sent as written and what restoration safety leaves unrestored when
  a model echoes every message, and fails if any count differs from the
  recorded baseline ([ADR-021](docs/decisions.md#adr-021),
  [ADR-033](docs/decisions.md#adr-033),
  [ADR-040](docs/decisions.md#adr-040)). Its tables are the headline
  numbers: [Measured results](#measured-results). Person names, measured
  separately, are above.
- **Real providers:** the tests use a mock of Ollama built from Ollama's
  documentation and source; Pseudonym has also been run against a real
  Ollama (0.35.0, on a CPU): one recorded stream is a test fixture, and the
  model measurement made 30 calls through the real pipeline (2026-10-02).
  Answers recorded from Gemini's endpoint (2026-10-07 to 2026-10-10) are
  replayed through the adapter and the gateway. Two requests went through
  the whole pipeline to Gemini on 2026-10-15, non-streaming, one with
  person names off and one with them on: the request captured on its way
  to Google held placeholders only, and the card number, email address, IP
  address and IFSC came back restored in both answers. With names on, the
  model left the name out of its answer, which the request had not asked
  it to repeat, so this shows nothing about whether Gemini keeps
  `[PERSON_1]`. Not run end to end: a streamed answer, and a request the
  gateway refuses because the provider does not accept one of its
  parameters ([ADR-041](docs/decisions.md#adr-041), section 17).

**Which figures are checked:** the results block under
[Measured results](#measured-results) is regenerated by `npm run eval` and
compared with `eval/baseline.json` on every push, and a test compares a
few others with the code or a stored result
(`test/unit/readme-facts.test.ts`). Every other measured figure in this
README carries its date and source, and nothing re-checks it.

## Quick start

Needs Node.js 22.20+ (or Docker) and, to talk to a model, either
[Ollama](https://ollama.com) with the demo model pulled
(`ollama pull qwen3:4b-instruct-2507-q4_K_M`, a 4B instruct model that runs
on a CPU) or a [Gemini API key](#gemini-instead-of-ollama).

```bash
npm install
cp .env.example .env    # PSEUDONYM_MODEL is the demo model
npm run dev             # gateway on http://127.0.0.1:3000/v1
```

Or in Docker: copy `.env.example` to `.env`, set
`PSEUDONYM_PROVIDER_BASE_URL=http://host.docker.internal:11434/v1` in it,
and run `docker compose up --build`. With `PSEUDONYM_PROVIDER_API_KEY` also
set, the gateway refuses to start with that address: it is plain `http://`
and not this machine
([start-up messages](docs/user-manual.md#start-up-messages)).

Point your OpenAI client at `http://127.0.0.1:3000/v1` and use the model
name in `PSEUDONYM_MODEL`. On Linux, `npm run dev` refuses to start until
you set `PSEUDONYM_DISABLE_HARDENING=true` in your own `.env`, never in
production. Everything else: [Running locally](#running-locally),
[Running in Docker](#running-in-docker).

## Design

What Pseudonym does:

- **OpenAI-compatible API.** `POST /v1/chat/completions`; switch by changing the
  base URL and the model name. Every request field is on an allowlist:
  message text and `stop` are redacted, numeric settings are forwarded,
  `user` is dropped, and anything else is rejected rather than forwarded
  ([ADR-014](docs/decisions.md#adr-014)).
- **Two providers.** A local Ollama (the default) or Gemini, through
  Google's OpenAI-compatible endpoint, behind one adapter with a profile
  per provider. What a provider refuses is measured, never assumed from its
  documentation, and kept in its profile by exact model name; a request
  carrying a refused parameter is answered 400 before anything is sent
  ([ADR-041](docs/decisions.md#adr-041); see
  [Running locally](#running-locally) and
  [Unsupported input](#unsupported-input)).
- **Stateless by design.** Chat APIs resend the full history on every request, so
  Pseudonym re-pseudonymises it deterministically each time. The same value
  always gets the same placeholder (`[EMAIL_1]` in every message), without
  storing anything between requests ([ADR-012](docs/decisions.md#adr-012),
  [ADR-013](docs/decisions.md#adr-013)).
- **India-aware detection.** Aadhaar (Verhoeff check digit), PAN, UPI IDs
  (known app and bank handles) and IFSC codes (bank codes from RBI's list)
  alongside emails, phone numbers, card numbers (Luhn check) and IPv4 and
  IPv6 addresses (a hand-written parser). Passport numbers, voter IDs and
  dates of birth only next to a word naming them: their shapes alone are
  every other order code and date ([ADR-010](docs/decisions.md#adr-010),
  [ADR-024](docs/decisions.md#adr-024), [ADR-025](docs/decisions.md#adr-025),
  [ADR-026](docs/decisions.md#adr-026), [ADR-031](docs/decisions.md#adr-031)).
- **Unicode-hardened.** Digits in any script (full-width, mathematical,
  Devanagari, Bengali, Tamil and every other Unicode decimal digit) are
  normalised, and invisible characters that can hide data (zero-width spaces,
  soft hyphens, direction marks) are removed before detection. Values are still
  replaced in the original text, so a hidden value is replaced completely
  ([ADR-007](docs/decisions.md#adr-007)).
- **Placeholder instruction.** Pseudonym can add one short system message
  asking the model to copy placeholders exactly, since a placeholder the
  model rewrites ("email 1") cannot be restored. Off by default
  (`PSEUDONYM_PLACEHOLDER_INSTRUCTION`): measured on the demo model, it
  did not help (see "What a real model does with placeholders";
  [ADR-017](docs/decisions.md#adr-017)).
- **Streaming.** `stream: true` returns OpenAI-style server-sent events
  (with `stream_options.include_usage` if asked). Placeholders split across
  streamed chunks (`[CAR` + `D_1]`) are restored correctly, holding back
  at most 16 characters and only while the text could still become a
  placeholder ([ADR-018](docs/decisions.md#adr-018),
  [ADR-019](docs/decisions.md#adr-019)). A property test checks that any way of cutting an answer
  gives exactly the same result as restoring it whole. If the provider
  fails after the stream has started, the client gets what was already
  decided, then an `error` event (the same fixed messages as an HTTP
  error) and no `[DONE]`.
- **Injection-aware.** Values are not restored inside URLs, markdown links or
  HTML attributes, or where they would become part of a hostname
  (`CARD_1.attacker.example`), blocking a known image-URL exfiltration trick.
  This covers that one path, not prompt injection in general
  ([ADR-013](docs/decisions.md#adr-013), [ADR-018](docs/decisions.md#adr-018)).

## Supported data types

The types marked "redacted" below are replaced before a request leaves
Pseudonym, in every message and in `stop`. Everything else in a message is
sent as written: a person's name typed into a message **goes to the
provider unless names are switched on** (off by default, below). The measurements below come from
synthetic datasets, one of them small, so do not rely on Pseudonym to
protect real data.

| Type                                | Validation                                                                                                                                                                                    | Status   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Email                               | pattern (Unicode addresses included)                                                                                                                                                          | redacted |
| Phone (India + international)       | libphonenumber-js, full metadata                                                                                                                                                              | redacted |
| Aadhaar                             | Verhoeff check digit, first digit 2–9                                                                                                                                                         | redacted |
| PAN                                 | format + holder-type letter                                                                                                                                                                   | redacted |
| Card number                         | Luhn + issuer prefix (Visa, Mastercard, Amex, Discover, RuPay, Diners, JCB, UnionPay)                                                                                                         | redacted |
| API keys, tokens, private keys      | a known format: prefix, alphabet and length (OpenAI, Anthropic, GitHub, GitLab, AWS, Stripe, Razorpay, Slack, Google, npm, Hugging Face), JSON Web Tokens, PEM private key blocks             | redacted |
| Passwords and codes after a keyword | none possible: the value directly after "password", "api key", "token", "secret", "OTP", "PIN", "CVV" and similar, in English and Hindi                                                       | redacted |
| Any other number of 9+ digits       | none: a safety net for numbers no detector claimed (bank accounts, odd layouts)                                                                                                               | redacted |
| UPI ID                              | a handle on Pseudonym's list of 51 app and bank handles (Google Pay, PhonePe, Paytm, BHIM, banks' own…), compiled from public sources, not NPCI's list; any other handle only near a keyword  | redacted |
| IFSC code                           | a bank code on Pseudonym's list of 260 (every bank with branches in RBI's list of NEFT-enabled branches, taken from a published copy of RBI's files); any other bank code only near a keyword | redacted |
| IP address (IPv4 and IPv6)          | parsed by hand: four parts of 0–255, or an IPv6 form (compressed, full, with an IPv4 part); addresses no single host owns (loopback, netmasks, multicast) are left as written                 | redacted |
| Passport number                     | none possible: a letter and 7 digits, only near "passport" or पासपोर्ट                                                                                                                        | redacted |
| Voter ID (EPIC)                     | none possible: 3 letters and 7 digits, only near "voter", "EPIC", मतदाता or वोटर                                                                                                              | redacted |
| Date of birth                       | a real calendar date in a common form, only near "DOB", "birth", "born", "birthday", जन्म or "janm"/"janam"                                                                                   | redacted |
| Person names                        | local NER model and a name list, no validation; **off by default** (`PSEUDONYM_NAMES`)                                                                                                        | optional |

Why each type is checked the way it is: phone numbers
[ADR-004](docs/decisions.md#adr-004); checks and keywords
[ADR-010](docs/decisions.md#adr-010); the 9+-digit safety net
[ADR-011](docs/decisions.md#adr-011); secrets
[ADR-022](docs/decisions.md#adr-022); UPI IDs
[ADR-024](docs/decisions.md#adr-024); IFSC codes
[ADR-025](docs/decisions.md#adr-025); IP addresses
[ADR-026](docs/decisions.md#adr-026); passport numbers, voter IDs and
dates of birth [ADR-031](docs/decisions.md#adr-031); person names
[ADR-035](docs/decisions.md#adr-035) and
[ADR-036](docs/decisions.md#adr-036).

Which detected matches count, in short ([ADR-010](docs/decisions.md#adr-010)):

- **Validated** (passes the checks above): always. **Right shape, failed
  checks** (an Aadhaar with a typo in its check digit): only with a keyword
  for that type nearby. **Email:** on the pattern alone. A UPI handle or an
  IFSC bank code that is not on the list: only with a keyword nearby.
- **Passport numbers, voter IDs and dates of birth:** only with a word
  naming them within 40 characters, before or after, and then anything of
  the same shape within those 40 characters is redacted too.
- **Detection fails closed:** a value found inside a longer number takes
  the whole number with it, every stretch of 9 or more digits no detector
  claimed is redacted, and no input is skipped for being too long. So
  ordinary numbers (order IDs, tracking numbers) are replaced too; the
  user still sees them in the reply.

**Known gaps, in short:** person names with names off (the default); a
secret with neither a known format nor a keyword directly before it; a UPI
ID at an unknown handle, or an IFSC code with an unknown bank code, with no
keyword nearby; a passport number, voter ID or date of birth with no
keyword nearby; a number split across two messages; emails written as
"name at example dot com", quoted or IP-literal addresses; MAC addresses;
numbers written as words or with letters for digits, postal addresses and
vehicle numbers.

**The full rules, their measured costs and every known gap** (overlaps,
mobiles in tables, numbers wrapped onto the next line, secrets, IP ranges)
are in [Detection: rules, costs and known gaps](docs/detection.md).

## Person names

**Off by default.** With `PSEUDONYM_NAMES=true`, every request's names
are found before anything is sent and replaced like every other value
(`[PERSON_1]`, restored in the answer). They are off by default because
they fail two of the three limits set before measuring
([ADR-035](docs/decisions.md#adr-035)): too slow, and too many ordinary
words taken for names.

- **How:** a multilingual named-entity model
  ([`Xenova/bert-base-multilingual-cased-ner-hrl`](https://huggingface.co/Xenova/bert-base-multilingual-cased-ner-hrl),
  pinned to a commit, run locally in a worker thread of the gateway's own)
  joined with a list of given and family names from Wikidata (CC0). Names
  never leave the machine to be found.
- **Found, on an Intel Core i5-12450H (2026-10-03):** 81.8% of the
  generated set's 612 names, 41 of 45 on the held-out set
  ([Measured results](#choosing-a-person-name-detector-phase-6a)). On that
  CPU the gateway reproduces the published measurement exactly: `npm run
eval:names` sends the 1,998 measured messages through it and compares
  every span by SHA-256 ([ADR-036](docs/decisions.md#adr-036), step 4b).
  Every machine tried since gave one of two results: the same spans on
  machines without AVX-512, and on machines with it one detection more, a
  correct name (934 instead of 933, in runs of 2026-10-07 to 2026-10-10;
  the table below, [ADR-036](docs/decisions.md#adr-036)).
- **Missed:** names in all lower case (3 of 59 found, 2026-10-03); a name broken by an
  invisible character is covered to the end of the word only when part of
  that word was found, and its second word is not reached that way; "Asha"
  and "Asha Rao" are two values, not linked.
- **Taken though not names:** about 5.85 words in 1,000 of ordinary text
  (2026-10-03),
  most often names of deities, places, companies and festivals. **Public
  figures are names and are redacted**: a question about a well-known
  person reaches the provider without the name. No allowlist.
- **Cost, measured through the gateway** (2026-10-07, Intel i5-12450H, no
  GPU; each figure is the worst of three runs, rounded up to the precision
  shown, never down): 332 ms per KiB of text; 0.15 s added to a 1 KiB
  request, 1.2 s to 4 KiB, 23 s to 64 KiB; 287 MiB more memory while idle,
  369 MiB at its peak
  ([ADR-036](docs/decisions.md#adr-036), step 4b).
- **Fails closed:** if names cannot be found (the model failed, timed out,
  is busy, crashed) the request gets a 503 and is never sent without them.
  A call that runs past its timeout cannot be interrupted, so the model
  finishes it while `GET /health` reports unhealthy
  ([ADR-037](docs/decisions.md#adr-037)). The timeout's default, 202 s, is
  derived from the slowest speed measured on the largest body the 256 KiB
  limit allows; **raising `PSEUDONYM_MAX_BODY_BYTES` invalidates both that
  and the decision not to stop long calls**, and would call for the model
  in a separate process (ADR-037, step 4b).
- **Install:** the runtime is an optional dependency, never loaded with
  names off; the model comes from `npm run fetch:model` (four files,
  181.5 MB, of which the model file is 178.5 MB), each kept only if its
  SHA-256 matches, and with names on the gateway refuses to
  start if the list, a file or the runtime is wrong or missing. Sizes, and
  the Linux install setting that skips 274 MB of GPU libraries (measured
  2026-10-07):
  [Person names: install, licence and CPUs](docs/person-names.md#install).
- **Licence** (not legal advice): the model files state no licence. They
  are used on the strength of their card's statement that they are
  Davlan's model (AFL-3.0) converted to ONNX, itself a fine-tune of
  Google's multilingual BERT (Apache-2.0); the training data's terms were
  not checked ([details](docs/person-names.md#licence),
  [ADR-036](docs/decisions.md#adr-036)).
- **Which CPUs the figures hold on:** measured on an Intel Core i5-12450H.
  Every machine tried since gave one of exactly two sets of spans, split
  by whether it has AVX-512: without it the published figures reproduce
  exactly; with it the gateway's result differs by one detection in 933, one
  extra correct name. Why is a hypothesis, not shown. Which machines, and
  why the names check does not run on every push:
  [details](docs/person-names.md#which-cpus-the-figures-hold-on),
  [ADR-036](docs/decisions.md#adr-036). The two sets of figures (runs of
  2026-10-07 to 2026-10-10), the second beside the published ones, never
  in their place:

| Generated set (1,998 messages)  | Without AVX-512     | With AVX-512    |
| ------------------------------- | ------------------- | --------------- |
| Names found (612)               | 501 (81.8%)         | 502 (82.0%)     |
| Detections, precision           | 933, 70.8%          | 934, 70.8%      |
| False positives per 1,000 words | 5.85                | 5.85            |
| Main cases, PERSON              | 145/153             | 145/153         |
| Held-out (45)                   | 41 (i5-12450H only) | not run (spent) |

## Measured results

Two datasets, reported separately. Every number in this section is
produced by `npm run eval` (deterministic, run in CI), except the last two
parts: a model measurement that needs Ollama
(`scripts/measure-rewrites.ts`, one run on 2026-10-02) and the
person-name comparison (`scripts/compare-names.ts`, 2026-10-03).

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
- The generated dataset's headline table is its **500 main cases**, written
  the usual ways. Below it, and kept apart from it, is the **shape block**:
  cases written in ways that are hard on purpose (a line break inside a
  number, a value split across two messages, two values side by side, a
  checked value inside an email address or key, passport and voter ID
  numbers and dates of birth, contact sheets of mobiles in columns, values
  inside a URL, a markdown link or an HTML tag, person names), one row per
  way of writing. Each row there measures one hard layout; a low number in
  it is that layout's gap, not the overall quality.

PERSON is measured here with names off, the default build, so its rows
read 0; it was labelled from the start so that the "before" is on record.
Of the shape block's 612 names, with names on, 501 are found (2026-10-03;
[Choosing a person-name detector](#choosing-a-person-name-detector-phase-6a)).
What each row's misses and over-redactions are, row by row, and how the
echo and held-out rows read:
[Measured results: notes](docs/results-notes.md).

<!-- eval:start -->

_Measured on 2026-10-06 (UTC date) by `npm run eval`. This block is generated, and the run fails if it is out of date._

**Generated dataset, main cases** (seed 20260930; 600 messages in 500 cases, 1683 labelled personal values). Its generator and the detectors share an author, so it mostly shows regressions.

| Type    | Values | Redacted (any type) | Partly redacted | Recall (right type) | Precision (right type) | F1     | Over-redactions |
| ------- | ------ | ------------------- | --------------- | ------------------- | ---------------------- | ------ | --------------- |
| AADHAAR | 153    | 153/153 (100.0%)    | 0               | 153/153 (100.0%)    | 153/160 (95.6%)        | 97.7%  | 3               |
| CARD    | 153    | 150/153 (98.0%)     | 0               | 149/153 (97.3%)     | 149/154 (96.7%)        | 97.0%  | 1               |
| PAN     | 153    | 142/153 (92.8%)     | 0               | 142/153 (92.8%)     | 142/152 (93.4%)        | 93.1%  | 10              |
| PHONE   | 153    | 153/153 (100.0%)    | 0               | 153/153 (100.0%)    | 153/219 (69.8%)        | 82.2%  | 46              |
| EMAIL   | 153    | 153/153 (100.0%)    | 0               | 153/153 (100.0%)    | 153/153 (100.0%)       | 100.0% | 0               |
| NUMBER  | 153    | 135/153 (88.2%)     | 0               | 112/153 (73.2%)     | 112/178 (62.9%)        | 67.6%  | 66              |
| IFSC    | 153    | 152/153 (99.3%)     | 0               | 152/153 (99.3%)     | 152/155 (98.0%)        | 98.7%  | 3               |
| UPI     | 153    | 147/153 (96.0%)     | 0               | 147/153 (96.0%)     | 147/147 (100.0%)       | 98.0%  | 0               |
| IP      | 153    | 153/153 (100.0%)    | 0               | 149/153 (97.3%)     | 149/202 (73.7%)        | 83.9%  | 53              |
| SECRET  | 153    | 147/153 (96.0%)     | 0               | 147/153 (96.0%)     | 147/147 (100.0%)       | 98.0%  | 0               |
| PERSON  | 153    | 0/153 (0.0%)        | 0               | 0/153 (0.0%)        | -                      | -      | 0               |

**Generated dataset, shape block** (2017 labelled personal values, in cases apart from the main ones). Each row is a way of writing values that is hard on purpose: a line break inside a value, a value split across two messages, two values side by side, digits beside a mobile, a checked value inside an address or key, digits joined by a bracket, passport and voter ID numbers and dates of birth, contact sheets of mobiles in columns (aligned, and with one row out of line), values inside markup (a URL, a markdown link or image, an HTML tag), and person names written the ways people write them, beside words that are not names (Phase 6). These rows measure hard layouts one at a time; they are not part of the numbers above.

| Written as         | Values | Redacted (any type) | Partly redacted | Recall (right type) | Over-redactions |
| ------------------ | ------ | ------------------- | --------------- | ------------------- | --------------- |
| line-break         | 120    | 113/120 (94.1%)     | 0               | 112/120 (93.3%)     | 12              |
| message-split      | 60     | 0/60 (0.0%)         | 2               | 0/60 (0.0%)         | 0               |
| side-by-side       | 80     | 80/80 (100.0%)      | 0               | 66/80 (82.5%)       | 5               |
| digit-beside       | 40     | 40/40 (100.0%)      | 0               | 40/40 (100.0%)      | 4               |
| contained          | 70     | 70/70 (100.0%)      | 0               | 70/70 (100.0%)      | 9               |
| joined-digits      | 30     | 21/30 (70.0%)       | 9               | 6/30 (20.0%)        | 4               |
| short-id           | 459    | 305/459 (66.4%)     | 0               | 304/459 (66.2%)     | 25              |
| contact-sheet      | 120    | 120/120 (100.0%)    | 0               | 120/120 (100.0%)    | 0               |
| misaligned-sheet   | 132    | 132/132 (100.0%)    | 0               | 132/132 (100.0%)    | 0               |
| in-markup          | 90     | 90/90 (100.0%)      | 0               | 90/90 (100.0%)      | 8               |
| names              | 612    | 0/612 (0.0%)        | 0               | 0/612 (0.0%)        | 79              |
| glued-literal      | 108    | 105/108 (97.2%)     | 0               | 92/108 (85.1%)      | 41              |
| keyword-in-literal | 96     | 96/96 (100.0%)      | 0               | 96/96 (100.0%)      | 0               |

**Held-out adversarial dataset** (drafted with AI assistance in a separate session that did not write the detectors, then reviewed by the author; never run against the detectors before it was committed, and never used for tuning; 80 messages in 76 cases, 118 labelled personal values).

| Type     | Values | Redacted (any type) | Partly redacted | Recall (right type) | Precision (right type) | F1     | Over-redactions |
| -------- | ------ | ------------------- | --------------- | ------------------- | ---------------------- | ------ | --------------- |
| AADHAAR  | 9      | 8/9 (88.8%)         | 0               | 7/9 (77.7%)         | 7/7 (100.0%)           | 87.5%  | 0               |
| CARD     | 7      | 4/7 (57.1%)         | 0               | 4/7 (57.1%)         | 4/4 (100.0%)           | 72.7%  | 0               |
| PAN      | 8      | 7/8 (87.5%)         | 0               | 7/8 (87.5%)         | 7/7 (100.0%)           | 93.3%  | 0               |
| PHONE    | 22     | 21/22 (95.4%)       | 0               | 21/22 (95.4%)       | 21/22 (95.4%)          | 95.4%  | 1               |
| EMAIL    | 8      | 7/8 (87.5%)         | 0               | 7/8 (87.5%)         | 7/7 (100.0%)           | 93.3%  | 0               |
| NUMBER   | 6      | 5/6 (83.3%)         | 0               | 3/6 (50.0%)         | 3/8 (37.5%)            | 42.8%  | 4               |
| IFSC     | 3      | 3/3 (100.0%)        | 0               | 3/3 (100.0%)        | 3/3 (100.0%)           | 100.0% | 0               |
| UPI      | 3      | 3/3 (100.0%)        | 0               | 3/3 (100.0%)        | 3/3 (100.0%)           | 100.0% | 0               |
| IP       | 2      | 2/2 (100.0%)        | 0               | 2/2 (100.0%)        | 2/4 (50.0%)            | 66.6%  | 2               |
| SECRET   | 5      | 5/5 (100.0%)        | 0               | 5/5 (100.0%)        | 5/5 (100.0%)           | 100.0% | 0               |
| PERSON   | 45     | 0/45 (0.0%)         | 0               | 0/45 (0.0%)         | -                      | -      | 0               |
| PASSPORT | 0      | -                   | 0               | -                   | 0/1 (0.0%)             | -      | 0               |
| VOTER    | 0      | -                   | 0               | -                   | 0/1 (0.0%)             | -      | 0               |
| DOB      | 0      | -                   | 0               | -                   | 0/1 (0.0%)             | -      | 1               |

**Echo** (ADR-033): every message redacted, then restored as if the model had repeated it unchanged. A placeholder in a URL, a link or image target, or an HTML attribute value stays a placeholder (restoration safety); each one left is counted under the rule that held it. "Back exactly" restores with those rules off and compares with the original message.

| Echoed unchanged                                    | Generated, main   | Shape block: in-markup | Shape block: other shapes | Held-out      |
| --------------------------------------------------- | ----------------- | ---------------------- | ------------------------- | ------------- |
| Messages                                            | 600               | 90                     | 1512                      | 80            |
| Placeholders                                        | 1667              | 98                     | 1434                      | 74            |
| Restored                                            | 1660/1667 (99.5%) | 26/98 (26.5%)          | 1425/1434 (99.3%)         | 70/74 (94.5%) |
| Left: in a markdown link or image target            | 0                 | 18                     | 9                         | 0             |
| Left: after "[label]:"                              | 0                 | 9                      | 0                         | 0             |
| Left: in a quoted HTML attribute value              | 0                 | 18                     | 0                         | 2             |
| Left: in a URL (scheme, `mailto:` or host and path) | 7                 | 27                     | 0                         | 2             |
| Left: rest of a line after an unclosed "<" target   | 0                 | 0                      | 0                         | 0             |
| Left: rest of the text after an unclosed `="`       | 0                 | 0                      | 0                         | 0             |
| Left: host rule (`[TYPE_N].x`)                      | 0                 | 0                      | 0                         | 0             |
| `Type N` text, never restored (ADR-013)             | 0                 | 0                      | 0                         | 0             |
| Messages back exactly                               | 600               | 90                     | 1512                      | 80            |
| Messages back with a later mention as first written | 0                 | 0                      | 0                         | 0             |
| Messages not restored correctly                     | 0                 | 0                      | 0                         | 0             |

**Sent as written** (ADR-040): labelled personal values whose text, exactly as written, is still in what the redaction sends (`redactMessage`'s output, each case's messages redacted in order with one mapping). The tables above measure what the detectors find (`detect()`), not what is sent; bugs 58 and 61 showed that the two can differ, and this count is the one that measures the promise. It counts whole values only: a value sent partly, with a placeholder over some of it, is not counted here. Every written piece counts, so a value split across two messages is two. It is measured with names off, the default build, so no person name is detected and every one is sent: the whole names shape and the person names among the main cases; that is the documented behaviour of a feature that ships disabled (ADR-035), not a detection failure. Known-failing parts are accepted, with an exact number the run checks.

| Part                                             | Values | Sent as written  | Known and accepted |
| ------------------------------------------------ | ------ | ---------------- | ------------------ |
| Generated, main                                  | 1683   | 198/1683 (11.7%) | -                  |
| Generated, line-break                            | 120    | 7/120 (5.8%)     | -                  |
| Generated, message-split                         | 120    | 118/120 (98.3%)  | -                  |
| Generated, side-by-side                          | 80     | 0/80 (0.0%)      | -                  |
| Generated, digit-beside                          | 40     | 0/40 (0.0%)      | -                  |
| Generated, contained                             | 70     | 0/70 (0.0%)      | -                  |
| Generated, joined-digits                         | 30     | 0/30 (0.0%)      | -                  |
| Generated, short-id                              | 459    | 154/459 (33.5%)  | -                  |
| Generated, contact-sheet                         | 120    | 0/120 (0.0%)     | -                  |
| Generated, misaligned-sheet                      | 132    | 0/132 (0.0%)     | -                  |
| Generated, in-markup                             | 90     | 0/90 (0.0%)      | -                  |
| Generated, names (names off, the default build)  | 612    | 612/612 (100.0%) | -                  |
| Generated, glued-literal                         | 108    | 3/108 (2.7%)     | known-failing: 3   |
| Generated, keyword-in-literal                    | 96     | 0/96 (0.0%)      | -                  |
| Held-out (reporting only, never used for tuning) | 120    | 55/120 (45.8%)   | -                  |

- Known-failing, `glued-literal`: a secret after a credential word and a placeholder-shaped text with a space in it (`password: [pan 1]<password>`) is sent as written; bug-log 61, left unfixed after two fixes each sent values that are redacted today (ADR-038, final amendment).

<!-- eval:end -->

The counts are recorded in `eval/baseline.json` and act as thresholds: both
datasets are deterministic, so `npm run eval` fails if any count is worse
than recorded, and also if one is better until the record is updated. A
worse count can only be accepted with a written reason, which is kept in
that file ([ADR-021](docs/decisions.md#adr-021)).

**Restoration safety has a cost** a user sees: a placeholder inside a URL,
a markdown link or image target, after `[label]:`, or in a quoted HTML
attribute value stays a placeholder, by design, and so does a quoted value
in code (`API_KEY = "[SECRET_1]"`). The held-out set is blind and never
used for tuning; it is small, so one value moves a row by several points.
How the echo table reads, the full list of restoration safety's costs, and
exactly how the held-out set was made:
[Measured results: notes](docs/results-notes.md).

### What a real model does with placeholders

Measured on 2026-10-02 with one local model,
`qwen3:4b-instruct-2507-q4_K_M` on Ollama 0.35.0, at temperature 0 with a
fixed seed: **15 tasks, 34 values per setting, one run**, each task asking
the model to repeat every value it was given (a reply, JSON, an SMS, a
Hindi translation, a summary, a table, a log line, a CSV row, code…).

| Placeholder instruction | Values | Restored | Held back (safety) | Rewritten | Dropped | Invented |
| ----------------------- | ------ | -------- | ------------------ | --------- | ------- | -------- |
| On                      | 34     | 30       | 0                  | 0         | 4       | 0        |
| Off                     | 34     | 32       | 2                  | 0         | 0       | 0        |

**All 4 dropped values come from one task**, the CSV row: with the
instruction on, the model wrote the header and no data row. The decision
below therefore rests on a single task out of 15. With the instruction
off, the model often wrote placeholders without their brackets (`EMAIL_1`), which restoration reads anyway. The 2 held back were
code, `API_KEY = "[SECRET_1]"` (a known cost, above). No answer
rewrote a placeholder into a form restoration cannot read, and none made
one up. By a rule fixed before measuring ([ADR-017](docs/decisions.md#adr-017): keep the instruction
only if it leaves fewer values unrestored and invents no more), the
instruction is off by default. This is one model; other models may differ.
Thinking models are not the demo model
([notes](docs/results-notes.md#thinking-models)).

### Choosing a person-name detector (Phase 6a)

Measured on 2026-10-03, on one machine (Intel i5-12450H, no GPU), by a
rule fixed before any model ran ([ADR-035](docs/decisions.md#adr-035)): recall on the generated set's
612-name block of at least 60% to ship at all, and three limits for being
on by default: at most 1.0 false positive per 1,000 words (over the whole
generated set, 1,998 messages), at most 60 ms per KiB of text, at most
1.5 GiB of memory. Every model runs locally; names never leave the
machine.

**The chosen configuration, B and F together, on both datasets:**

| Dataset                                                   | Names found         | 95% interval | Precision       |
| --------------------------------------------------------- | ------------------- | ------------ | --------------- |
| Generated, names block                                    | **501/612 (81.8%)** | 78.6–84.7%   | 661/933 (70.8%) |
| **Held-out** (separate session, run once, never tuned on) | **41/45 (91.1%)**   | 79.3–96.5%   | 41/46 (89.1%)   |

The held-out figure is the one to quote: the generated set and the
detector configuration share an author. Both rows were measured on the
Intel Core i5-12450H ([Person names](#person-names) for other CPUs); why
the held-out figure can be higher, and how `npm run eval:names`
reproduces the generated row:
[notes](docs/results-notes.md#the-person-name-comparison).

| Candidate                                 | Names found (612)                 | False positives per 1,000 words | ms per KiB | Memory      | Fails           |
| ----------------------------------------- | --------------------------------- | ------------------------------- | ---------- | ----------- | --------------- |
| A: `bert-base-NER` (English)              | 293 (47.8%)                       | 0.99                            | 416        | 245 MiB     | speed           |
| B: `bert-base-multilingual-cased-ner-hrl` | 383 (62.5%)                       | 0.96                            | 285        | 325 MiB     | speed           |
| F: name lists and cue words, no model     | 420 (68.6%)                       | 4.98                            | 1          | 30 MiB      | false positives |
| A and F together                          | 468 (76.4%)                       | 5.67                            | 417        | 245 MiB     | both            |
| **B and F together**                      | **501 (81.8%)**                   | **5.85**                        | **286**    | **325 MiB** | **both**        |
| D: GLiNER (`gliner_multi_pii-v1`)         | port unverified, results excluded |                                 |            |             |                 |
| E: the local LLM (`qwen3:4b-instruct`)    | did not complete                  |                                 |            |             | speed           |

Why D and E have no figures:
[notes](docs/results-notes.md#the-person-name-comparison).

**Decision, by the rule as written:** no candidate meets all three
limits, so the one with the highest recall, B and F together (81.8%), is
what Phase 6 builds, **off by default** behind `PSEUDONYM_NAMES`. It
fails the false-positive limit by 5.85 times (about one wrongly redacted
word in every 170) and the speed limit. The table's speed and memory are
the comparison script's; the gateway's own, measured through it, are in
[Person names](#person-names) (332 ms per KiB and 369 MiB at its peak,
the worst of three runs on 2026-10-07, rounded up).
What was observed after the measurement, and why the rule was not changed:
[notes](docs/results-notes.md#the-person-name-comparison).

## Unsupported input

Pseudonym handles text chat messages (system, user and assistant roles),
streamed or not. It reads text, not documents: a file, an image or a PDF
is rejected, never opened. Everything else is **rejected with a 4xx error**, never
forwarded unredacted ([ADR-014](docs/decisions.md#adr-014)):

- a message `name` (it is never redacted, whether person names are on or
  off);
- tool/function calls and tool messages, the `developer` role;
- image, audio and file content parts;
- `metadata`/`store`, logprobs, `n` other than 1, `json_schema` response
  formats; `stream_options` other than `include_usage`, or without
  `stream: true`;
- a `model` other than the one Pseudonym is configured for;
- **any request field Pseudonym does not know**;
- other endpoints (embeddings, `/v1/models`, …), bodies over 256 KiB, and
  anything that is not `application/json` (the body limit:
  [ADR-015](docs/decisions.md#adr-015)).

**Parameters the provider is measured refusing.** For a model with
measured refusals (today Gemini's `gemini-3.5-flash-lite`), a request
carrying a refused parameter is answered 400 before name detection,
redaction or any call, so **it sends nothing to the provider**, while a
refusal the profile does not know is sent, the redacted request goes out,
and the provider's own 400 comes back (below); which fields and values,
the exact errors and the probes behind each are in the
[user manual](docs/user-manual.md#parameters-a-model-is-measured-refusing)
([ADR-041](docs/decisions.md#adr-041), section 16).

The `user` and `safety_identifier` fields are accepted and dropped: they
exist to identify the end user to the provider. Error messages never repeat
what was sent, and a provider's own error message is never passed on (it can
echo the prompt). A provider 400 reaches the client as a 400
`provider_rejected_request`; any other provider error as a 502
`provider_error` with the provider's status code
([ADR-041](docs/decisions.md#adr-041), section 16). The exception is a
provider 429. The gateway's upstream is limiting
requests on a key every client shares, so the client gets a 503
`provider_rate_limited` with `Retry-After: 30`, the gateway's own value,
never the provider's ([ADR-041](docs/decisions.md#adr-041), section 15).
Pseudonym reads at most 1 MiB of a provider's response when not streaming
(`PSEUDONYM_MAX_RESPONSE_BYTES`) and at most 32 MiB of a streamed one
(`PSEUDONYM_MAX_STREAM_BYTES`); beyond that the answer fails with
`provider_response_too_large`. Why the stream limit is larger
([ADR-020](docs/decisions.md#adr-020)):
[notes](docs/results-notes.md#why-the-stream-limit-is-32-mib).

**Refusals and empty answers.** A refusal the provider names in its own
`refusal` field reaches the client in OpenAI's shape: `content: null` and
the refusal text, restored like any answer, restoration safety included;
streamed, it arrives as `delta.refusal` chunks. A non-streamed message
always carries `refusal`, `null` when there was none, as OpenAI's own
response does. An answer with no text, no refusal and `finish_reason:
"stop"` cannot be told from a refusal, so it is a 502
`provider_empty_response`, streamed or not. Neither provider has been
recorded naming a refusal: none of the 12 Gemini answers recorded from
2026-10-07 to 2026-10-10 carries
a `refusal` key, and nor does the recorded Ollama stream
([ADR-041](docs/decisions.md#adr-041), section 15).

**Fields Pseudonym does not know are stripped from answers.** An answer is
rebuilt field by field, so nothing else a provider adds reaches the client.
Gemini adds `extra_content` (a `thought_signature`) to every answer, 12 of
12 recorded (2026-10-07 to 2026-10-10); it is stripped, and only counted
in the log (see [Threat model](#threat-model-summary)).

## Upgrading: behaviour that changed

Three changes on 2026-10-11 make some requests behave differently from
before ([ADR-041](docs/decisions.md#adr-041), section 16):

- **A provider 400 is a 400, no longer a 502.** It reaches the client as
  `provider_rejected_request` ("the provider rejected the request", `param`
  null), where it used to be a 502 `provider_error`. This holds for every
  provider, Ollama included: Ollama answers a prompt longer than its
  context window with an HTTP 400, which is now this 400. It is logged once
  at `warn` with the provider's name and the status, and nothing of either
  body. A client that retried a 502 will not retry this, which is the
  point: the same request would be refused again.
- **Streams with usage early or more than once now succeed.** A stream in
  which `usage` arrives before the finish, or on more than one chunk, used
  to fail with `provider_bad_response`; it now succeeds, for every
  provider. Gemini sends `usage` on every chunk, as running totals, so
  every Gemini stream with `stream_options.include_usage` used to fail. The
  last usage is passed on, once, after the finish, as before. If a count
  went down from one chunk to the next, one `warn` line, "provider usage
  counts decreased", names which of prompt, completion and total did,
  never their values (bug-log 75).
- **A key with a plain-HTTP base URL off this machine refuses to start.**
  See [Start-up messages](#start-up-messages): any configuration that
  sets `PSEUDONYM_PROVIDER_API_KEY` with such a URL, Ollama's included,
  used to start and now does not.

## Threat model (summary)

**Protects against:** the AI provider seeing detected personal values, and
provider-side logging or training on them.

**Does not protect against:** values the detectors miss (today that includes
every person's name with names off, the default, and with names on the names the model and the list miss: 111 of 612 on the generated set, 4 of 45 on the held-out one (2026-10-03, [ADR-035](docs/decisions.md#adr-035)), an IFSC code with an unknown bank code and no keyword nearby, any secret with neither a known format
nor a keyword directly before it, a UPI ID at an unknown handle with no
keyword nearby, a passport number, voter ID or date of birth with no
keyword nearby, an IP address inside a host name, the part of an email
address before a `/`, `=` or `?` in its local part, a secret after a
credential word and a placeholder-shaped text with a space in it, numbers
written as words or with letters for digits, postal addresses and vehicle
numbers);
anything your application
logs before
calling Pseudonym; a compromised Pseudonym host; prompt injection that
manipulates answers (only the URL-exfiltration path is mitigated);
unsupported content types, if the rejection of them is bypassed. The
URL-exfiltration mitigation has known gaps, all in plain text that no
client fetches on its own:
[Restoration safety: known gaps](docs/threat-model.md#restoration-safety-known-gaps).

**Google's free tier.** Gemini's API terms for the Unpaid Services say that
Google uses the content submitted "to provide, improve, and develop Google
products" and that "human reviewers may read, annotate, and process your
API input and output" (terms last modified 2026-04-28, read 2026-10-07),
and they ask: "Do not submit sensitive, confidential, or personal
information to the Unpaid Services" (as read on 2026-10-11). Pseudonym
narrows that exposure to the values it detects; it does not remove it.
In the generated main cases with names off, the default, 198 of 1,683
labelled personal values are sent as written: all 153 person names, and
45 of the other 1,530 values (the results block above, 2026-10-06). That
gap is why the figures are published, per type, rather than a claim that
nothing personal leaves. Names are off by default because they failed the
speed and false-positive limits set before measuring, not because the gap
is small: with them off, every name goes to Google as written. An operator
using the free tier either switches them on, with their measured cost and
the names they still miss, or accepts that every name is sent
([ADR-035](docs/decisions.md#adr-035),
[ADR-040](docs/decisions.md#adr-040),
[ADR-041](docs/decisions.md#adr-041)).

**Inside Pseudonym:** the mapping from placeholders back to real values
exists only in memory for one request, and is never logged, stored or put in
an error. It is not encrypted, and someone who can read the process's
memory can read values ([ADR-012](docs/decisions.md#adr-012)). On every
start, a guard refuses to start if dumps or a debugger could be switched
on; only `PSEUDONYM_DISABLE_HARDENING=true` turns it off, and it can verify
none of this on Windows or macOS. Production means Linux
([ADR-016](docs/decisions.md#adr-016),
[ADR-047](docs/decisions.md#adr-047)).

**In a container,** the network in front of it, not the loopback default,
decides who can reach the gateway: the image listens on `0.0.0.0`, and the
compose file publishes on the host's loopback only
([ADR-046](docs/decisions.md#adr-046)).

**Disclosed: a dependency's telemetry (found 2026-10-10).** ONNX Runtime
1.30.0, the library that runs the person-name model, sends usage telemetry
to Microsoft by default: the CPU model, a device ID, and each loaded
model's file name, hashes and metadata, never request text. Pseudonym
loads it only with names on. In the shipped Linux container it is forced
off in code and proven off by a negative control. One run on 2026-10-07,
in a different image, probably uploaded one session's events; that cannot
be verified or taken back. On Windows it cannot be turned off from
Pseudonym, which says so in one line at start-up with names on; that it
fires there rests on inference and is still unobserved. The full entry:
[Threat model: detail](docs/threat-model.md#a-dependencys-telemetry)
([ADR-046](docs/decisions.md#adr-046), item 8 and amendments A and D).

Logs contain the method, route, status and timing of each request, never a
body, a URL or an error message. Two kinds of line add numbers and nothing
else: an empty answer from the provider (one line each), and fields the
provider sent that Pseudonym drops. For Gemini's `extra_content` that is
how many there were and each thought signature's length, never the
signature itself ([ADR-041](docs/decisions.md#adr-041), section 15).

This is a summary. Inside Pseudonym, the container, restoration safety's
known gaps and the telemetry entry in full:
[Threat model: detail](docs/threat-model.md). The decision behind
each part, and what was measured for it, is in the
[decision record](docs/decisions.md).

## Running locally

Requires Node.js 22.20+ and, to actually talk to a model, either
[Ollama](https://ollama.com) with a model pulled or a Gemini API key
([below](#gemini-instead-of-ollama)). The demo model, a 4B
instruct model that runs on a CPU, is
`ollama pull qwen3:4b-instruct-2507-q4_K_M` (already set in
`.env.example`). The tests do not need Ollama.

```bash
npm install
npm test               # run the test suite (the timing tests last)
npm run test:coverage  # coverage, without the timing tests
npm run test:timing    # only the timing tests
npm run test:names     # person-name tests on the real model (needs npm run fetch:model)
npm run eval:names     # names through the gateway, against the published figures (needs the model)
npm run lint           # lint
npm run typecheck      # type-check

cp .env.example .env    # PSEUDONYM_MODEL is the demo model; change it to use another
npm run dev             # gateway on http://127.0.0.1:3000/v1
```

The start-up guard runs on every start. On Windows and macOS it only
warns. On Linux `npm run dev` refuses to start, because it does not pass
`--disable-sigusr1`, until you set `PSEUDONYM_DISABLE_HARDENING=true` in
your own `.env` (never in production;
[ADR-047](docs/decisions.md#adr-047)).

`npm install` also installs the person-name runtime, an optional
dependency of about 303 MB (on Windows x64, measured 2026-10-07) that is
never loaded with names off. To run the
built gateway without it, install with `npm ci --omit=optional --omit=dev`
(after `npm run build`). Keep the plain install for development:
`--omit=optional` also removes the platform binaries of the development
tools, and esbuild's install script then downloads its binary outside the
lockfile, where no integrity hash checks it (the tests not starting is
only the symptom; [ADR-036](docs/decisions.md#adr-036), step 4a).

The timing tests check that detection and restoration take linear time:
each times the same work on an input and on one four times as long, and
fails if the time grows 8 times or more (linear code grows about 4
times, quadratic about 16). They run after the other tests and need the
machine mostly to themselves; how often they fail when they do not, and
what a failure prints:
[testing guide](docs/testing-guide.md#phase-5d-part-2--timing-tests-in-their-own-project-2026-10-02-adr-032-bug-logs-46-and-47)
([ADR-023](docs/decisions.md#adr-023), [ADR-032](docs/decisions.md#adr-032)).
Any test can also time out when the machine is short of memory (bug-log 57
in the [bug log](docs/bug-log.md)): check free memory before a full run, as
the [testing guide](docs/testing-guide.md) describes.

Point your OpenAI client at `http://127.0.0.1:3000/v1` and use the same model
name as `PSEUDONYM_MODEL`; requests naming any other model are rejected.
`.env.example` lists every setting (body and response limits, timeout,
restoration safety, the placeholder instruction). The timeout covers the
whole call when not streaming; when streaming it applies to each wait (for
the first chunk, then between chunks), so a long answer that keeps arriving
is never cut off by it. `GET /health` answers `{"status":"ok"}`; with
person names on it answers 503 `{"status":"unhealthy"}` while the name model
is held by a call past its timeout, and from a crash on, until the process
is restarted
([ADR-037](docs/decisions.md#adr-037)).

### Gemini instead of Ollama

Set `PSEUDONYM_PROVIDER=gemini`, `PSEUDONYM_PROVIDER_API_KEY` and
`PSEUDONYM_MODEL` (for example `gemini-3.5-flash-lite`, the model whose
refusals were measured). The key is required: without it Pseudonym refuses
to start. The base URL defaults to
`https://generativelanguage.googleapis.com/v1beta/openai/`. Google calls
this OpenAI-compatible endpoint "still in beta", and everything this README
says about Gemini was measured against that compatibility layer (2026-10-07
to 2026-10-10), not against OpenAI's own API, which this project does not
call because it costs money. Before sending anything, read
[Google's free-tier terms](#threat-model-summary)
([ADR-041](docs/decisions.md#adr-041)).

### Start-up messages

The common causes of a first run refusing to start:

- `Invalid environment variables: PSEUDONYM_MODEL`: it is unset; it has no default.
- `Invalid environment variables: PSEUDONYM_PROVIDER_API_KEY`: `PSEUDONYM_PROVIDER=gemini` with no key.
- `Invalid environment variables: PSEUDONYM_PROVIDER_BASE_URL`: a key is set and the base URL is plain `http://` to another machine.

This is not the complete list. The
[user manual](docs/user-manual.md#start-up-messages) has every start-up
message with its cause: thirteen when counted on 2026-10-16, seven of
which refuse to start.

## Running in Docker

The [Dockerfile](Dockerfile) builds a Debian slim image (Node 22.23.3,
pinned by digest) that runs the built gateway as an unprivileged user,
with the start-up guard on. Measured on 2026-10-10 (sizes rounded up),
it is 594 MB unpacked and a 201 MB download (Docker Desktop shows 795 MB,
counting both). About 305 MB unpacked and 115 MB of the download is the
person-name runtime. That is kept deliberately, so that names can be
switched on by mounting the model, without another image. With names off
the runtime is never loaded, and an image without it would be 290 MB
unpacked and an 86 MB download. The model
is never inside it ([ADR-046](docs/decisions.md#adr-046), amendment B).

```bash
docker compose up --build    # gateway on http://127.0.0.1:3000/v1
```

[compose.yaml](compose.yaml) reads `.env` and adds what the container
needs:

- the core dump limit at zero, without which the start-up guard refuses to
  start;
- Docker's init process, so a stop is a clean exit, not a kill after
  Docker's default of 10 s (the Compose file reference,
  `stop_grace_period`, read 2026-10-16);
- a read-only filesystem, no Linux capabilities, and no privilege
  escalation;
- the port published on the host's loopback only.

**Core dumps on the host.** The limit is the container's, but where a
crashing process's memory goes is the host's: if the host's
`/proc/sys/kernel/core_pattern` starts with `|`, the kernel hands it to
that program and the limit does not stop it. A dump of this process can
hold request text, so on such a host turn off the handler's storage of
dumps (for systemd-coredump, `Storage=none` in
`/etc/systemd/coredump.conf`). The start-up guard can only warn
([ADR-016](docs/decisions.md#adr-016)).

In `.env`, point `PSEUDONYM_PROVIDER_BASE_URL` at an address the container
can reach. For an Ollama on the same machine that is
`http://host.docker.internal:11434/v1`, not `localhost`. If `.env` also
sets `PSEUDONYM_PROVIDER_API_KEY`, the gateway refuses to start with that
address: it is plain `http://` and not this machine
([start-up messages](docs/user-manual.md#start-up-messages)). Do not paste
the output of `docker compose config`: it prints the API key from `.env`.

Without compose:

```bash
docker build -t pseudonym-gateway .
docker run --init --ulimit core=0 --read-only --cap-drop ALL \
  --security-opt no-new-privileges -p 127.0.0.1:3000:3000 \
  -e PSEUDONYM_MODEL=qwen3:4b-instruct-2507-q4_K_M \
  -e PSEUDONYM_PROVIDER_BASE_URL=http://host.docker.internal:11434/v1 \
  pseudonym-gateway
```

With a key added (`-e PSEUDONYM_PROVIDER_API_KEY`, or an `--env-file`
that sets one), the gateway refuses to start with that base URL: it is
plain `http://` and not this machine
([start-up messages](docs/user-manual.md#start-up-messages)).

**A development `.env` and `docker run --env-file`.** The `.env` made
from `.env.example` says `HOST=127.0.0.1`, which nothing outside the
container can reach. The compose file overrides it; `docker run` cannot,
so pass `-e HOST=0.0.0.0` after it. Its `NODE_ENV=development` no longer
matters: the guard is on unless `PSEUDONYM_DISABLE_HARDENING=true`
([ADR-047](docs/decisions.md#adr-047)). Never give a container a `.env`
with that set.

**The network is the boundary.** The image sets `HOST=0.0.0.0`. The
loopback default protects a process on a host, not a container, so
publish the port on `127.0.0.1` (as above) unless a network boundary in
front of the gateway is meant to decide who reaches it.

**Person names:** run `npm run fetch:model`, set `PSEUDONYM_NAMES=true`,
and mount the model read-only: uncomment the `volumes` lines in
`compose.yaml`, or add `-v "$PWD/models:/app/models:ro"`. With names on and
no model mounted, the container refuses to start.

The container's health check calls `GET /health`, which never calls the
provider. A healthy container is not proof that it can be reached: the
check runs inside it. CI checks that separately (below)
([ADR-046](docs/decisions.md#adr-046)).

## Continuous integration

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs on every push and
pull request, on GitHub's `ubuntu-24.04` runner with the Node version in
`.nvmrc` and read-only permissions. The runner's OS label is pinned, not
`ubuntu-latest`, so a new Ubuntu release never arrives unannounced; GitHub
still rebuilds the image under that label about weekly with tool updates (as
recorded on 2026-10-06), and that cannot be pinned
([ADR-036](docs/decisions.md#adr-036)). One job, one step after another: `npm ci`,
typecheck, lint, format check, the tests with coverage (the run fails below
100% of lines, branches, functions and statements in `src` and `eval`), the
timing tests as their own step, then `npm run eval`, which fails if any
count moves from `eval/baseline.json` or the README's results block is out
of date. The timing tests run one file at a time there: the three at a time
used locally was measured on 12 cores, and the runner had 4 when CI was
set up (2026-10-02)
([ADR-032](docs/decisions.md#adr-032)).

A second job builds the Docker image and runs
[scripts/docker-smoke.ts](scripts/docker-smoke.ts) on it. It checks the
built image, not the Dockerfile:

- a listing of its whole filesystem has no `.env` file, no `eval/` (where
  the held-out set lives), `test/`, `docs/` or model, and `/app` holds only
  the built code, its dependencies and `package.json`;
- it runs as a non-root user, configured and running;
- the start-up guard refuses a core dump limit, a debugger flag and a
  missing `--disable-sigusr1`, and still refuses with `.env.example` passed
  by `--env-file`;
- names on with no model mounted refuses to start;
- a real request with a synthetic email, sent through the published port
  to a stub provider, comes back with the email restored, and the stub
  received only its placeholder;
- the same with names on: the model, restored from a cache shared with
  the Names workflow (either one saves it, only on a miss and only after
  the files are verified; [ADR-046](docs/decisions.md#adr-046), amendment
  G) and checked file by file, is mounted read-only, and a synthetic
  name reaches the stub only as its placeholder; the Windows-only telemetry
  line is not printed there.

As of 2026-10-10, six deliberately broken images each fail it (the last, with the
Windows-only check compiled as Linux's, fails exactly the telemetry-line
check), and a seventh, with `NODE_ENV=development`, passes it, as it
should since ADR-047 ([ADR-046](docs/decisions.md#adr-046), amendment D).

Not covered by CI:

- **The model measurement** (`scripts/measure-rewrites.ts`, the table
  under [What a real model does with placeholders](#what-a-real-model-does-with-placeholders))
  needs Ollama and a model, so it is run by hand; CI only checks that the
  README's table matches `eval/model-rewrites.json`.
- **Recording a new Ollama stream** (`scripts/record-ollama-stream.ts`) needs
  Ollama too; CI replays the recorded fixture.
- **No real provider is called.** Every test talks to a mock or a recording.
- **Mutation checks** (`scripts/mutate.ts`), which show that the tests can
  fail, are run by hand. Their lists are in the repository only from
  2026-10-10 (`scripts/mutations/`); every earlier mutation count is
  recorded but cannot be re-run from the history
  ([ADR-043](docs/decisions.md#adr-043)).
- **One platform and one Node version**: Linux with Node 22.23.3, not
  Windows or macOS, and not the oldest version `engines` allows (22.20).
- **The Docker image on arm64.** Only linux/amd64 is built. The names-on
  image check runs on whichever runner CPU GitHub assigns; it checks that a
  name is redacted, not that spans match a baseline (the Names workflow
  does that).

## Documentation

- [Decision record](docs/decisions.md): every design decision as a short
  ADR (context, options, decision, consequences), ADR-001 onwards. Its
  provenance note says what the git history does and does not show about
  when each was written.
- [Bug log](docs/bug-log.md): real bugs found during development, each with
  its root cause and the test that now guards it.
- [Testing guide](docs/testing-guide.md): how every part is tested, with the
  mutation checks that show the tests can fail.
- [User manual](docs/user-manual.md): how each part works, phase by phase.
- [Detection: rules, costs and known gaps](docs/detection.md): every
  detector's rule, what it costs in ordinary text, and every known gap.
- [Measured results: notes](docs/results-notes.md): what each row of the
  results means, the echo table, how the held-out set was made, and the
  person-name comparison.
- [Person names: install, licence and CPUs](docs/person-names.md): the
  runtime's install, the model's licence, and which CPUs reproduce the
  figures.
- [Threat model: detail](docs/threat-model.md): the mapping in memory, the
  start-up guard, the container, restoration safety's known gaps, and a
  dependency's telemetry.

## Tech stack

TypeScript (strict) · Node.js 22 · Fastify (with its Pino logger) · Zod ·
libphonenumber-js (phone validation) · Vitest · fast-check · ESLint · Prettier.
The provider is called with Node's built-in `fetch`. Person names, an
optional dependency loaded only with names on: ONNX Runtime
(`onnxruntime-node`) and `@huggingface/tokenizers`.

## License

[MIT](LICENSE). Material by others copied into this repository, the IFSC
bank codes from Razorpay's dataset, keeps its own notice:
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

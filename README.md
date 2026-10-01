# Pseudonym

**An OpenAI-compatible privacy gateway that pseudonymises personal data before it
reaches an LLM, and restores it in the reply.**

> **Status: work in progress (Phase 4 of 8 done; Phase 5, evaluation, under
> way: its detector part is complete, and every planned detector except
> person names is built).** Not ready
> for production use.
> Pseudonym runs as a gateway: `POST /v1/chat/completions` (OpenAI format,
> streaming and non-streaming) redacts emails, phone numbers, Aadhaar, PAN,
> card numbers, UPI IDs, IFSC codes, IP addresses, API keys in known formats, secrets written after a
> keyword (`password: …`) and any other number of 9+ digits, forwards the
> request to a local [Ollama](https://ollama.com) model, and restores the
> values in the answer, including when it arrives as a stream. No-leak tests
> send planted values through both paths and check none reaches the
> provider. **Person names are not detected yet** (they
> are sent as written), and neither is a password or token with no keyword
> before it and no known format, nor a UPI ID at an app or bank handle
> Pseudonym does not know with no word such as "UPI" near it, nor an IFSC
> code whose bank code is not on Pseudonym's list with no word such as
> "IFSC" near it.
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
- **India-aware detection.** Aadhaar (Verhoeff check digit), PAN, UPI IDs
  (known app and bank handles) and IFSC codes (bank codes from RBI's list)
  alongside emails, phone numbers, card numbers (Luhn check) and IPv4 and
  IPv6 addresses (a hand-written parser).
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
sent as written: a person's name typed into a message **goes to the
provider today**. The measurements below come from
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
| UPI ID                              | a handle on Pseudonym's list of 54 app and bank handles (Google Pay, PhonePe, Paytm, BHIM, banks' own…), compiled from public sources, not NPCI's list; any other handle only near a keyword  | redacted |
| IFSC code                           | a bank code on Pseudonym's list of 260 (every bank with branches in RBI's list of NEFT-enabled branches, taken from a published copy of RBI's files); any other bank code only near a keyword | redacted |
| IP address (IPv4 and IPv6)          | parsed by hand: four parts of 0–255, or an IPv6 form (compressed, full, with an IPv4 part); addresses no single host owns (loopback, netmasks, multicast) are left as written                 | redacted |
| Person names                        | local NER model                                                                                                                                                                               | planned  |

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
  (`<name>@paytm.com`), it is an email, not a UPI ID. The list of handles
  is compiled from public sources (Wikipedia's list of UPI apps, payment
  companies' guides, banks' own handles), **not from NPCI's official
  list**, which could not be read. How complete it is has not been
  measured.
- **IFSC code** (four letters, a zero, six letters or digits): always when
  the four letters are a bank code on the list; with any other four letters
  only if "IFSC", "IFS code", "NEFT", "RTGS", "IMPS", "branch", आईएफएससी
  or शाखा is nearby ("bank" alone is not enough). Any case
  (`sbin0001234` is the same code). An IFSC touching `@` is part of an
  email address or UPI ID. The list is every bank with branches in RBI's
  list of NEFT-enabled branches (updated 2026-09-15); RBI's own files could
  not be downloaded, so the codes come from Razorpay's open-source copy of
  them, checked against the bank names on RBI's page. A bank added after
  that is found only with a keyword.
- **IP address:** every address, public or private, except the ones no
  single host owns: `0.0.0.0` and the rest of 0/8, loopback (`127.x`,
  `::1`), multicast (`224.x`–`239.x`, `ff00::/8`) and the reserved
  `240.x`–`255.x`, which holds the broadcast address and every netmask
  (`255.255.255.0`). Those are the same on every machine and are left as
  written, and no other detector may take them for a phone number or an
  Aadhaar either. Private (`10.x`, `192.168.x`…), carrier-grade NAT,
  link-local and documentation addresses are redacted: it was measured that
  leaving them to the other detectors would not keep them visible anyway
  (most would be redacted as phone numbers or long numbers) and would only
  make it depend on how many digits they have. Only the address is
  replaced: a port (`:8080`), a prefix length (`/24`), a zone (`%eth0`),
  brackets and the rest of a URL stay as written. Two forms are found only
  near a word such as "IP", "IPv4", "IPv6" or "inet": four numbers right
  after a version word ("version", "build", "firmware", संस्करण…), and IPv6
  addresses made only of one- or two-digit groups (`a::b`, eight pairs of
  hex digits), which is also what names in code and hardware ids look
  like. A version with no such word in front of it cannot be told from an
  address and is redacted.
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
the 9 digits the safety net needs (the held-out NUMBER row shows it). An
IFSC written with the letter O for its zero (`SBINO001234`) or with a space
or hyphen after the bank code is not caught. **A value inside a longer
address or secret** can leave the rest visible: in `<PAN>.x@example.com`,
`<IFSC>.x@example.com` or `api_key=<IFSC>-x7` only the PAN or IFSC is
replaced, because a checked value wins over a longer unchecked one (an
open question for the next part of Phase 5). **IP addresses:** one written
inside a host name (`<address>.nip.io`, reverse-DNS names) is not
recognised; an address with a prefix length whose digits also read as a
valid phone number (some `203.x.x.x/24`) is replaced as a phone number,
prefix and all; two addresses joined only by a space or hyphen share one
placeholder; and because private addresses are replaced too, the model
cannot tell whether two of them are on the same network. **MAC addresses**
(a device identifier) have no detector: written with colons
(`00:1A:2B:3C:4D:5E`) they are always sent as written, and in other forms
they are replaced only when their decimal digits happen to reach the 9 the
safety net needs. A 10-digit mobile
written in two groups of five is not detected at all when another group of
digits sits next to it with only spaces between: a second such mobile, a
PIN code after it, `24x7` after it, or a lone digit in front of it
(`Room 3 <mobile>`, or an address such as `127.0.0.1`). A word such as
"mobile" or "call" nearby helps only in the last case.

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
- The generated dataset's headline table is its **500 main cases**, written
  the usual ways. Below it, and kept apart from it, is the **shape block**:
  cases written in ways that are hard on purpose (a line break inside a
  number, a value split across two messages, two values side by side, a
  checked value inside an email address or key, passport and voter ID
  numbers and dates of birth), one row per way of writing. Each row there
  measures one known gap; a low number in it is that gap, not the overall
  quality.

PERSON has no detector yet, and neither have passport numbers, voter IDs
and dates of birth (the shape block's `short-id` row). They are labelled
and measured from the start so that the "before" is on record. The IP
row's 4 values of the wrong type are
addresses written with a prefix length (`/24`) whose digits also read as a
valid phone number: still redacted, as a phone number, prefix and all. Its
53 over-redactions are private (14) and link-local (17) addresses, which
are redacted on purpose, four-part versions with no version word in front
(20), which cannot be told from an address, and two IPv6 interface ids
next to an IP keyword. The SECRET row counts eleven kinds of secret in
equal shares: nine known key formats, passwords and bare 40-character
tokens. The last two are found only after a keyword, and some of the
generated sentences deliberately have none ("I pasted … into the chat by
mistake"): those are the misses in that row. The same holds for UPI: the
six misses are IDs at a handle on no list, in sentences with no UPI
keyword. Every real handle the generator uses is taken from the
detector's list (the others are made up), so the UPI row does not measure
how complete that list is, and nothing else does yet: the list is compiled
from public sources, not NPCI's official list. The IFSC row has the same
limit. Of its 24 IFSCs with an unknown bank code, 23 have a keyword nearby
and are found; the one without is the row's one miss, by design. Its 3
over-redactions are IFSC-shaped product codes (four letters, a zero, six
digits): 3 of the 15 in the set. None of the 35 codes that are one
character off (a fifth character other than zero, three letters instead of
four) was touched.

<!-- eval:start -->

_Measured on 2026-10-01 (UTC date) by `npm run eval`. This block is generated, and the run fails if it is out of date._

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

**Generated dataset, shape block** (859 labelled personal values, in cases apart from the main ones). Each row is a way of writing values that is hard on purpose: a line break inside a value, a value split across two messages, two values side by side, digits beside a mobile, a checked value inside an address or key, digits joined by a bracket, passport and voter ID numbers and dates of birth. These rows measure known gaps one at a time; they are not part of the numbers above.

| Written as    | Values | Redacted (any type) | Partly redacted | Recall (right type) | Over-redactions |
| ------------- | ------ | ------------------- | --------------- | ------------------- | --------------- |
| line-break    | 120    | 11/120 (9.1%)       | 7               | 11/120 (9.1%)       | 12              |
| message-split | 60     | 0/60 (0.0%)         | 2               | 0/60 (0.0%)         | 0               |
| side-by-side  | 80     | 68/80 (85.0%)       | 4               | 52/80 (65.0%)       | 5               |
| digit-beside  | 40     | 13/40 (32.5%)       | 0               | 13/40 (32.5%)       | 4               |
| contained     | 70     | 0/70 (0.0%)         | 70              | 0/70 (0.0%)         | 8               |
| joined-digits | 30     | 6/30 (20.0%)        | 24              | 6/30 (20.0%)        | 4               |
| short-id      | 459    | 1/459 (0.2%)        | 0               | 0/459 (0.0%)        | 0               |

**Held-out adversarial dataset** (drafted with AI assistance in a separate session that did not write the detectors, then reviewed by the author; never run against the detectors before it was committed, and never used for tuning; 58 messages in 54 cases, 79 labelled personal values).

| Type    | Values | Redacted (any type) | Partly redacted | Recall (right type) | Precision (right type) | F1     | Over-redactions |
| ------- | ------ | ------------------- | --------------- | ------------------- | ---------------------- | ------ | --------------- |
| AADHAAR | 9      | 8/9 (88.8%)         | 0               | 7/9 (77.7%)         | 7/7 (100.0%)           | 87.5%  | 0               |
| CARD    | 7      | 4/7 (57.1%)         | 0               | 4/7 (57.1%)         | 4/4 (100.0%)           | 72.7%  | 0               |
| PAN     | 8      | 7/8 (87.5%)         | 0               | 7/8 (87.5%)         | 7/7 (100.0%)           | 93.3%  | 0               |
| PHONE   | 19     | 18/19 (94.7%)       | 0               | 18/19 (94.7%)       | 17/18 (94.4%)          | 94.5%  | 1               |
| EMAIL   | 7      | 6/7 (85.7%)         | 0               | 6/7 (85.7%)         | 6/6 (100.0%)           | 92.3%  | 0               |
| NUMBER  | 6      | 3/6 (50.0%)         | 0               | 3/6 (50.0%)         | 3/8 (37.5%)            | 42.8%  | 4               |
| IFSC    | 3      | 3/3 (100.0%)        | 0               | 3/3 (100.0%)        | 3/3 (100.0%)           | 100.0% | 0               |
| UPI     | 3      | 3/3 (100.0%)        | 0               | 3/3 (100.0%)        | 3/3 (100.0%)           | 100.0% | 0               |
| IP      | 2      | 2/2 (100.0%)        | 0               | 2/2 (100.0%)        | 2/4 (50.0%)            | 66.6%  | 2               |
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
every person's name, an IFSC code with an unknown bank code and no keyword nearby, any secret with neither a known format
nor a keyword directly before it, a UPI ID at an unknown handle with no
keyword nearby, an IP address inside a host name, and a spaced mobile
number right after a lone digit with no keyword nearby); anything your application
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

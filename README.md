# Pseudonym

**An OpenAI-compatible privacy gateway that pseudonymises personal data before it
reaches an LLM, and restores it in the reply.**

> **Status: work in progress (Phase 5 of 8 done: detection, the gateway,
> streaming and the evaluation are built, and a CI workflow runs the checks,
> tests and evaluation; person names are under way: their test set is
> built, and the request path is wired and tested against a stand-in
> model, but the model itself is not built in yet).** Not ready for production
> use.
> Pseudonym runs as a gateway: `POST /v1/chat/completions` (OpenAI format,
> streaming and non-streaming) redacts emails, phone numbers, Aadhaar, PAN,
> card numbers, UPI IDs, IFSC codes, IP addresses, API keys in known formats, secrets written after a
> keyword (`password: …`), passport numbers, voter IDs and dates of birth
> with a word such as "passport", "voter ID" or "DOB" next to them, and any
> other number of 9+ digits, forwards the
> request to a local [Ollama](https://ollama.com) model, and restores the
> values in the answer, including when it arrives as a stream. No-leak tests
> send planted values through both paths and check none reaches the
> provider. **Person names are not detected yet** (they
> are sent as written), and neither is a password or token with no keyword
> before it and no known format, nor a UPI ID at an app or bank handle
> Pseudonym does not know with no word such as "UPI" near it, nor an IFSC
> code whose bank code is not on Pseudonym's list with no word such as
> "IFSC" near it, nor a passport number, voter ID or date of birth with no
> such word near it, nor numbers written as words, postal addresses or
> vehicle numbers.
> Detection is measured on two datasets, a generated one and a small
> held-out adversarial one (see [Measured results](#measured-results)).
> The tests use a mock of Ollama built from Ollama's documentation and
> source; Pseudonym has also been run against a real Ollama (0.35.0, on a
> CPU): one recorded stream is a test fixture, and the model measurement
> made 30 calls through the real pipeline.

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
  `user` is dropped, and anything else is rejected rather than forwarded
  ([ADR-014](docs/decisions.md#adr-014)).
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
- **Proof.** Built: no-leak tests, streaming and non-streaming (seeded
  histories full of planted values through the real gateway to a recording
  mock provider; none may arrive in any form), and canary tests (every error
  path forced, before and during a stream; no planted value in any
  response, log line or error), each shown able to fail by switching off
  one detector or check at a time; property-based streaming restoration
  tests; an evaluation (`npm run eval`) that scores the detectors on a
  seeded, generated dataset and on a held-out adversarial one, counts what
  restoration safety leaves unrestored when a model echoes every message,
  and fails if any count differs from the recorded baseline
  ([ADR-021](docs/decisions.md#adr-021), [ADR-033](docs/decisions.md#adr-033)).

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
| UPI ID                              | a handle on Pseudonym's list of 51 app and bank handles (Google Pay, PhonePe, Paytm, BHIM, banks' own…), compiled from public sources, not NPCI's list; any other handle only near a keyword  | redacted |
| IFSC code                           | a bank code on Pseudonym's list of 260 (every bank with branches in RBI's list of NEFT-enabled branches, taken from a published copy of RBI's files); any other bank code only near a keyword | redacted |
| IP address (IPv4 and IPv6)          | parsed by hand: four parts of 0–255, or an IPv6 form (compressed, full, with an IPv4 part); addresses no single host owns (loopback, netmasks, multicast) are left as written                 | redacted |
| Passport number                     | none possible: a letter and 7 digits, only near "passport" or पासपोर्ट                                                                                                                        | redacted |
| Voter ID (EPIC)                     | none possible: 3 letters and 7 digits, only near "voter", "EPIC", मतदाता or वोटर                                                                                                              | redacted |
| Date of birth                       | a real calendar date in a common form, only near "DOB", "birth", "born", "birthday", जन्म or "janm"/"janam"                                                                                   | redacted |
| Person names                        | local NER model                                                                                                                                                                               | planned  |

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

Which detected matches count ([ADR-010](docs/decisions.md#adr-010)):

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
- **Passport numbers, voter IDs and dates of birth:** only with a word
  naming them within 40 characters, before or after: "passport",
  पासपोर्ट; "voter", "EPIC", मतदाता, वोटर; "DOB", "date of birth",
  "born", "birthday", जन्म तिथि, "janm tithi". Without one they are sent
  as written, by design: a letter and 7 digits is also a model number, 3
  letters and 7 digits an order code (`ORD` and 7 digits), and a date is
  usually an order or invoice date. A date of birth is a real calendar
  date written day, month, year (`07/03/1991`, `7.3.1991`, `07-03-91`;
  month first too, when only that reading is a real date), year first
  (`1991-03-07`), or with the month as a word (`7 March 1991`,
  `07-Mar-1991`, `March 7, 1991`). With a keyword nearby, **anything of
  the same shape within those 40 characters is redacted too**. Measured on
  2026-10-02 on 200 synthetic messages of each layout, the neighbour was redacted in all
  200: a joining date after a date of birth (`DOB: … Joined: …`), a
  ticket code after a passport number (`Passport no: … Ticket: …`), an
  order code after a voter ID (`Voter ID: … Order: …`), and a date or
  code after "born", "epic" or "passport" in ordinary prose ("our brand
  was born in Pune; offer valid till …", "an epic deal: order …",
  "passport size photo, model …"). Invoice lines, order mails and log
  lines with no such word, or with it more than 40 characters away, lose
  nothing (0 in 200 each).
- **Any stretch of 9 or more digits that no detector claimed**, counted across
  dots, hyphens, dashes, brackets and `+` but not spaces: always, as a generic
  number, together with the letters, digits and underscores it is glued to
  (the whole of `UID234567890123` or of a hexadecimal token, never a piece
  cut out of it). Dates such as `2024-09-28 14:30` and amounts such as
  `1,25,000` stay below 9 digits and are not touched. Digits joined by a
  bracket, `+`, a dot or a hyphen to a detected value are taken however few
  (`<mobile>(12345`), since they were written as one number.

**When readings overlap** ([ADR-003](docs/decisions.md#adr-003),
[ADR-029](docs/decisions.md#adr-029)). A checked value wins over an unchecked one, then
the reading with more letters and digits (separators do not count), then the
type order. A reading that wholly contains the winners it touches replaces
them: `<PAN>.x@example.com` is one email, `token: abc-<mobile>` one secret.
Any other reading that lost keeps whatever no winner covers, so two values
written side by side are both replaced even when one could be read as
running into the other (`<Aadhaar>-name@example.com`): where exactly the
two are split then depends on these rules, but nothing of either is sent.
Emails and UPI IDs are read outwards from every `@`, so two of them glued
by a hyphen are both found; a key in a known format takes the rest of the
token it is glued to, so two keys joined by a hyphen become one secret.

This leans towards redacting: a check digit passes about 1 in 10 random
numbers, and every number of 9+ digits is caught, so ordinary numbers (order
IDs, tracking numbers, build numbers, hashes with a long stretch of digits)
will be replaced too; the user will still see the real number in the reply.
Digits in any script (Devanagari, Bengali, Tamil, full-width…) and numbers
split by invisible characters are detected. Detection fails closed: a value
found inside a longer number takes the whole number with it (up to where
the next value starts: two values in one stretch of digits keep two
placeholders), and no input is skipped for being too long
([ADR-010](docs/decisions.md#adr-010), [ADR-028](docs/decisions.md#adr-028)).

**Mobiles written in two groups of five** are found even with other digits
beside them (`Room 3 <mobile>`, `<mobile> 411038`, two mobiles side by
side, a contact sheet of mobiles in columns). Tables of 5-digit numbers pay
for it. Two neighbouring groups of five starting 6–9 read as a mobile, so
inside a table they count only if every other row with two 5-digit groups
in those same two positions has a mobile there too, or if a word such as
"mobile" or "call" is nearby. Measured on 2026-10-01 on 200 synthetic
tables of each layout (detections in text with nothing personal; before → now): a row
number and two 5-digit amounts per row (`12 34567 89012`) 116 → 149;
three 5-digit amounts per row 4 → 43; the same with some row labels
containing a digit (`Q1`) 5 → 130, in 68 of the 200 tables; two rows of
three 5-digit amounts 1 → 151; two rows of a row number and two amounts
25 → 80. Two 5-digit amounts per row were already read as phone numbers
before this (763 in 200 tables, unchanged). Amounts written with commas
(`65,000`, `1,25,000`) and plain 6-digit amounts are not affected
([ADR-027](docs/decisions.md#adr-027)).

**Numbers wrapped onto the next line** (`2345 6789`, a line break, `0123`)
are read as one number when only one line break (LF or CRLF, with at most
two spaces or separators around it) is between the two halves. Aadhaar and
card numbers count as they do on one line: they must pass their checks, or
have a word such as "Aadhaar" or "card" nearby. A phone number wrapped
like this always needs a word such as "mobile" or "call" nearby, because
two lines of five digits are as often two amounts as one mobile. Another
number beside the wrapped one on one of its lines (`Room 3 2345 6789`, a
line break, `0123`) does not stop it being found. Lists of codes pay for
it: the end of one line and the start of the next often pass the checks.
Measured on 2026-10-02 on 200 synthetic messages of each layout
(detections in text with nothing personal; before → now): two 4-digit codes per line 0 → 124, in 98
of the 200 messages; three 4-digit codes per line 96 → 155; one 6-digit
number per line 0 → 70, in 55 messages; one 5-digit number per line with
"phone" in the first line 0 → 539, in all 200. Statements, logs, addresses,
numbered steps, dates and amounts written with commas, one per line, are
not affected (0 before and after) ([ADR-030](docs/decisions.md#adr-030)).

**Secrets are found in two ways and no third**
([ADR-022](docs/decisions.md#adr-022)). There is no entropy
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
for the safety net; a number **split across two messages** is not caught at
all (each message is checked on its own, and each part is too short for the
safety net); a number wrapped onto the next line is caught only in the forms
described above (not across a blank line, nor broken over three lines, nor
inside a digit group of a spaced number, nor written without spaces with
another number beside it on the same line); nor are emails written as "name at example dot com",
quoted or IP-literal addresses, or the 16-digit Aadhaar Virtual ID. **An
address with `/`, `=` or `?` in its local part** (allowed by the email
standard, RFC 5322, but not issued by mail providers) is redacted only from
the character after the last of them: `a/b@example.com` sends `a/`. This
is a deliberate trade, so that an address inside a URL
(`https://a.example/?id=priya@example.com`) is redacted alone and the URL
stays a URL ([ADR-034](docs/decisions.md#adr-034)). **Short
personal identifiers need their word** ([ADR-031](docs/decisions.md#adr-031)): a passport number, voter ID or date
of birth with no keyword within 40 characters is sent as written (the
safety net needs 9 digits). Nor are these caught with one: a passport
number with a space after its letter, voter IDs in the older state formats,
a date of birth without its year, with spaces around the separators of a
numeric date (`07 / 03 / 1991`), with a time glued to it
(`1991-03-07T10:00`), or with its month named in a language other than
English. An
IFSC written with the letter O for its zero (`SBINO001234`) or with a space
or hyphen after the bank code is not caught. A lone digit and a space
before a long number (`1 23456789(12345`) leave the lone digit visible: the
safety net does not join across spaces, and widening the number over them
was measured to redact the quantity and price columns of tables (on
2026-10-01: 4,893 digits redacted instead of 5 in 200 tables of an id, a
quantity and a price per row; [ADR-029](docs/decisions.md#adr-029)). **IP addresses:** one written
inside a host name (`<address>.nip.io`, reverse-DNS names) is not
recognised; an address with a prefix length whose digits also read as a
valid phone number (some `203.x.x.x/24`) is replaced as a phone number,
prefix and all; and because private addresses are replaced too, the model
cannot tell whether two of them are on the same network. **MAC addresses**
(a device identifier) have no detector: written with colons
(`00:1A:2B:3C:4D:5E`) they are always sent as written, and in other forms
they are replaced only when their decimal digits happen to reach the 9 the
safety net needs. **Not detected, and not measured:** numbers written as
words ("nine eight seven…", "nau aath saat…"); letters standing in for
digits (O for 0, l for 1, as in scanned or retyped text), which stop a value
being recognised as its type, so it is replaced only when 9 or more digits
are left in one stretch for the safety net (in a probe on 2026-10-02, one
letter for one digit in 500 generated values of each type: 208 of 494 Aadhaar numbers, 403 of 500 card numbers, 0 of 489
mobiles); postal addresses; and vehicle registration numbers. The
evaluation's case format cannot express any of the four yet
([eval/HELD-OUT-FORMAT.md](eval/HELD-OUT-FORMAT.md), "Not expressible
yet"), so neither dataset contains them
([ADR-021](docs/decisions.md#adr-021)).

## Measured results

Two datasets, reported separately. Every number in this section is
produced by `npm run eval` (deterministic, run in CI), except the last
part, a model measurement that needs Ollama
(`scripts/measure-rewrites.ts`, one run on 2026-10-02).

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

PERSON has no detector yet. It is labelled and measured from the start so
that the "before" is on record. The main cases' 153 names come from a
short list in sentences that say a name follows; the shape block's `names`
row is the harder set Phase 6 is measured on: 612 names paired at random
from Wikidata's given and family names (CC0), Indian by region and
international, in Latin script and Devanagari, written in full, as a given
name alone, with initials, with an honorific, in lower case or capitals,
in a greeting, a sign-off, a form field or the middle of a sentence,
beside words that are not names (months, places, companies, festivals,
words that are also names, code identifiers). Today 0 of them are
redacted. Passport numbers, voter IDs and dates of birth were measured the
same way before their detectors: the shape block's `short-id` row went
from 1 of 459 redacted to 305 when their detectors were added (passport
93, voter ID 103, date of birth 108 of 153 each with the right type, and
one date of birth read as a phone number). Its misses are values in
sentences that name no type ("Document … expired last month", "The age
proof says …"), which are sent as written by design. Its 25
over-redactions are codes and dates of the same shapes within 40
characters of a real value's keyword: model, ticket, invoice and order
codes (18), dates in the 1900s (4), and order dates in 2026 (3). The IP
row's 4 values of the wrong type are addresses written with a prefix
length (`/24`) whose digits also read as a valid phone number: still
redacted, as a phone number, prefix and all. Its 53 over-redactions are
private (14) and link-local (17) addresses, which are redacted on purpose,
four-part versions with no version word in front (20), which cannot be
told from an address, and two IPv6 interface ids next to an IP keyword.
The SECRET row counts eleven kinds of secret in equal shares: nine known
key formats, passwords and bare 40-character tokens. The last two are
found only after a keyword, and some of the generated sentences
deliberately have none ("I pasted … into the chat by mistake"): those are
the misses in that row. The same holds for UPI: the six misses are IDs at
a handle on no list, in sentences with no UPI keyword. Every real handle
the generator uses is taken from the detector's list (the others are made
up), so the UPI row does not measure how complete that list is, and
nothing else does yet: the list is compiled from public sources, not
NPCI's official list. The IFSC row has the same limit. Of its 24 IFSCs
with an unknown bank code, 23 have a keyword nearby and are found; the one
without is the row's one miss, by design. Its 3 over-redactions are
IFSC-shaped product codes (four letters, a zero, six digits): 3 of the 15
in the set. None of the 35 codes that are one character off (a fifth
character other than zero, three letters instead of four) was touched.

<!-- eval:start -->

_Measured on 2026-10-03 (UTC date) by `npm run eval`. This block is generated, and the run fails if it is out of date._

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
| Placeholders                                        | 1667              | 98                     | 1437                      | 74            |
| Restored                                            | 1660/1667 (99.5%) | 26/98 (26.5%)          | 1428/1437 (99.3%)         | 70/74 (94.5%) |
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

<!-- eval:end -->

The PHONE and NUMBER rows over-redact on purpose: a 10-digit tracking number
or timestamp is a valid phone number as far as any check can tell, and the
safety net takes every number of 9 or more digits. For the generated
dataset `npm run eval` also prints which kinds of lookalike were redacted.
The held-out set labels no passport number, voter ID or date of birth, so
its PASSPORT, VOTER and DOB rows only count detections: one PASSPORT and
one VOTER detection on values labelled as another type, and one date in
plain text read as a date of birth. In the same run its NUMBER row's
redacted count rose from 3 to 5.

The counts are recorded in `eval/baseline.json` and act as thresholds: both
datasets are deterministic, so `npm run eval` fails if any count is worse
than recorded, and also if one is better until the record is updated. A
worse count can only be accepted with a written reason, which is kept in
that file ([ADR-021](docs/decisions.md#adr-021)).

The echo table is the cost of restoration safety in the best case, a model
that repeats every placeholder exactly. In the generated main cases 7 of
1,667 placeholders stay placeholders, all IP addresses inside a
`http://…/login` URL. The `in-markup` shape puts one value in each of ten
places in a URL, a markdown link or an HTML tag: 72 of its 98 stay
placeholders, which is the rule doing its job, and the 26 restored are
link texts and table cells (18) and lookalikes in filler sentences (8).
The first measurement found 6 more restored: emails in a plain URL's query
or path, which the email detection took together with the URL's host and
path (`https:[EMAIL_1]`), so the URL rule saw no URL. An address's local
part now stops at `/`, `=` and `?` (see the email gap above). In the other
shapes, 9 placeholders stay because of Pseudonym's own bracket: digits
joined by a bracket (`1234567890(12345`) become `[NUMBER_1]([NUMBER_2]`,
and the `](` reads as a link target. The rules added for streaming (an
unclosed `<` or `="`, the host rule) hold nothing back in the generated
set, which has no such text. Every message comes back exactly with the
rules switched off. A model that rewrites or drops placeholders is a
separate measurement ([ADR-033](docs/decisions.md#adr-033)).

**Known costs of restoration safety** (values the user sees as
placeholders, not as the real value): any placeholder inside a URL, a
markdown link or image target, after `[label]:`, or in a quoted HTML
attribute value, by design; the second placeholder of `[NUMBER_1]([NUMBER_2]`,
because Pseudonym's own bracket followed by `(` reads as a link target; and
**code that assigns a quoted string**: a quoted value after `=` is treated
as an HTML attribute, so `API_KEY = "[SECRET_1]"` stays unrestored. The
echo table above cannot show that last one, because neither dataset
contains code; the model measurement below found it (2 of 34 values in one
task) ([ADR-018](docs/decisions.md#adr-018),
[ADR-033](docs/decisions.md#adr-033)).

How the held-out set was made, stated exactly: it was drafted with AI
assistance in a separate session that did not write the detectors, then
reviewed by the author. It is blind (no case was run against
the detectors before the set was committed) and it is never used for tuning:
whoever works on the detectors does not read the file, and the evaluation
prints counts per data type, never a case's text, so a detector cannot be
adjusted to a case it missed. It is small, so one value moves a row by
several points. Its format is described in
[eval/HELD-OUT-FORMAT.md](eval/HELD-OUT-FORMAT.md). That format cannot yet
express some things people really write: numbers spelled out in words, letters
standing in for digits in scanned text (O for 0, l for 1), postal addresses
and vehicle numbers. None of those is measured, and none is detected
([ADR-021](docs/decisions.md#adr-021)).

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

Thinking models are not the demo model. On `qwen3:4b` (a thinking model)
one answer took 13.4 minutes on the same CPU, `reasoning_effort: "none"`
put its reasoning into the answer itself (ending with a stray
`</think>`), and its reasoning once wrote `[EMAIL_:1]`, a form
restoration does not read.

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
detector configuration share an author, while the held-out set was
drafted with AI assistance in a separate session that did not write the
detectors, then reviewed by the author. It came out higher than the
generated one, but with 45 names its interval overlaps the generated
one, so the two are consistent rather than different. One known reason
it can be higher: on the generated set the name list in F can never
match, because the test names come from the other half of the same
Wikidata lists by design, while real names in the held-out set can be on
that list. Precision is not comparable between the two: the generated
set plants name lookalikes on purpose. These are measurements of the
configuration Phase 6 will build. The gateway does not detect names yet,
so the evaluation tables above still show PERSON at 0.

| Candidate                                 | Names found (612)                 | False positives per 1,000 words | ms per KiB | Memory      | Fails           |
| ----------------------------------------- | --------------------------------- | ------------------------------- | ---------- | ----------- | --------------- |
| A: `bert-base-NER` (English)              | 293 (47.8%)                       | 0.99                            | 416        | 245 MiB     | speed           |
| B: `bert-base-multilingual-cased-ner-hrl` | 383 (62.5%)                       | 0.96                            | 285        | 325 MiB     | speed           |
| F: name lists and cue words, no model     | 420 (68.6%)                       | 4.98                            | 1          | 30 MiB      | false positives |
| A and F together                          | 468 (76.4%)                       | 5.67                            | 417        | 245 MiB     | both            |
| **B and F together**                      | **501 (81.8%)**                   | **5.85**                        | **286**    | **325 MiB** | **both**        |
| D: GLiNER (`gliner_multi_pii-v1`)         | port unverified, results excluded |                                 |            |             |                 |
| E: the local LLM (`qwen3:4b-instruct`)    | did not complete                  |                                 |            |             | speed           |

D is excluded because our port of it reproduced none of the six entities
in the example on the model's own card, so its numbers would describe our
code, not the model. E stopped after 92 of 612 messages on an error inside
Ollama; no number is published from a partial run in a fixed order, and E
could not have been on by default anyway (one request takes seconds).

**Decision, by the rule as written:** no candidate meets all three
limits, so the one with the highest recall, B and F together (81.8%), is
what Phase 6 builds, **off by default** behind `PSEUDONYM_NAMES`. It
fails the false-positive limit by 5.85 times (about one wrongly redacted
word in every 170) and the speed limit. Names in all lower case are
almost never found (3 of 59). Until Phase 6 is built, names are not
detected. The request path is wired and tested against a stand-in for
the model ([ADR-037](docs/decisions.md#adr-037)): with names on, every
request's names are found before anything is sent, and a request whose
names cannot be found (the model failed, timed out, is busy or has
crashed) gets a 503 and is never sent without them. Until the model is
built in, `PSEUDONYM_NAMES=true` refuses to start. How the model runtime, the model file and the name list will
reach a machine, and what the held-out figure depends on, is
[ADR-036](docs/decisions.md#adr-036).

**Observed after the measurement, not before:** B alone meets both
accuracy requirements (62.5% of names, 0.96 false positives per 1,000
words) and fails only the speed limit. In absolute terms it adds about
138 ms to a 1 KiB request and 1.1 s to a 4 KiB one, while the local demo
model itself takes 15.8 s and 66.9 s to its first token on the same
machine (a hosted model is usually much faster, so there the share would
be larger). A future revision that set an absolute added-latency budget
instead of a flat rate per KiB would likely allow B on by default. The
rule was not changed after seeing this.

## Unsupported input

Pseudonym handles text chat messages (system, user and assistant roles),
streamed or not. Everything else is **rejected with a 4xx error**, never
forwarded unredacted ([ADR-014](docs/decisions.md#adr-014)):

- a message `name` (names cannot be redacted until Phase 6);
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
the script). These figures are computed from Ollama's chunk format, and a
recorded stream from Ollama 0.35.0 matches them: 516,575 bytes in 2,335
events, 2,332 of them tokens, about 221 bytes per token
([ADR-020](docs/decisions.md#adr-020)).

## Threat model (summary)

**Protects against:** the AI provider seeing detected personal values, and
provider-side logging or training on them.

**Does not protect against:** values the detectors miss (today that includes
every person's name, an IFSC code with an unknown bank code and no keyword nearby, any secret with neither a known format
nor a keyword directly before it, a UPI ID at an unknown handle with no
keyword nearby, a passport number, voter ID or date of birth with no
keyword nearby, an IP address inside a host name, the part of an email
address before a `/`, `=` or `?` in its local part, numbers written as
words or with letters for digits, postal addresses and vehicle numbers);
anything your application
logs before
calling Pseudonym; a compromised Pseudonym host; prompt injection that
manipulates answers (only the URL-exfiltration path is mitigated).

**Inside Pseudonym:** the mapping from placeholders back to real values
exists only in memory for one request, and is never logged, stored or put in
an error. It is not encrypted (the key would sit in the same process), and
JavaScript strings cannot be reliably wiped, so someone who can read the
process's memory can read values ([ADR-012](docs/decisions.md#adr-012)). In production (`NODE_ENV=production`)
Pseudonym refuses to start if the debugger, heap snapshots or diagnostic
reports could be switched on, or, on Linux, if core dumps are enabled or
`--disable-sigusr1` is missing. It cannot stop a host that pipes core dumps
to a handler (the kernel then ignores the limit; Pseudonym warns), and it can
verify none of this on Windows or macOS. Production means Linux
([ADR-016](docs/decisions.md#adr-016)).

Logs contain the method, route, status and timing of each request, never a
body, a URL or an error message.

The full threat model will be documented as the project matures.

## Running locally

Requires Node.js 22.20+ and, to actually talk to a model,
[Ollama](https://ollama.com) with a model pulled. The demo model, a 4B
instruct model that runs on a CPU, is
`ollama pull qwen3:4b-instruct-2507-q4_K_M` (already set in
`.env.example`). The tests do not need Ollama.

```bash
npm install
npm test               # run the test suite (the timing tests last)
npm run test:coverage  # coverage, without the timing tests
npm run test:timing    # only the timing tests
npm run lint           # lint
npm run typecheck      # type-check

cp .env.example .env    # PSEUDONYM_MODEL is the demo model; change it to use another
npm run dev             # gateway on http://127.0.0.1:3000/v1
```

The timing tests check that detection and restoration take linear time:
each times the same work on an input and on one four times as long, and
fails if the time grows 8 times or more (linear code grows about 4
times, quadratic about 16). They run after the other tests, at most three
files at a time (one in CI), and they need the machine mostly to themselves. Measured
on 2026-10-02: run alongside two other test suites, they failed 5 ratio
checks and timed out 6 times in two runs (178 checks); on their own, one
or three files at a time, they passed all 890 checks in 10 runs. A failure
prints its input sizes and every run's time
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

## Continuous integration

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs on every push and
pull request, on GitHub's `ubuntu-latest` with the Node version in `.nvmrc`
and read-only permissions. One job, one step after another: `npm ci`,
typecheck, lint, format check, the tests with coverage (the run fails below
100% of lines, branches, functions and statements in `src` and `eval`), the
timing tests as their own step, then `npm run eval`, which fails if any
count moves from `eval/baseline.json` or the README's results block is out
of date. The timing tests run one file at a time there: the three at a time
used locally was measured on 12 cores, and the runner has 4
([ADR-032](docs/decisions.md#adr-032)).

Not covered by CI:

- **The model measurement** (`scripts/measure-rewrites.ts`, the table
  under [What a real model does with placeholders](#what-a-real-model-does-with-placeholders))
  needs Ollama and a model, so it is run by hand; CI only checks that the
  README's table matches `eval/model-rewrites.json`.
- **Recording a new Ollama stream** (`scripts/record-ollama-stream.ts`) needs
  Ollama too; CI replays the recorded fixture.
- **No real provider is called.** Every test talks to a mock or a recording.
- **Mutation checks** (`scripts/mutate.ts`), which show that the tests can
  fail, are run by hand.
- **One platform and one Node version**: Linux with Node 22.23.3, not
  Windows or macOS, and not the oldest version `engines` allows (22.20).
- **Docker** does not exist yet (Phase 8).

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

## Tech stack

TypeScript (strict) · Node.js 22 · Fastify (with its Pino logger) · Zod ·
libphonenumber-js (phone validation) · Vitest · fast-check · ESLint · Prettier.
The provider is called with Node's built-in `fetch`.

## License

[MIT](LICENSE)

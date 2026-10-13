# Measured results: notes

The commentary that sat around the README's
[Measured results](../README.md#measured-results), moved here from the
README on 2026-10-14 so that the README stays short. The tables stay in
the README; the generated block there is rewritten by `npm run eval` and
checked on every push, while the notes below are dated observations that
nothing re-checks. The text is the README's as it stood then; only its
links, and a word where "above" or "below" no longer pointed at the right
thing, were changed.

## The PERSON rows, and the shape block row by row

PERSON is measured here with names off, the default build, so its rows
read 0; it was labelled from the start so that the "before" is on record.
With names on, see
[Choosing a person-name detector](../README.md#choosing-a-person-name-detector-phase-6a).
The main cases' 153 names come from a
short list in sentences that say a name follows; the shape block's `names`
row is the harder set Phase 6 is measured on: 612 names paired at random
from Wikidata's given and family names (CC0), Indian by region and
international, in Latin script and Devanagari, written in full, as a given
name alone, with initials, with an honorific, in lower case or capitals,
in a greeting, a sign-off, a form field or the middle of a sentence,
beside words that are not names (months, places, companies, festivals,
words that are also names, code identifiers). With names off, 0 of them
are redacted; with names on, 501 are found (2026-10-03). Passport numbers, voter IDs and dates of birth were measured the
same way before their detectors: the shape block's `short-id` row went
from 1 of 459 redacted to 305 when their detectors were added on
2026-10-02 (passport
93, voter ID 103, date of birth 108 of 153 each with the right type, and
one date of birth read as a phone number). The rest of this paragraph
describes the block below (measured 2026-10-06). The `short-id` row's misses are values in
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

("The block below" is the README's generated block, measured on the date
it states.)

## Over-redactions, and the held-out set's keyword-only rows

The PHONE and NUMBER rows over-redact on purpose: a 10-digit tracking number
or timestamp is a valid phone number as far as any check can tell, and the
safety net takes every number of 9 or more digits. For the generated
dataset `npm run eval` also prints which kinds of lookalike were redacted.
The held-out set labels no passport number, voter ID or date of birth, so
its PASSPORT, VOTER and DOB rows only count detections: one PASSPORT and
one VOTER detection on values labelled as another type, and one date in
plain text read as a date of birth. In the run that added those three
detectors (2026-10-02), its NUMBER row's redacted count rose from 3 to 5.

## The echo table

The echo table is the cost of restoration safety in the best case, a model
that repeats every placeholder exactly. In the block above (2026-10-06), in the generated main cases 7 of
1,667 placeholders stay placeholders, all IP addresses inside a
`http://…/login` URL. The `in-markup` shape puts one value in each of ten
places in a URL, a markdown link or an HTML tag: 72 of its 98 stay
placeholders, which is the rule doing its job, and the 26 restored are
link texts and table cells (18) and lookalikes in filler sentences (8).
The first measurement (2026-10-02) found 6 more restored: emails in a plain URL's query
or path, which the email detection took together with the URL's host and
path (`https:[EMAIL_1]`), so the URL rule saw no URL. An address's local
part now stops at `/`, `=` and `?` (see the email gap in
[Known gaps](detection.md#known-gaps)). In the other
shapes, 9 placeholders stay because of Pseudonym's own bracket: digits
joined by a bracket (`1234567890(12345`) become `[NUMBER_1]([NUMBER_2]`,
and the `](` reads as a link target. The rules added for streaming (an
unclosed `<` or `="`, the host rule) hold nothing back in the generated
set, which has no such text. Every message comes back exactly with the
rules switched off. A model that rewrites or drops placeholders is a
separate measurement ([ADR-033](decisions.md#adr-033)).

("The block above" is the README's generated block.)

## Known costs of restoration safety

**Known costs of restoration safety** (values the user sees as
placeholders, not as the real value): any placeholder inside a URL, a
markdown link or image target, after `[label]:`, or in a quoted HTML
attribute value, by design; the second placeholder of `[NUMBER_1]([NUMBER_2]`,
because Pseudonym's own bracket followed by `(` reads as a link target; and
**code that assigns a quoted string**: a quoted value after `=` is treated
as an HTML attribute, so `API_KEY = "[SECRET_1]"` stays unrestored. The
echo table cannot show that last one, because neither dataset
contains code; the README's
[model measurement](../README.md#what-a-real-model-does-with-placeholders)
found it (2 of 34 values in one
task) ([ADR-018](decisions.md#adr-018),
[ADR-033](decisions.md#adr-033)).

## How the held-out set was made

How the held-out set was made, stated exactly: it was drafted with AI
assistance in a separate session that did not write the detectors, then
reviewed by the author. It is blind (no case was run against
the detectors before the set was committed) and it is never used for tuning:
whoever works on the detectors does not read the file, and the evaluation
prints counts per data type, never a case's text, so a detector cannot be
adjusted to a case it missed. It is small, so one value moves a row by
several points. Its format is described in
[eval/HELD-OUT-FORMAT.md](../eval/HELD-OUT-FORMAT.md). That format cannot yet
express some things people really write: numbers spelled out in words, letters
standing in for digits in scanned text (O for 0, l for 1), postal addresses
and vehicle numbers. None of those is measured, and none is detected
([ADR-021](decisions.md#adr-021)).

## Thinking models

Thinking models are not the demo model. On `qwen3:4b` (a thinking model)
one answer took 13.4 minutes on the same CPU, `reasoning_effort: "none"`
put its reasoning into the answer itself (ending with a stray
`</think>`), and its reasoning once wrote `[EMAIL_:1]`, a form
restoration does not read.

("The same CPU" is the one the README's
[model measurement](../README.md#what-a-real-model-does-with-placeholders)
ran on, 2026-10-02.)

## The person-name comparison

Both rows were measured on the Intel Core i5-12450H. The generated row is
reproduced exactly on machines without AVX-512, and differs by one extra
correct name, identically, on machines with it (502/612, 662/934),
whatever the CPU model's name; the held-out row is not re-run on any other
CPU ([Person names](../README.md#person-names)).

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
configuration the gateway now runs with names on. `npm run eval` measures
the default build, names off, so the evaluation tables above still show
PERSON at 0; `npm run eval:names` sends the 1,998 generated messages
through the gateway with names on and reproduces the generated row above
exactly, down to the SHA-256 of every span
([ADR-036](decisions.md#adr-036), step 4b).

D is excluded because our port of it reproduced none of the six entities
in the example on the model's own card, so its numbers would describe our
code, not the model. E stopped after 92 of 612 messages on an error inside
Ollama; no number is published from a partial run in a fixed order, and E
could not have been on by default anyway (one request takes seconds).

**Observed after the measurement, not before:** B alone meets both
accuracy requirements (62.5% of names, 0.96 false positives per 1,000
words) and fails only the speed limit. In absolute terms it adds about
138 ms to a 1 KiB request and 1.1 s to a 4 KiB one, while the local demo
model itself takes 15.8 s and 66.9 s to its first token on the same
machine (a hosted model is usually much faster, so there the share would
be larger). A future revision that set an absolute added-latency budget
instead of a flat rate per KiB would likely allow B on by default. The
rule was not changed after seeing this.

("Both rows", "the generated row" and "the tables above" are the README's
[Choosing a person-name detector](../README.md#choosing-a-person-name-detector-phase-6a)
tables and its generated block.)

## Why the stream limit is 32 MiB

The stream limit is larger because it counts
bytes on the wire, and every streamed token, a thinking model's reasoning
tokens included, arrives in its own chunk of about 200 to 250 bytes. 32 MiB
is about 130,000 to 160,000 tokens: room for a 32,768-token answer after as
many reasoning tokens (13.4 to 16.3 MiB, depending on the model name and
the script). These figures are computed from Ollama's chunk format
(2026-09-30), and a stream recorded from Ollama 0.35.0 on 2026-10-02
matches them: 516,575 bytes in 2,335
events, 2,332 of them tokens, about 221 bytes per token
([ADR-020](decisions.md#adr-020)).

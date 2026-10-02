# Writing the held-out set

`eval/held-out.txt` is a set of messages written to catch Pseudonym's
detectors out: awkward formats, near-misses and traps. It is the second of
the two datasets the evaluation reports.

Three rules make its numbers worth publishing:

1. **It is written apart from the detectors, and blind.** The set was
   drafted with AI assistance in a separate session that did not write the
   detectors, then reviewed by the author. No case was run
   against the detectors before the set was committed.
2. **It is written before the detectors it will test,** and committed first.
3. **It is never used for tuning.** The detectors' author does not read this
   file; the tools print case ids, line numbers, rule names and counts only.
   If a case ever leads to a detector change, it is moved out of the set and
   the README says how many were.

And one rule from the rest of the repo: **no real personal data, and nothing
that looks like it.** You never type an Aadhaar, card, PAN or phone number.
You write a _slot_, and the value is generated in memory each time the
evaluation runs.

## The file

```
%% A line starting with %% is a comment.

=== H001 | line-break, aadhaar
@user
Sir my aadhaar no is {{AADHAAR:#### ####
####}} please update it
@assistant
Noted, I have updated it.

=== H002 | lookalike
@user
Order {{NOT:ORD-######}} has not arrived. No personal details here.
```

- A case starts with `=== ID | tag, tag`. The id is letters, digits and
  hyphens and must be unique. Give every case at least one tag (lower-case
  letters, digits, hyphens): tags are how results can be grouped later.
- A message starts with a line that is exactly `@user`, `@assistant` or
  `@system`, and runs until the next such line or the next case. Blank lines
  at its start and end are dropped; everything else is kept as typed,
  line breaks and leading spaces included.
- A case may have several messages: they are one conversation.
- Limits: a message line cannot start with `===` or `%%`, and you cannot
  write a literal `{{`.

## Slots

Everything **outside** a slot is labelled "not personal". A slot says "a
value is here", and whether it is personal.

| You write                                                                                     | What appears in the message                                                                                                              | Counts as        |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `{{AADHAAR}}`                                                                                 | a valid 12-digit Aadhaar                                                                                                                 | personal         |
| `{{CARD}}`, `{{CARD.amex}}`, `{{CARD=4111 1111 1111 1111}}`                                   | a valid 16-digit card number, a 15-digit Amex, or a published test card you typed                                                        | personal         |
| `{{PAN}}`                                                                                     | a valid PAN                                                                                                                              | personal         |
| `{{PHONE}}`, `{{PHONE=+44 7700 900123}}`                                                      | a 10-digit Indian mobile, or a number you typed from a range reserved for fiction                                                        | personal         |
| `{{NUMBER:#########}}`                                                                        | digits you lay out with a mask: a bank account, a customer number, any personal number with no type of its own                           | personal         |
| `{{EMAIL}}`, `{{EMAIL=priya@example.com}}`                                                    | an address at a reserved domain, generated or typed                                                                                      | personal         |
| `{{UPI}}`, `{{UPI.mobile}}`, `{{UPI.unknown}}`                                                | a UPI ID: a name at a known handle, a mobile number at a known handle, a name at a handle nobody has heard of                            | personal         |
| `{{IFSC}}`, `{{IFSC.unknown}}`, `{{IFSC=SBIN0001234}}`                                        | an IFSC with a large bank's code, with a made-up bank code, or one you typed (branch codes are public)                                   | personal         |
| `{{SECRET.kind}}`                                                                             | a key or password. Kinds: `openai`, `anthropic`, `github`, `aws`, `stripe`, `razorpay`, `slack`, `google`, `jwt`, `password`, `token`    | personal         |
| `{{IP=203.0.113.7}}`                                                                          | what you typed (see "What you may type")                                                                                                 | personal         |
| `{{PERSON=Priya Sharma}}`                                                                     | what you typed                                                                                                                           | personal         |
| `{{PASSPORT}}`, `{{VOTER}}`, `{{DOB}}`                                                        | an Indian passport number (a letter, 7 digits), a voter ID (3 letters, 7 digits), a date of birth in one of five common forms            | personal         |
| `{{EMAIL.pan}}`, `{{EMAIL.ifsc}}`, `{{EMAIL.mobile}}`                                         | an email address whose local part starts with a PAN, an IFSC or a mobile, then a dot and a name                                          | personal         |
| `{{SECRET.ifsc-tail}}`, `{{SECRET.ip-tail}}`, `{{SECRET.mobile-tail}}`, `{{UPI.mobile-name}}` | a key made of an IFSC or IP address and `-x7`; three letters, a hyphen and a mobile; a mobile, a dot and a name at an unknown UPI handle | personal         |
| `{{NOT:ORD-######}}`, `{{NOT=10.0.0.1}}`                                                      | a generated or typed lookalike                                                                                                           | **not** personal |

Label a value by what it **is**, not by what you expect Pseudonym to do with
it. A customer's Aadhaar with a typo is still personal. An order number that
happens to have 12 digits is not. If Pseudonym redacts something labelled
`NOT`, or anything outside a slot, that counts against it as over-redaction;
if it misses any character of a personal value, that counts as a miss.

### Masks: how a value is laid out

After a colon comes a mask. Each `#` takes the next character of the value;
everything else is copied as typed, line breaks included.

```
{{AADHAAR:#### #### ####}}          {{CARD:####-####-####-####}}
{{PHONE:+91 (#####) #####}}         {{PAN:##### #### #}}
{{AADHAAR:####
####
####}}
```

- A mask must place the whole value: 12 `#` for an Aadhaar, 16 for a card
  (15 for `CARD.amex`), 10 for a PAN or a phone number, 11 for an IFSC.
- Text in the mask that is not `#` (such as `+91`) is not part of the value:
  it does not have to be redacted.
- `NUMBER` and `NOT` have no fixed length: they produce as many characters
  as the mask has marks. In a `NOT` mask, `?` is a random capital letter
  (`{{NOT:?????####?}}` is a PAN-shaped product code).
- `EMAIL`, `UPI` and `SECRET` are generated whole and take no mask.

### A typo: `!`

`{{AADHAAR!}}`, `{{CARD!:#### #### #### ####}}`, `{{PAN!}}` give the right
shape with a failed check (a wrong check digit; for PAN, an impossible fourth
letter). Still personal.

### One value in several pieces: `@name`

Name a value, place part of it, and continue it later in the same case, in
the same message or a later one:

```
@user
my card is {{CARD@c:#### ####}}
@user
sorry, got cut off: {{@c:#### ####}}
```

The pieces must add up to the whole value. It counts as redacted only if
every piece is. Works for AADHAAR, CARD, PAN, PHONE, IFSC and NUMBER.

### Modifiers: `|`

Written after the type (and after `!` or `@name`), before the mask:

| Modifier                                                                        | Effect                                                                                               |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `devanagari`, `bengali`, `gujarati`, `tamil`, `arabic`, `fullwidth`, `mathbold` | the slot's digits are written in that script                                                         |
| `invisible`                                                                     | invisible characters (zero-width space, soft hyphen, direction marks…) between the slot's characters |
| `lower`, `upper`                                                                | the slot's letters in that case                                                                      |

`{{AADHAAR|devanagari:#### #### ####}}`, `{{PAN|lower}}`,
`{{PHONE|invisible|fullwidth:+91 ##########}}`.

### Labels for lookalikes

`NOT` may carry a label of your choice after a dot: `{{NOT.order:…}}`,
`{{NOT.tracking:…}}`. It changes nothing in the text; it lets the report say
which kinds of lookalike were over-redacted. For this file the report only
does so when you ask (`npx tsx eval/run.ts --by-tag`, which also gives
results per tag): labels and tags are your words, and the ordinary run
prints none of them.

## What you may type

Anything typed is checked by `npm run eval:lint`. The check is about safety
only, and is written without the detectors: it tells you nothing about what
Pseudonym would find.

| Rule                                         | What it rejects                                                                                                                                              | What to write instead                                                                                                                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typed-digits`                               | more than 8 typed digits in one stretch, in any script, counting across spaces, dots, hyphens, dashes, brackets and `+` (up to three of them between groups) | generate it: `{{NOT:######-####}}`, `{{NUMBER:…}}`. To keep most of a typed number, break it with a `#`: `{{NOT:2026-09-2# 14:30}}`                                                                                                                            |
| `typed-pan`                                  | a PAN-shaped code (5 letters, 4 digits, 1 letter)                                                                                                            | `{{PAN}}` or `{{NOT:?????####?}}`                                                                                                                                                                                                                              |
| `typed-id`                                   | a code shaped like a passport or voter ID number (1 or 3 letters, then 7 digits)                                                                             | `{{PASSPORT}}`, `{{VOTER}}` or `{{NOT:?#######}}`                                                                                                                                                                                                              |
| `address-outside-slot`                       | anything with an `@` between two characters, outside a slot                                                                                                  | `{{EMAIL=…}}`, `{{EMAIL}}`, `{{UPI}}`, or `{{NOT=noreply@example.com}}`                                                                                                                                                                                        |
| `email-not-reserved`, `address-not-reserved` | a typed address whose domain is not reserved                                                                                                                 | use `example.com`, `example.org`, `example.net`, anything with the label `example`, or a name ending in `.test`, `.invalid` or `.localhost`. `{{EMAIL=priya at example dot com}}` passes too                                                                   |
| `ip-not-reserved`                            | a typed `{{IP=…}}` outside the documentation, private, loopback and link-local ranges and those no single host owns                                          | `192.0.2.x`, `198.51.100.x`, `203.0.113.x`, `2001:db8::…`, `10.x`, `172.16–31.x`, `192.168.x`, `127.x`, `169.254.x`, `::1`, `fe80::…`, `fc00::/7`; `0.x`, `224–255.x` (multicast, netmasks), `::`, `ff00::/8`; any of these IPv4 addresses as `::ffff:a.b.c.d` |
| `card-not-published`                         | a typed `{{CARD=…}}` that is not a published test card                                                                                                       | one from `test/fixtures/published-test-cards.ts`, in any layout: `{{CARD=4111 1111 1111 1111}}`                                                                                                                                                                |
| `phone-not-fictional`                        | a typed `{{PHONE=…}}` outside the ranges reserved for fiction                                                                                                | US/Canada `+1 xxx 555 01xx`; UK `07700 900xxx`, `020 7946 0xxx`, `0113 496 0xxx`; Australia `0491 570 xxx`                                                                                                                                                     |
| `bad-name`                                   | a `{{PERSON=…}}` with a digit or an `@`                                                                                                                      | a name                                                                                                                                                                                                                                                         |
| `typed-secret`                               | a typed string that starts like a key or token (`sk-…`, `ghp_…`, `AKIA…`, `eyJ…`, `-----BEGIN`…)                                                             | `{{SECRET.kind}}`. A key-shaped string in a public repo can also get a push blocked                                                                                                                                                                            |

A full IP address has more than 8 digits, so it always goes in a slot:
`{{IP=…}}` if you mean it as someone's address, `{{NOT=…}}` if not (a
private or loopback address, say). Short dotted numbers such as `10.0.0.1`
or a version such as `v2.0.1.4` may simply be typed; outside a slot they
count as not personal.

The other rules are about the slots themselves (`bad-slot`,
`unknown-variant`, `too-few-marks`, `too-many-marks`, `unfinished-value`,
`unknown-name`, `mask-required`, `literal-required`…). Each message says
what is expected.

## Not expressible yet

Four things people really write cannot be written as cases in this
format. They stay documented gaps: none is measured by either dataset, and
none is detected (README, known gaps).

| What                           | Example of the shape                                              | Why the format cannot express it                                                                                           |
| ------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Numbers written as words       | "nine eight seven six…", "nau aath saat…"                         | a slot generates digits; no modifier spells them out, and a typed spelled-out number could be anybody's                    |
| Letters standing in for digits | O for 0, l for 1, S for 5, B for 8, as in scanned or retyped text | masks place the value's own characters; no modifier swaps a digit for a letter, and typing one would mean typing the value |
| Postal addresses               | flat, street, locality, PIN code                                  | there is no address type and no generator, and the lint cannot tell a typed address is fictional                           |
| Vehicle registration numbers   | a state code, a district number, letters and four digits          | there is no vehicle type and no generator, and a typed one could be a real registration                                    |

Adding any of them means a new slot type or modifier, with a generator
and a lint rule, first. A probe outside the datasets (2026-10-02, generated
values, one digit written as a letter) found such values never recognised
as their type, and redacted whole only when 9 or more digits are left in
one stretch, by the safety net: 208 of 494 Aadhaar numbers, 403 of 500
card numbers, 0 of 489 mobiles.

## Checking your work

```powershell
npm run eval:lint                          # problems by case, line and rule; then counts
npx tsx eval/check-held-out.ts --tags      # the same, plus how many cases carry each tag
npx tsx eval/check-held-out.ts --show H001 # how one case renders, values shown as •
```

`--tags` and `--show` print what you wrote (tag names, a case's text), so
they are for you: whoever works on the detectors does not run them. The
flags are given to `tsx` directly because PowerShell drops the `--` that
`npm run eval:lint -- --show H001` needs, and npm then keeps the flag for
itself.

## Suggested tags

The categories below are a starting list, names only. Cases that fit none of
them are the most valuable ones.

`separators`, `line-break`, `split-message`, `other-scripts`, `invisible`,
`glued`, `typo`, `hindi`, `hinglish`, `adjacent-values`, `in-url`,
`in-markup`, `lookalike`, `placeholder-shaped`, `email-forms`, `upi`, `ifsc`,
`ip`, `secret`, `person`, `nothing-personal`.

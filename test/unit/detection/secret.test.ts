// Secrets (ADR-022): known key formats and keyword assignments.
//
// No key-shaped string is written in this file. Every key is put together
// at run time from its prefix and a filler, so the file holds nothing that
// secret scanning (or a reader) could take for a real credential. Passwords
// here are made up and obviously so. Generated secrets stay in memory and
// are compared as offsets or booleans (ADR-009).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { detect } from '../../../src/detection/detect.js';
import { MIN_SECRET_LOOKING_LENGTH, secretCandidates } from '../../../src/detection/secret.js';
import { secret, type SecretKind } from '../../../src/synthetic/identifiers.js';
import { createRng } from '../../../src/synthetic/rng.js';
import { indianMobile } from '../../../src/synthetic/values.js';
import { compose } from '../../support/compose.js';
import { growthRatio, MAX_GROWTH_RATIO } from '../../support/linear-time.js';
import { assertPropertyQuietly, seedArb } from '../../support/quiet-property.js';

/** `n` characters of filler: letters in both cases and digits, no long digit stretch. */
const filler = (n: number, alphabet = 'aB3dE5fGh'): string =>
  alphabet.repeat(Math.ceil(n / alphabet.length)).slice(0, n);
const digits = (n: number): string => filler(n, '1234567890');

const known = (span: { start: number; end: number }) => ({
  type: 'SECRET',
  ...span,
  validated: true,
  context: false,
});
const assigned = (span: { start: number; end: number }) => ({
  type: 'SECRET',
  ...span,
  validated: false,
  context: true,
});

const PEM_BEGIN = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
const PEM_END = ['-----END', 'RSA PRIVATE KEY-----'].join(' ');

describe('secrets: known formats', () => {
  it.each([
    ['an OpenAI key', 'sk-', filler(48)],
    ['an OpenAI project key', 'sk-proj-', filler(120, 'aB3_dE-5f')],
    ['an Anthropic key', 'sk-ant-api03-', filler(95, 'aB3_dE-5f')],
    ['a GitHub personal access token', 'ghp_', filler(36)],
    ['a GitHub OAuth token', 'gho_', filler(36)],
    ['a GitHub user-to-server token', 'ghu_', filler(36)],
    ['a GitHub server-to-server token', 'ghs_', filler(36)],
    ['a GitHub refresh token', 'ghr_', filler(36)],
    ['a fine-grained GitHub token', 'github_pat_', filler(82, 'aB3_dE5')],
    ['a GitLab token', 'glpat-', filler(20, 'aB3_dE-5f')],
    ['an AWS access key ID', 'AKIA', filler(16, 'AB3DE5')],
    ['a temporary AWS access key ID', 'ASIA', filler(16, 'AB3DE5')],
    ['a Stripe live key', 'sk_live_', filler(24)],
    ['a Stripe test key', 'sk_test_', filler(24)],
    ['a Stripe restricted key', 'rk_live_', filler(24)],
    ['a Stripe webhook secret', 'whsec_', filler(32)],
    ['a Razorpay live key', 'rzp_live_', filler(14)],
    ['a Razorpay test key', 'rzp_test_', filler(14)],
    ['a Slack bot token', 'xoxb-', `${digits(12)}-${digits(13)}-${filler(24)}`],
    ['a Slack user token', 'xoxp-', `${digits(12)}-${digits(12)}-${filler(32)}`],
    ['a Slack app token', 'xapp-', `1-A${digits(10)}-${digits(13)}-${filler(64, 'a1b2c3')}`],
    ['a Google API key', 'AIza', filler(35, 'aB3_dE-5f')],
    ['an npm token', 'npm_', filler(36)],
    ['a Hugging Face token', 'hf_', filler(34, 'aBcDeFg')],
    ['a JSON Web Token', 'eyJ', `${filler(20)}.eyJ${filler(60)}.${filler(43, 'aB3_dE-5f')}`],
  ])('finds %s, whole and validated', (_name, prefix, rest) => {
    const { text, spans } = compose`Here it is: ${prefix + rest}, thanks`;
    expect(detect(text)).toEqual([known(spans[0]!)]);
  });

  it('takes a key longer than its format whole (fail closed)', () => {
    for (const key of [
      `ghp_${filler(50)}`,
      `AKIA${filler(30, 'AB3DE5')}`,
      `rzp_live_${filler(40)}`,
      `sk-${filler(50_000)}`,
    ]) {
      const { text, spans } = compose`key ${key} end`;
      expect(detect(text)).toEqual([known(spans[0]!)]);
    }
  });

  it.each([
    ['a GitHub prefix with 35 characters', `ghp_${filler(35)}`],
    ['an AWS prefix with 15 characters', `AKIA${filler(15, 'ABCDEF')}`],
    ['sk- with 19 characters', `sk-${filler(19)}`],
    ['a Razorpay prefix with 13 characters', `rzp_live_${filler(13)}`],
    ['a Google prefix with 34 characters', `AIza${filler(34)}`],
    ['a Stripe publishable key (public by design)', `pk_live_${filler(24)}`],
    ['a prefix in the wrong case', `GHP_${filler(36)}`],
  ])('does not take %s for a known format', (_name, token) => {
    expect(detect(`see ${token} now`)).toEqual([]);
  });

  it('sk- needs a digit or a capital: a hyphenated phrase is not a key', () => {
    expect(detect('we use an sk-learn-based-text-classification-pipeline here')).toEqual([]);
    const { text, spans } = compose`key ${`sk-${filler(30, 'abcdefg')}X`} end`;
    expect(detect(text)).toEqual([known(spans[0]!)]);
  });

  it.each(['x', 'é', '9', '_'])('is not a key when glued after %j', (glue) => {
    expect(detect(`see ${glue}ghp_${filler(36, 'aBcDeFg')} now`)).toEqual([]);
    expect(detect(`see ${glue}sk-${filler(48, 'aBcDeFg')} now`)).toEqual([]);
  });

  it.each(['"', "'", '=', ':', '(', '-', '/', '`'])('is a key right after %j', (before) => {
    const { text, spans } = compose`x${before}${`ghp_${filler(36)}`} y`;
    expect(detect(text)).toEqual([known(spans[1]!)]);
  });

  describe('JSON Web Tokens', () => {
    const header = `eyJ${filler(20)}`;
    const payload = `eyJ${filler(60)}`;

    it('takes header and payload with no signature, and an empty signature', () => {
      const unsigned = compose`jwt ${`${header}.${payload}`} end`;
      expect(detect(unsigned.text)).toEqual([known(unsigned.spans[0]!)]);
      const empty = compose`jwt ${`${header}.${payload}.`} end`;
      expect(detect(empty.text)).toEqual([known(empty.spans[0]!)]);
    });

    it('needs two parts that both start with eyJ', () => {
      expect(detect(`jwt ${header} end`)).toEqual([]);
      expect(detect(`jwt ${header}.${filler(60)} end`)).toEqual([]);
      expect(detect(`jwt eyJab.eyJcd end`)).toEqual([]);
    });

    it('starts after a hyphen (ADR-029: <value>-eyJ…), never after a dot', () => {
      const { text, spans } = compose`jwt x-${`${header}.${payload}`} end`;
      expect(detect(text)).toEqual([known(spans[0]!)]);
      expect(detect(`jwt x.${header}.${payload} end`)).toEqual([]);
    });
  });

  describe('PEM private keys', () => {
    const block = `${PEM_BEGIN}\n${filler(64)}\n${filler(64)}\n${PEM_END}`;

    it('takes the whole block, BEGIN line to END line', () => {
      const { text, spans } = compose`My key:\n${block}\nplease check`;
      expect(detect(text)).toEqual([known(spans[0]!)]);
    });

    it.each(['', ' RSA', ' EC', ' OPENSSH', ' ENCRYPTED', ' PGP'])('with the label%j', (label) => {
      const suffix = label === ' PGP' ? ' BLOCK' : '';
      const begin = ['-----BEGIN', `${label.trim()} PRIVATE KEY${suffix}-----`.trim()].join(' ');
      const end = ['-----END', `${label.trim()} PRIVATE KEY${suffix}-----`.trim()].join(' ');
      const { text, spans } = compose`x ${`${begin}\n${filler(64)}\n${end}`} y`;
      expect(detect(text)).toEqual([known(spans[0]!)]);
    });

    it('with no END line, takes everything to the end of the text (fail closed)', () => {
      const { text, spans } = compose`My key:\n${`${PEM_BEGIN}\n${filler(64)}\nand more text`}`;
      expect(detect(text)).toEqual([known(spans[0]!)]);
    });

    it('leaves a public key and a certificate alone', () => {
      const publicKey = ['-----BEGIN', 'PUBLIC KEY-----'].join(' ');
      const certificate = ['-----BEGIN', 'CERTIFICATE-----'].join(' ');
      expect(detect(`${publicKey}\n${filler(64, 'aBcDeFg')}\n`)).toEqual([]);
      expect(detect(`${certificate}\n${filler(64, 'aBcDeFg')}\n`)).toEqual([]);
    });
  });

  it('finds a key written in full-width characters, and covers it in the original text', () => {
    const fullWidth = (s: string): string =>
      s.replace(/[!-~]/g, (ch) => String.fromCodePoint(ch.codePointAt(0)! - 0x21 + 0xff01));
    const { text, spans } = compose`key ${fullWidth(`ghp_${filler(36)}`)} end`;
    expect(detect(text)).toEqual([known(spans[0]!)]);
  });

  it('finds a key split by invisible characters', () => {
    const key = `ghp_${filler(36)}`;
    const split = `${key.slice(0, 2)}\u200B${key.slice(2, 20)}\u00AD${key.slice(20)}`;
    const { text, spans } = compose`key ${split} end`;
    expect(detect(text)).toEqual([known(spans[0]!)]);
  });

  // The generator (src/synthetic/identifiers.ts) and this detector were
  // written separately (ADR-008); this is where they meet.
  const KNOWN_KINDS: readonly SecretKind[] = [
    'openai',
    'anthropic',
    'github',
    'aws',
    'stripe',
    'razorpay',
    'slack',
    'google',
    'jwt',
  ];
  it.each(KNOWN_KINDS)('finds every generated %s secret, exactly and as one detection', (kind) => {
    assertPropertyQuietly(
      fc.property(seedArb, (seed) => {
        const { text, spans } = compose`I pasted ${secret(createRng(seed), kind)} by mistake`;
        const found = detect(text);
        return (
          found.length === 1 &&
          found[0]!.type === 'SECRET' &&
          found[0]!.validated &&
          found[0]!.start === spans[0]!.start &&
          found[0]!.end === spans[0]!.end
        );
      }),
      { numRuns: 300 },
    );
  });
});

describe('secrets: keyword assignment', () => {
  const secrets = (text: string): unknown[] => detect(text).filter((d) => d.type === 'SECRET');

  it.each([
    ['a colon', 'password: ', 'Tr0ub4dor&3', ' and then I was locked out'],
    ['an equals sign (any value)', 'password=', 'sunshine', ' user=priya'],
    ['"is"', 'My password is ', 'Monsoon#2024', '.'],
    ['"was"', 'The old password was ', 'Monsoon#2023', ', I changed it'],
    ['"is" and a colon', 'The password is: ', 'Monsoon#2024', ' ok'],
    ['nothing in between (Hinglish)', 'Mera password ', 'Barsaat@77', ' hai.'],
    ['"hai" and a colon', 'Ye mera token hai: ', 'a1b2c3d4e5', ''],
    ['Hindi', 'मेरा पासवर्ड ', 'Barsaat@77', ' है।'],
    ['a Hindi keyword for a token', 'टोकन ', 'a1b2c3d4e5f6', ' काम नहीं कर रहा।'],
    ['"API key"', 'Here is my API key: ', 'zx81-qwerty-0099', ''],
    ['"api_key"', 'api_key=', 'a1b2c3', ''],
    ['"apikey"', 'apikey: ', 'a1b2c3d4', ' ok'],
    ['"api-key"', 'x-api-key: ', 'a1b2c3d4', ' ok'],
    ['"api secret"', 'API secret ', 'a1b2c3d4', ' ok'],
    ['a Bearer header', 'Authorization: Bearer ', 'abc123def456ghi789', ''],
    ['an environment variable', 'DB_PASSWORD=', 'hunter', '\nDB_USER=app'],
    ['a name the keyword list has whole', 'aws_secret_access_key = ', filler(40), ''],
    ['a name with a tail after the keyword', 'SECRET_KEY_BASE=', 'abc', '\nRAILS_ENV=test'],
    ['a name with a tail that ends in a digit', 'PASSWORD_2=', 'hunter', ''],
    ['a name with a hyphenated tail', 'token-id: ', 'a1b2c3d4', ' ok'],
    ['"client_secret"', 'client_secret: ', 'q9w8e7r6', ' ok'],
    ['"secret key"', 'secret key: ', 'k3y-m4t3rial', ' keep it safe'],
    ['"access key"', 'access key ', 'k3ymat3rial', ' ok'],
    ['"private key"', 'private key = ', 'abc', ' ok'],
    ['"auth token"', 'auth_token: ', 'a1b2c3d4', ' ok'],
    ['"pwd"', 'pwd: ', 'q1w2e3r4', ' ok'],
    ['"passwd"', 'passwd ', 'q1w2e3r4', ' ok'],
    ['"passphrase"', 'passphrase: ', 'q1w2e3r4', ' ok'],
    ['"passcode"', 'passcode is ', 'q1w2e3r4', ' ok'],
    ['upper case', 'PASSWORD: ', 'Q1W2E3R4', ' ok'],
    ['a spaced dash', 'Password - ', 'Monsoon#2024', ' (new)'],
    ['quotes after "is"', 'my password is "', 'sunshine', '" for now'],
    ['single quotes', "password '", 'sunshine', "' for now"],
    ['a JSON field', '{"user": "p", "password": "', 'sunshine', '", "remember": true}'],
    ['the last thing on its line, after a colon', 'Password: ', 'sunshine', '\nThanks'],
    ['the same with blanks before the line break', 'Password: ', 'sunshine', '  \t\nThanks'],
    ['the last thing in the text, after a colon', 'Password: ', 'sunshine', ''],
    ['the next line, after a colon', 'Password:\n', 'Monsoon#2024', ' is it'],
    ['the second keyword, when the first has no value', 'secret token: ', 'abc123xyz', ' ok'],
    ['a symbol and no digit', 'password is ', 'Monsoon#', ' ok'],
  ])('takes the value after %s', (_name, before, value, after) => {
    const { text, spans } = compose`${before}${value}${after}`;
    expect(secrets(text)).toEqual([assigned(spans[1]!)]);
  });

  it.each([
    ['an OTP', 'OTP ', '482913', ' aaya tha'],
    ['an OTP with "is"', 'The OTP is ', '482913', '.'],
    ['a PIN', 'my ATM PIN is ', '4821', ' and the card is blocked'],
    ['an mPIN', 'mPIN: ', '482913', ' ok'],
    ['a CVV', 'CVV ', '123', ' on the back'],
    ['a CVC', 'cvc=', '1234', ''],
    ['a passcode', 'passcode ', '482913', ' ok'],
    ['an OTP in Hindi', 'ओटीपी ', '482913', ' आया था'],
    ['a PIN in Hindi', 'पिन ', '4821', ' है'],
    ['a PIN in Devanagari digits', 'पिन ', '४८२१', ' है'],
  ])('takes the digits of %s', (_name, before, value, after) => {
    const { text, spans } = compose`${before}${value}${after}`;
    expect(secrets(text)).toEqual([assigned(spans[1]!)]);
  });

  // The other half: a credential word in an ordinary sentence. None of these
  // has a value, and nothing may be replaced in them.
  it.each([
    'My password is wrong.',
    'my password is not working since morning',
    'I forgot my password, please reset it',
    'Password reset link not received',
    'Please change the password for my account',
    'Password: I forgot it, please help',
    'Forgot password? Click the link below',
    'my password, which I changed yesterday',
    'Mera password galat hai',
    'पासवर्ड गलत है',
    'passwords are hard to remember',
    'The token expired yesterday',
    'token number 5 at the counter',
    'tokens: many',
    'The secret to good chai is patience',
    'secretary: Anita',
    'OTP nahi aaya',
    'OTP not received',
    'Enter the OTP within 10 minutes',
    'The OTP is valid for 5 minutes',
    'PIN code 560001',
    'pin the message please',
    'in my opinion: fine',
    'CVV 3 digits on the back',
    'the api key was revoked',
    'API key rotation policy',
    'Bearer of bad news',
    'password123',
    'pin1234',
    'password',
    'password: ',
    'password = ',
    'password: "',
  ])('finds no secret in %j', (text) => {
    expect(secrets(text)).toEqual([]);
  });

  // The sentences above with "secretary", "passwords" and "opinion" are
  // turned down by other rules too (no link, no value). These are not: only
  // the rule that a keyword is a whole word keeps them out.
  it('a keyword is a whole word: not the start of a longer one, nor its end', () => {
    // The start: glued to a linking word, which would otherwise be the link.
    expect(secrets('passwordis hunter22 ok')).toEqual([]);
    expect(secrets('pinhai 4821 ok')).toEqual([]);
    // The end: "spin", "Chopin", "hairpin" and आलपिन all end in a code word.
    expect(secrets('spin 1200 rpm')).toEqual([]);
    expect(secrets('Chopin 1810 to 1849')).toEqual([]);
    expect(secrets('hairpin: bent')).toEqual([]);
    expect(secrets('आलपिन 500 चाहिए')).toEqual([]);
    // A combining mark is part of the word on either side of it (x́ has no
    // single-character form, so normalising keeps the mark).
    expect(secrets('x́pin 4821 ok')).toEqual([]);
    expect(secrets('piń 4821 ok')).toEqual([]);
  });

  it(`a value judged on its looks needs ${MIN_SECRET_LOOKING_LENGTH} characters and a digit or symbol`, () => {
    expect(MIN_SECRET_LOOKING_LENGTH).toBe(6);
    expect(secrets('password is abcd1 ok')).toEqual([]);
    expect(secrets('password is abcde1 ok')).toHaveLength(1);
    expect(secrets('password is abcdefgh ok')).toEqual([]);
    for (const symbol of '@#$%^&*!+=~|<>') {
      expect(secrets(`password is abcde${symbol}x ok`)).toHaveLength(1);
    }
    // Punctuation of ordinary writing is not evidence.
    for (const mark of ["'", '-', '_', '/', '.', ',', '?']) {
      expect(secrets(`password is abcde${mark}xyz ok`)).toEqual([]);
    }
  });

  it('only the value itself is evidence, not what stands before it in the same stretch', () => {
    // "password9" has no value of its own; its "9" must not vouch for the
    // letters after "token:".
    expect(secrets('password9:token:abcdefgh ok')).toEqual([]);
    const { text, spans } = compose`password9:token:${'abcdefg1'} ok`;
    expect(secrets(text)).toEqual([assigned(spans[0]!)]);
  });

  it('gives one candidate for one value, even when the value holds more keywords', () => {
    const { text, spans } = compose`password=${'token=pin=1234'} ok`;
    expect([...secretCandidates(text)]).toEqual([
      { type: 'SECRET', ...spans[0]!, validated: false, context: true },
    ]);
  });

  it('two searches over the same text do not disturb each other', () => {
    const text = 'password: abc123x and token: def456y ok';
    const first = secretCandidates(text);
    const second = secretCandidates(text);
    const head = first.next().value as unknown;
    const all = [...second];
    expect(all).toHaveLength(2);
    expect([head, ...first]).toEqual(all);
  });

  it('a numeric code is 3 to 8 digits, and nothing else', () => {
    expect(secrets('OTP 12 ok')).toEqual([]);
    expect(secrets('OTP 123 ok')).toHaveLength(1);
    expect(secrets('OTP 12345678 ok')).toHaveLength(1);
    // Nine digits are taken too, on their looks (6 or more characters with
    // a digit), and as a secret rather than by the safety net.
    expect(detect('OTP 123456789 ok').map((d) => d.type)).toEqual(['SECRET']);
    expect(secrets('OTP 12a4 ok')).toEqual([]);
    // Only a code word gets this rule.
    expect(secrets('password 1234 ok')).toEqual([]);
    expect(secrets('token 123 ok')).toEqual([]);
  });

  describe('where the value ends', () => {
    it('drops closing punctuation, keeps "!" and "?"', () => {
      const closed = compose`(password: ${'Hunter2x9'}).`;
      expect(secrets(closed.text)).toEqual([assigned(closed.spans[0]!)]);
      const danda = compose`पासवर्ड ${'Hunter2x9'}।`;
      expect(secrets(danda.text)).toEqual([assigned(danda.spans[0]!)]);
      const bang = compose`password is ${'Hunter2!'} ok`;
      expect(secrets(bang.text)).toEqual([assigned(bang.spans[0]!)]);
      const question = compose`password is ${'Hunter2?'} ok`;
      expect(secrets(question.text)).toEqual([assigned(question.spans[0]!)]);
    });

    it('runs to the next blank, whatever is in between (fail closed)', () => {
      const { text, spans } = compose`see /login?token=${'abc123&page=2,x'} next`;
      expect(secrets(text)).toEqual([assigned(spans[0]!)]);
    });

    it('takes one word only: a passphrase with spaces is cut short (known limit)', () => {
      const { text, spans } = compose`password: ${'c0rrect'} horse battery staple`;
      expect(secrets(text)).toEqual([assigned(spans[0]!)]);
    });
  });

  // Stated limits (ADR-022, README): no entropy scanning, and the value must
  // directly follow its keyword. Each of these holds a secret and is missed.
  describe('what is not found (known limits)', () => {
    it.each([
      ['a password made of letters, in a sentence', 'my password is sunshine and it fails'],
      ['no credential word at all', 'I tried logging in with Monsoon#2024 and it failed'],
      ['the keyword after the value', 'Monsoon#2024 is my password'],
      ['words between keyword and value', 'the password for the portal is Monsoon#2024'],
      ['a header line, then the value on the next line', 'Name,Password\npriya,Monsoon#2024'],
      ['a bare random string', `please check ${filler(40, 'a1b2c3d4')} for me`],
      ['credentials inside a URL', 'DB is postgres://app:Monsoon2024@localhost:5432/orders now'],
    ])('%s', (_name, text) => {
      expect(detect(text)).toEqual([]);
    });
  });

  // And the accepted cost of failing closed after a colon.
  it('takes a status word that stands alone after a colon (accepted cost)', () => {
    const { text, spans } = compose`Token: ${'expired'}\nPlease renew`;
    expect(secrets(text)).toEqual([assigned(spans[0]!)]);
  });

  it('reports both ways of finding a key; the validated one wins the overlap', () => {
    const key = `ghp_${filler(36)}`;
    const { text, spans } = compose`api_key=${key}`;
    expect([...secretCandidates(text)]).toEqual([
      { type: 'SECRET', ...spans[0]!, validated: true },
      { type: 'SECRET', ...spans[0]!, validated: false, context: true },
    ]);
    expect(detect(text)).toEqual([known(spans[0]!)]);
  });

  it('a value that is a phone number or an email keeps its own type', () => {
    const mobile = compose`password: ${indianMobile(createRng(7))}\n`;
    expect(detect(mobile.text)).toEqual([
      { type: 'PHONE', ...mobile.spans[0]!, validated: true, context: false },
    ]);
    const address = compose`password: ${'priya@example.com'}\n`;
    expect(detect(address.text)).toEqual([
      { type: 'EMAIL', ...address.spans[0]!, validated: false, context: false },
    ]);
  });

  it('finds the keyword forms the generator writes (generated passwords and tokens)', () => {
    assertPropertyQuietly(
      fc.property(
        seedArb,
        fc.constantFrom<[SecretKind, (s: string) => string]>(
          ['password', (s) => `My password is ${s}`],
          ['password', (s) => `password: ${s} Please help.`],
          ['password', (s) => `Mera password ${s} hai.`],
          ['password', (s) => `मेरा पासवर्ड ${s} है।`],
          ['token', (s) => `Here is my API key: ${s}`],
          ['token', (s) => `api_key=${s}`],
          ['token', (s) => `Authorization: Bearer ${s}`],
          ['token', (s) => `Token ${s} kaam nahi kar raha.`],
          ['token', (s) => `टोकन ${s} काम नहीं कर रहा।`],
        ),
        (seed, [kind, sentence]) => {
          const value = secret(createRng(seed), kind);
          const text = sentence(value);
          const start = text.indexOf(value);
          const found = detect(text);
          return (
            found.length === 1 &&
            found[0]!.type === 'SECRET' &&
            found[0]!.start === start &&
            found[0]!.end === start + value.length
          );
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('secrets: with the other detectors', () => {
  it('a token full of digits is one secret, not numbers cut out of it', () => {
    const token = `xoxb-${digits(12)}-${digits(13)}-${filler(24)}`;
    const { text, spans } = compose`Slack: ${token} ok`;
    expect(detect(text)).toEqual([known(spans[0]!)]);
  });

  it('a token with no keyword and a long digit stretch goes whole to the safety net', () => {
    const token = `${filler(12, 'abcdef')}${digits(10)}${filler(18, 'abcdef')}`;
    const { text, spans } = compose`I pasted ${token} by mistake`;
    expect(detect(text)).toEqual([
      { type: 'NUMBER', ...spans[0]!, validated: false, context: false },
    ]);
  });

  it('never leaves part of a generated hexadecimal token visible', () => {
    // Either nothing is found (no keyword, no long digit stretch: a known
    // limit) or the whole token is. Half a token is a leak.
    assertPropertyQuietly(
      fc.property(seedArb, (seed) => {
        const { text, spans } = compose`I pasted ${secret(createRng(seed), 'token')} by mistake`;
        const found = detect(text);
        return (
          found.length === 0 ||
          (found.length === 1 &&
            found[0]!.start === spans[0]!.start &&
            found[0]!.end === spans[0]!.end)
        );
      }),
      { numRuns: 2000 },
    );
  });
});

// Each case makes the input 4 times longer and checks the time grows about
// 4 times, not 16 (test/support/linear-time.ts).
describe('secrets: linear time', () => {
  it.each([
    ['keywords chained by colons', (n: number) => `${'pin:'.repeat(n / 4)} x`],
    ['keywords chained by colons, with quotes', (n: number) => `${'pin:a"'.repeat(n / 6)} x`],
    ['keywords with no value', (n: number) => 'pin '.repeat(n / 4)],
    ['keywords in prose', (n: number) => 'password is wrong '.repeat(n / 18)],
    ['keywords chained by underscores', (n: number) => `${'pin_'.repeat(n / 4)} x`],
    [
      'keywords chained by underscores, then a line end',
      (n: number) => `${'pin_'.repeat(n / 4)}\n`,
    ],
    ['keywords chained by equals signs', (n: number) => `${'pin='.repeat(n / 4)} x`],
    ['a keyword and a long value without evidence', (n: number) => `token ${'a'.repeat(n)} x`],
    ['a keyword and a long run of blanks', (n: number) => `token${' '.repeat(n)}\nx`],
    ['sk- chains', (n: number) => 'sk-'.repeat(n / 3)],
    ['GitHub prefixes', (n: number) => 'ghp_'.repeat(n / 4)],
    ['Google prefixes joined by hyphens', (n: number) => 'AIza-'.repeat(n / 5)],
    ['JWT starts with no dot', (n: number) => 'eyJaaaaaaaa-'.repeat(n / 12)],
    ['JWT starts with dots', (n: number) => 'eyJaaaaaaaa.'.repeat(n / 12)],
    ['PEM BEGIN lines with no END', (n: number) => `${PEM_BEGIN}\n`.repeat(n / 32)],
    ['BEGIN with no label', (n: number) => '-----BEGIN A '.repeat(n / 13)],
  ])('scans %s in linear time', (_name, make) => {
    expect(growthRatio(make, 25_000, detect)).toBeLessThan(MAX_GROWTH_RATIO);
  });
});

// ADR-029: a key takes the rest of its token; a JWT may start after "-".
describe('secrets glued to other text', () => {
  const r = createRng(2029);

  it('a key takes the rest of the token it is glued to', () => {
    const key = secret(r, 'github');
    const { text, spans } = compose`key ${`${key}-abc.def`} ok`;
    expect(detect(text)).toEqual([known(spans[0]!)]);
  });

  it('two keys joined by a hyphen are one secret, wholly covered', () => {
    for (const [a, b] of [
      ['openai', 'jwt'],
      ['slack', 'github'],
      ['google', 'jwt'],
      ['jwt', 'jwt'],
    ] as const) {
      const { text, spans } = compose`keys ${`${secret(r, a)}-${secret(r, b)}`} ok`;
      expect([a, b, detect(text)]).toEqual([a, b, [known(spans[0]!)]]);
    }
  });

  it('the secret detector alone reads a chain of keys whose alphabet has no hyphen in linear time', () => {
    // Each key takes the rest of the token, the whole chain; the search must
    // then go on after it, not find every next key again. Timed on the
    // detector alone (the other detectors would hide a quadratic one), ten
    // scans per measurement, as one takes about a millisecond.
    const unit = ['gh', 'p_', filler(36), '-'].join('');
    const make = (n: number): string => unit.repeat(Math.ceil(n / unit.length));
    const work = (text: string): number => {
      let found = 0;
      for (let i = 0; i < 10; i++) found += [...secretCandidates(text)].length;
      return found;
    };
    expect(growthRatio(make, 100_000, work)).toBeLessThan(MAX_GROWTH_RATIO);
  });

  it('a JWT glued to a letter outside its alphabet is not one', () => {
    expect(detect(`ref é${secret(r, 'jwt')} ok`)).toEqual([]);
  });

  it('a JWT after a value and a hyphen is found', () => {
    const jwt = secret(r, 'jwt');
    const { text, spans } = compose`ref 2345-6789-${jwt} ok`;
    expect(
      detect(text).some(
        (d) => d.type === 'SECRET' && d.start === spans[0]!.start && d.end === spans[0]!.end,
      ),
    ).toBe(true);
  });

  it.each([
    ['a dotless chain of JWT headers', 'eyJabcdefghij-'],
    ['a chain of JWT header and payload parts', 'eyJabcdefghij.eyJabcdefghij-'],
    ['a chain of keys', 'sk-Abc123456789012345678-'],
  ])('reads %s in linear time', (_name, unit) => {
    const make = (n: number): string => unit.repeat(Math.ceil(n / unit.length));
    expect(growthRatio(make, 25_000, detect)).toBeLessThan(MAX_GROWTH_RATIO);
  });
});

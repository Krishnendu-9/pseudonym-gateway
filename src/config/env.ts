import { z } from 'zod';

// "true"/"false" only: z.coerce.boolean() would turn the string "false" into true.
const booleanFlag = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((value) => value === 'true');

const envSchema = z.object({
  // Validated by convention only: since ADR-047 it switches nothing on or
  // off. The start-up guard used to run only when this was "production",
  // which every development template sets to "development".
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // The start-up guard (ADR-016) runs unless this is exactly "true"
  // (ADR-047): the unsafe state has to be asked for by name. Any value but
  // "true" or "false" is an error, so a typo refuses to start rather than
  // turning the guard off.
  PSEUDONYM_DISABLE_HARDENING: booleanFlag('false'),
  // Loopback by default: nothing is exposed to the network until it is asked
  // for. The Docker image sets 0.0.0.0, so this protects nothing there; the
  // network in front of the container does that (ADR-046).
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  PSEUDONYM_PROVIDER: z.enum(['ollama']).default('ollama'),
  // The one model requests must name (ADR-014). No default: model names are
  // configuration, never code.
  PSEUDONYM_MODEL: z.string().min(1),
  PSEUDONYM_PROVIDER_BASE_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:11434/v1'),
  PSEUDONYM_PROVIDER_API_KEY: z.string().min(1).optional(),
  // Local models on a CPU can take minutes for a long answer. Streaming
  // applies it to every wait instead: the headers, then each next piece.
  PSEUDONYM_PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  // 256 KiB (ADR-015): about 64k English tokens; redacting it takes about
  // 0.25 s for prose and about 1.1 s for digit-heavy text, during which the
  // event loop serves nothing else.
  // It also bounds how long the name model can work on one request (about
  // 79-135 s at 256 KiB as measured), which two names decisions rest on
  // (ADR-037, step 4b): a call past its timeout is never stopped, only
  // waited out, and the names timeout is derived from this size
  // (NAMES_TIMEOUT_MS_DEFAULT, wiring.ts). Raising it changes both; with a
  // larger limit, the model belongs in a child process that can be killed
  // (option 4 there), since a worker thread cannot be stopped mid-call.
  PSEUDONYM_MAX_BODY_BYTES: z.coerce.number().int().positive().default(262_144),
  // 1 MiB (ADR-020): the most of a non-streamed provider response the
  // gateway will read, all of which it holds in memory. About 250,000
  // English tokens.
  PSEUDONYM_MAX_RESPONSE_BYTES: z.coerce.number().int().positive().default(1_048_576),
  // 32 MiB (ADR-020): the most of a streamed response, counted on the wire.
  // Every streamed token is its own chunk of 205 to 255 bytes, and reasoning
  // tokens are chunks too, so a 32,768-token answer after as much reasoning
  // is 13.4 to 16.3 MiB. Not a memory bound: a stream is never held whole
  // (one event, at most 64 KiB, at a time).
  PSEUDONYM_MAX_STREAM_BYTES: z.coerce.number().int().positive().default(33_554_432),
  PSEUDONYM_RESTORE_IN_UNSAFE_REGIONS: booleanFlag('false'),
  // Off since Phase 5d measured it (ADR-017): with it on, the demo model
  // left more values unrestored, not fewer.
  PSEUDONYM_PLACEHOLDER_INSTRUCTION: booleanFlag('false'),
  // Person names (ADR-035: off by default, too slow and too many false
  // positives to be on for everyone). Unlike the switches above it has no
  // default and stays text: a configuration with names off is then exactly
  // the configuration from before names existed (ADR-037). nameFinder() in
  // wiring.ts reads it.
  PSEUDONYM_NAMES: z.enum(['true', 'false']).optional(),
  // With names on: how long a request may wait for its names, queued and
  // running together, and how many requests may wait while the model works
  // on another (ADR-037). No default here, for the same reason as
  // PSEUDONYM_NAMES: their defaults are applied by nameOptions() in
  // wiring.ts, which only names on reaches.
  PSEUDONYM_NAMES_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  PSEUDONYM_NAMES_MAX_QUEUE: z.coerce.number().int().nonnegative().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parses the environment. On failure, throws an error naming only the
 * variables that are wrong, never their values: one of them may be an API key.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;
  const names = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
  throw new Error(`Invalid environment variables: ${names.join(', ')}`);
}

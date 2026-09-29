import { z } from 'zod';

// "true"/"false" only: z.coerce.boolean() would turn the string "false" into true.
const booleanFlag = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Loopback by default: nothing is exposed to the network until it is asked
  // for (Docker sets 0.0.0.0 in Phase 8).
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  PSEUDONYM_PROVIDER: z.enum(['ollama']).default('ollama'),
  // The one model requests must name (ADR-014). No default: model names are
  // configuration, never code.
  PSEUDONYM_MODEL: z.string().min(1),
  PSEUDONYM_PROVIDER_BASE_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:11434/v1'),
  PSEUDONYM_PROVIDER_API_KEY: z.string().min(1).optional(),
  // Local models on a CPU can take minutes for a long answer.
  PSEUDONYM_PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  // 256 KiB (ADR-015): about 64k English tokens; redacting it takes about
  // 0.25 s for prose and about 1.1 s for digit-heavy text, during which the
  // event loop serves nothing else.
  PSEUDONYM_MAX_BODY_BYTES: z.coerce.number().int().positive().default(262_144),
  PSEUDONYM_RESTORE_IN_UNSAFE_REGIONS: booleanFlag('false'),
  // Provisional default until Phase 5 measures it (ADR-017).
  PSEUDONYM_PLACEHOLDER_INSTRUCTION: booleanFlag('true'),
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

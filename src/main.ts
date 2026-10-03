// Entry point: read configuration, check production hardening, listen.
// Kept to wiring only; everything with a decision in it lives in a module
// with tests, including which variable feeds which setting
// (config/wiring.ts). Excluded from coverage (vitest.config.ts).

import { readFileSync } from 'node:fs';
import { loadEnv } from './config/env.js';
import { nameFinder, ollamaConfig, serverConfig } from './config/wiring.js';
import { NameStartupError, safeErrorDetails } from './gateway/errors.js';
import { buildServer } from './gateway/server.js';
import { checkProductionHardening } from './hardening.js';
import { createOllamaProvider } from './providers/ollama.js';

const readOptional = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

// Node's default for an uncaught error prints its message, which may hold
// input. Log only the safe details and exit.
const fail = (error: unknown): never => {
  process.stderr.write(`${JSON.stringify({ fatal: safeErrorDetails(error) })}\n`);
  process.exit(1);
};
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

let env: ReturnType<typeof loadEnv>;
try {
  env = loadEnv();
} catch (error) {
  // loadEnv's message names the wrong variables, never their values.
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
}

if (env.NODE_ENV === 'production') {
  const { problems, warnings } = checkProductionHardening({
    platform: process.platform,
    execArgv: process.execArgv,
    nodeOptions: process.env.NODE_OPTIONS,
    procSelfLimits: readOptional('/proc/self/limits'),
    corePattern: readOptional('/proc/sys/kernel/core_pattern'),
  });
  for (const warning of warnings) process.stderr.write(`hardening warning: ${warning}\n`);
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`hardening problem: ${problem}\n`);
    process.exit(1);
  }
}

// Names on: the gateway starts only with a name list that matches its pinned
// hash and a model that loads (ADR-036). The model runtime and its worker are
// Phase 6b step 4; until then names on always refuses start-up. Names off
// never calls this, and nothing here imports a name module.
const names = await nameFinder(env, () =>
  Promise.reject(new NameStartupError('NAME_MODEL_LOAD_FAILED')),
);

const app = buildServer(
  { ...serverConfig(env), ...(names === undefined ? {} : { names }) },
  createOllamaProvider(ollamaConfig(env)),
);

await app.listen({ host: env.HOST, port: env.PORT });

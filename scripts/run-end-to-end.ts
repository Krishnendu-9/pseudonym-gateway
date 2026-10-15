// The end-to-end calls of ADR-041 section 17: E1 (names off), then E2
// (names on), through the whole gateway with Gemini as its provider. The
// registration, the checks and the run are in end-to-end.ts.
//
//   npx tsx scripts/run-end-to-end.ts --dry-run --out <dir outside the repository>
//   npx tsx scripts/run-end-to-end.ts --live
//
// Run from the repository root (the name model is read from models/).
//
// --dry-run: the same run against a local stub provider on 127.0.0.1
// (section 17 item 3): the same bodies, E2 with the real name model. Nothing
// goes to Google and .env is not read (the stub gets a placeholder key). It
// writes `<out>/attempt-N`, which must be outside the repository, and
// prints each call's outgoing body, whether it is the registered one, and
// what the planted-value checks found.
//
// --live: refuses to start unless the working tree is clean and HEAD is an
// ancestor of the last known origin/main (live-run-guard.ts), so section 17
// and this script are committed and pushed first. Only the key is read from
// .env (never printed); the provider, the model and the names switch are set
// here, and the base URL is the product's default for Gemini. Recordings go
// to test/fixtures/gemini-7b/attempt-N, the next unused N. A body that is not
// the registered one is refused before it is sent, so a dry run that does
// not pass cannot be followed by a live run that sends something else.
//
// Exit status 0 only if both calls ran and nothing stopped the run.

import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import type { Env } from '../src/config/env.js';
import { nameOptions } from '../src/config/wiring.js';
import type { NameFinder } from '../src/gateway/server.js';
import {
  CALLS,
  MODEL,
  SPACING_MS,
  gatewayEnv,
  gatewayStarter,
  newAttempt,
  plantedForms,
  plantedIn,
  runCalls,
  startStubProvider,
  type StubProvider,
} from './end-to-end.js';
import { changedPaths, checkTree, gitIn } from './live-run-guard.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LIVE_OUT = join(ROOT, 'test', 'fixtures', 'gemini-7b');
// Not a credential: the dry run's stub ignores it. Gemini needs a key to start.
const DRY_RUN_KEY = 'dry-run-placeholder-key';

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    live: { type: 'boolean', default: false },
    out: { type: 'string' },
  },
});
const dryRun = args['dry-run'];
if (dryRun === args.live || (dryRun && !args.out) || (args.live && args.out)) {
  console.error('usage: run-end-to-end.ts --dry-run --out <dir outside the repository> | --live');
  process.exit(1);
}

const git = gitIn(ROOT);
let about: Record<string, unknown>;
let out: string;
let key: string;
let stub: StubProvider | undefined;
if (dryRun) {
  out = resolve(args.out!);
  const inside = relative(ROOT, out);
  if (!inside.startsWith('..') && !isAbsolute(inside)) {
    console.error('the dry run writes outside the repository: --out must not be inside it');
    process.exit(1);
  }
  let head: string | null = null;
  let changed: number | null = null;
  try {
    head = git(['rev-parse', 'HEAD']).trim();
    changed = changedPaths(git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).length;
  } catch {
    // Recorded as unknown.
  }
  about = { mode: 'end-to-end dry run', model: MODEL, calls: 'e1,e2', head, changedPaths: changed };
  key = DRY_RUN_KEY;
  stub = await startStubProvider();
} else {
  // Before anything that could lead to a call (ADR-041 section 11).
  const tree = checkTree(git);
  if (!tree.ok) {
    console.error(tree.reason);
    process.exit(1);
  }
  console.log(`working tree clean at ${tree.head}, an ancestor of the last known origin/main`);
  about = {
    mode: 'end-to-end',
    model: MODEL,
    calls: 'e1,e2',
    head: tree.head,
    originMain: tree.remote,
  };
  out = LIVE_OUT;
  let fromFile: string | undefined;
  try {
    fromFile = parseEnv(readFileSync(join(ROOT, '.env'), 'utf8')).PSEUDONYM_PROVIDER_API_KEY;
  } catch {
    fromFile = undefined;
  }
  if (fromFile === undefined || fromFile === '') {
    console.error('PSEUDONYM_PROVIDER_API_KEY must be set in .env');
    process.exit(1);
  }
  key = fromFile;
}

// As main.ts starts names (names on only), with the same notice.
const startNames = async (env: Env): Promise<NameFinder> => {
  const { runtimeTelemetryNotice } = await import('../src/gateway/name-worker.js');
  const notice = runtimeTelemetryNotice(process.platform);
  if (notice !== undefined) console.log(notice);
  const { startNameDetection } = await import('../src/gateway/names.js');
  const { loadNameModel, MODEL_ROOT, NAME_MODEL } = await import('../src/gateway/name-model.js');
  return startNameDetection(
    () => loadNameModel(join(MODEL_ROOT, NAME_MODEL.dir)),
    nameOptions(env),
  );
};

const say = (line: string): void => console.log(line);
const providerBase = gatewayEnv(CALLS[0]!, key, stub?.baseUrl).PSEUDONYM_PROVIDER_BASE_URL;
const dir = newAttempt(out, { ...about, startedAt: new Date().toISOString() });
say(`${dryRun ? 'dry run' : 'live run'}: ${MODEL}, e1 then e2, ${SPACING_MS / 1000} s apart`);
say(`provider base URL ${providerBase}; recordings in ${dir}`);

let result: Awaited<ReturnType<typeof runCalls>>;
try {
  result = await runCalls({
    providerBase,
    startGateway: gatewayStarter(key, stub?.baseUrl, startNames, say),
    sleep: (ms) => sleep(ms),
    write: (name, data) => writeFileSync(join(dir, name), data),
    say,
  });
} catch (error) {
  // A gateway that did not start: nothing was sent. Its name and code only.
  const code = (error as { code?: unknown }).code;
  console.error(
    `the run did not start: ${(error as Error).name}${typeof code === 'string' ? ` ${code}` : ''}`,
  );
  await stub?.close();
  process.exit(1);
}
await stub?.close();

for (const outcome of result.outcomes) {
  const call = CALLS.find((c) => c.id === outcome.id)!;
  const forms = plantedForms(call.planted);
  say(`\n${outcome.id} (names ${call.names ? 'on' : 'off'}):`);
  say(`  gateway status to the client: ${outcome.clientStatus ?? 'none'}`);
  say(
    `  provider requests sent: ${outcome.sent}; provider status: ${outcome.providerStatus ?? 'none'}`,
  );
  if (outcome.outgoing !== undefined) {
    say(`  outgoing body, as passed to fetch:`);
    say(`    ${outcome.outgoing}`);
    const found = plantedIn(outcome.outgoing, forms);
    say(
      `  planted values in it: ${found.length === 0 ? `none of ${forms.length} forms` : found.join('; ')}`,
    );
  }
  if (outcome.refused.length > 0) {
    say(`  refused before sending:\n${outcome.refused.map((r) => `    - ${r}`).join('\n')}`);
  } else if (outcome.outgoing !== undefined) {
    say('  refused before sending: no; the body is the registered one, character for character');
  } else {
    say('  the gateway made no provider request');
  }
  say(
    `  planted values in its log lines: ${outcome.plantedInLogs.length === 0 ? `none of ${forms.length} forms` : outcome.plantedInLogs.join('; ')}`,
  );
}
if (dryRun && stub !== undefined)
  say(`\nstub provider received ${stub.received.length} request(s)`);
say(
  result.stopped === undefined
    ? '\nboth calls made; nothing stopped the run'
    : `\nstopped: ${result.stopped}`,
);
// The name worker keeps the process alive; everything is written.
process.exit(result.stopped === undefined && result.outcomes.length === CALLS.length ? 0 : 1);

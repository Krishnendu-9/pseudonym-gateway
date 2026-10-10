// Smoke test for the Docker image (ADR-046), run by CI after `docker build`:
//
//   npx tsx scripts/docker-smoke.ts <image>
//
// It checks the built image, not the Dockerfile or .dockerignore:
//  1. contents, from a listing of the whole exported filesystem: /app holds
//     only dist/src, node_modules and package.json, and there is no .env
//     file, eval/, test/, docs/, models/ or held-out set in it;
//  2. configuration: a non-root user, the environment the image promises
//     and a health check;
//  3. the ADR-016 start-up guard is live: it refuses a core dump limit, an
//     inspect flag in NODE_OPTIONS and a start without --disable-sigusr1,
//     and still refuses with a .env made from .env.example passed by
//     --env-file (ADR-047); names on with no model mounted refuses to start
//     (ADR-036);
//  4. serving: with a stub provider on a private network, a request with
//     a synthetic email is answered with the email restored, the stub saw
//     only its placeholder, Docker's own health check says healthy, and the
//     gateway's process does not run as root.
// With `--models <dir>` (the directory `npm run fetch:model` fills), it also
// serves with names on and that directory mounted read-only, and checks that
// a synthetic name reaches the stub only as its placeholder. CI runs it with
// the model from the Names workflow's cache.
// Run from the repository's root: the --env-file check reads .env.example.
// It prints check names, paths and exit codes, never a request, an answer
// or the stub's log (rule 5).

import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const modelsAt = args.indexOf('--models');
const models = modelsAt === -1 ? undefined : args[modelsAt + 1];
const image = args.find(
  (arg, i) => !arg.startsWith('-') && (modelsAt === -1 || i !== modelsAt + 1),
);
if (image === undefined || (modelsAt !== -1 && models === undefined)) {
  process.stderr.write('usage: npx tsx scripts/docker-smoke.ts [--models <dir>] <image>\n');
  process.exit(2);
}

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` (${detail})`}\n`);
  if (!ok) failures.push(name);
}

interface Result {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
function docker(args: readonly string[], timeoutMs?: number): Result {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fetch with a time limit; undefined on any failure. Needed: a request to a
 * published port before the gateway listens can be accepted by Docker's
 * port forwarder and never answered, and with nothing else pending Node
 * then exits mid-run (code 13) without cleaning up. The limit is an
 * ordinary timer, not AbortSignal.timeout, whose timer does not keep the
 * process alive.
 */
async function request(
  url: string,
  init: RequestInit,
  limitMs: number,
): Promise<{ status: number; body: string } | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limitMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { status: response.status, body: await response.text() };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// --- 1. Contents ---------------------------------------------------------

/** Every path in the image's filesystem, without a leading "./" or a trailing "/". */
async function imagePaths(): Promise<string[]> {
  const created = docker(['create', image!]);
  if (created.status !== 0) throw new Error(`docker create failed: ${created.stderr.trim()}`);
  const id = created.stdout.trim();
  try {
    return await new Promise<string[]>((resolve, reject) => {
      const exported = spawn('docker', ['export', id], { stdio: ['ignore', 'pipe', 'inherit'] });
      const tar = spawn('tar', ['-tf', '-'], { stdio: ['pipe', 'pipe', 'inherit'] });
      exported.stdout.pipe(tar.stdin);
      let listing = '';
      tar.stdout.setEncoding('utf8');
      tar.stdout.on('data', (chunk: string) => (listing += chunk));
      exported.on('error', reject);
      tar.on('error', reject);
      tar.on('close', (code) => {
        if (code !== 0) return reject(new Error(`tar exited with ${code}`));
        resolve(
          listing
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => line.replace(/^\.\//, '').replace(/\/$/, '')),
        );
      });
    });
  } finally {
    docker(['rm', id]);
  }
}

const head = (path: string, segments: number): string =>
  path.split('/').slice(0, segments).join('/');
const differences = (actual: Set<string>, expected: readonly string[]): string =>
  [...actual].filter((x) => !expected.includes(x)).join(', ');

const paths = await imagePaths();
const app = paths.filter((p) => p.startsWith('app/'));
const appTop = new Set(app.map((p) => head(p, 2)));
const APP_TOP = ['app/dist', 'app/node_modules', 'app/package.json'];
check(
  'the image has a filesystem listing with /app in it',
  paths.length > 1000 && app.length > 0,
  `${paths.length} paths`,
);
check(
  '/app holds only dist, node_modules and package.json',
  appTop.size === APP_TOP.length && APP_TOP.every((p) => appTop.has(p)),
  differences(appTop, APP_TOP),
);
const distTop = new Set(app.filter((p) => p.startsWith('app/dist/')).map((p) => head(p, 3)));
check(
  '/app/dist holds only src',
  [...distTop].every((p) => p === 'app/dist/src'),
  differences(distTop, ['app/dist/src']),
);
for (const file of [
  'app/package.json',
  'app/dist/src/main.js',
  'app/dist/src/gateway/name-worker-entry.js',
  'app/node_modules/fastify/package.json',
  'app/node_modules/onnxruntime-node/package.json',
]) {
  check(`the image contains ${file}`, paths.includes(file));
}
const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const envFiles = paths.filter((p) => base(p) === '.env' || base(p).startsWith('.env.'));
check('no .env or .env.* file anywhere in the image', envFiles.length === 0, envFiles.join(', '));
const heldOut = paths.filter((p) => p.includes('held-out'));
check('nothing named held-out anywhere in the image', heldOut.length === 0, heldOut.join(', '));
const FORBIDDEN_DIRS = new Set(['eval', 'test', 'docs', 'dev_docs', 'models', 'scripts', '.git']);
const forbidden = app.filter(
  (p) =>
    !p.startsWith('app/node_modules/') && p.split('/').some((part) => FORBIDDEN_DIRS.has(part)),
);
check(
  'no eval/, test/, docs/, dev_docs/, models/, scripts/ or .git under /app',
  forbidden.length === 0,
  forbidden.slice(0, 5).join(', '),
);

// --- 2. Configuration ------------------------------------------------------

interface ImageConfig {
  readonly User?: string;
  readonly Env?: readonly string[];
  readonly Cmd?: readonly string[];
  readonly Healthcheck?: { readonly Test?: readonly string[] };
}
const config = JSON.parse(
  docker(['image', 'inspect', '--format', '{{json .Config}}', image]).stdout,
) as ImageConfig;
const user = config.User ?? '';
check(
  'the image runs as a non-root user',
  user !== '' && !['root', '0'].includes(user.split(':')[0]!),
  `user "${user}"`,
);
for (const variable of ['HOST=0.0.0.0', 'ORT_DISABLE_TELEMETRY=1']) {
  check(`the image sets ${variable}`, config.Env?.includes(variable) === true);
}
check(
  'the image does not set PSEUDONYM_DISABLE_HARDENING',
  !(config.Env ?? []).some((e) => e.startsWith('PSEUDONYM_DISABLE_HARDENING=')),
);
check(
  'the command runs node with --disable-sigusr1',
  config.Cmd?.[0] === 'node' && config.Cmd.includes('--disable-sigusr1'),
);
check('the image has a health check', (config.Healthcheck?.Test?.length ?? 0) > 0);

// --- 3. Refusals -----------------------------------------------------------

const MODEL = ['-e', 'PSEUDONYM_MODEL=smoke-model'];
// A refusal exits within seconds. One that does not refuse would serve
// forever, so each run is named, given a limit, and removed afterwards.
const REFUSAL_LIMIT_MS = 60_000;
let refusals = 0;
function refuses(name: string, args: readonly string[], expected: string): void {
  const container = `pseudonym-smoke-${process.pid}-refusal-${++refusals}`;
  const result = docker(
    ['run', '--rm', '--name', container, '--no-healthcheck', ...args],
    REFUSAL_LIMIT_MS,
  );
  docker(['rm', '-f', container]);
  check(
    name,
    result.status !== null && result.status !== 0 && result.stderr.includes(expected),
    result.status === null
      ? `still running after ${REFUSAL_LIMIT_MS / 1000} s`
      : `exit ${result.status}`,
  );
}
refuses(
  'the guard refuses a core dump limit above zero',
  ['--ulimit', 'core=1024', ...MODEL, image],
  'core dumps must be disabled',
);
refuses(
  'the guard refuses an inspect flag in NODE_OPTIONS',
  ['--ulimit', 'core=0', '-e', 'NODE_OPTIONS=--inspect', ...MODEL, image],
  '--inspect must not be set in production',
);
refuses(
  'the guard refuses a start without --disable-sigusr1',
  ['--ulimit', 'core=0', ...MODEL, image, 'node', 'dist/src/main.js'],
  '--disable-sigusr1 must be set in production',
);
// The case ADR-046 found: a .env made from the template, with its
// NODE_ENV=development, used to turn the guard off (ADR-047).
refuses(
  'a .env made from .env.example (--env-file) does not turn the guard off',
  ['--env-file', '.env.example', '--ulimit', 'core=1024', image],
  'core dumps must be disabled',
);
refuses(
  'names on with no model mounted refuses to start',
  ['--ulimit', 'core=0', ...MODEL, '-e', 'PSEUDONYM_NAMES=true', image],
  'NAME_MODEL_FILE_MISSING',
);

// --- 4. Serving ------------------------------------------------------------

// The stub provider: logs each request it receives (read here, never
// printed) and answers with the last message it was given, so the gateway
// has a placeholder to restore.
const STUB = `
const http = require('node:http');
http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    process.stdout.write(JSON.stringify({ url: req.url, body }) + '\\n');
    let said = '';
    try { const m = JSON.parse(body).messages; said = m[m.length - 1].content; } catch {}
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'smoke', created: 0, choices: [
      { message: { role: 'assistant', content: 'You wrote: ' + said }, finish_reason: 'stop' },
    ] }));
  });
}).listen(11434, '0.0.0.0');
`;
// The hardened run the README recommends.
const HARDENED = ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'];

interface Scenario {
  /** Prefixes every check's name. */
  readonly label: string;
  /** More `docker run` options for the gateway. */
  readonly options: readonly string[];
  /** The value planted in the request (synthetic, rule 4). */
  readonly value: string;
  /** Parts of it that must not reach the stub either. */
  readonly parts: readonly string[];
  readonly placeholder: string;
  /** Text the gateway's own output must not contain once it serves. */
  readonly mustNotPrint?: string;
}

async function serves({
  label,
  options,
  value,
  parts,
  placeholder,
  mustNotPrint,
}: Scenario): Promise<void> {
  const run = `pseudonym-smoke-${process.pid}-${label.replaceAll(' ', '-')}`;
  const [network, stub, gateway] = [`${run}-net`, `${run}-stub`, `${run}-gateway`];
  const named = (name: string): string => `${label}: ${name}`;
  try {
    docker(['network', 'create', network]);
    docker([
      'run',
      '-d',
      '--name',
      stub,
      '--network',
      network,
      '--no-healthcheck',
      ...HARDENED,
      image!,
      'node',
      '-e',
      STUB,
    ]);
    const started = docker([
      'run',
      '-d',
      '--name',
      gateway,
      '--network',
      network,
      '--init',
      '--ulimit',
      'core=0',
      ...HARDENED,
      '-p',
      '127.0.0.1::3000',
      '--health-interval',
      '2s',
      ...options,
      ...MODEL,
      '-e',
      `PSEUDONYM_PROVIDER_BASE_URL=http://${stub}:11434/v1`,
      image!,
    ]);
    check(named('the gateway container starts'), started.status === 0, started.stderr.trim());
    const address = docker(['port', gateway, '3000/tcp']).stdout.trim().split('\n')[0] ?? '';

    let health = 0;
    for (let i = 0; i < 90 && health !== 200; i++) {
      if (docker(['inspect', '--format', '{{.State.Running}}', gateway]).stdout.trim() !== 'true') {
        break;
      }
      health = (await request(`http://${address}/health`, {}, 2_000))?.status ?? 0;
      if (health !== 200) await sleep(1_000);
    }
    check(
      named('GET /health answers 200 through the published port'),
      health === 200,
      `status ${health}`,
    );
    if (health !== 200) {
      // The gateway's logs hold no bodies (ADR-014), so they can be shown.
      const logs = docker(['logs', gateway]);
      process.stdout.write(logs.stdout + logs.stderr);
    }
    if (mustNotPrint !== undefined) {
      const logs = docker(['logs', gateway]);
      check(
        named(`the gateway does not print "${mustNotPrint}"`),
        !`${logs.stdout}${logs.stderr}`.includes(mustNotPrint),
      );
    }

    const response = await request(
      `http://${address}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'smoke-model',
          messages: [{ role: 'user', content: `Please write to ${value} today.` }],
        }),
      },
      60_000,
    );
    let answer: { choices?: { message?: { content?: unknown } }[] } | undefined;
    try {
      answer = JSON.parse(response?.body ?? '') as typeof answer;
    } catch {
      answer = undefined;
    }
    const content = answer?.choices?.[0]?.message?.content;
    check(
      named('a chat completion is answered with 200'),
      response?.status === 200,
      `status ${response?.status}`,
    );
    check(
      named('the answer has the value restored, not its placeholder'),
      typeof content === 'string' && content.includes(value) && !content.includes(placeholder),
    );
    const received = docker(['logs', stub])
      .stdout.trim()
      .split('\n')
      .filter((l) => l !== '');
    check(
      named('the provider received exactly one request'),
      received.length === 1,
      `${received.length}`,
    );
    check(
      named('the provider saw the placeholder and never the value'),
      received.some((l) => l.includes(placeholder)) &&
        !received.some((l) => [value, ...parts].some((part) => l.includes(part))),
    );

    let status = '';
    for (let i = 0; i < 30 && status !== 'healthy'; i++) {
      status = docker(['inspect', '--format', '{{.State.Health.Status}}', gateway]).stdout.trim();
      if (status !== 'healthy') await sleep(1_000);
    }
    check(named("Docker's health check says healthy"), status === 'healthy', status);

    // The gateway's own process, found by its arguments: "node" with
    // dist/src/main.js as an argument of its own. PID 1 is the init process
    // --init adds, whose arguments contain the same words, as does this
    // probe's script.
    const uids = docker([
      'exec',
      gateway,
      'node',
      '-e',
      "const fs = require('node:fs'); for (const p of fs.readdirSync('/proc')) { if (!/^[0-9]+$/.test(p)) continue; let a = []; try { a = fs.readFileSync('/proc/' + p + '/cmdline', 'utf8').split('\\0'); } catch { continue; } if (a[0] === 'node' && a.includes('dist/src/main.js')) console.log(/^Uid:\\s+(\\d+)\\s+(\\d+)/m.exec(fs.readFileSync('/proc/' + p + '/status', 'utf8')).slice(1).join(' ')); }",
    ]).stdout.trim();
    check(
      named("the gateway's process runs with a non-zero real and effective uid"),
      /^[0-9]+ [0-9]+$/.test(uids) && uids.split(' ').every((u) => u !== '0'),
      `uid ${uids || 'not found'}`,
    );
  } finally {
    docker(['rm', '-f', gateway, stub]);
    docker(['network', 'rm', network]);
  }
}

// Synthetic, at a reserved domain (rule 4).
await serves({
  label: 'names off',
  options: [],
  value: 'smoke.check@example.com',
  parts: ['smoke.check'],
  placeholder: '[EMAIL_1]',
});
if (models !== undefined) {
  // A synthetic name (rule 4), read-only mount, as the README describes.
  await serves({
    label: 'names on',
    options: [
      '-e',
      'PSEUDONYM_NAMES=true',
      '--mount',
      `type=bind,source=${resolve(models)},target=/app/models,readonly`,
    ],
    value: 'Rahul Verma',
    parts: ['Rahul', 'Verma'],
    placeholder: '[PERSON_1]',
    // The Windows-only telemetry line (ADR-046 amendment D) would be untrue
    // here: on Linux the runtime's telemetry is off.
    mustNotPrint: 'telemetry cannot be turned off',
  });
}

process.stdout.write(
  failures.length === 0
    ? 'docker smoke: all checks passed\n'
    : `docker smoke: ${failures.length} failed\n`,
);
process.exit(failures.length === 0 ? 0 : 1);

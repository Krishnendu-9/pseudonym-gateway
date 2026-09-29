// Production start-up guard (ADR-012 follow-through, ADR-016). The
// per-request mapping holds real values as plain strings, so anything that
// can copy the process's memory to disk or to a debugger must be off in
// production:
//  - heap snapshots and the inspector (`--inspect*`, `--heapsnapshot-*`),
//    including the inspector Linux starts when any process sends SIGUSR1,
//    unless Node runs with `--disable-sigusr1` (Node 22.14+, stable 22.20);
//  - diagnostic reports (`--report-on-*`), which include the environment and
//    so the provider API key;
//  - core dumps: `--abort-on-uncaught-exception`, and any core size limit
//    above zero (Node aborts, and so may dump core, on fatal errors).
//
// Node accepts every one of these flags in NODE_OPTIONS, where they do not
// appear in process.execArgv, so both are checked.
//
// What this cannot see: if the host pipes core dumps to a handler
// (`core_pattern` starting with "|", e.g. systemd-coredump), the kernel does
// not enforce RLIMIT_CORE at all (core(5)); that is only a warning here and
// is the host operator's to configure. Windows and macOS have no /proc to
// read, so nothing about dumps can be verified there: a warning, and the
// README says production means Linux.

/** Flags that let the process's memory be written out or inspected. */
export const FORBIDDEN_FLAGS = [
  '--inspect',
  '--inspect-brk',
  '--inspect-wait',
  '--heapsnapshot-signal',
  '--heapsnapshot-near-heap-limit',
  '--report-on-signal',
  '--report-on-fatalerror',
  '--report-uncaught-exception',
  '--abort-on-uncaught-exception',
] as const;

export interface HardeningInput {
  readonly platform: NodeJS.Platform;
  readonly execArgv: readonly string[];
  readonly nodeOptions: string | undefined;
  /** Contents of /proc/self/limits, or undefined if it could not be read. */
  readonly procSelfLimits: string | undefined;
  /** Contents of /proc/sys/kernel/core_pattern, or undefined. */
  readonly corePattern: string | undefined;
}

export interface HardeningResult {
  /** Any problem means production must not start. */
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
}

// NODE_OPTIONS is split on whitespace; Node also allows double-quoted values.
function nodeOptionFlags(nodeOptions: string | undefined): string[] {
  return (nodeOptions ?? '').match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
}

// `--report_on_signal=x` and `--report-on-signal` are the same flag to Node.
function flagName(arg: string): string {
  const name = arg.split('=', 1)[0]!;
  return name.startsWith('--') ? `--${name.slice(2).replaceAll('_', '-')}` : name;
}

/** The soft "Max core file size" from /proc/self/limits, or undefined if absent. */
export function coreSoftLimit(procSelfLimits: string): string | undefined {
  const line = procSelfLimits.split('\n').find((l) => l.startsWith('Max core file size'));
  return line?.slice('Max core file size'.length).trim().split(/\s+/)[0];
}

export function checkProductionHardening(input: HardeningInput): HardeningResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const flags = [...input.execArgv, ...nodeOptionFlags(input.nodeOptions)].map(flagName);

  for (const forbidden of FORBIDDEN_FLAGS) {
    if (flags.includes(forbidden)) problems.push(`${forbidden} must not be set in production`);
  }

  if (input.platform !== 'linux') {
    warnings.push(
      `core dumps, crash dumps and debugger attach cannot be verified on ${input.platform}; ` +
        'production is supported on Linux only',
    );
    return { problems, warnings };
  }

  if (!flags.includes('--disable-sigusr1')) {
    problems.push('--disable-sigusr1 must be set in production (SIGUSR1 starts the inspector)');
  }
  const core = input.procSelfLimits === undefined ? undefined : coreSoftLimit(input.procSelfLimits);
  if (core === undefined) problems.push('could not read the core dump size limit');
  else if (core !== '0') problems.push('core dumps must be disabled (ulimit -c 0)');

  if (input.corePattern?.startsWith('|')) {
    warnings.push(
      'the host pipes core dumps to a handler, which ignores the core size limit; ' +
        'disable core dump storage on the host',
    );
  }
  return { problems, warnings };
}

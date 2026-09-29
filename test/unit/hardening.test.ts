// The production start-up guard (ADR-016): which flags and settings stop
// production from starting, and what can only be a warning.

import { describe, expect, it } from 'vitest';
import {
  checkProductionHardening,
  coreSoftLimit,
  FORBIDDEN_FLAGS,
  type HardeningInput,
} from '../../src/hardening.js';

const limits = (soft: string, hard = soft): string =>
  [
    'Limit                     Soft Limit           Hard Limit           Units     ',
    'Max cpu time              unlimited            unlimited            seconds   ',
    `Max core file size        ${soft.padEnd(21)}${hard.padEnd(21)}bytes     `,
    'Max open files            1048576              1048576              files     ',
  ].join('\n');

const HARDENED: HardeningInput = {
  platform: 'linux',
  execArgv: ['--disable-sigusr1'],
  nodeOptions: undefined,
  procSelfLimits: limits('0'),
  corePattern: 'core',
};

const check = (overrides: Partial<HardeningInput>) =>
  checkProductionHardening({ ...HARDENED, ...overrides });

describe('checkProductionHardening on Linux', () => {
  it('a hardened process passes with no warnings', () => {
    expect(check({})).toEqual({ problems: [], warnings: [] });
  });

  it.each(FORBIDDEN_FLAGS)('%s in execArgv is a problem', (flag) => {
    expect(check({ execArgv: ['--disable-sigusr1', flag] }).problems).toEqual([
      `${flag} must not be set in production`,
    ]);
  });

  it.each(FORBIDDEN_FLAGS)('%s in NODE_OPTIONS is a problem too', (flag) => {
    expect(check({ nodeOptions: `--max-old-space-size=512 ${flag}` }).problems).toEqual([
      `${flag} must not be set in production`,
    ]);
  });

  it.each([
    ['with a value', { execArgv: ['--disable-sigusr1', '--inspect=0.0.0.0:9229'] }],
    ['with underscores', { execArgv: ['--disable-sigusr1', '--report_on_signal'] }],
    ['quoted in NODE_OPTIONS', { nodeOptions: '--title="my app" --heapsnapshot-signal=SIGUSR2' }],
  ])('a forbidden flag %s is still found', (_name, input) => {
    expect(check(input).problems).toHaveLength(1);
  });

  it('flags that only look similar are not problems', () => {
    expect(
      check({
        execArgv: ['--disable-sigusr1', '--inspect-port=9229', '--report-dir=/tmp', 'app.js'],
      }).problems,
    ).toEqual([]);
  });

  it('--disable-sigusr1 is required, and accepted from NODE_OPTIONS', () => {
    expect(check({ execArgv: [] }).problems).toEqual([
      '--disable-sigusr1 must be set in production (SIGUSR1 starts the inspector)',
    ]);
    expect(check({ execArgv: [], nodeOptions: '--disable-sigusr1' }).problems).toEqual([]);
  });

  it('a core size limit other than 0 is a problem; only the soft limit counts', () => {
    expect(check({ procSelfLimits: limits('unlimited') }).problems).toEqual([
      'core dumps must be disabled (ulimit -c 0)',
    ]);
    expect(check({ procSelfLimits: limits('1024', 'unlimited') }).problems).toHaveLength(1);
    expect(check({ procSelfLimits: limits('0', 'unlimited') }).problems).toEqual([]);
  });

  it('an unreadable or unrecognised /proc/self/limits is a problem', () => {
    const expected = ['could not read the core dump size limit'];
    expect(check({ procSelfLimits: undefined }).problems).toEqual(expected);
    expect(check({ procSelfLimits: 'Max open files 1 1 files' }).problems).toEqual(expected);
  });

  it('a core_pattern that pipes to a handler is a warning, not a problem', () => {
    const result = check({ corePattern: '|/usr/lib/systemd/systemd-coredump %P %u %g %s %t' });
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual([
      'the host pipes core dumps to a handler, which ignores the core size limit; ' +
        'disable core dump storage on the host',
    ]);
    expect(check({ corePattern: undefined }).warnings).toEqual([]);
  });

  it('reports every problem at once', () => {
    const result = check({
      execArgv: ['--inspect'],
      nodeOptions: '--abort-on-uncaught-exception',
      procSelfLimits: limits('unlimited'),
    });
    expect(result.problems).toHaveLength(4);
  });
});

describe('checkProductionHardening on other platforms', () => {
  it.each(['win32', 'darwin'] as const)(
    '%s: a warning that nothing can be verified',
    (platform) => {
      const result = check({ platform, execArgv: [], procSelfLimits: undefined });
      expect(result.problems).toEqual([]);
      expect(result.warnings).toEqual([
        `core dumps, crash dumps and debugger attach cannot be verified on ${platform}; ` +
          'production is supported on Linux only',
      ]);
    },
  );

  it('forbidden flags are still problems there', () => {
    expect(check({ platform: 'win32', execArgv: ['--inspect'] }).problems).toEqual([
      '--inspect must not be set in production',
    ]);
  });
});

describe('coreSoftLimit', () => {
  it('reads the soft limit column', () => {
    expect(coreSoftLimit(limits('0', 'unlimited'))).toBe('0');
    expect(coreSoftLimit(limits('unlimited'))).toBe('unlimited');
    expect(coreSoftLimit('')).toBeUndefined();
  });
});

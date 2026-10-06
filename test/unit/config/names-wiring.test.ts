// Names off must leave the gateway as it was (ADR-037): the name finder is
// never started, and nothing main.ts loads can reach the name model's code.

import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../../src/config/env.js';
import { nameFinder } from '../../../src/config/wiring.js';
import type { NameFinder } from '../../../src/gateway/server.js';

const FINDER: NameFinder = { find: () => Promise.resolve([]), healthy: true };

describe('PSEUDONYM_NAMES', () => {
  it('is absent from the parsed configuration unless set', () => {
    expect('PSEUDONYM_NAMES' in loadEnv({ PSEUDONYM_MODEL: 'm' })).toBe(false);
  });

  it('takes only "true" or "false", and names the variable, not the value, when wrong', () => {
    expect(loadEnv({ PSEUDONYM_MODEL: 'm', PSEUDONYM_NAMES: 'true' }).PSEUDONYM_NAMES).toBe('true');
    expect(() => loadEnv({ PSEUDONYM_MODEL: 'm', PSEUDONYM_NAMES: 'yes' })).toThrow(
      'Invalid environment variables: PSEUDONYM_NAMES',
    );
  });
});

describe('nameFinder: names off never starts the finder', () => {
  it.each([
    ['unset', {}],
    ['false', { PSEUDONYM_NAMES: 'false' }],
  ])('names %s: start is never called', async (_label, extra) => {
    let starts = 0;
    const finder = await nameFinder(loadEnv({ PSEUDONYM_MODEL: 'm', ...extra }), () => {
      starts++;
      return Promise.resolve(FINDER);
    });
    expect(finder).toBeUndefined();
    expect(starts).toBe(0);
  });

  it('names on: started once, and a failure to start is thrown, refusing start-up', async () => {
    let starts = 0;
    const env = loadEnv({ PSEUDONYM_MODEL: 'm', PSEUDONYM_NAMES: 'true' });
    const finder = await nameFinder(env, () => {
      starts++;
      return Promise.resolve(FINDER);
    });
    expect(finder).toBe(FINDER);
    expect(starts).toBe(1);
    await expect(nameFinder(env, () => Promise.reject(new Error('no model')))).rejects.toThrow(
      'no model',
    );
  });
});

// Static imports only: an `import type` is erased, a dynamic import() runs
// only when called. `import { type X }` is kept by verbatimModuleSyntax, so
// it counts as a load, as it does at run time.
const STATIC_IMPORT = /^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?'([^']+)'/gmu;

function staticClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) {
      if (specifier!.startsWith('.')) {
        visit(resolve(dirname(file), specifier!.replace(/\.js$/u, '.ts')));
      } else {
        seen.add(`package:${specifier}`);
      }
    }
  };
  visit(resolve(entry));
  return seen;
}

describe('the code main.ts loads with names off', () => {
  const closure = [...staticClosure('src/main.ts')].map((file) =>
    file.startsWith('package:') ? file : relative('.', file).replaceAll('\\', '/'),
  );

  it('is what it should be: the server, the detectors, Fastify (so the check is not vacuous)', () => {
    expect(closure).toEqual(
      expect.arrayContaining([
        'src/gateway/server.ts',
        'src/detection/detect.ts',
        'src/redaction/redact.ts',
        'package:fastify',
      ]),
    );
  });

  it('holds no name module, no name list, and no model runtime', () => {
    const forbidden = closure.filter(
      (file) =>
        file.startsWith('src/detection/names/') ||
        file === 'src/gateway/names.ts' ||
        file === 'src/gateway/name-model.ts' ||
        file.startsWith('src/gateway/name-worker') ||
        file === 'src/synthetic/wikidata-names.ts' ||
        /onnxruntime|@huggingface/u.test(file),
    );
    expect(forbidden).toEqual([]);
  });

  it('would see them if they were imported: the same walk from the name detector reaches them', () => {
    const fromNames = [...staticClosure('src/gateway/names.ts')].map((file) =>
      relative('.', file).replaceAll('\\', '/'),
    );
    expect(fromNames).toEqual(
      expect.arrayContaining([
        'src/detection/names/find.ts',
        'src/detection/names/gazetteer.ts',
        'src/synthetic/wikidata-names.ts',
      ]),
    );
    // And from the model loader to the worker and the code it runs.
    const fromModel = [...staticClosure('src/gateway/name-model.ts')].map((file) =>
      relative('.', file).replaceAll('\\', '/'),
    );
    expect(fromModel).toContain('src/gateway/name-worker.ts');
    const fromThread = [...staticClosure('src/gateway/name-worker-entry.ts')].map((file) =>
      relative('.', file).replaceAll('\\', '/'),
    );
    expect(fromThread).toContain('src/detection/names/bert.ts');
  });

  it('reaches the name modules only through main.ts, where nameFinder decides', () => {
    // The imports that load them are dynamic, inside the function
    // nameFinder calls only with names on; this pins that main.ts still
    // goes through nameFinder.
    const main = readFileSync(join('src', 'main.ts'), 'utf8');
    expect(main).toContain('await nameFinder(env,');
  });
});

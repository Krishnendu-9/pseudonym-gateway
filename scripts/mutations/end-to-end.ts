// Mutations of the end-to-end run script (ADR-041 section 17), for
// scripts/mutate.ts (ADR-043: tracked with the change it checks):
//
//   npx tsx scripts/mutate.ts --out <dir outside the repo> scripts/mutations/end-to-end.ts
//
// Each one weakens a check the registration or the run depends on: the
// planted-value refusal, the registered-body gate, the log-line checks, the
// stop rules, the spacing, the environment, or putting fetch back.
//
// There is no E11. It removed a separate check for a provider 429 and
// survived: a 429 is already "a status other than 200 or 400" (E12), with
// the same message. The redundant line was deleted from the script and the
// mutation from this list before either was first committed.

import type { Mutation } from '../mutate.js';

const FILE = 'scripts/end-to-end.ts';
const TESTS = ['test/unit/scripts/end-to-end.test.ts'];
const m = (id: string, what: string, find: string, replace: string): Mutation => ({
  id,
  what,
  file: FILE,
  tests: TESTS,
  find,
  replace,
});

export const MUTATIONS: readonly Mutation[] = [
  m(
    'E1',
    'the outgoing body is not searched for planted values',
    'for (const label of plantedIn(body, state.forms)) {',
    "for (const label of plantedIn('', state.forms)) {",
  ),
  m(
    'E2',
    'no value is looked for as its digits without separators',
    "if (digits !== '' && digits !== value) {",
    'if (false) {',
  ),
  m(
    'E3',
    'the search is case-sensitive',
    'const lower = text.toLowerCase();',
    'const lower = text;',
  ),
  m(
    'E4',
    'log lines written before sending are not searched',
    "for (const label of plantedIn(state.logs.join(''), state.forms)) {",
    "for (const label of plantedIn('', state.forms)) {",
  ),
  m(
    'E5',
    'a body that is not the registered one is sent',
    'if (difference !== undefined) refused.push(',
    'if (false) refused.push(',
  ),
  m(
    'E6',
    "a request to another address than the provider's is sent",
    'if (!url.startsWith(providerBase)) {',
    'if (false) {',
  ),
  m(
    'E7',
    'a body that is not text is sent unchecked',
    'if (body === undefined) refused.push(',
    'if (false) refused.push(',
  ),
  m(
    'E8',
    'a refused request is sent anyway',
    "if (refused.length > 0) throw new Error('refused before sending');",
    '',
  ),
  m(
    'E9',
    'log lines are not searched once the call is over',
    "plantedInLogs: plantedIn(state.logs.join(''), state.forms),",
    'plantedInLogs: [],',
  ),
  m(
    'E10',
    'a call not answered 200 does not stop the run',
    'if (outcome.clientStatus !== 200) {',
    'if (false) {',
  ),
  m(
    'E12',
    'a provider status other than 200 or 400 is not a stop of its own',
    'if (provider !== undefined && provider !== 200 && provider !== 400) {',
    'if (false) {',
  ),
  m('E13', 'E2 follows E1 at once', 'if (i > 0) await options.sleep(spacingMs);', ''),
  m(
    'E14',
    'the spacing is not 15 s',
    'export const SPACING_MS = 15_000;',
    'export const SPACING_MS = 1_500;',
  ),
  m('E15', 'the outgoing model is not compared', 'if (json.model !== MODEL) {', 'if (false) {'),
  m('E16', 'extra messages pass', 'if (messages.length !== 2)', 'if (messages.length < 2)'),
  m('E17', 'the roles are not compared', 'if (got.role !== want.role) return', 'if (false) return'),
  m('E18', 'extra fields in a message pass', "if (fields !== 'content, role')", 'if (false)'),
  m(
    'E19',
    'only the first gateway is started before the calls',
    'for (const call of calls) gateways.push(await options.startGateway(call, sink));',
    'for (const call of calls.slice(0, 1)) gateways.push(await options.startGateway(call, sink));',
  ),
  m('E20', 'fetch is not put back', 'globalThis.fetch = realFetch;', ''),
  m(
    'E21',
    'names are on for both calls',
    "PSEUDONYM_NAMES: call.names ? 'true' : 'false',",
    "PSEUDONYM_NAMES: 'true',",
  ),
  m(
    'E22',
    'the model can come from the process environment',
    'PSEUDONYM_MODEL: MODEL,',
    'PSEUDONYM_MODEL: process.env.PSEUDONYM_MODEL ?? MODEL,',
  ),
  m(
    'E23',
    'a provider request outside a call does not stop the run',
    'if (stopped === undefined && recorder.stray.length > 0)',
    'if (false)',
  ),
  m(
    'E24',
    'start-up log lines are not searched',
    'if (stopped === undefined && setupPlanted.length > 0)',
    'if (false)',
  ),
  m(
    'E25',
    'a refused body is recorded as sent',
    "const kind = exchange.refused.length > 0 ? 'refused' : 'sent';",
    "const kind = 'sent';",
  ),
  m(
    'E26',
    'more than one provider request in a call does not stop the run',
    'if (outcome.sent > 1) return',
    'if (false) return',
  ),
  m(
    'E27',
    'a refusal is not a stop of its own',
    'if (outcome.refused.length > 0) return',
    'if (false) return',
  ),
  m(
    'E28',
    'a planted value in a log line is not a stop of its own',
    'if (outcome.plantedInLogs.length > 0) return',
    'if (false) return',
  ),
  m(
    'E29',
    'a value JSON would escape is searched for anyway',
    'if (JSON.stringify(form.text) !== `"${form.text}"`) {',
    'if (false) {',
  ),
  m('E30', 'a stop does not stop the run', 'if (stopped !== undefined) break;', ''),
  // The log files (ADR-041 section 17, amendment 2026-10-15, ruling 1).
  m(
    'E31',
    "a call's log file keeps the machine's name",
    'options.write(`${call.id}.log.txt`, written.text);',
    "options.write(`${call.id}.log.txt`, state.logs.join(''));",
  ),
  m(
    'E32',
    "the start-up log file keeps the machine's name",
    "options.write('setup.log.txt', written.text);",
    "options.write('setup.log.txt', setupLogs.join(''));",
  ),
  m('E33', 'the name is replaced only in the case written', "'gi');", "'g');"),
  m(
    'E34',
    'the name is read as a pattern',
    'const pattern = new RegExp(host.replace(',
    'const pattern = new RegExp(host || host.replace(',
  ),
  m('E35', 'the replacements are not counted', 'replaced++;', ''),
  m(
    'E36',
    'the log lines are checked after the name is replaced',
    "plantedInLogs: plantedIn(state.logs.join(''), state.forms),",
    "plantedInLogs: plantedIn(withoutHostname(state.logs.join(''), host).text, state.forms),",
  ),
];

// Fetches the name lists for the Phase 6 names dataset from Wikidata (CC0)
// and writes src/synthetic/wikidata-names.ts (ADR-035).
//
// For each Indian state and union territory: the given names (P735) and
// family names (P734) of humans with Indian citizenship born in a place
// inside it, with how many people carry each. States are grouped into
// regions. "international" is the cricketers of the United Kingdom,
// Australia and New Zealand born in 1950 or later: names Indian users
// mention, from a query small enough for the query service (all UK citizens
// timed out). Only single names and counts come back; never a person.
//
// Each name is put in one of two disjoint halves by a hash of its spelling:
// the dataset draws from `eval`, candidate F's name list from `gazetteer`,
// so no candidate has the dataset's names in its own list.
//
// Run with `npm run gen:names`. It takes several minutes (one query per
// state and property, one at a time, as the service asks).

import { writeFileSync } from 'node:fs';

const ENDPOINT = 'https://query.wikidata.org/sparql';
const USER_AGENT = 'pseudonym-gateway-eval/0.1 (synthetic test data; github.com/krishnendu-9)';
const OUT_FILE = new URL('../src/synthetic/wikidata-names.ts', import.meta.url);
/** Names kept per region and kind, the most frequent first. */
const PER_REGION = 160;
const PAUSE_MS = 1_000;

const REGIONS = ['north', 'south', 'east', 'north-east', 'west', 'international'] as const;
type Region = (typeof REGIONS)[number];

// States and union territories by region. "north" is the north and the
// Hindi-speaking centre and east (Bihar, Jharkhand), whose names are alike.
const STATE_REGION: Readonly<Record<string, Region>> = {
  Q9357528: 'north', // Delhi
  Q66278313: 'north', // Jammu and Kashmir
  Q200667: 'north', // Ladakh
  Q120971341: 'north', // Chandigarh
  Q1174: 'north', // Haryana
  Q1177: 'north', // Himachal Pradesh
  Q22424: 'north', // Punjab
  Q1437: 'north', // Rajasthan
  Q1498: 'north', // Uttar Pradesh
  Q1499: 'north', // Uttarakhand
  Q1188: 'north', // Madhya Pradesh
  Q1168: 'north', // Chhattisgarh
  Q1165: 'north', // Bihar
  Q1184: 'north', // Jharkhand
  Q1445: 'south', // Tamil Nadu
  Q1186: 'south', // Kerala
  Q1185: 'south', // Karnataka
  Q1159: 'south', // Andhra Pradesh
  Q677037: 'south', // Telangana
  Q66743: 'south', // Puducherry
  Q26927: 'south', // Lakshadweep
  Q40888: 'south', // Andaman and Nicobar Islands
  Q1356: 'east', // West Bengal
  Q22048: 'east', // Odisha
  Q1164: 'north-east', // Assam
  Q1162: 'north-east', // Arunachal Pradesh
  Q1193: 'north-east', // Manipur
  Q1195: 'north-east', // Meghalaya
  Q1502: 'north-east', // Mizoram
  Q1599: 'north-east', // Nagaland
  Q1363: 'north-east', // Tripura
  Q1505: 'north-east', // Sikkim
  Q1061: 'west', // Gujarat
  Q1191: 'west', // Maharashtra
  Q1171: 'west', // Goa
  Q77997266: 'west', // Dadra and Nagar Haveli and Daman and Diu
};
const CRICKET_COUNTRIES = ['Q145', 'Q408', 'Q664']; // UK, Australia, New Zealand

const KINDS = { given: 'P735', family: 'P734' } as const;
type Kind = keyof typeof KINDS;

// One capitalised word of ASCII letters, with an optional D'/O'/Mc/Mac
// prefix or one hyphenated part. Initials ("K."), which Wikidata lists as
// given names in the south, and labels with spaces are left out.
const LATIN = /^(?:[A-Z]'|Mc|Mac)?[A-Z][a-z]+(?:-[A-Z][a-z]+)?$/;
// Devanagari letters and signs, no danda and no digits.
const DEVANAGARI = /^[ऀ-ॣॱ-ॿ]{2,}$/u;

interface Row {
  readonly item: string;
  readonly latin: string | undefined;
  readonly devanagari: string | undefined;
  readonly count: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function query(sparql: string): Promise<Row[]> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${ENDPOINT}?query=${encodeURIComponent(sparql)}`, {
      headers: { Accept: 'application/sparql-results+json', 'User-Agent': USER_AGENT },
    });
    if (response.ok) {
      const body = (await response.json()) as {
        results: { bindings: Record<string, { value: string } | undefined>[] };
      };
      return body.results.bindings.map((b) => ({
        item: b.item!.value.replace('http://www.wikidata.org/entity/', ''),
        latin: b.en?.value,
        devanagari: b.hi?.value,
        count: Number(b.n!.value),
      }));
    }
    if (attempt === 3) throw new Error(`query failed with HTTP ${response.status}`);
    await sleep(PAUSE_MS * 10 * attempt);
  }
}

const labels = `
  OPTIONAL { ?item rdfs:label ?en FILTER(LANG(?en) = "en") }
  OPTIONAL { ?item rdfs:label ?hi FILTER(LANG(?hi) = "hi") }`;

const stateQuery = (state: string, property: string): string => `
SELECT ?item ?en ?hi (COUNT(DISTINCT ?person) AS ?n) WHERE {
  ?person wdt:P31 wd:Q5; wdt:P27 wd:Q668; wdt:P19 ?place; wdt:${property} ?item.
  ?place wdt:P131+ wd:${state}.${labels}
} GROUP BY ?item ?en ?hi ORDER BY DESC(?n) LIMIT 400`;

const cricketQuery = (country: string, property: string): string => `
SELECT ?item ?en ?hi (COUNT(DISTINCT ?person) AS ?n) WHERE {
  ?person wdt:P27 wd:${country}; wdt:P106 wd:Q12299841; wdt:P569 ?born; wdt:${property} ?item.
  FILTER(YEAR(?born) >= 1950)${labels}
} GROUP BY ?item ?en ?hi ORDER BY DESC(?n) LIMIT 400`;

// FNV-1a over the lower-cased spelling: the same name always lands in the
// same half, whichever item (a male and a female "Kiran") it came from.
function half(latin: string): 'eval' | 'gazetteer' {
  let hash = 0x811c9dc5;
  for (const ch of latin.toLowerCase()) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 2 === 0 ? 'eval' : 'gazetteer';
}

interface Name {
  latin: string;
  devanagari: string | undefined;
  count: number;
}

/** Merges rows by spelling, keeps well-formed ones, most frequent first. */
function topNames(rows: readonly Row[]): Name[] {
  const bySpelling = new Map<string, Name>();
  for (const row of rows) {
    if (row.latin === undefined || !LATIN.test(row.latin)) continue;
    const devanagari =
      row.devanagari !== undefined && DEVANAGARI.test(row.devanagari) ? row.devanagari : undefined;
    const name = bySpelling.get(row.latin) ?? { latin: row.latin, devanagari, count: 0 };
    name.count += row.count;
    name.devanagari ??= devanagari;
    bySpelling.set(row.latin, name);
  }
  return [...bySpelling.values()]
    .sort((a, b) => b.count - a.count || (a.latin < b.latin ? -1 : 1))
    .slice(0, PER_REGION);
}

const rows: Record<Region, Record<Kind, Row[]>> = Object.fromEntries(
  REGIONS.map((region) => [region, { given: [], family: [] }]),
) as unknown as Record<Region, Record<Kind, Row[]>>;

const jobs: { region: Region; kind: Kind; sparql: string }[] = [];
for (const [state, region] of Object.entries(STATE_REGION)) {
  for (const [kind, property] of Object.entries(KINDS) as [Kind, string][]) {
    jobs.push({ region, kind, sparql: stateQuery(state, property) });
  }
}
for (const country of CRICKET_COUNTRIES) {
  for (const [kind, property] of Object.entries(KINDS) as [Kind, string][]) {
    jobs.push({ region: 'international', kind, sparql: cricketQuery(country, property) });
  }
}

for (const [i, job] of jobs.entries()) {
  rows[job.region][job.kind].push(...(await query(job.sparql)));
  console.log(`${i + 1}/${jobs.length} queries done`);
  await sleep(PAUSE_MS);
}

const fetched = new Date().toISOString().slice(0, 10);
const counts: string[] = [];
const entries: string[] = [];
const tuple = (n: Name): string =>
  JSON.stringify(n.devanagari === undefined ? [n.latin] : [n.latin, n.devanagari]);
for (const region of REGIONS) {
  const parts: string[] = [];
  const summary: string[] = [];
  for (const kind of Object.keys(KINDS) as Kind[]) {
    const names = topNames(rows[region][kind]);
    const withHindi = names.filter((n) => n.devanagari !== undefined).length;
    summary.push(`${names.length} ${kind} (${withHindi} with a Hindi label)`);
    for (const which of ['eval', 'gazetteer'] as const) {
      const chosen = names.filter((n) => half(n.latin) === which);
      parts.push(
        `${which}${kind === 'given' ? 'Given' : 'Family'}: [${chosen.map(tuple).join(', ')}],`,
      );
    }
  }
  counts.push(`//   ${region}: ${summary.join(', ')}`);
  entries.push(`'${region}': { ${parts.join(' ')} },`);
}

const source = `// GENERATED by scripts/fetch-wikidata-names.ts on ${fetched} (UTC). Do not edit by hand.
// Source: Wikidata, CC0 1.0 (https://www.wikidata.org/wiki/Wikidata:Licensing).
//
// Given names (P735) and family names (P734) of humans with Indian
// citizenship, by the region of the state their place of birth lies in;
// "international": cricketers of the UK, Australia and New Zealand born in
// 1950 or later. The ${PER_REGION} most frequent of each per region, after
// leaving out initials and labels that are not one capitalised word:
${counts.join('\n')}
//
// Each entry is [Latin spelling, Devanagari spelling if Wikidata has one].
// Single names only: no person and no pair of names is stored here. The
// two halves are disjoint by spelling (ADR-035): the names dataset uses
// \`eval\`, the name-list candidate uses \`gazetteer\`.

export const NAME_REGIONS = ${JSON.stringify(REGIONS).replaceAll('"', "'")} as const;
export type NameRegion = (typeof NAME_REGIONS)[number];

/** A name: its Latin spelling, and its Devanagari spelling if known. */
export type NamePart = readonly [latin: string, devanagari?: string];

export interface RegionNames {
  readonly evalGiven: readonly NamePart[];
  readonly evalFamily: readonly NamePart[];
  readonly gazetteerGiven: readonly NamePart[];
  readonly gazetteerFamily: readonly NamePart[];
}

export const WIKIDATA_NAMES_FETCHED = '${fetched}';

export const WIKIDATA_NAMES: Readonly<Record<NameRegion, RegionNames>> = {
${entries.join('\n')}
};
`;
writeFileSync(OUT_FILE, source);
console.log(`wrote src/synthetic/wikidata-names.ts`);

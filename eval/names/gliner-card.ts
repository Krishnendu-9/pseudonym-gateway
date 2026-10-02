// Checking the GLiNER port (candidate D) against the example its model card
// publishes with expected output (the user's decision after the 6a run,
// 2026-10-03): if the port reproduces it, D's numbers stand; if not, D is
// "port unverified, results excluded".
//
// The card is fetched when the check runs and is never stored in the repo:
// its example holds a phone number and an email address.

export interface CardExample {
  readonly text: string;
  readonly labels: readonly string[];
  readonly expected: readonly { readonly text: string; readonly label: string }[];
}

/**
 * The example in a GLiNER model card's README: the Python `text = """…"""`,
 * the `labels = [...]` list, and the `text => label` lines of the output
 * block after it. Undefined when any of the three is missing.
 */
export function parseCard(readme: string): CardExample | undefined {
  const text = /text = """([\s\S]*?)"""/.exec(readme)?.[1];
  const labelList = /labels = (\[[^\]]*\])/.exec(readme)?.[1];
  if (text === undefined || labelList === undefined) return undefined;
  let labels: unknown;
  try {
    labels = JSON.parse(labelList);
  } catch {
    return undefined;
  }
  if (!Array.isArray(labels) || !labels.every((l) => typeof l === 'string')) return undefined;
  const afterCode = readme.slice(readme.indexOf(labelList));
  const output = /```\s*\n([\s\S]*?)```/.exec(afterCode.slice(afterCode.indexOf('```') + 3));
  const expected = (output?.[1] ?? '')
    .split('\n')
    .map((line) => /^(.+?) => (.+)$/.exec(line.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ text: m[1]!, label: m[2]! }));
  if (expected.length === 0) return undefined;
  return { text, labels, expected };
}

export interface CardVerdict {
  /** Per expected entity, in the card's order: its label and what the port did. */
  readonly rows: readonly { readonly label: string; readonly result: Outcome }[];
  /** Entities the port found that the card does not list, by label. */
  readonly extra: readonly string[];
  readonly reproduced: boolean;
}

export type Outcome = 'reproduced' | 'other label' | 'missing';

/** Compares what the port found with the card's expected output, exactly (text and label). */
export function compareCard(
  expected: CardExample['expected'],
  found: readonly { readonly text: string; readonly label: string }[],
): CardVerdict {
  const used = new Set<number>();
  const rows = expected.map((e) => {
    const exact = found.findIndex(
      (f, i) => !used.has(i) && f.text === e.text && f.label === e.label,
    );
    if (exact >= 0) {
      used.add(exact);
      return { label: e.label, result: 'reproduced' as const };
    }
    const sameText = found.findIndex((f, i) => !used.has(i) && f.text === e.text);
    if (sameText >= 0) {
      used.add(sameText);
      return { label: e.label, result: 'other label' as const };
    }
    return { label: e.label, result: 'missing' as const };
  });
  const extra = found.filter((_, i) => !used.has(i)).map((f) => f.label);
  return {
    rows,
    extra,
    reproduced: rows.every((r) => r.result === 'reproduced') && extra.length === 0,
  };
}

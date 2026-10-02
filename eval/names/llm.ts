// Candidate E: the local LLM, asked for the names in a text. It answers
// with strings, not offsets, so each name it gives is looked for in the
// text: every whole-word occurrence becomes a span (score 1), and a name
// that is not in the text at all is counted as invented.

import type { ScoredSpan } from './spans.js';

export const NAMES_PROMPT =
  "List every person's name in the user's text, exactly as it is written there. " +
  'Reply with a JSON array of strings and nothing else, or [] if there is none.';

export function namesMessages(text: string): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: NAMES_PROMPT },
    { role: 'user', content: text },
  ];
}

/**
 * The names in the model's answer: the JSON array of strings it holds
 * (inside a code fence or not), or undefined if it holds none.
 */
export function parseNames(answer: string): string[] | undefined {
  const open = answer.indexOf('[');
  const close = answer.lastIndexOf(']');
  if (open < 0 || close < open) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.slice(open, close + 1));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || !parsed.every((n) => typeof n === 'string')) return undefined;
  return parsed;
}

const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;
const isWordChar = (ch: string | undefined): boolean => ch !== undefined && WORD_CHAR.test(ch);

/** Where the names occur in the text, as whole words; and how many occur nowhere. */
export function locate(
  text: string,
  names: readonly string[],
): { spans: ScoredSpan[]; invented: number } {
  const spans: ScoredSpan[] = [];
  let invented = 0;
  for (const name of new Set(names.map((n) => n.trim()).filter((n) => n !== ''))) {
    let found = false;
    for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
      if (!isWordChar(text[at - 1]) && !isWordChar(text[at + name.length])) {
        spans.push({ start: at, end: at + name.length, score: 1 });
        found = true;
      }
    }
    if (!found) invented++;
  }
  return { spans, invented };
}

// The latency added by a name detector at realistic request sizes, and
// what the text costs each model in tokens (Phase 6a; asked for by the
// user after the first run, reported beside ADR-035's ms per KiB, which
// stays the rule's measure).

/** Request sizes measured, in KiB. */
export const LATENCY_SIZES_KIB = [1, 4, 16, 64] as const;

/** The middle value (the lower middle of an even count); undefined for none. */
export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

const DEVANAGARI = /\p{Script=Devanagari}/u;

export interface TokenCount {
  readonly kib: number;
  readonly tokens: number;
}

/**
 * Tokens per KiB of UTF-8, for the messages with Devanagari letters in them,
 * for the rest, and for all, from each message's token count.
 */
export function tokensByScript(
  messages: readonly string[],
  count: (text: string) => number,
): Record<'devanagari' | 'latin' | 'all', TokenCount> {
  const out = {
    devanagari: { kib: 0, tokens: 0 },
    latin: { kib: 0, tokens: 0 },
    all: { kib: 0, tokens: 0 },
  };
  for (const text of messages) {
    const kib = Buffer.byteLength(text) / 1024;
    const tokens = count(text);
    for (const key of [DEVANAGARI.test(text) ? 'devanagari' : 'latin', 'all'] as const) {
      out[key].kib += kib;
      out[key].tokens += tokens;
    }
  }
  return out;
}

/** Tokens per KiB; 0 for no text. */
export const perKiB = (c: TokenCount): number => (c.kib === 0 ? 0 : c.tokens / c.kib);

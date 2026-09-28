// Per-request placeholder <-> value map ("Stateless, deterministic
// redaction" in CLAUDE.md). One instance lives for the lifetime of one
// request, including its stream, and is then discarded: never logged,
// serialised or written to disk.
//
// Indices are assigned by order of first appearance, one counter per
// namespace (ADR-002). A value is looked up by its *value key*: a
// type-specific normalised form (ADR-013) so the same person, card or email
// written two different ways still gets one placeholder. The placeholder
// restores to the first surface form seen (`value`), not the key.
//
// Loose variants of a placeholder already present in the user's own text
// (`Person 1`, `PAN_1`) must never be confused with a real detection at the
// same index (ADR-002). `reserve` records that an index is also a loose
// variant: if no real value holds that index yet, it is skipped when one is
// assigned later; if one already does, that entry becomes exact-only
// (ADR-013), so restoration will only ever rewrite the bracketed form back,
// never a bare one. Reservations only affect indices at or after the point
// they are seen: an index already assigned keeps its number, so the prefix
// already sent to the provider for an earlier message never changes.

import { formatPlaceholder, MAX_PLACEHOLDER_INDEX, PlaceholderLimitError } from './placeholder.js';
import type { PlaceholderNamespace } from './placeholder.js';

interface Entry {
  readonly index: number;
  readonly value: string;
  exactOnly: boolean;
}

interface NamespaceState {
  readonly byKey: Map<string, Entry>;
  readonly byIndex: Map<number, Entry>;
  readonly reserved: Set<number>;
  nextIndex: number;
}

export class PlaceholderMapping {
  readonly #namespaces = new Map<PlaceholderNamespace, NamespaceState>();

  #stateFor(namespace: PlaceholderNamespace): NamespaceState {
    let state = this.#namespaces.get(namespace);
    if (!state) {
      state = { byKey: new Map(), byIndex: new Map(), reserved: new Set(), nextIndex: 1 };
      this.#namespaces.set(namespace, state);
    }
    return state;
  }

  /**
   * Returns the placeholder for `key` in `namespace`, assigning the next
   * free index the first time this key is seen (skipping any index already
   * reserved by a loose variant). Later calls with the same key return the
   * same placeholder and keep its first surface form.
   */
  getOrAssign(namespace: PlaceholderNamespace, key: string, value: string): string {
    const state = this.#stateFor(namespace);
    let entry = state.byKey.get(key);
    if (!entry) {
      let index = state.nextIndex;
      while (state.reserved.has(index)) index++;
      if (index > MAX_PLACEHOLDER_INDEX) throw new PlaceholderLimitError(namespace);
      state.nextIndex = index + 1;
      entry = { index, value, exactOnly: false };
      state.byKey.set(key, entry);
      state.byIndex.set(index, entry);
    }
    return formatPlaceholder(namespace, entry.index);
  }

  /**
   * Records that `index` in `namespace` is also a loose variant found in the
   * user's own text (ADR-002, ADR-013).
   */
  reserve(namespace: PlaceholderNamespace, index: number): void {
    const state = this.#stateFor(namespace);
    const entry = state.byIndex.get(index);
    if (entry) entry.exactOnly = true;
    else state.reserved.add(index);
  }

  /**
   * The real value and restoration mode for a placeholder, or undefined if
   * `namespace`/`index` was never assigned in this request.
   */
  lookup(
    namespace: PlaceholderNamespace,
    index: number,
  ): { value: string; exactOnly: boolean } | undefined {
    const entry = this.#namespaces.get(namespace)?.byIndex.get(index);
    return entry ? { value: entry.value, exactOnly: entry.exactOnly } : undefined;
  }
}

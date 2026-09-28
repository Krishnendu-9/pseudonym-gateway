import type { Span } from '../../src/detection/normalise.js';

/**
 * Builds a message from a template and records where each interpolated value
 * landed, so tests can compare detections against offsets instead of values.
 * A failing `expect` then prints numbers, never a generated value (ADR-009).
 *
 *   const { text, spans } = compose`Aadhaar: ${value}.`;
 *   // spans[0] = { start: 9, end: 9 + value.length }
 */
export function compose(
  strings: TemplateStringsArray,
  ...values: string[]
): { text: string; spans: Span[] } {
  let text = strings[0]!;
  const spans: Span[] = [];
  values.forEach((value, i) => {
    spans.push({ start: text.length, end: text.length + value.length });
    text += value + strings[i + 1]!;
  });
  return { text, spans };
}

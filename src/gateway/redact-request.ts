// Turns a validated request into what the provider receives (ADR-014).
//
// Every piece of client text goes through redactMessage() against the one
// per-request mapping, in a fixed order: messages in conversation order
// (each message's text parts in order), then `stop`. That order is what
// makes numbering deterministic and means appending a message never
// renumbers an earlier one. `stop` comes last because it only matters to
// this one request; a stop sequence containing a value is redacted to the
// same placeholder the model will actually write, so it still matches.
//
// Text parts are joined into one string before detection, and that one
// string is what is sent. Detection therefore runs on exactly the text the
// provider receives: a value split across two parts cannot slip through
// because each half looked harmless on its own. The separator is a space,
// not a newline: spaces are number separators to the detectors, so a card
// split at a group boundary (`4111 1111` + `1111 1111`) is one card again,
// while a line break between groups is not detected at all (a known
// detection gap, README; Phase 5).

import type {
  ProviderChatRequest,
  ProviderMessage,
  SamplingOptions,
} from '../providers/provider.js';
import type { PlaceholderMapping } from '../redaction/mapping.js';
import {
  NameTextMismatchError,
  redactMessage,
  type NameSpans,
  type RedactedText,
} from '../redaction/redact.js';
import { PLACEHOLDER_INSTRUCTION } from './instruction.js';
import type { ChatMessage, ChatRequest } from './schema.js';

/** The separator between a message's text parts (see above). */
export const PART_SEPARATOR = ' ';

const messageText = (content: ChatMessage['content']): string =>
  typeof content === 'string' ? content : content.map((part) => part.text).join(PART_SEPARATOR);

function samplingOptions(request: ChatRequest): SamplingOptions {
  const options: Record<string, unknown> = {};
  const copy = (key: keyof SamplingOptions, value: unknown): void => {
    if (value !== null && value !== undefined) options[key] = value;
  };
  copy('temperature', request.temperature);
  copy('top_p', request.top_p);
  copy('max_tokens', request.max_completion_tokens ?? request.max_tokens);
  copy('seed', request.seed);
  copy('frequency_penalty', request.frequency_penalty);
  copy('presence_penalty', request.presence_penalty);
  copy('reasoning_effort', request.reasoning_effort);
  copy('response_format', request.response_format);
  return options as SamplingOptions;
}

/**
 * Every piece of client text, in the order redactRequest() redacts it: each
 * message's text (its parts joined), then each stop sequence. The name
 * finder runs on exactly these strings (ADR-037), so the names it finds
 * belong to the text that is redacted and sent.
 */
export function requestTexts(request: ChatRequest): string[] {
  const stop = typeof request.stop === 'string' ? [request.stop] : (request.stop ?? []);
  return [...request.messages.map((message) => messageText(message.content)), ...stop];
}

export interface RedactRequestOptions {
  /** Add PLACEHOLDER_INSTRUCTION when the request contains any placeholder (ADR-017). */
  readonly placeholderInstruction: boolean;
  /**
   * With names on: the names found in requestTexts(request), one entry per
   * text, in the same order (ADR-037). Each must carry its own text.
   */
  readonly names?: readonly NameSpans[];
}

export function redactRequest(
  request: ChatRequest,
  mapping: PlaceholderMapping,
  options: RedactRequestOptions,
): ProviderChatRequest {
  const texts = requestTexts(request);
  const { names } = options;
  if (names !== undefined && names.length !== texts.length) throw new NameTextMismatchError();
  const redacted = texts.map((text, i) => redactMessage(text, mapping, names?.[i]));

  const messages: ProviderMessage[] = request.messages.map((message, i) => ({
    role: message.role,
    content: redacted[i]!,
  }));

  const stop: RedactedText[] | undefined =
    request.stop === undefined || request.stop === null
      ? undefined
      : redacted.slice(request.messages.length);

  // Added after redaction, so its own text is never treated as a literal.
  if (options.placeholderInstruction && mapping.size > 0) {
    messages.unshift({ role: 'system', content: PLACEHOLDER_INSTRUCTION });
  }

  return {
    messages,
    options: samplingOptions(request),
    ...(stop === undefined ? {} : { stop }),
  };
}

// Option 3 (ADR-041 sections 13 and 16): a field or value the configured
// provider and model were measured refusing is refused here, with a 400
// naming the field, before anything else happens to the request. No
// redaction, no name detection and no provider call, so a request that would
// be refused anyway sends no redacted text anywhere.
//
// The message names the field (one of REFUSABLE_FIELDS, never a request key)
// and nothing else: not the model, not the provider, not the value sent
// (section 16). The `values` message lists no allowed values: a list would
// claim that every value outside it is refused, and only measured values are.

import {
  REFUSABLE_FIELDS,
  type ModelRefusals,
  type RefusableField,
  type RefusalRule,
} from '../providers/openai-compatible.js';
import { GatewayError } from './errors.js';
import type { ChatRequest } from './schema.js';

const SCOPE = 'for the configured provider and model';

// Whether `value` (present, not null) is refused by `rule`. Zero is the parsed
// value === 0, so -0 counts: the outgoing body is written with JSON.stringify,
// which sends -0 as 0, exactly what was measured accepted (section 16, E).
function refuses(rule: RefusalRule, value: string | number): boolean {
  switch (rule.kind) {
    case 'any':
      return true;
    case 'nonzero':
      return value !== 0;
    case 'values':
      return rule.values.includes(value);
  }
}

function refusal(field: RefusableField, rule: RefusalRule): GatewayError {
  switch (rule.kind) {
    case 'any':
      return new GatewayError(
        400,
        'unsupported_parameter',
        `${field} is not supported by the configured provider and model`,
        {},
        field,
      );
    case 'nonzero':
      return new GatewayError(
        400,
        'unsupported_value',
        `${field} must be 0 or unset ${SCOPE}`,
        {},
        field,
      );
    case 'values':
      return new GatewayError(
        400,
        'unsupported_value',
        `${field} does not support this value ${SCOPE}`,
        {},
        field,
      );
  }
}

/**
 * The first refused field of `request` under `refusals`, as the error to
 * return, or undefined. Fields are checked in REFUSABLE_FIELDS order. A field
 * left unset or set to null is never refused: it is not sent.
 */
export function refusedParameter(
  request: ChatRequest,
  refusals: ModelRefusals | undefined,
): GatewayError | undefined {
  if (refusals === undefined) return undefined;
  for (const field of REFUSABLE_FIELDS) {
    const rule = refusals[field];
    const value = request[field];
    if (rule === undefined || value === undefined || value === null) continue;
    if (refuses(rule, value)) return refusal(field, rule);
  }
  return undefined;
}

// The system message asking the model to copy placeholders exactly
// (ADR-017, provisional until Phase 5 measures it). A model that rewrites
// `[EMAIL_1]` as "email 1" leaves that value unrestored in the answer;
// every such rewrite works against "the answer still reads naturally".
//
// Its example is `[TYPE_N]`, never a real namespace such as `[EMAIL_1]`: if
// the model echoed a real-looking example, restoration would write a real
// value into the answer where no one mentioned it. `TYPE` is not a
// namespace and `N` is not an index, so `restore()` never touches it and
// `detect()` finds nothing in it (both tested).

import type { RedactedText } from '../redaction/redact.js';

// Pseudonym's own fixed text, containing no personal data: the one string
// that becomes RedactedText without passing through redactMessage().
export const PLACEHOLDER_INSTRUCTION =
  ('Some values in this conversation were replaced with placeholders in square brackets, ' +
    'such as [TYPE_N]. Whenever you mention one of those values, write its placeholder ' +
    'exactly as it appears, brackets included.') as RedactedText;

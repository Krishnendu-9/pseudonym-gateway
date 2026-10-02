// The 15 tasks of the model-rewrite measurement (Phase 5d part 4,
// ADR-017). Each asks the model to repeat every value it is given, in the
// kinds of output people ask for: a reply, a form, a translation, a table,
// a log line, code. Written with the evaluation's slots (slots.ts), so the
// values are generated in memory from the seed (ADR-009) and none is in
// this file. Fixed before the first model call; never tuned to a result.

import type { RawCase, RawMessage } from './format.js';
import { renderCase } from './render.js';
import type { LabelledCase, Role } from './types.js';

/** The seed the values are generated from, and the one the model samples with. */
export const REWRITE_SEED = 20_261_002;

interface Task {
  readonly id: string;
  /** What the task asks for, in a few words (the report's row label). */
  readonly what: string;
  readonly messages: readonly (readonly [Role, string])[];
}

export const REWRITE_TASKS: readonly Task[] = [
  {
    id: 'reply',
    what: 'a reply confirming contact details',
    messages: [
      [
        'user',
        'Write a two-sentence reply to a customer confirming that their contact details are now email {{EMAIL}} and mobile {{PHONE:+91 ##########}}. Repeat both in the reply.',
      ],
    ],
  },
  {
    id: 'json',
    what: 'a JSON object',
    messages: [
      [
        'user',
        'Turn this into a JSON object with the keys email, phone and pan, and nothing else: email {{EMAIL}}, phone {{PHONE}}, PAN {{PAN}}.',
      ],
    ],
  },
  {
    id: 'sms',
    what: 'an SMS about a refund',
    messages: [
      [
        'user',
        'Write a short SMS telling the customer that the refund of Rs 2,000 will be sent to their UPI ID {{UPI}} within 3 working days. Include the UPI ID.',
      ],
    ],
  },
  {
    id: 'translate',
    what: 'a translation into Hindi',
    messages: [
      [
        'user',
        'Translate into Hindi, keeping the numbers as they are: "My PAN is {{PAN}} and my Aadhaar number is {{AADHAAR:#### #### ####}}."',
      ],
    ],
  },
  {
    id: 'summary',
    what: 'a one-line summary',
    messages: [
      [
        'user',
        'Summarise this ticket in one line, keeping the card number and the account number: "Hi, my card {{CARD:#### #### #### ####}} was charged twice and the money has not come back to account number {{NUMBER:############}}. Please help."',
      ],
    ],
  },
  {
    id: 'table',
    what: 'a markdown table',
    messages: [
      [
        'user',
        'Make a markdown table with the columns Field and Value for these bank details: IFSC {{IFSC}}, account number {{NUMBER:##############}}, UPI ID {{UPI}}.',
      ],
    ],
  },
  {
    id: 'formal',
    what: 'a formal rewrite',
    messages: [
      [
        'user',
        'Rewrite this in formal English: "hey pls send the invoice to {{EMAIL}} or call me on {{PHONE:##### #####}}, thx"',
      ],
    ],
  },
  {
    id: 'extract',
    what: 'a bullet list of contacts',
    messages: [
      [
        'user',
        'List every email address and phone number in this text as bullet points: "Reach the office at {{EMAIL}} or {{PHONE:0##########}}. After hours, write to {{EMAIL}}."',
      ],
    ],
  },
  {
    id: 'log',
    what: 'a log line',
    messages: [
      [
        'user',
        'Write one log line, in the format "<level> <message>", for a blocked login attempt from IP address {{IP=203.0.113.77}} on the account {{EMAIL}}.',
      ],
    ],
  },
  {
    id: 'grammar',
    what: 'a grammar correction',
    messages: [
      [
        'user',
        'Correct the grammar, changing nothing else: "me passport number is {{PASSPORT}} and my date of birth are {{DOB}}, please verify it"',
      ],
    ],
  },
  {
    id: 'bank-email',
    what: 'an email to a bank',
    messages: [
      [
        'user',
        'Write a short email to my bank asking them to block my card {{CARD}}. Mention that my registered mobile number is {{PHONE}} and my customer ID is {{NUMBER:##########}}.',
      ],
    ],
  },
  {
    id: 'chat',
    what: 'a confirmation in a three-message chat',
    messages: [
      ['user', 'My email is {{EMAIL}} and my phone is {{PHONE}}.'],
      ['assistant', 'Thank you. I have noted your email and phone number.'],
      ['user', 'Please repeat both back to me so I can check them.'],
    ],
  },
  {
    id: 'csv',
    what: 'a CSV row',
    messages: [
      [
        'user',
        'Write a CSV header and one row for this applicant: Aadhaar {{AADHAAR}}, PAN {{PAN}}, mobile {{PHONE}}, voter ID {{VOTER}}.',
      ],
    ],
  },
  {
    id: 'hinglish',
    what: 'a reply in Hinglish',
    messages: [
      [
        'user',
        'Mera UPI ID {{UPI}} hai aur refund abhi tak nahi aaya. Hinglish mein ek chhota reply likho jo mera UPI ID dohraye.',
      ],
    ],
  },
  {
    id: 'code',
    what: 'a config snippet',
    messages: [
      [
        'user',
        'Write a Python snippet that sets two variables: API_KEY to {{SECRET.openai}} and ADMIN_EMAIL to {{EMAIL}}. Just the code.',
      ],
    ],
  },
];

const message = ([role, text]: readonly [Role, string]): RawMessage => ({
  role,
  text,
  lines: text.split('\n').map(() => 0),
});

/** The tasks as raw cases (slots, no values), for the lint. */
export const rewriteRawCases = (): RawCase[] =>
  REWRITE_TASKS.map((task) => ({
    id: task.id,
    tags: [],
    line: 0,
    messages: task.messages.map(message),
  }));

/** The tasks with their values, generated in memory. */
export const rewriteCases = (seed = REWRITE_SEED): LabelledCase[] =>
  rewriteRawCases().map((raw) => renderCase(raw, seed));

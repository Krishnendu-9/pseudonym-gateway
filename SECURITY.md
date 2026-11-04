# Security policy

## What this project is

Pseudonym is a portfolio project: a gateway that replaces detected personal
data with placeholders before a chat request reaches an AI provider, and
puts the real values back in the answer. It is **not ready for production
use**, its author does not run it anywhere, and it has no known users. It is
maintained by one person in their own time. Fixes, when made, go to the
`main` branch.

## Known limits are not vulnerabilities

Detection is never complete, and the project says so. The
[threat model in the README](README.md#threat-model-summary) and its
[detail page](docs/threat-model.md) list what Pseudonym does not protect
against: values the detectors miss, anything an application logs before
calling it, a compromised host, prompt injection beyond the one
URL-exfiltration path it mitigates, and more. How much it detects is
measured and published per data type.

A report that a listed limit exists is not a vulnerability. A report that a
limit is wider than documented, or that a documented protection does not
hold, is welcome. Examples:

- a value Pseudonym **detects** still reaching the provider, in any form;
- a personal value appearing in a log line, an error response or a stack
  trace;
- a real value restored inside a URL, a markdown link or image target, or
  an HTML attribute, with the default settings;
- unsupported input (tool calls, images, other content types) forwarded
  instead of rejected;
- a request within the body limit that crashes or hangs the gateway.

## Reporting

- **In public:** open a [GitHub issue](https://github.com/Krishnendu-9/pseudonym-gateway/issues).
- **In private:** use **Report a vulnerability** on the repository's
  Security tab (GitHub's private vulnerability reporting). If that button
  is not there, open an issue asking for a private contact, without the
  details.

Use synthetic data only. Never put real personal data, or a real API key, in
a report.

There is no bounty and no promised response time. Reports are read when
the author can, and a confirmed bug and its fix are recorded in
[the bug log](docs/bug-log.md).

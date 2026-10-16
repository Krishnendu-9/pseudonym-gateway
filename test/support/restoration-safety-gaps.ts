// The known gaps of restoration safety: shapes where a placeholder in
// URL-like text is still restored. One list, used at both ends (ADR-049):
// `unsafe-regions.test.ts` checks that each is still a gap, end to end
// through `restore()`, and that `docs/threat-model.md` names each one, word
// for word. If a gap closes, its negative test fails: take it off this list
// and out of the threat model together.
//
// None is fetched by a client on its own; a user would have to click a
// linkified one. Re-derived from the code on 2026-10-16 (ADR-049's
// correction): the fourth replaces the brief's example, which the host rule
// already covers.

export interface RestorationSafetyGap {
  /** As the threat model names it. */
  readonly name: string;
  /** A text with `[AADHAAR_1]` where the gap lets it be restored. */
  readonly text: string;
}

export const RESTORATION_SAFETY_GAPS: readonly RestorationSafetyGap[] = [
  { name: 'a bare host with a query and no path', text: 'Visit a.example?d=[AADHAAR_1] now' },
  { name: 'a bare IP address with no scheme', text: 'Visit 203.0.113.9/?d=[AADHAAR_1] now' },
  {
    name: 'an unquoted HTML attribute that is not a full URL',
    text: '<img src=a.example?d=[AADHAAR_1]>',
  },
  {
    name: "a value glued to the end of a bare host's last label",
    text: 'Visit a.example-[AADHAAR_1]/p now',
  },
];

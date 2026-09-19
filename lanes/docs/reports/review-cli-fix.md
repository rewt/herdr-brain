# Review command-string follow-up report

Status: READY for operator review and promotion after the required final post-commit
gate.

## Delivered behavior

- Re-executed command and witness-command strings retain shell/machine syntax after
  path and alias sanitization. The public record serializes them inside its JSON code
  fence, so angle brackets, redirections, brackets, backticks, emphasis-like tokens,
  dollar variables, and encoded-looking command text cannot become record markup.
- The exemption is limited to the prose markup and encoded-text checks. Commands
  still receive single-line ASCII, reserved-placeholder, path, alias, residual, and
  idempotence checks. Results, observed failures, findings, fixes, Non-claims, and
  Unverified remain restricted prose.
- CRLF private records now receive the specific `private review must use LF line
  endings; CRLF is not supported` diagnostic. The template and REFERENCE state the
  LF-only rule and distinguish verbatim command strings from restricted prose.
- The review design now names Findings, Non-claims, and Unverified as the three lists
  requiring consecutive entries. Both current and change OpenSpec requirements record
  the command/prose projection boundary.
- The 39-case accepted-boundary matrix passes `--timeout 2`, bounding a future
  completion-probe regression instead of inheriting the 1800-second default.

## Regression evidence

- Baseline `npm test` passed 92/92 in 73.462 seconds after a clear process probe.
- Before implementation, the focused command fixture was refused with the production
  `projected payload contains unsupported markup or encoded text` error, the CRLF
  fixture lacked the required specific diagnostic, and the documentation control
  failed on the Findings-only design sentence. Each retained test has a deliberate
  `negativeControl` assertion.
- The accepted command regression includes `<`, `>`, backticks, `[`, `]`, `**`,
  `$VAR`, percent/HTML-looking text, and literal backslash escape syntax in both the
  top-level and witness command. It verifies both findings in the resulting public
  record and round-trips the command values through the JSON fence. The same string in
  a finding description refuses; command-specific reserved-placeholder and non-ASCII
  cases also refuse.
- Final `npm test` passed 93/93 in 81.835 seconds. The serialized
  `LANE_TEST_NEGATIVE_CONTROL=1 npm test` run produced 0 passes and all 93 deliberate
  failures in 73.878 seconds.
- `OPENSPEC_TELEMETRY=0 openspec validate --all --strict --no-interactive
  --concurrency 1` passed 16/16. `git diff --check` passed.
- Verification used Node.js v20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0.
  Every build, test, and validation command ran alone after a clear process probe.

## Limits

No live reviewer or Herdr mutation, alternate operating system, concurrent private
writer, permission-denied filesystem, push, promotion, archive, or change under
`docs/reviews/` was performed. The fake reviewer exercises the real CLI projection
boundary but does not establish that arbitrary undeclared private text can be detected.
The final post-commit `lane check` is intentionally reported only in the operator
conversation so the recorded gate names the final commit.

# Review prose escaping follow-up report

Status: READY for operator review and promotion after the required final post-commit
gate.

## Delivered behavior

- Public Findings, Non-claims, and Unverified prose now backslash-escapes backticks,
  asterisks, underscores, square brackets, and angle brackets. Reviewers write ordinary
  unescaped ASCII prose, including quoted diagnostics, usage text, and identifiers;
  Markdown and HTML render the quoted characters literally.
- Path and alias sanitization plus the idempotence rescan operate on the unescaped
  payload before display escaping. CLI-generated sanitizer placeholders remain exact
  structural atoms, and a finding description containing a declared private identifier
  is refused before an underscore or other punctuation can be escaped.
- Re-executed command and witness-command strings remain verbatim inside the public
  JSON fence. The private-only section guard now matches exact heading lines, so quoted
  `## Analysis` or `## Private identifiers` text inside a command is ordinary evidence
  rather than a false leak.
- The template Role and Required output sections, REFERENCE, change design/task, and
  current/change OpenSpec requirements now describe the same escaping and refusal
  boundary. No contract amendment was applied.

## Regression evidence

- Baseline `npm test` passed 109/109 in 108.665 seconds after a clear process probe.
- Before implementation, the three focused regressions all failed: valid quoted prose
  exited 2 with the unsupported-markup diagnostic, a finding description containing
  its declared private identifier incorrectly published with exit 0, and private-only
  heading text inside a command exited 2. Each retained regression calls
  `negativeControl`.
- The focused corrected set passed all six selected projection/documentation tests.
  It covers two findings, every escaped character, a quoted Git pathspec error,
  literal-render recovery, a declared identifier containing an underscore, exact
  command round-tripping, and line-exact private-section detection.
- Final `npm test` passed 112/112 with zero skips in 106.166 seconds. The serialized
  `LANE_TEST_NEGATIVE_CONTROL=1 npm test` run produced 0 passes and all 112 deliberate
  failures in 101.011 seconds.
- `OPENSPEC_TELEMETRY=0 openspec validate --all --strict --no-interactive
  --concurrency 1` passed 17/17. Verification used Node.js v20.19.4, npm 10.8.2,
  Git 2.54.0, and OpenSpec 1.6.0. Every test and validation command ran alone after
  a clear process probe.

## Limits

No live reviewer or Herdr mutation, alternate operating system, concurrent private
writer, permission-denied filesystem, push, promotion, archive, or change under
`docs/reviews/` was performed. The fake reviewer exercises the real CLI projection
boundary but cannot establish that arbitrary undeclared private text is absent. The
final post-commit `lane check` is reported only in the operator conversation so its
record names the final commit.

## 2026-09-10 Round 2 addendum

The Round 1 findings are closed in the review projection path. Underscores now delimit
aliases, so declared and automatic aliases wrapped in underscores are redacted. The
residual path and alias check decodes percent octets and decimal or hexadecimal numeric
character references in a scratch copy; the decoded text is never substituted into the
public prose. Literal backslashes are escaped before the other Markdown characters, and
an opening parenthesis immediately after a generated placeholder is escaped so the
placeholder cannot become a Markdown link label. A lone slash is not treated as a
private absolute path, preserving quoted `%2F` command text. Finding file-and-line values
retain their separately documented markup and encoding refusal.

The reported board-cli PASS refusal could not be reproduced from the supplied record.
The raw record was copied read-only to a system temporary directory, its invocation
metadata was rebound by the fake reviewer, and its projected sections were otherwise
unchanged. The focused regression passed through this branch, an archive of `main`, and
the installed canonical `main` entrypoint; the two main entrypoints were byte-identical.
A field-by-field scan also found no value matching main's unsupported-markup or encoded-
text expression. That diagnostic can only be emitted by `assertPublicPayloadRestrictions`
on main, but the check did not fire for this record, so there is no defensible culprit
value in the bytes now present. The observation therefore requires different record
bytes or a different executable/state at the time it occurred. A public-safe fixture
retains both original findings and representative evidence/limits, and the regression
requires validation plus projection of every finding.

The required baseline passed 112/112. Before product edits, four selected tests failed:
the underscore/encoding sanitizer group, backslash escaping, placeholder-parenthesis
escaping, and the finding-location documentation assertion. After implementation, the
five-test focus including the production-derived fixture passed, and the same five
tests all failed at their deliberate controls. The first full run passed 113/114 and
exposed the lone decoded `%2F` compatibility case; after requiring content following a
POSIX separator, the relevant focused tests passed. The final suite against the full
sanitized fixture passed 114/114 in 126.783 seconds.
`LANE_TEST_NEGATIVE_CONTROL=1 npm test` produced 0 passes and 114 deliberate failures
in 120.088 seconds. Strict OpenSpec validation passed 17/17, and
`git diff --check` passed.

No live reviewer or Herdr mutation, alternate operating system, concurrent private
writer, permission-denied filesystem, push, promotion, archive, or change under
`docs/reviews/` was performed. The supplied private records and system-temporary copies
were read-only inputs and are not tracked. The final post-commit gate remains
conversation-only evidence.

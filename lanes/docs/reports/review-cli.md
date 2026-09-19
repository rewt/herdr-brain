# Foreground lane review implementation report

Status: READY for operator review and promotion after the required final post-commit
gate. R-i private evidence and R-ii public projection are both delivered.

## R-i delivered behavior

- Added `lane review` with required explicit round and OpenSpec change or brief
  source, default/overridable review route, 1800-second default and bounded timeout,
  duplicate/unknown option refusal, and review-wide exit 2 errors.
- Resolves the reviewed lane and canonical checkout through existing Git identity and
  worktree metadata, captures full HEAD/base/merge-base, requires a clean target, and
  verifies ignored private and trackable public round paths without overwriting.
- Renders the packaged review-only template with literal sources, current gate status,
  invocation-bound review ID, exact private/public paths, zero-or-explicit run budget,
  and system-temp-only test/mutation rules. The template requires plain ASCII payload
  prose and uses an ASCII finding separator.
- Dispatches exactly one reviewer through the existing Herdr path, bounds subprocesses
  and foreground private-file polling by the deadline, preserves late/partial evidence,
  and takes no follow-up lifecycle action.
- Validates the 1 MiB UTF-8 `lane-review/v1` envelope: canonical verdict, full identity
  metadata, fixed ordered sections, tagged repository-relative findings, exact JSON
  execution/witness fields, mandatory limits, and completion marker. It then rechecks
  HEAD, branch, and the complete lane tree before emitting a verdict.
- R-i stdout is exactly PASS with exit 0 or NEEDS-WORK/FAIL with exit 1. Refusals,
  timeout, interruption, malformed evidence, or mutation exit 2 without a verdict.
  The validated private path is named on stderr. No public record is created.
- Updated usage, README, REFERENCE, shared OpenSpec guidance, template map, and the
  current foreground-lane-review spec with only R-i's complete requirement blocks.
  The combined change task remains unchecked and public evidence remains a manual
  operator artifact until R-ii lands.

## R-i regression evidence

- Baseline before feature work: `npm test` passed 69/69 in 14.947 seconds after a
  clear process probe.
- Before implementation, the five focused review groups all failed: option/source
  exits, canonical verdict outcomes, source/gate rendering, invalid/incomplete/
  timeout/mutation evidence, and output path preflight. The carried workspace refresh
  tests were added and observed failing before their separate correction commit.
- Final R-i `npm test` passed 77/77 in 23.952 seconds after a clear process probe.
- `LANE_TEST_NEGATIVE_CONTROL=1 npm test` deliberately failed all 77 controls with
  zero passes in 25.125 seconds. The focused review controls likewise failed all
  selected tests.
- Strict OpenSpec validation passed all 16 items with telemetry disabled and
  concurrency one. `git diff --check` and a full public-text/diff review are required
  immediately before the R-i commit.

The fake Herdr fixture uses the existing dispatch path and real protocol field shapes.
It writes only the rendered private path, supports all three verdicts, invalid SHA/
witness/finding modes, incomplete/oversized records, and a prohibited public mutation.
Fixtures live under the system temporary directory and are removed. One asynchronous
signal test confirms SIGTERM returns exit 2, emits no verdict, leaves the reviewer
untouched, and sends no close/remove follow-up. It was added as coverage after the
core boundary existed; its deliberate control was observed in the final full control
run rather than as a separate pre-implementation product failure.

## R-i limits

No real reviewer, live Herdr mutation, stalled real Herdr subprocess, Windows/Linux
host, SHA-prefix collision, concurrent private writer, permission-denial filesystem,
or maximum-size valid report was exercised. The checker validates evidence structure,
not the truth or semantic strength of reviewer claims. R-i intentionally does not
sanitize or publish private evidence; operators must not copy it into tracked files
without separate inspection.

At the R-i commit, no dependency, configuration key, fix loop, background watcher,
promotion rule, wrapper, UI behavior, push, promotion, archive, or `docs/reviews/`
record was added. R-ii then added sanitization and publication in the separate commit
described below.

## R-ii delivered behavior and evidence

- Builds the public record only from parsed validated metadata, Findings,
  Re-executed, Non-claims, and Unverified. Private identifiers, Analysis, unknown
  fields, raw source, and transcripts never enter the projection.
- Converts proven reviewed-repository paths before redacting POSIX, drive-letter,
  UNC and file-URL paths. It derives automatic user/home/host aliases, merges declared
  private aliases with user/host/private precedence, matches longest-first at
  case-insensitive path-segment or Unicode word boundaries, and refuses ambiguous
  declared substrings or protected locations.
- Enforces the plain-ASCII payload contract and rejects controls, newlines, non-ASCII
  residue, markup, reserved placeholders, percent/HTML/backslash encodings, residual
  paths/aliases, and any non-idempotent second pass. Public records report exact
  substitution/category counts and redacted execution field labels without originals.
- Bounds public output to 120 lines/64 KiB, creates it exclusively only after the
  unchanged-lane check, yields to expose publication races, and then requires the
  captured HEAD/branch plus exactly the selected untracked public file. It never
  stages or commits the result.
- The five focused R-ii groups all failed before implementation. Final-audit
  controls for preserving an ordinary repository-relative path and separating a
  repository-name prefix also failed before their matcher fixes. Together they cover
  all verdicts, fixed placeholders/counts, actual injected OS alias values,
  related-word boundaries, declared ambiguity, protected file locations, ASCII/
  markup/encoding/ambiguous-path refusal, Analysis omission, board verdict parsing,
  clean-tree refusal, occupied rounds, and retained files on a late mutation.
- Final combined `npm test` passed 81/81 in 35.956 seconds. The repository-wide
  negative-control run deliberately failed all 81 tests with zero passes in 35.876
  seconds. Strict OpenSpec validation passed 16/16 with telemetry disabled and
  concurrency one. The final environment used Node.js v20.19.4, npm 10.8.2, Git
  2.54.0, and OpenSpec 1.6.0. All test/validation runs were serialized after clear
  probes.

R-i's post-commit gate was
`GATE 76cb545727ec953e5e73e1d48213f7898bf4fbb8 exit=0 (27.727s)`.
The complete current OpenSpec now contains all review-cli requirement blocks, and the
combined task is checked. The final R-ii commit still requires its own clean post-
commit gate, which belongs in the operator conversation rather than this tracked file.

No live reviewer or real Herdr mutation was run. OS aliases were obtained through the
same Node APIs as production and injected into private fake-reviewer payloads without
tracking their values; forced API failure and a distinct nested full/short hostname
were not available on this host. The mechanical sanitizer cannot prove absence of an
undeclared human name or arbitrary secret. No alternate host, permission race, live
concurrent private writer, push, promotion, archive, or facilitator-owned review record
was exercised or changed.

## Round 2 review corrections

- Section extraction now ends at the next heading's own line, so a finding immediately
  before that heading is retained and the existing trailing trim removes only the
  separator. The compact-section regression verifies both findings in the public
  projection.
- Protected finding locations now receive the same ASCII, reserved-placeholder,
  markup, and encoded-payload checks as other public fields before the existing
  alias/path protection. REFERENCE now describes that uniform refusal policy and the
  shipped publication boundary.
- Template rendering resolves and validates metadata before inserting literal source
  and supplemental-brief blocks. Uppercase brace tokens in either source remain
  literal and cannot be mistaken for unresolved template metadata.
- The free-prose test-claim guard no longer scans private Analysis and accepts explicit
  negation or unavailable-witness language in Unverified while still refusing an
  affirmative unwitnessed claim. Timeout and interruption errors identify the
  dispatched reviewer agent and tab so late evidence can be recovered.

All seven focused Round 2 expectations failed before the behavior changes and passed
afterward; each test includes a deliberate negative control. Baseline `npm test` passed
81/81 in 35.503 seconds. Final `npm test` passed 85/85 in 42.164 seconds, and
`LANE_TEST_NEGATIVE_CONTROL=1 npm test` deliberately failed all 85 tests with zero
passes in 42.452 seconds. Strict OpenSpec validation passed 16/16 with telemetry off
and concurrency one. Verification used Node.js v20.19.4, npm 10.8.2, Git 2.54.0, and
OpenSpec 1.6.0, with every test/validation run serialized after a clear process probe.

No live reviewer or Herdr mutation, alternate operating system, permission failure,
concurrent writer, push, promotion, archive, or change under `docs/reviews/` was
performed. The final post-commit lane gate is intentionally recorded only in the
operator conversation.

## Round 3 review corrections

- Section extraction now trims a run of trailing separator blank lines, preserving
  both the previously covered compact boundary and ordinary extra Markdown spacing.
  A blank line between finding entries still refuses, with a Findings-spacing
  diagnostic instead of blaming the finding schema.
- Finding projection retains the sanitized description and fix fields captured by the
  schema match and feeds those fields directly to the idempotence pass. It no longer
  reparses a rendered finding with a no-space location pattern, so repository-relative
  locations containing spaces remain protected and publish correctly.

The three focused expectations failed before implementation and passed afterward,
each with its own deliberate negative control. Baseline `npm test` passed 85/85 in
42.132 seconds. Final `npm test` passed 88/88 in 52.668 seconds; the repository-wide
negative-control run deliberately failed all 88 tests with zero passes in 49.173
seconds. Strict OpenSpec validation passed 16/16 with telemetry disabled and
concurrency one. All test and validation runs followed clear process probes and ran
alone.

No live reviewer or Herdr mutation, alternate operating system, concurrent writer,
push, promotion, archive, or change under `docs/reviews/` was performed. The final
post-commit gate remains conversation-only evidence.

## Round 4 review corrections

- One newline-boundary normalizer now serves both private-review completion detection
  and schema validation. It removes leading and trailing newline runs from the whole
  record and from every section, and completion uses the last non-empty line.
- A table-driven regression exercises zero, one, and two blank lines at all 13 record
  and section boundaries (39 review runs), retaining and projecting both findings in
  every accepted variant. A separate zero/one/two table preserves the deliberate
  refusal for blank lines between Findings entries, now documented in the template
  and REFERENCE.
- The awaited top-level review call now contains unexpected post-dispatch failures,
  returns exit 2 with empty stdout and one path-free diagnostic, and preserves any
  private evidence already written. Post-dispatch Git probes suppress their own raw
  diagnostics so a vanished worktree cannot expose an absolute path first.
- The remaining review-path newline splits and trims were audited. Source-block and
  supplement trimming is confined to literal prompt composition; schema line splits,
  finding parsing, bullet parsing, prose checks, and size accounting operate after
  normalized section extraction and introduce no additional boundary convention.

The four focused expectations initially produced one pass and three failures: the
existing internal-Findings-spacing rule already held, while the boundary matrix,
unexpected-error containment, and documentation assertions failed. All focused tests
passed after implementation, and every new assertion has a deliberate negative
control. Baseline `npm test` passed 88/88 in 50.666 seconds. Final `npm test` passed
90/90 in 71.879 seconds; `LANE_TEST_NEGATIVE_CONTROL=1 npm test` deliberately failed
all 90 tests with zero passes in 74.921 seconds. Strict OpenSpec validation passed
16/16 with telemetry disabled and concurrency one. Every test and validation run
followed a clear process probe and ran alone.

No live reviewer or Herdr mutation, alternate operating system, concurrent writer,
push, promotion, archive, or change under `docs/reviews/` was performed. The final
post-commit lane gate remains conversation-only evidence.

## Round 5 review corrections

- Completion detection is now deliberately more permissive than schema validation.
  It trims trailing whitespace (including carriage returns) before comparing the
  final content line with the marker, while the validator retains its stricter
  newline-only boundary normalization. Thus every accepted boundary fixture is
  detected complete, and malformed-but-finished output reaches a schema refusal
  instead of exhausting the deadline.
- The existing 39-case accepted-boundary matrix now states and exercises that
  completion/validation invariant. A new table covers whitespace-only and tab-only
  final lines plus a CRLF record; all three return exit 2 with empty stdout and a
  schema diagnostic in less than 1.5 seconds against a two-second deadline.
- The unexpected-error boundary now warns that private evidence may remain and a
  public record may also have been created, requiring inspection before recovery. An
  injected failure after exclusive publication verifies exit 2, empty stdout, no
  stack or absolute path, and retention of the untracked public record.
- The template and REFERENCE now state that Findings, Non-claims, and Unverified
  entries each use consecutive lines with no intervening blank line. The completion
  invariant and malformed-completed-record scenario are synchronized in the design,
  change delta, and current capability.

The initial four-test focused run passed the accepted-fixture invariant and failed the
three new correction expectations before implementation. The added design/spec
assertion also failed before those documents were synchronized. Every added behavior
has a deliberate negative control. Baseline `npm test` passed 90/90 in 68.172 seconds.
Final `npm test` passed 92/92 in 70.787 seconds; the repository-wide
`LANE_TEST_NEGATIVE_CONTROL=1 npm test` run deliberately failed all 92 tests with zero
passes in 70.762 seconds. Strict OpenSpec validation passed 16/16 with telemetry
disabled and concurrency one. The recorded verification runs followed clear process
probes and ran alone. One discarded
diagnostic-only documentation rerun followed a completed focused run without a fresh
system-wide probe; the corrected assertion was subsequently rerun after a clear probe.

No live reviewer or Herdr mutation, alternate operating system, concurrent writer,
push, promotion, archive, or change under `docs/reviews/` was performed. The final
post-commit lane gate remains conversation-only evidence.

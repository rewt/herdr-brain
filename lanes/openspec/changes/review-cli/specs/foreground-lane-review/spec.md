## Purpose

Dispatch one independent review of a fixed lane commit, validate its private
record and generate public evidence through bounded foreground observation.

## ADDED Requirements

### Requirement: Explicit source round and captured target
The CLI SHALL require --round and --change or --brief, resolve an existing clean
lane by git metadata, capture full HEAD/base and disclose its gate or the absence
of a usable current gate without automatically running validation.
#### Scenario: OpenSpec source with a different topic
- **WHEN** topic differs from --change and a supplemental brief is supplied
- **THEN** the reviewer receives all change artifacts, available current specs, AGENTS.md/shared rules and the supplement, bound to captured HEAD/base.
#### Scenario: Brief-only review and missing gate
- **WHEN** --brief is supplied without --change and the gate is missing, stale or unusable
- **THEN** no framework is needed, gate absence is explicit and review continues with the limitation rather than inventing validation evidence.
#### Scenario: Explicit round and early refusal
- **WHEN** round is omitted/invalid, an output already exists, source/route is invalid, or paths/lane state are unsafe
- **THEN** review exits 2 before dispatch/writes; it never infers a next round or overwrites existing records.

### Requirement: Mandatory private reviewer output and finite checks
The reusable template SHALL require a private record as an explicitly permitted
write, forbid reviewer public-record or tracked-file edits and commits, and state
a finite check budget plus the one-build/test machine rule.
#### Scenario: No run authorization
- **WHEN** no unambiguous Review run budget is supplied
- **THEN** the template permits zero build/test/prepare/install/check commands, still requires the private record, and lists omitted verification as Unverified.
#### Scenario: Budgeted checks and mutation witness
- **WHEN** tests are authorized
- **THEN** commands including negative controls stay within the finite budget after a clear load probe, all fixtures/copies use cleaned system-temp paths, and nothing is created or modified in the lane worktree, tracked or untracked.

### Requirement: Machine-checkable review evidence
New private records SHALL use the design's v1 envelope with a fixed first nonempty line
PASS, NEEDS-WORK or FAIL verdict, full Reviewed commit, explicit round, tagged
findings and mandatory Re-executed, Non-claims and Unverified sections.
#### Scenario: Missing witness or malformed schema
- **WHEN** a tests-pass entry has no observed negative-control/mutation witness, or required metadata/sections/tags are invalid
- **THEN** the completed record is refused with exit 2 and no public evidence or verdict is emitted.
#### Scenario: Boundary blank lines
- **WHEN** zero, one or two blank lines occur at the start of the record, after a section heading, before the next heading, or after the completion marker
- **THEN** leading and trailing newline runs are normalized symmetrically and every valid finding reaches the public projection.
#### Scenario: Malformed completed record
- **WHEN** a completion marker is followed by a whitespace-only or tab-only line, or a completed record uses CRLF line endings
- **THEN** the permissive completion probe detects the finished write and schema validation refuses it with exit 2 before the deadline instead of reporting a timeout.
#### Scenario: Record settle
- **WHEN** a reviewer writes a completion marker and then rewrites the private record
- **THEN** size and modification time must remain unchanged for two continuous seconds, after which the CLI re-reads the bytes immediately before validating and projecting that final read.
#### Scenario: Mismatched reviewed SHA
- **WHEN** Reviewed commit differs from captured or current HEAD, even with the same abbreviation
- **THEN** the review is refused, private evidence is retained and no public record is created.

### Requirement: Tool-enforced unchanged lane
Review SHALL record HEAD and a clean-tree check before dispatch, and require the
same HEAD/branch and a completely clean tree after private completion and before
accepting a private review result.
#### Scenario: Reviewer or engineer changes the worktree
- **WHEN** HEAD moves or tracked/index/untracked state is dirty, including a reviewer-written public record
- **THEN** the command exits 2, preserves all work/evidence, and neither resets files nor accepts the review.

### Requirement: Orchestrator-only sanitized public record
Only lane review SHALL generate docs/reviews/<topic>/<head7>-rN.md after validating
the private canonical .lane/reviews/<topic>/<head7>-rN.md and verifying sanitization.
#### Scenario: Sanitizable private evidence
- **WHEN** a valid record contains removable absolute paths or declared/local user and host names
- **THEN** the CLI publishes a bounded schema-preserving projection with explicit placeholders/redaction labels, retains exact private evidence and leaves the public record untracked.
#### Scenario: Sanitization cannot be verified
- **WHEN** private strings remain, controls or non-ASCII text are unsupported, or redaction loses a finding's location/meaning
- **THEN** the command exits 2, writes no public record, retains the private record and does not leak it through diagnostics.
#### Scenario: Deterministic aliases and placeholders
- **WHEN** injected OS username, home basename, full/short hostname and declared tokens occur in varied case and inside unrelated words
- **THEN** only whole path-segment/word-boundary matches are replaced with the design's fixed placeholders and counts; substring collisions, protected locations and unsupported payloads refuse exactly as defined there.
#### Scenario: Verbatim command syntax and escaped prose
- **WHEN** Re-executed command or witness-command strings contain shell syntax, markup characters or encoded-looking text
- **THEN** path, alias, ASCII and reserved-placeholder checks still apply, encoded scratch rescans cannot hide an alias or path, remaining command characters are rendered verbatim inside the public JSON fence, and quoted punctuation and backslashes in prose are backslash-escaped only after sanitization and idempotence checks on the unescaped payload.
#### Scenario: Concrete absolute paths and slash prose
- **WHEN** projected text contains JavaScript regex literals, slash-delimited phrases, shell command substitutions, contiguous POSIX paths, drive-letter paths, UNC paths, file URLs, backslash-escaped forward separators, parenthesized path residue, or adjacent in-repository paths
- **THEN** there is no syntax exemption: regex literals and slash-delimited phrases in public prose may be replaced by the absolute-path placeholder without the matcher itself refusing the record, reviewers should spell patterns in words, escaped external paths refuse on residual or protected-value inspection, an opening parenthesis after a concrete match refuses as ambiguous residue, a closing parenthesis followed by a non-whitespace character also refuses while a standalone closing delimiter publishes, paths inside command substitutions are sanitized, protected paths refuse, after each concrete match the spaced-path scan advances to the next whitespace regardless of intervening non-whitespace characters, the scan continues across separator-free tokens and refuses a separator-bearing suffix, concrete matches with an unmatched separator-bearing prefix or suffix do not make a token independently sanitizable, and adjacent in-repository paths convert safely.

### Requirement: After-check publication boundary
The complete review command SHALL require successful sanitized public generation
and a final integrity check before returning a verdict, extending the private-only
slice's validated-record completion point without weakening its checks.
#### Scenario: Complete-command success
- **WHEN** the private record passes validation and the lane is still clean at its captured HEAD
- **THEN** only the CLI creates the public file without replacement, rechecks HEAD/tree allowing that file alone, and then emits the verdict with exit 0 or 1.
#### Scenario: Mutation during publication
- **WHEN** another mutation appears after public creation or a selected output already exists
- **THEN** the command exits exactly 2 with no verdict, keeps existing evidence, and explains the inspection/commit/removal and explicit-round recovery rather than retrying.

### Requirement: Single dispatch bounded observation and explicit outcomes
Review SHALL call the existing dispatch path once, default to review, enforce the
documented three-through-7200-second --timeout and stop local observation without any follow-up lifecycle action.
Refusals SHALL use an exit-2 boundary, never the shared exit-1 fail helper.
#### Scenario: Settle-compatible timeout
- **WHEN** an explicit timeout is less than three seconds
- **THEN** review exits 2 before dispatch because the deadline cannot accommodate the two-second settle window and polling interval.
#### Scenario: Private-only recorded verdict
- **WHEN** the R-i slice obtains a validated private record and unchanged clean lane
- **THEN** stdout is PASS with exit 0 or NEEDS-WORK/FAIL with exit 1, stderr names the private path, and no public output is created; the complete command additionally satisfies After-check publication boundary before emitting a verdict.
#### Scenario: Missing result or interrupted wait
- **WHEN** dispatch stalls, the record stays missing/incomplete, timeout occurs, or observation is interrupted
- **THEN** the command exits 2 with no verdict, closes local children/timers, keeps evidence and states that the Herdr reviewer may still write late output.
#### Scenario: Later review round
- **WHEN** --round is 3 or greater
- **THEN** documentation recommends a higher explicitly chosen review route; the command never chooses a tier/round, loops, commits, fixes, re-dispatches engineers, promotes or pushes.

### Requirement: Offline tests and discoverable protocol
The implementation SHALL use built-ins-only fake-reviewer tests and document the
command/template/protocol in usage, the README table, REFERENCE and shared rules.
#### Scenario: No real agent or UI dependencies
- **WHEN** the offline suite runs in cleaned temporary repositories
- **THEN** a fake reviewer writing only the private file exercises the delivered slice's verdict/error paths and unchanged-tree refusal, with every refusal asserting exactly 2, without real Herdr, nested builds/tests or UI installation; public-projection coverage belongs to R-ii's requirement blocks.

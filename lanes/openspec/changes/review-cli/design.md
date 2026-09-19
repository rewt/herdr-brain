# Design: Run one independent review in the foreground

## Interface and provenance

```sh
lane review <topic> --round N [--brief <path>] [--change <name>] \
  [--route <name>] [--timeout <seconds>]
```

--round is required: a positive safe integer, with no default or automatic next
round. --route defaults to review; missing/unknown routes fail without falling back
to engineer. --timeout defaults to 1800 seconds and accepts integers 3 through 7200;
the lower bound leaves one polling interval beyond the required two-second settle
window. Smaller values fail before dispatch.
Reject duplicate/unknown flags, empty/missing values, invalid topics and operands
before effects. No new config key, environment variable or runtime dependency.
Until default-config ships, configure a review route before using this command;
include that prerequisite in its README and REFERENCE instructions.

Require --change or --brief (both allowed). The caller supplies --change for every
OpenSpec-origin lane, including differing topic/change names. Resolve one simple
change name under the reviewed lane's openspec/changes; reject traversal/archive
paths and incomplete artifacts. Include proposal, design, tasks and all delta
specs, plus corresponding synced current specs when present. No framework executable
is needed. --brief alone is the acceptance source; with --change it adds questions
and the run budget. Relative brief paths resolve against invocation cwd. Explicit
local/absolute briefs may be read but are never copied into tracked files.

Locate lane/<topic> through git worktree metadata from any checkout of the same
repository; verify its branch and common directory, never guess paths from labels.
Resolve the canonical non-linked checkout via git metadata for private output.
Use the resolver on main after roots-config, not a separate lane-local config path.
Capture full HEAD, head7 (first seven hex characters), configured base branch and
its full commit/merge base. Compare the captured base commit...reviewed SHA, so a
moving main cannot silently change what was reviewed. Render all artifact paths,
AGENTS.md/shared rules, identified engineer report and latest HANDOFF entry; state
absent optional files. Pass source text as literal data, never shell interpolation.

Read .lane/gate.json in the lane. A usable gate matches full HEAD and branch;
disclose its exit/signal, command and timestamps. Missing, malformed or mismatched
gates are respectively missing, unusable or stale: state no usable gate at HEAD in
stderr and the prompt and continue with the limitation. Never run prepare/check or
validation automatically, manufacture a gate, or equate a gate with a verdict.

## Tool-enforced review boundary and round outputs

| Artifact | Writer and location |
| --- | --- |
| Full private record | Reviewer only: canonical checkout .lane/reviews/<topic>/<head7>-rN.md |
| Public-safe record | lane review only, after validation: lane worktree docs/reviews/<topic>/<head7>-rN.md |
| Rendered brief | In-memory dispatch input; no persistent job record |

Before dispatch record HEAD/branch and require git status --porcelain to be empty
(including untracked files) in the lane. Require private output to be untracked and
gitignored, public output untracked and not ignored, and both selected paths absent.
Check ancestor realpaths/file types; reject symlink escapes, foreign paths or an
existing/previously tracked output. Never alter ignore rules or overwrite records.
Existing matching head7 records naming another full SHA make that prefix ambiguous:
refuse. N is always the operator's choice, even when files suggest another round.
Generate an in-memory review ID and bind the private record to that invocation.

After receiving a complete private record, recheck full HEAD/branch and a completely
clean lane tree BEFORE generating the public record. If HEAD moved or the tree is
dirty, refuse with exit 2 and preserve evidence/work. A reviewer-created public
record is a dirty-tree violation, not accepted output. No reset, cleanup or repair.
This enforces the observed before/after boundary; it is not an OS sandbox or proof
that an agent made no transient edit and reverted it. The template forbids those
edits too. Tests/mutation witnesses use cleaned temporary copies, not tracked lane
files. The private review is the only permitted repository output of the reviewer.

Operator discipline serializes reviews of a lane. Private creation is exclusive;
concurrent collisions fail rather than choose a new round. The command creates the
public file without replacement only after all checks, and verifies afterward that
it alone is the new untracked lane file and HEAD is unchanged. A concurrent mutation
at that boundary is still failure; retained output is not a successful review result.

## Template and machine-checkable record schema

The engineering lane adds docs/REVIEW_TEMPLATE.md beside BRIEF_TEMPLATE.md and its
AGENTS.md repository-map entry (documentation maintenance, not a contract amendment).
Initially load the template from the tool installation; default-config later adds
repository overrides.
Use documented literal placeholders, no template engine. The required sections of
the rendered brief are Role, Target and sources, Run budget, Review criteria,
Required output, and Completion. A supplied brief cannot broaden write permissions.

Required output must say explicitly: writing the designated PRIVATE RECORD FILE is
mandatory completion work and is permitted despite the prohibition on changing
tracked files. The reviewer must not write the public record, stage, commit, fix,
rebase, promote, push or send work back to an engineer. Nothing may be created or
modified inside the reviewed lane worktree, tracked or untracked, including ignored
scratch. All test/mutation fixtures and temporary copies belong under the system
temp directory and must be cleaned up; direct caches/build outputs there too, or
report the check as unavailable. Within repository checkouts, only the designated
canonical gitignored private record may be written. A chat verdict is insufficient.

Default run budget is zero build/test/prepare/install/check commands. An explicit
Review run budget section in --brief may authorize exact commands with a finite
maximum count per command, including witness commands. Absent/ambiguous permission
means zero and an Unverified entry. The CLI passes this as text and executes none
of it. Read-only git/file inspection remains allowed. The reviewer follows this
budget instead of generic engineering baseline/commit instructions. Before each
build/test, wait for an explicit clear machine load probe; never stop another
session's work. A timeout or unavailable slot is a limit, not permission to overrun.

New records use a strict v1 Markdown envelope. After leading and trailing blank-line
runs are stripped from the whole record and each section symmetrically, the first
nonempty line is exactly one of **PASS**, **NEEDS-WORK**, **FAIL** (including the
Markdown double asterisks, with no prefix or title). These spellings match the existing
board parser after public projection. Findings, Non-claims, and Unverified entries
each occupy consecutive lines with no blank line between them. No other bold verdict
tokens are allowed; historical records are not rewritten. Use mandatory, unique
header lines followed by the exact sections below:

The completion probe is deliberately more permissive than schema validation. It trims
trailing whitespace, including carriage returns, before comparing the final content
line with the completion marker. Every schema-valid record is therefore detected as
complete, while malformed but finished output reaches validation after the required
settle interval and receives a schema diagnostic instead of exhausting the review
deadline.

```text
**PASS**
Schema: lane-review/v1
Reviewed commit: <full SHA>
Topic: <topic>
Round: <N>
Review ID: <invocation token>
Base branch: <branch>
Base commit: <full SHA>

## Findings
- [Major] <repository-relative file>:<positive line> - <finding>; Fix: <concrete change>

## Re-executed
<one JSON fenced block containing the execution array described below>

## Non-claims
- <claims this evidence does not establish>

## Unverified
- <unexercised check, reason and limit>

## Private identifiers
<one JSON fenced block listing private user/host names and other redactable values>

## Analysis
<full private reasoning and additional evidence, never copied publicly>

<!-- lane-review-complete -->
```

Findings use only [Major], [Moderate], [Minor] with file:line and a concrete Fix;
no findings is the literal None. Non-claims and Unverified are mandatory and use
None when empty. Private identifiers is mandatory (an empty array is valid) and
must disclose any private identifiers appearing in the fields intended for public
projection, including names belonging to other people/hosts. Never put credentials
in either output. Analysis may be empty; other unknown/duplicate sections refuse.

Re-executed is an array, empty when no command was run. Each entry has exactly
command (nonempty string), cwd (lane or scratch), exit_code (integer), result
(nonempty string), tests_pass (boolean), and witness (null or the object below).
This structure is a small built-ins-only schema check, not a JSON-schema dependency.
Every tests_pass=true entry needs exit_code=0 and a witness object with kind
(negative-control or mutation), command, cwd, exit_code and result, plus a nonempty
observed_failure explaining the detection expected and actually seen. A failure
must be observed, not merely a planned command or a green rerun. Witness execution
counts against the run budget. A mutation uses a system-temp copy with cleanup and
never writes inside the reviewed lane. Witnesses may be reused only when
their stated scope actually covers each linked claim.

Tests-pass assertions belong only to these witnessed entries, not free prose.
An existing green gate is disclosed as inherited evidence, not inserted into
Re-executed or presented as a fresh test-pass claim. If its witness is unavailable,
state that limit in Unverified. The CLI checks evidence structure, not the truth of
a reviewer's reported execution or the semantic adequacy of a mutation. Reviewers
must assess those, and must not claim tests passed without the required witness.

Record size is bounded at 1 MiB, valid UTF-8, with the final completion marker;
partial writes wait within the deadline. A completed invalid record fails. Compare
Reviewed commit to both captured and current full HEAD, not head7 alone, and verify
round/topic/review ID/base. A mismatch refuses. PASS means acceptance is supported;
NEEDS-WORK means concrete revisions are needed; FAIL means the result is unsuitable
or a fundamental requirement fails. The reviewer decides from the evidence; there
is no automatic severity-to-verdict formula.

After the completion marker first appears, require the private record's size and
modification time to remain unchanged for two continuous seconds. Any change resets
the interval, which remains part of the end-to-end deadline. Re-read the record bytes
immediately before validation and validate/project only that final read.

## Public projection and verified sanitization

The CLI parses the private record and constructs a new public envelope from its
validated metadata, Findings, Re-executed, Non-claims and Unverified. It does not
copy Analysis, Private identifiers, raw transcripts, or unknown fields. Retain the
verdict, full reviewed SHA and substantive findings; never upgrade the verdict or
omit a finding to make publication possible. The public envelope adds a Sanitization
section recording placeholder substitutions by category/count, without the original
private values. Keep it within 120 lines and 64 KiB; never silently truncate evidence.

Use this deterministic policy for every projected string, including commands and
results, after JSON/string decoding and NFC normalization. Command strings retain
their remaining machine syntax verbatim inside the JSON fence after path and alias
sanitization. Prose may quote error messages, usage strings, and identifiers. Alias
inputs are exactly:

| Source | Category |
| --- | --- |
| os.userInfo().username | user |
| basename(os.homedir()) | user |
| os.hostname() and its first dot-separated label | host |
| Every string in the record's Private identifiers array | private |

Ignore empty OS aliases, but fail if an OS source cannot be read. Declared entries
must be nonempty strings. Deduplicate case-insensitively; identical aliases use
user before host before private. Remove duplicates of automatic aliases from the
declared set. Do not read git author data, environment dumps or credential stores.
Tests inject these exact OS values so host fixtures remain deterministic.

First convert paths proven inside the reviewed repository to repository-relative
paths. Replace other contiguous absolute POSIX tokens, drive-letter paths, UNC paths,
and file URLs matched by the concrete absolute-path pattern, including their private
segments. There is no syntax exemption from the concrete matcher. Regex literals and
slash-delimited phrases in public prose may be replaced by the absolute-path
placeholder; this over-redaction is acceptable because publishing a path is not, and
reviewers should spell patterns in words. The concrete matcher itself only replaces
and never refuses; the ambiguous spaced-path and parenthesized-residue rules still can
refuse the whole publication, including regex-like text. Shell command-substitution
delimiters remain literal, but neither their bodies nor trailing path text are exempt
from path sanitization. Non-file URL-like tokens remain literal when the concrete
matcher does not match them. After repository-path conversion, each concrete
absolute-path match starts an ambiguity scan that advances to the next whitespace
regardless of any intervening non-whitespace characters. The scan continues across
subsequent whitespace-delimited tokens while they remain separator-free. Stop at the
end or at another token whose
path separators are all covered by concrete matches, which will be sanitized
independently. Refuse if a non-absolute token containing a slash or backslash is
reached first, or if concrete matches leave an unmatched separator-bearing prefix or
suffix, rather than publish a partially redacted suffix. Then
redact aliases, matching case-
insensitively at whole path segments (delimited by slash/backslash or string ends)
or Unicode word boundaries (adjacent characters must not be letters, combining
marks or numbers; underscore is therefore a boundary). Never substring-replace a username inside an
unrelated word. Match accepted aliases longest-first, using the category precedence
above for ties, so a hostname and its first label do not compete. Preserve the case
of unaffected text.

Only these generated placeholders and categories are permitted:

| Category | Placeholder |
| --- | --- |
| absolute-path | [ABS_PATH] |
| user | [USER] |
| host | [HOST] |
| private | [PRIVATE] |

Sanitization lists counts for all four categories, including zero, and identifies
modified execution fields by array index/field as redacted, never by their original
values. Repository-relative path conversions are counted separately as relative-path
conversions and use no placeholder. Keep exact commands privately; a redacted public
command must not be represented as a literal execution. Generated placeholders are
reserved atoms, skipped on rescans; a reviewer cannot preinsert them into projected
payload text to hide a value.

The following are concrete refusal triggers, before writing any public file:

- Ambiguous spaced path: after repository-path conversion, a concrete absolute-path
  match advances through any following non-whitespace characters to the next
  whitespace, then reaches a non-absolute separator-bearing token before the end or
  another independently sanitizable absolute path. A token is independently
  sanitizable only when its concrete matches leave no unmatched separator-bearing
  prefix or suffix.
- Parenthesized path residue: an opening parenthesis immediately after a concrete
  absolute-path match refuses publication, and a closing parenthesis followed by a
  non-whitespace character also refuses rather than expose an unmatched suffix; a
  standalone closing delimiter remains publishable.
- Ambiguous aliases: after deduplication, one remaining declared token is a proper
  case-insensitive substring of another declared token. Do not guess which identity
  was intended. Known nested automatic hostname aliases use the longest-first rule.
- Ambiguous location: after safe repository-path conversion, any alias match would
  replace text in a finding's file:line or a captured identity/base metadata field.
  Refuse instead of changing the location or the commit/branch being asserted.
- Unsupported payload: projected field strings must be plain single-line text,
  restricted to ASCII U+0020 through U+007E after sanitization. Reject controls,
  newlines and non-ASCII residue everywhere. Prose punctuation and encoded-looking
  quoted text are not refusal categories. A finding description containing a declared
  private identifier is unresolved and refuses publication.
- Residual private content: an absolute path or alias still matches on rescan,
  redaction changes on a second pass, or a required finding/fix/evidence field is
  lost. No transliteration, semantic rewrite or silent truncation is allowed.

Verify the transformed schema and require idempotence (identical second-pass text
and zero additional substitutions) on the unescaped payload. Decode percent octets,
numeric character references, and a backslash immediately before a forward slash
into a scratch copy before the residual path and alias checks so encoding or escaping
cannot hide private content. Decode the same escaped separator before protected-value
path inspection. Only after that rescan,
backslash-escape every backslash, backtick, asterisk, underscore, square bracket and
angle bracket in prose rendered outside the JSON fence, plus an opening parenthesis
immediately after a generated placeholder. Commands stay verbatim in the fence. The
v1 plain-text restriction still refuses non-ASCII and control characters; retain
those details privately and let the operator arrange a later explicitly numbered
review with publishable wording.
On any unverifiable case, exit 2 with no public record and a concise diagnostic;
retain the private file for operator inspection. Never echo private content.
This verifies a documented mechanical sanitization policy; it cannot certify the
absence of every possible secret or undeclared human name in arbitrary prose.
The template requires disclosure/public-safe wording, the checker fails closed on
uncertainty it detects, and the operator still inspects the result before committing.

## Foreground lifecycle and exit codes

Use the existing dispatch path exactly once, with a separate reviewer session,
selected review route and rendered brief. Preserve route handling, cwd verification
and existing bounded startup checks; add no new start/prompt retry or second control
path. A narrow shared adapter or own-installed-CLI child is acceptable. Timeout is
end-to-end from completed preflight through dispatch, private record wait and
publication, including stalled dispatch calls. Bound subprocesses by remaining time.

Poll the one expected private file with foreground timers (250 ms to 1 s), not a
busy loop. Do not infer completion from an agent footer, exit or chat message.
For combined delivery or completed R-ii, publication and final integrity checks must
complete before reporting a verdict. The pre-agreed split below defines R-i's
private-only completion point.

| Exit | Result on stdout |
| --- | --- |
| 0 | PASS followed by a newline; public record successfully written. |
| 1 | NEEDS-WORK or FAIL followed by a newline; public record successfully written. |
| 2 | No verdict; timeout, missing/incomplete/invalid record, dirty/moved target, unverified sanitization, dispatch/preflight/write failure or interruption. |

Review refusals must not use the shared fail() helper, which exits 1. Use a
review-specific exit-2 error boundary, including failures surfaced by shared config,
path or dispatch helpers; preserve those helpers' behavior for other commands.
Every refusal test asserts exactly 2 and empty verdict stdout, not just nonzero.

Gate disclosure, diagnostics and paths go to stderr. Timeout, Ctrl-C, SIGTERM or
stdout closure ends local children/timers promptly with exit 2, never a synthetic
PASS. Preserve other commands' exit semantics. Do not kill the Herdr reviewer or
delete partial/late records: report that it may still finish, with available session
identifiers. No local watcher remains and no command resumes/redispatches itself.

## Operator ownership, escalation and documentation

The CLI-created public record is intentionally untracked after success. The
operator inspects and authorizes its later commit with any fixes. A new commit
needs a fresh lane check; the old record still names its original reviewed SHA.
Do not exempt evidence from clean-tree checks or trigger self-review after a
record-only commit. Promotion always revalidates and never depends on a verdict.

REFERENCE must name the late-publication failure: an exit-2 result can leave an
untracked public file if a concurrent mutation is detected after its creation.
Inspect that file and the private evidence before deciding to commit or remove it;
never treat it as a successful command result. A commit changes HEAD, so a new check
and explicitly selected round target that new SHA. To reuse the same HEAD/round,
the operator must separately authorize removing both old output files after
inspection, ensure the old reviewer cannot still write, and restore a clean tree.
Otherwise retain the evidence and choose a fresh round. The CLI does none of this
cleanup and never bypasses its occupied-output refusal.

Recommend an explicit higher review route for round 3 or later: review-xhigh for
adversarial, crypto or semantics work, review-max after repeated NEEDS-WORK. Until
those routes are configured or default-config ships, use operator-owned equivalents.
The operator chooses --round and --route on every invocation; advice never selects
a model, advances a round, re-dispatches an engineer, loops or promotes automatically.
Any review-fix loop belongs to the operator or a separately authorized contrib
wrapper with a fixed round cap. No wrapper is specified in this lane: fix authority
and round policy exceed one foreground review.

Document syntax/defaults/flags in usage and the README command table, link the new
template, and put gate/source/budget/schema/witness/sanitization/exit/recovery details
in REFERENCE. Update shared rules to distinguish review-only permissions from
engineering delivery. No AGENTS.md contract amendment is needed for review-cli.

## Pre-agreed split point

Choose combined delivery or this exact split at dispatch, before implementation.
Use the split if the combined scope exceeds one focused session; it needs no new
product decision. The private-only first slice is useful on its own, and both
slices include their own tests, docs, report, commit and post-commit gate.

| Subphase / topic | Complete requirement blocks and acceptance | Depends on |
| --- | --- | --- |
| R-i / review-private | Own Explicit source round and captured target; Mandatory private reviewer output and finite checks; Machine-checkable review evidence; Tool-enforced unchanged lane; Single dispatch bounded observation and explicit outcomes; Offline tests and discoverable protocol. Deliver template/map, explicit source/round, gate disclosure, one existing-path dispatch, private validator and bounded wait/exit. Test source/flag/route/gate/path refusals with exact exit 2, all three private verdicts with exits 0/1, witness/schema/SHA errors, before/after tree checks, system-temp fixtures, timeout/signal/pipe cleanup and no public file created. | Current main; roots-config promoted for lane.mjs sequencing. |
| R-ii / review-public | Own Orchestrator-only sanitized public record and After-check publication boundary. Deliver alias policy, projection, sanitization verification and publication only after the clean-tree check. Test every alias source/boundary/case/placeholder, prose escaping after raw idempotence, non-ASCII/control refusal, redaction counts/idempotence, meaningful locations, private retention, exclusive public creation, concurrent mutation and occupied-round recovery. Assert exact exit 2 on every refusal and retain R-i regressions. | review-private (R-i). |

For R-i, the outcome table terminates at the validated private record and unchanged
tree: PASS exits 0; NEEDS-WORK/FAIL exit 1; all refusals exit 2. Print the private path
on stderr and create no public output. R-ii's After-check publication boundary adds
the full-command requirement that stdout verdict/exit 0 or 1 wait for successful
public generation and its final integrity check. There is no temporary user flag,
alternate dispatch path or automatic transition between these deliverable versions.

Partition the named complete requirement blocks into two OpenSpec changes and one
dispatchable brief each before coding. Each owns docs/reports/<topic>.md and its
acceptance; sync only delivered blocks. Do not check off the combined task or sync
publication requirements after R-i alone. Consumers requiring full review-cli,
including default-config, wait for R-ii; an operator can inspect R-i's private output.

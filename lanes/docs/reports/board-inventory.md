# Board inventory delivery report

Date: 2026-09-11

## Correction round 1 — 2026-09-13

The saved Round 1 review remains unchanged. All seven findings are in scope for this
lane. The untouched correction baseline passed 210/210 tests with zero skips in
311.657 seconds. The lane rebased only onto `main` at `8d80ffa`; the HANDOFF conflict
was resolved by retaining both the earlier inventory entry and all newer main
entries. The review file's Git blob remains `992703ffe8d47594cdbdc416bbff92b2cd248172`.

Seven offline regression groups were added without product changes, each with a
deliberate negative control. In the supervisor-prioritized clear test window, the
focused inventory file passed its four existing groups and failed all four new
groups: cross-repository Git evidence leaked (`true` versus expected `false`), a
non-Git cwd inherited a repository instead of `null`, ambiguous claims left only
one instead of three unregistered agents, and the second preview read returned
`null` instead of retaining the first read's message.

The focused CLI/view selection failed all three new groups. Two socket fixtures
initially hit sandbox `listen EPERM`, so they were rerun outside the sandbox: signal
shutdown still probed one later endpoint (expected zero), and watch rendered
`prefix STOP suffix` instead of the configured `STOP`. The plain group found the
missing machine plain renderer. No product files had changed when these failures
were observed; the shared test slot was released after that focused run.

The correction binds per-session Git/report evidence to canonical repository and
session identity; derives live repository and branch from actual Git cwd; requires a
unique verified workspace/occupant registry claim; and keeps unmatched agents in
the live union. The foreground watch retains endpoint/occupant-bound preview and
tripwire state, closes pending observation clients on cancellation, and skips later
endpoint probes. Plain output now states scope, history, endpoint coverage, and
disambiguated repository/group identity with an active-after-done marker. JSON stays
schema v1 with no added public fields, and the existing five-second refresh and
one-second output coalescing are unchanged.

The corrected inventory file then passed 8/8 in 1.840 seconds. The three selected
watch/plain groups passed 3/3 with 142 unrelated name-filter skips in 1.498 seconds
outside the sandbox. Deliberate controls for the four inventory groups failed 4/4
at their named controls with four unrelated skips; the three selected watch/plain
controls likewise failed 3/3 at their named controls with 142 unrelated skips.
No Herdr executable was needed for these offline protocol/socket fixtures.

The first serialized full run reached 219/220 with zero skips in 312.646 seconds.
Its one failure exposed an inherited event-frame contract: an unconfigured
`pane.output_matched` event must still emit an unchanged watch frame. The first
implementation ignored that event, so the existing three-frame fixture timed out
and left a board-watch child after its temporary directory was removed. That exact
fixture child was terminated. The watch now emits the frame without inventing a
tripwire value; the related tests also clean up children on assertion failure and
allow a longer fixture-only wait under full-suite load. The four related focused
watch groups then passed 4/4 with 141 unrelated skips in 6.291 seconds. The second
serialized full `npm test` passed 220/220 with zero skips in 311.140 seconds,
including all socket fixtures. Strict OpenSpec validation passed 23/23 with zero
failures. Verification used Node.js 20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec
1.6.0. Every full run followed a clear process probe and ran alone.

This round did not exercise an alternate host, a live multi-endpoint watch, or the
Ink UI; the socket fixtures are offline protocol stand-ins. It makes no deferred
sampling responsiveness/freshness claim. No push, promotion, close, lifecycle
scheduling, remote discovery, `board/app.mjs`, `board/ui/`, or review-record edit
occurred. The final source-CLI gate remains to be run after the documentation
commit and will be handed to the supervisor verbatim.

## Correction round 2 — 2026-09-13

The fixed-commit Round 2 NEEDS-WORK review at
`docs/reviews/board-inventory/f243562-r2.md` was preserved byte-for-byte (Git blob
`99c93a64d595f3780621e8ccb668d7cace29895a`). Its four findings are addressed
without changing the Ink entrypoint, UI, lifecycle actions, or JSON schema.
The untouched baseline passed 220/220 with zero skips in 311.606 seconds.

Before product edits, the three new inventory groups all failed: a switched branch
left one joined row instead of separate historical/live rows; a same-name, same-pane
replacement with a new agent-session ID inherited a done record and disappeared;
and a title-only unregistered row exposed its title as `brief.excerpt`. Two CLI groups
also failed: dispatch omitted the asserted immutable record fields, and a status-only
watch event did not trigger a pane read before the periodic refresh. All five groups
retained deliberate `negativeControl` calls. An additional post-prompt replacement
fixture was added to pin the dispatch guard. The focused failure-first slot was
released before implementation.

Dispatch previously recorded only mutable name, workspace, and pane handles. The
installed Herdr agent-list response was inspected for field names only and exposes
`agent_session` plus `terminal_id`. Dispatch now compares the same occupant before
and after delivery, writes optional `agent_session_id` and `terminal_id` into the
immutable, gitignored session record, and refuses a detected post-prompt replacement
as partial success without replaying the brief. This metadata is display-only. A
registry join now requires a recorded agent-session ID, matching terminal ID when
present, the canonical repository, and agreement between recorded `lane` and the
verified live branch. Detached or switched checkouts and replacement occupants stay
separate; older records lacking immutable evidence still load as offline history.
The live occupant remains unregistered and visible. Unregistered title goals keep
their labeled `goal`, while `brief.path` and `brief.excerpt` remain null. Status events
emit the status frame first and schedule the existing coalesced preview refresh.

After correction, the full inventory file passed 11/11 and the three selected
dispatch/watch cases passed 3/3. Two older board fixtures initially failed because
they modeled a registry lane against the main checkout without immutable evidence;
they were updated to represent a real lane checkout and agent-session identity, then
passed. The six selected deliberate controls failed at their named controls with
zero passes. Final serialized `npm test` passed 226/226 with zero skips in 316.863
seconds, including fake-socket behavior. Strict OpenSpec validation passed 23/23;
the change delta and current machine-session-discovery spec are synchronized.
Node.js 20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0 were used.

No live dispatch, real multi-endpoint watch, alternate-host, Ink render, or
minimum-version check was performed. Responsiveness and freshness guarantees remain
in board-sampling (2c-ii); the existing five-second periodic refresh and one-second
event coalescing remain. Final whitespace/public-safety checks and a source-CLI gate
against the clean final commit follow this report; the gate line stays outside tracked
files.

## Correction round 3 — 2026-09-13

The saved Round 3 NEEDS-WORK review remains unchanged (Git blob
`2de4e8575ab78962162e97170ce4ba4dd44258ea`). Before product edits, the
expanded offline `npm test` run passed 226/230, with four failures at the intended
coalesced status preview, same-session terminal replacement, titleless goal
provenance, and late terminal read assertions. The revised workspace-claim fixture
first established a successful verified lane/workspace join, then kept missing,
stale, and duplicate claims separate; that group passed in the failure-first run.
No product file changed until those results were observed.

The foreground machine watch now retains one coalesced status-preview request if
its timer fires during collection and drains it on completion without concurrent
observations. The shared occupant identity includes terminal ID when available,
even when the Herdr agent-session value is unchanged. Thus replacement terminals
cannot inherit an old preview, tripwire, or late pane read. An unregistered row
without a title retains null `goal` and `goal_source`; registry provenance is inferred
only for actual registered goal metadata. No public JSON field was added or changed
in meaning. `docs/REFERENCE.md`, the board-inventory delta, and only its current
machine-session-discovery capability spec describe these boundaries. The existing
five-second periodic refresh remains; this round makes no sampling freshness or
responsiveness guarantee.

After correction, the four selected inventory/message groups passed 4/4 (50
name-filter skips), the delayed-watch group passed 1/1 (148 skips), and all five
deliberate controls failed at their named assertions (198 skips). Strict OpenSpec
validation passed 23/23 at concurrency one. The correction was committed, then the
lane rebased only onto confirmed `main` at `ee529a3`. The HANDOFF conflict was
resolved by retaining coordinator and inventory histories. All three saved
inventory review blobs are unchanged: Round 1 `992703ffe8d47594cdbdc416bbff92b2cd248172`,
Round 2 `99c93a64d595f3780621e8ccb668d7cace29895a`, and Round 3
`2de4e8575ab78962162e97170ce4ba4dd44258ea`.

The serialized post-rebase `npm test` passed 230/230 with zero failures/skips in
339.090 seconds, including local socket fixtures. Post-rebase strict OpenSpec
validation passed 24/24, including the coordinator change now on main; the five
selected deliberate controls again failed 5/5 at their named controls. Each full
run followed a clear process probe and held the sole test slot. The focused tests
are offline and use
cleaned system-temp fixtures; no live Herdr replacement, alternate-host test,
multi-endpoint watch, or Ink rendering was performed. Node.js 20.19.4 and Git
2.54.0 were used. The final source-CLI gate is run only after this report and
HANDOFF are committed; its exact result is conversation-only evidence.

## Correction round 4 — 2026-09-13

The preserved Round 4 NEEDS-WORK review is unchanged at Git blob
`6d8cc34b94c080c16b053bf8bee34be14b8b943a`. The untouched serialized
baseline passed 230/230 with zero skips in 332.922 seconds. Before product edits,
the deterministic two-pane collection fixture failed: a first-pane match changed
the live tripwire from `OLD` to `LATEST` while the second pane read was pending,
but completion restored `OLD`. The real socket watch fixture then showed a
`LATEST` match frame followed by a completed frame with null tripwire. The
adjacent shared preview helper independently overwrote a newer match with `OLD`
on both successful and failed pane reads. Its failed-read witness was observed
against the original writeback before that path was corrected. An early socket
fixture lacked its agent-kind field and timed out before any pane read; the
fixture was completed and the actual null-versus-`LATEST` failure was captured
before implementation.

`board/inventory.mjs` now merges the latest tripwire and match observation time
only when the endpoint occupant still matches, while preserving refreshed message
fields. It refuses a concurrent different-occupant runtime replacement. The
adjacent successful and failed writebacks in `board/message-preview.mjs` likewise
retain a newer same-occupant match and refuse a concurrent different occupant.
The existing terminal replacement and late-read protections remain unchanged.
This is a memory-only display correction, not a new sampling, freshness,
subscription, or lifecycle behavior. The reference and only the board-inventory
delta/current machine-session-discovery spec were synchronized; JSON schema v1
has no new fields.

The corrected three race fixtures passed 3/3; they and the existing replacement
and late-read checks passed together 7/7. The fourth failed-read fixture passed
in the full run. Four deliberate controls failed 4/4 at their named assertions.
The serialized post-correction `npm test` passed 234/234 with zero skips in
336.045 seconds; strict OpenSpec validation passed 24/24 at concurrency one.
All full and focused runs followed clear process probes and used cleaned system-
temp, offline fixtures. No live Herdr match, alternate host, interactive Ink
render, multi-endpoint watch, or sampling bound was verified. Node.js 20.19.4
and Git 2.54.0 were used. Main remained `ee529a3`; no rebase, push, promotion,
close, or review-record edit occurred. The clean-commit source-CLI gate follows
this report and HANDOFF commit; its exact line is conversation-only evidence.

## Result

The dependency-free board read path now defaults to accessible local-machine Herdr
scope. It enumerates and canonicalizes local endpoints, keeps failures as coverage
errors, identifies repositories only by Git common directory, unions registry history
with all live agents, and supports canonical `--repo` filtering plus independent
`--all` history inclusion. Rows are ordered by development root, repository, then
facilitator/lane group. Unregistered, unnamed, non-Git, facilitator, Herdr-done, and
metadata-done-but-active agents retain honest unknown and completion state.

The JSON document remains schema v1. Existing fields retain their meanings; inventory
adds scope history state, endpoint coverage, repository display disambiguators, row
goal provenance, active-after-done state, and grouping. Discovery, endpoint,
repository, registry, and message errors remain outside agent state.

The pre-agreed OpenSpec split was activated first in commit `e226e60`. The original
board-discovery change remains as a superseded, unchecked proposal. The inventory
change owns its three complete requirements; responsive bounded observation remains
unchecked in board-sampling. The implementation checkpoint is `f500351`.

## Regression evidence

- Untouched baseline: `npm test` passed 206/206 with zero skips in 315.780 seconds.
- Before product changes, `test/board-inventory.test.mjs` passed 0/4: three groups
  failed because the inventory service did not exist, and the CLI group failed because
  `--all` was rejected.
- Corrected focused inventory run: 4/4 passed in 1.134 seconds.
- Existing board compatibility focus: 20/20 passed with 122 name-filter skips in
  8.986 seconds; the complete inventory file then passed 4/4 in 1.134 seconds.
- Deliberate inventory controls: with `LANE_TEST_NEGATIVE_CONTROL=1`, 0/4 passed and
  all four groups failed at their named control in 1.195 seconds.
- First full post-change run reached 209/210 in 317.460 seconds; its only failure was
  the old README/usage assertion omitting the new `--all` flag. The corrected focused
  documentation test passed 1/1.
- Final `npm test`: 210/210 passed, zero skips, in 317.701 seconds. The run was outside
  the filesystem sandbox so the existing local Unix-socket fixtures could listen.
- `OPENSPEC_TELEMETRY=0 openspec validate --all --strict --no-interactive
  --concurrency 1`: 23/23 items passed.
- Syntax checks for `lane.mjs` and `board/inventory.mjs` and `git diff --check` passed
  during implementation. Final whitespace and public-safety checks are recorded in
  the handoff.

Every full-suite or build-like verification was started only after a process probe
showed no running `vitest`, `npm test`, `node --test`, or lane check/promote process.
One sibling suite was observed and allowed to finish before the final full runs;
focused checks also ran serially.

## Live and environment checks

A read-only live smoke check emitted only aggregate data: machine scope discovered two
local endpoint records, one accessible endpoint, seven canonical repositories, and
nineteen rows; discovery was correctly partial with one endpoint error. No raw socket
path, repository path, workspace label, agent identity, or pane output was copied into
this report.

Verification used Node.js 20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0. Local
main remained the merge base at `de11d4b`; no rebase was needed.

## Limits and unchanged behavior

`board/app.mjs` and `board/ui/` were not changed because the sibling board-frame lane
owns the Ink frame. Its current repository anchor is documented; the underlying
foreground JSON watch is machine-capable for that lane to consume. Sampling retains
the existing five-second refresh, subscriptions, and message-preview coalescing. This
change makes no responsiveness or freshness claim; board-sampling owns those future
guarantees.

No filesystem crawler, OS-process agent detector, remote discovery, persistent machine
registry, Git identity mutation, lifecycle scheduling, push, promotion, close,
history rewrite, or `docs/reviews/` edit occurred. Live coverage used only one
accessible server; multiple accessible endpoints, malformed/foreign registries, and
offline behavior were verified with protocol-shaped offline fixtures. The final lane
gate is intentionally conversation-only evidence and remains to be run against the
final documentation commit.

# Design: manual identity coordination with optional observation

## Authority and roster

The operator names one coordinator and its authority source. The coordinator keeps
one explicit daily roster: identity label, roster revision and date; each project's
canonical Git common directory, canonical checkout, integration branch, verified
instruction/goal/evidence locators, integration owner, optional project supervisor,
and open outcomes. A development-root label groups repositories but is never a
repository key. A root-only request must select a canonical repository before any
lane lifecycle command. Roster entries are private operator/project records; examples
in this change are synthetic. Reconcile each path through Git before use, including
linked worktrees. Never infer a project from basename, remote, Git author, or account.

The operator's instruction or project policy grants lifecycle authority. The
coordinator may allocate priorities, dependency order, and finite budgets within
that delegation; beyond it, a proposed change waits for an explicit decision. One
integration owner per project accepts engineering evidence and performs or directs
its review, promotion, close, and cleanup under project policy. A project supervisor,
when appointed, is that integration owner. Otherwise the coordinator is named as
integration owner and may own a small task directly with an engineer. The coordinator
reads the supervisor's compact acceptance result, not the full engineer transcript
or a duplicate detailed review. An independent reviewer remains separate wherever
the project requires one. The current [supervisor closeout protocol](../../../config/supervisor/2026.09.13.1/CLOSEOUT.md)
still governs accepted lane retirement; this proposal cannot waive its gates.

Git author identity belongs to Git configuration; GitHub credentials authorize
remote operations separately; a Codex profile selects local model/client settings;
and a development root is only a filesystem/display grouping. None is a substitute
for coordinator, integration owner, canonical repository, or permission to push.
Changing an agent/model default does not replace a running owner.

## Assignment and delta-report envelopes

Use short operator-authored records, not a task queue. An assignment has stable
`assignment_id` (opaque within a roster), monotonic `revision`, `project` (canonical
common-directory identity), `outcome_id`, `owner` (exact agent/person target),
`integration_owner`, acceptance criteria, budget ceilings and review-by time,
next milestone, blocker/decision, evidence locator, and next action. The assignment is effective
only after the named owner acknowledges the revision and its authority is checked
against the operator/project source. A revision changes scope, budget, or owner but
never reuses an assignment ID for a different project/outcome. The coordinator records
one or two daily outcomes per project and cross-project dependency edges with an
explicit unblock criterion. No implicit task dispatch follows recording.

A report contains `assignment_id`, `revision`, `report_id`, increasing `sequence`,
project, reporting owner, milestone/result, change since prior reconciled report,
blocker or requested decision, evidence pointers, and exactly one next action/owner.
Its result is a report claim, never project acceptance; the integration owner
checks the stated criteria, gate, and required review before recording acceptance.
It is sent only at a material checkpoint, blocker, or ready handoff. Evidence is
preserved before a single no-wait notification. For engineering lanes, include
branch, full HEAD, exact gate result or unverified, and durable report path as in
`ENGINEER_REPORT_APPENDIX.md`. A compact cross-project example, with placeholders,
is below; it is not a real assignment or authorization:

```text
ASSIGN v1 id=A-001 rev=1 project=<verified-common-dir> outcome=O-1
owner=<engineer-agent> integration_owner=<named-owner>
accept=<project-check-and-independent-review> budget=<approved-ceilings>
milestone=<planned-next-result> blocker=none evidence=<durable-index>
next=<owner-acknowledges-revision>

DELTA v1 id=A-001 rev=1 report=R-001 seq=1 project=<verified-common-dir>
owner=<engineer-agent> milestone=<result-since-assignment> blocker=none
evidence=<full-head-and-report-pointer> next=<integration-owner-verifies-gate>
```

Detailed project context stays at the project owner. The coordinator's daily view
contains only roster revision, outcomes, dependency/budget decisions, latest reconciled
report IDs, evidence pointers, and next actions. Private raw output and credentials
never enter tracked documents or brief messages.

## Delivery, handoff, and resumption

- Deduplicate exact `report_id` plus content digest; record receipt without another
  action. Conflicting bytes for one ID or the same sequence are quarantined for
  explicit owner clarification. An older revision or sequence cannot roll back the
  latest reconciled report. An out-of-order newer report is held until its predecessor
  and primary evidence are checked; a missing predecessor is an explicit gap, not a
  reason to replay work.
- If notification delivery fails, retain the durable report and mark delivery
  unconfirmed. Do not retry, redispatch, or infer failure of the underlying work.
  The operator or owner can make one explicit later reconciliation decision.
- A stale handoff is an evidence problem first. If its saved plan, HEAD, gate,
  review applicability, or report pointer is obsolete but the same owner remains
  available and authorized under the current assignment revision, that owner
  reconciles primary evidence and continues only the unfinished authorized step.
  No successor, new assignment revision, or duplicate review is required solely
  because the saved evidence is old. A changed scope/budget or contradictory
  authority still waits for an explicit decision.
- Owner transfer is separate. An unavailable, replaced, or no-longer-authorized
  owner freezes new assignment to that target; it does not create a lease expiry
  or automatic reassignment. The coordinator, within delegated authority or after
  operator approval, issues a new revision naming one successor. The old owner
  acknowledges when available; if unavailable, the authority source records its
  supersession. The successor acknowledges and checks primary evidence. Unclear
  ownership remains blocked.
- On resumption, compare current operator direction and project instructions,
  canonical Git common directory, branch/full HEAD/clean state, exact gate and
  independent review record, durable reports, and freshly observed Herdr occupant
  identities. Continue only the uncompleted authorized step. Saved roster, board,
  session registry, done markers, and pane status are hints, never authority.

No background scheduler, routine model poll, heartbeat traffic, state-driven
lifecycle call, or observation-reconnect replay is part of this design.

## Existing JSON and console dependency audit

Read-only `git show` of `lane/board-inventory` at `1fdd8f9` shows schema-v1
`row_id`, canonical `repo_id`/`root_id`, repository `path`, `goal`/`goal_source`,
`brief.excerpt`, `role`, `report.path`/`mtime`/`verdict`/`reviewed_head`, gate,
status, deadline, staleness, scope and coverage. It does not provide an assignment
ID, integration owner, accepted milestone, latest coordination delta, or decision
needed. A report path is not a latest coordination report. Read-only `git show` of
`lane/board-frame` at `9e8c8f9` shows attention computed from blocked/current failed
gate/stale/verified overdue/current non-pass review/unknown agent state; no
coordination ownership signal exists. Frame labels `single repository scope` and
renders only supplied document fields. These are branch observations, not deployed
behavior claims; the inventory branch can advance independently.

| Need | Existing field | Later owner / constraint |
| --- | --- | --- |
| Session goal | `row.goal`, `goal_source`, `brief.excerpt` | Inventory supplies title fallback; `coordination.outcome_goal` is a separate explicit assignment field, not a substitute for session title. |
| Canonical project | `repo_id`, repository `path`, `scope`, `coverage` | Inventory; development root only groups. A root cannot execute a lane. |
| Owner | `role` and `name` identify route/agent, not integration ownership | Coordination read-model brief adds `coordination.owner_id` and `integration_owner_id`, nullable and source-labeled. |
| Latest report | `report` is lane/review evidence | Coordination read-model adds one `latest_delta` pointer/sequence/revision and freshness, never raw text. |
| Attention | Frame computes technical attention reasons | A later UI may display separate coordination decision/blocker reasons; no auto-action or double counting of sessions. |

The pending `lane/board-inventory` sampling split (2c-ii, `board-sampling`) owns
bounded asynchronous sampling, stale/error semantics, two-child concurrency, and
the 100-session fixture; its inventory split owns machine/repository coverage and
canonical joins. The pending `lane/board-frame` frame split (3a-i) may remain
repository-scoped; its `board-details` split (3a-ii) waits for frame plus complete
discovery and owns complete evidence views. New coordination fields belong to this
separate later read-model and UI brief, not inventory, sampling, or frame. The
[idea CLI](../idea-cli/) and [composer](../idea-composer/) remain later explicit
repo/route launch work; no assignment implies automatic dispatch or destination.
The board UI must consume CLI observations and actions only. Display data never
authorizes focus, done, review, promotion, close, push, or resource allocation.

The read-model is explicitly opt-in: `lane board --json --coordination <path>` or
`lane board --watch --json --coordination <path>` reads one operator-maintained
local JSON snapshot. There is no default path, discovery, or writer. The path is
resolved once against the invoking cwd and passed as an argument, not an authority
source. The CLI read-model slice accepts it for JSON/watch reads; interactive use
refuses clearly until the later UI slice completes source forwarding. Neither slice
adds it to `focus` or `done` actions.

The v1 file is a strictly decoded UTF-8 JSON object without a BOM, at most 1 MiB
(1,048,576 raw bytes). Accept only an existing regular file: reject a directory, FIFO, device,
or symlink rather than blocking on or following it. Inspect with `lstat`/`fstat`,
read at most the cap plus one byte, and refuse a changed file identity/size during
the read. Bound the decoded structure to at most 32 projects, 512 assignments in
total, 32 `session_row_ids` per assignment, and 4,096 row links in total. Refuse
over-limit, malformed, duplicate project/assignment/row mapping, or invalid
type input as a localized `coordination` error. Unsafe, malformed, or oversized
files make the whole optional projection unavailable; ambiguous joins make only
affected mappings unavailable and coverage partial. Retain underlying board
rows and technical evidence. Do not leak raw source bytes in a diagnostic.

Required top-level fields are integer `schema_version: 1`, UTC RFC 3339
`recorded_at`, and `projects[]`. Each project requires a nonempty absolute
`git_common_dir` string (at most 4,096 Unicode code points) and `assignments[]`. Each
assignment requires nonempty `assignment_id` and `outcome_id` strings (at most
128 Unicode code points), positive safe-integer `revision`, and an array of 1–32
distinct nonempty `session_row_ids` (each at most 128 Unicode code points). `outcome_goal`,
`owner_id`, `integration_owner_id`, `milestone`, `blocker`, `decision_needed`, and
`next_action` are required but nullable strings: IDs at most 128 Unicode code
points, other text at most 512 Unicode code points. `milestone` is the **planned
next milestone**, not an accepted result. `latest_delta` is required and either null or an object with
nonempty `report_id` (at most 128 code points), positive safe-integer `sequence`,
positive safe-integer `revision`, UTC RFC 3339 `recorded_at`, nullable
`evidence_ref` (at most 1,024 Unicode code points), and nullable full Git object ID
`evidence_head` (40 or 64 hexadecimal characters, matching the repository's
object format). An assignment also requires nullable full Git object ID
`applies_to_head`. A delta revision differing from its assignment is historical,
not malformed. Unknown fields are ignored for schema-v1 compatibility;
missing required fields, wrong types, empty identifiers, and invalid timestamps
refuse the source. This example is illustrative, not an observed assignment:

```json
{
  "schema_version": 1,
  "recorded_at": "2026-09-13T12:00:00Z",
  "projects": [{
    "git_common_dir": "/sample/project-a/.git",
    "assignments": [{
      "assignment_id": "A-001", "revision": 1,
      "outcome_id": "O-1", "outcome_goal": "Document one workflow",
      "owner_id": "engineer-a", "integration_owner_id": "owner-a",
      "session_row_ids": ["sample-row-1"],
      "milestone": "Draft ready for review", "blocker": null,
      "decision_needed": null, "next_action": "Owner verifies evidence",
      "applies_to_head": null, "latest_delta": null
    }]
  }]
}
```

The CLI verifies `git_common_dir` against discovered canonical
repository identity and joins only exact stable row IDs. Duplicated project,
assignment, or row mappings yield localized unavailable/error state, not a winner.

Read freshness and content applicability are separate. `observed_at` means a
successful foreground read; a failed read immediately marks retained values
read-stale, and missed-refresh staleness follows board-sampling. A successful
reread clears only read-staleness. Neither `recorded_at` is a TTL or heartbeat;
quiet, unchanged work needs no rewrite. `applies_to_head` matches a row's current
verified Git HEAD for assignment applicability. A mismatch is historical; missing
head evidence makes applicability unknown, never current. `latest_delta` is
current-applicable only when the assignment itself is current-applicable, its
revision matches the assignment revision, and its `evidence_head` matches that
verified HEAD. A mismatch is historical; missing head or null delta is unknown.
Validate timestamps for UTC form, ordering
(`latest_delta.recorded_at` no later than snapshot `recorded_at`), and no more
than five minutes ahead of capture time; age alone never invalidates a report.
Thus a readable old snapshot with a mismatched HEAD is obsolete, while an
unchanged snapshot with a matching HEAD remains applicable without report traffic.
Even a current-applicable pointer is a report claim, not verified acceptance or
authority; changed plans outside the observed Git/head evidence remain unverified
until the project owner checks primary sources.

The snapshot is a display projection, not the roster's authority or a raw-report
store. It may be private; tracked examples use placeholders only. A matching row
gains nullable `coordination` fields with `source: explicit-snapshot`,
`observed_at`, `read_stale`, `assignment_applicability`,
`delta_applicability`, and `unavailable_reason`. Top-level
`coverage.coordination` is `not-selected`, `available`, `partial`, or
`unavailable`. Historical pointers may remain visible with their reason but must
not be labeled current, accepted, or counted as a current decision. New CLI flags
and fields must be documented in README/REFERENCE when implemented, not in today's
current command docs.

The UI slice completes the source path: `lane.mjs` interactive launcher forwards
the once-resolved `--coordination` value through `board/args.mjs` and
`board/app.mjs` to `board/cli-client.mjs`, whose foreground watch child retains
the same value on initial spawn, explicit refresh, and reconnect. The UI never
opens the file itself; action children still receive only row ID and repository.
Reject missing/duplicate/unknown interactive options before starting Ink. An
injected process-boundary fixture must prove all forwarding stages and no replay,
even after reconnect.

The read-model brief may start only after inventory and sampling are promoted and
reviewed, so it can consume stable machine coverage and bounded observation. A UI
details extension starts after frame, details, and the read-model are promoted.
The manual protocol/pilot needs neither console extension, only operator protocol
review and explicit identity/two-project selection.

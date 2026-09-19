# Carry-forward after console integration closeout

Date: 2026-09-15, America/Chicago. This record closes the open sequence in
`docs/plans/2026-09-13-console-coordination.md`; that plan's accepted outcomes
stand. No lane worktree or lane session remains open after this closeout. Nothing
below is authorized to start merely because it is listed here: each item needs an
explicit owner, verified baseline SHA, brief, and review requirement at dispatch.

## Closed in this session

- **board-inventory (2c-i) integrated.** Independent Round 5 passed without
  findings at `204b6eadcd46cf536291bf4f47f6a5b89f764498` (base `ee529a3`). The
  public review is the sole successor change in evidence-only commit
  `205b619ddacda74583523dc25e08709166c3b6be`. The refreshed gate at that commit
  passed 234/234 with zero skips in 326.873 seconds. Promotion revalidated 234/234
  in 323.327 seconds and fast-forwarded main from `ee529a3` to `205b619` without a
  rebase. The merged branch and worktree are removed, the lane's Herdr workspace and
  tabs are closed, and its six registered sessions are marked done.
- **board-frame (3a-i) parked, not integrated.** Its lane was closed unmerged and is
  recoverable from tag `archive/lane/board-frame` at
  `9e8c8f99ed1ffdaf35de6694fbe0a6bfbf33161f`. It has no independent review, and its
  saved final gate exited 1; the delivery report attributes that to sandbox socket
  denial, but no green final gate replaced it. Its worktree and Herdr workspace are
  removed and its one registered session is marked done.

## Open items

| # | Item | State | Prerequisite | First next action |
| --- | --- | --- | --- | --- |
| 1 | board-frame reconciliation | Archived at `9e8c8f9`; conflicts with main in HANDOFF, README, REFERENCE, and `test/lane.test.mjs` | Inventory on main (met) | `lane open board-frame archive/lane/board-frame`, then rebase and fix the compatibility gaps below |
| 2 | board-sampling (2c-ii) | Proposed in `openspec/changes/board-sampling`; task unchecked | Inventory on main (met) | Open from main; serialize shared `lane.mjs`, test, and doc edits with item 1 |
| 3 | board-details (3a-ii) | Proposal exists only on the frame archive tag | Frame integrated and complete discovery | Wait for items 1 and 2 |
| 4 | Coordination read-model | Brief in `openspec/changes/identity-coordinator` | Inventory and sampling promoted | Wait for item 2 |
| 5 | Coordination UI | Brief in `openspec/changes/identity-coordinator` | Frame, details, and read-model promoted | Wait for items 1, 3, 4 |
| 6 | Idea CLI and composer (4a, 4b) | Proposed in `idea-cli` and `idea-composer` | Composer needs idea-cli and the board UX (frame and details) promoted | Later slice; no dispatch planned |
| 7 | Built-in route defaults | Proposed in `default-config`; needs amendment A5 approval | Operator approval | Operator decision |
| 8 | Manual coordinator pilot | Specification accepted; no projects selected | Operator selects one identity, two projects, outcomes, budgets | Operator decision |
| 9 | Release and distribution | Installed core snapshot predates inventory and excludes the console; closeout protocol pack `2026.09.13.1` not installed into identity roots | Operator decision | Decide whether to cut a new pinned release |
| 10 | Remote publication | Local main is far ahead of the remote | Explicit operator request | Never push without that request |
| 11 | OpenSpec housekeeping | Completed changes remain unarchived; `board-discovery` is superseded and unchecked; `board-ux` is superseded by the frame/details split on the archive tag | Frame integration settles the UX split | Archive completed changes in a documentation-only lane |

### Frame compatibility gaps with integrated inventory

These are source-inspection hypotheses from a read-only preflight against an earlier
inventory commit. Recheck them against current main before changing product code,
and write each as a failing regression first.

1. Inventory excludes metadata-completed rows at source unless `--all` is passed, so
   the frame's `h` history toggle must switch to a repository-filtered CLI watch with
   `--all` and back, preserving `row_id` selection and never replaying an action.
2. Group rows by reported `group.kind`; a facilitator may have a null `role`.
3. Label `active_after_done` rows distinctly from ordinary completed history.
4. Show discovery and endpoint coverage, and attribute an unavailable message to the
   affected row rather than the first document-level error.
5. Prove a positive registered live focus/done call alongside unregistered, stale,
   offline, hidden, and disappeared selections that make no call.

The frame branch alone carries operator-approved amendment A4 in `AGENTS.md`, the
board-frame and board-details OpenSpec split, and the current `board-terminal-ux`
spec. Retain the A4 text exactly when reconciling. Keep the single-repository scope;
machine-scope UI, details, sampling, and composer work stay out of that lane.

### Verification gaps carried forward

Live multi-endpoint discovery, the frame's 140x40 and `NO_COLOR` real-terminal
variants, alternate hosts, and minimum supported Node.js and Git versions have not
been exercised. Sandboxed engineer sessions cannot bind the Unix-socket fixtures
(`listen EPERM`); the facilitator's unsandboxed gate and promotion validation remain
authoritative for those tests.

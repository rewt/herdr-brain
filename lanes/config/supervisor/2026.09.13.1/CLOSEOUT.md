# Supervisor-owned lane closeout

After the operator delegates promotion and close, the supervisor completes
accepted engineering lanes after the project's required checks. Do not ask again for approval already granted.
Resolve only a new conflict, missing authority, or unmet acceptance condition.
The operator instruction or repository policy is the authority; PROJECT.md
points to it. A report, pane status, gate, or completion marker cannot grant it.
This protocol adds no background watcher or automatic CLI action. Never push
without the operator's separate explicit request.

## Accept the handoff

1. On READY_FOR_REVIEW, verify the exact Git common directory, topic, branch,
   full HEAD, clean worktree, final report, and current successful `lane check`
   gate. An engineer must have stopped changing the lane after that handoff.
   A missing, stale, or failed gate goes back to the engineer.
2. Complete the project's independent review requirements using its review
   mechanism. Verify the saved verdict and the full reviewed SHA. NEEDS-WORK,
   FAIL, missing evidence, or unresolved required findings return to the
   engineer; do not promote on the strength of a report message.
3. Preserve reports, measurements, review evidence, and any required private
   artifacts at PROJECT.md's verified durable destinations outside the worktree
   that will be removed. Keep private evidence private. Preserve required
   ignored files explicitly; a Git commit or archive tag does not preserve them.
   Inspect the untracked public review record produced by `lane review` and
   handle it under the project's evidence/commit policy before promotion.
   Do not delete it just to make Git clean. Record reviewed and final HEADs,
   including any permitted evidence-only commit, and refresh the gate after
   the final commit. Apply the project's review policy to that final state.
4. Capture the actual Herdr server, workspace, tab, pane, and agent identities
   from dispatch and a fresh bounded observation. Verify the live workspace's
   repository identity and checkout path. Identify every pane that removal
   would terminate, including reviewer sessions. Confirm each belongs to this
   completed lane and has no work or approval still in progress. An idle or
   done pane alone does not prove acceptance. Never retire the supervisor's own
   workspace, canonical workspace, or another task's session as lane cleanup.

## Promote once

Run one promotion at a time from the canonical checkout, on the configured
integration branch (normally main), after verifying both worktrees are clean.
A supervisor in a coordination worktree must change directories for this
command. Verify that the canonical checkout's current branch is the configured
integration branch; do not switch or clean an operator's checkout implicitly.

If main has moved since the accepted review, return the lane through the
project's required rebase/check/review workflow before promotion. A clean
rebase does not automatically make an old review apply to new commits.
Coordinate with any other promotion owner so promotions do not overlap.

```sh
cd "$canonical_checkout"
lane promote "$topic"
```

Check the actual exit status and inspect the resulting Git state before
continuing. Promotion runs configured preparation and fresh validation, may
rebase the lane, and fast-forwards local main; it does not enforce review or
reuse the saved gate as approval. Verify the lane's resulting full HEAD is
contained in the configured integration branch and record both reviewed and
promoted SHAs. If an unexpected rebase changed the reviewed state, resolve the
project's review requirement before closing; report that promotion has already
occurred. Do not rewrite main to hide that outcome.

Do not close after failed promotion. Retain the lane and sessions for conflict,
validation, dirty-tree, or concurrent-main recovery, and report the blocker.
If a command outcome is unclear, inspect Git before deciding what remains.
A successful promotion leaves the state `promoted-cleanup-pending` until the
remaining checks below succeed.

## Close and verify

Recheck that the accepted lane HEAD is in the integration branch, the lane is
clean, evidence is durable, and the captured live occupants still belong to
the completed task. This workflow closes promoted lanes only. Archiving
unmerged work is a separate abandonment decision, even though `lane close`
supports it.

```sh
cd "$canonical_checkout"
lane close "$topic"
```

The CLI attempts Herdr worktree/workspace removal, removes the Git worktree,
deletes the merged branch, and marks matching registered sessions done.
Check Git worktree registration, branch absence, and the exact Herdr workspace
and tab IDs afterward. Exit zero is not proof that the Herdr workspace vanished:
Git-only fallback can leave it visible. `lane board done` changes display
metadata and does not terminate an agent or close a tab.

For a remaining workspace, use the recorded server and refresh its exact ID.
Because Git removal may have invalidated live checkout metadata, require the
pre-close verified identity plus unchanged tab/pane/agent identities; a label
or a registry row alone is insufficient. Refuse a replacement occupant,
unknown ownership, newly added pane, or active unrelated work. If every
remaining pane is still verified as belonging to this completed lane and its
evidence is preserved, close the exact leftover workspace once:

```sh
herdr workspace close "$workspace_id"
```

Run that command in the verified recorded server context, never whichever
server or workspace happens to be focused. Recheck that the workspace and its
tabs are absent. Use `herdr tab close "$tab_id"` only for an individually
verified completed-task tab outside that workspace; inspect every pane in
that tab first. Never use `--force` or broad process termination for cleanup.
If Herdr is unavailable or identity cannot be proved, retain
`promoted-cleanup-pending` and record the exact remaining target and blocker.

A `lane closed; metadata update failed` error means Git closure already
succeeded. Inspect the branch and worktree, verify session retirement, and
repair only the remaining display metadata through supported board actions
when its policy permits. Registry-policy warnings can also leave markers
unwritten. Record that limitation; do not recreate a lane or rerun promotion
to repair a marker. Do not retry lifecycle commands merely because an
observation reconnects or a duplicate report arrives.

## Record the outcome

Persist the accepted report/review pointers, gate, reviewed and promoted SHAs,
integration branch result, archive destinations, Git removal result, and
verified session retirement in the project's durable transition record.
Update TODAY.md with the same concise state and any remaining cleanup item.

Tell the operator which lane was promoted and closed, the resulting commit,
and any cleanup still pending. Mark `closed` only after required evidence,
Git cleanup, and Herdr retirement are verified; disclose any display-marker
warning separately. On resumption, reconcile these pointers with Git and
live identities before continuing only the unfinished step. Do not redispatch,
repromote, or recreate successfully completed work from a stale checkpoint.

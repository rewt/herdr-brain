# Promotion completion for manual batches

Promotion is complete only when the integrated Git result and every batch member's
record agree. A green gate or a closed top lane alone does not complete a batch.
Use this shared Herdr Brain command for manually stacked lanes and legacy project
promoters. Native queue notices continue through `supervisor.mjs handle`; a
manual batch must use the reconciliation receipt below, including when it spans
several original lanes.

1. Rebase and independently review the exact candidate. Record every included
   item's final report and finish its review/approval blockers. List every item
   considered for the batch, including exclusions. Explicitly name older open
   attempts that the final run supersedes; preserve already recorded reports.
2. From the canonical checkout, prepare a receipt before the gate:

   ```sh
   node /path/to/herdr-brain/supervisor/reconcile.mjs prepare \
     --repo /path/to/project --org /path/to/record --role supervisor \
     --manifest /path/to/batch.json --prepared /path/to/prepared.json \
     --gate-log /path/to/gate.log
   ```

   Example manifest (replace every identifier and full Git hash):

   ```json
   {
     "batch": "promotion-20261010-1",
     "candidate": "FULL_CANDIDATE_SHA",
     "items": [{
       "item": "ENG-1", "run": "R-3", "head": "FULL_REVIEWED_SHA",
       "superseded": ["R-1"],
       "why": "Independent review PASS; operator-authorized local promotion"
     }],
     "excluded": [{
       "item": "ENG-2", "run": "R-4", "superseded": [],
       "reason": "Needs a follow-up review after rebase",
       "next_action": "Rebase onto ENG-1, then dispatch the delta review",
       "blocked_by": ["ENG-1"]
     }]
   }
   ```

   A recorded blocked report requires an explicit `resolution` on its included
   entry. This does not override unresolved record blockers, declined operator
   questions or operator-reserved work. Exclusions remain open; a worker's done
   outcome is cleared so exclusion does not look like promotion. Record an
   immediate hold/block before preparation when work must stop now.
3. Run the project's approved promotion command once in its visible terminal.
   It owns validation and the clean fast-forward. Capture its real exit status;
   no model calls or status polling are needed. On gate failure, retain all lanes
   and record the failure and next action. Nothing is completed by this helper.
4. Only after successful integration, finish with that exit and exact tip:

   ```sh
   node /path/to/herdr-brain/supervisor/reconcile.mjs finish \
     --repo /path/to/project --org /path/to/record --role supervisor \
     --prepared /path/to/prepared.json --gate-exit 0 --tip FULL_CANDIDATE_SHA
   ```

   The supervisor attests to the promoter's actual successful exit; a log saying
   PASS is not itself authority. The command checks canonical project identity,
   the explicit record against discovery (ignoring inherited `ORG_DIR`), clean
   checkout, unchanged branch, exact candidate and integrated ancestry of every
   included head. It binds the nonempty gate log by SHA-256. Under the record lock,
   `record complete-batch --file RECEIPT` checks the prepared item/run/dependency
   fingerprints, retires explicitly superseded open attempts, closes all included
   items, records exclusions and appends a reconciliation marker in one transaction.
   The core treats Git/gate evidence as opaque supervisor attestations; Git
   verification belongs to the adapter. Only the record CLI writes record events.
5. Clean up merged lanes only after reconciliation succeeds. If Git integrated
   but reconciliation refuses, report **integrated; reconciliation pending** and
   retain lanes/evidence for inspection. Do not rerun a successful gate to retry
   bookkeeping. An identical finish is a no-op, even after a later item reopen;
   changed evidence cannot reuse the batch identity. A new run, blocker, report,
   hold or relevant note requires inspection before a newly prepared receipt.

The helper is foreground and dependency-free. It never dispatches, tests, promotes,
pushes, deletes a lane, installs a release, starts a scheduler, or polls. Keep the
prepared receipt, gate log and generated `.record.json` in durable project storage.
List the covered lanes in the supervisor's final batch result and close each merged
lane through its normal CLI. Unmerged exclusions remain recoverable; archive them
only after an explicit disposition rather than treating exclusion as abandonment.

## BCH Cloak transition

BCH Cloak's existing wrapper retains its pinned runtime, gate tier, host slot,
watchdog and Git promotion safeguards. It must require a batch manifest and call
this shared prepare/finish pair, refusing cleanup if completion fails. Set an
explicit `HERDR_BRAIN_ROOT` when piloting a reviewed source checkout; otherwise use
the installed release carrying this command. No global runtime switch is implied.

The destination is Herdr Brain's dispatch → settle/review → promotion queue →
record completion workflow. Retire the local promotion wrapper and watchdog only
at BCH Cloak's recorded release-gated switch (ENG-64), after testing the pinned
release's gate profile, Node runtime, host slot, review route and notice delivery.
Keep BCH-specific validation commands as configuration. Do not fork the shared
record reconciliation logic into BCH scripts or silently activate a new release.

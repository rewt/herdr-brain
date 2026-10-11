# Promotion completion for native and manual batches

Promotion is complete only when the integrated Git result and every batch member's
record agree. A green gate or a closed top lane alone does not complete a batch.
Use this shared Herdr Brain command for manually stacked lanes and legacy project
promoters. The native queue captures record fingerprints before gating, then calls the same
`record complete-batch` transaction for all successful members before any lane
cleanup. Its durable `train.json.record.json` binds every included member, the
original base, integrated tip, and each successful attempt's retained gate proof.
A bisected batch accounts for refused members as historical exclusions with a
reason and next action; it does not mutate their newer runs or outcomes. Manual
batches use the prepare/finish receipt below, including across original lanes.

When native integration succeeds but completion refuses, the queue reports
**integrated; reconciliation pending**, retains lanes and evidence, and keeps an
owned resumable batch. The queue's supported recovery reuses the completed train
and retries bookkeeping without host admission, validation or integration. A
changed included run/blocker/report still requires inspection; it never refreshes
the original fingerprint silently. Legacy successful trains without preparation
need the guarded manual recovery path. Later notices verify the reconciliation
marker instead of closing members individually. Git-only queues without a record
make no organizational completion claim.

For a native batch pending after a relevant note or resolved blocker changes its
fingerprint, the canonical project supervisor can recover it as follows:

1. Inspect the retained `train.json`, its `.record.json`, and gate log. Confirm
   every integrated member still has the same current done run and exact lane
   head, and resolve any new approval or blocker. Preserve the original receipts.
   A newer run needs its own reviewed work; this recovery cannot substitute it.
2. Create a new manual manifest with a new batch ID. Copy every included
   `item`, `run`, `head` and explicit `superseded` list from the native `.record.json`,
   add an inspection reason in `why` (and `resolution` for report questions), and
   copy every historical exclusion unchanged. Set `candidate` to the native
   receipt's integrated `tip`. Use the manual `prepare` and `finish` commands below
   with a new prepared filename and the retained native gate log. Attest to the
   already successful gate exit with `--gate-exit 0`; no new gate is needed.
3. Resume bookkeeping through the normal queue worker from the canonical
   supervisor, using an acknowledged included run:

   ```sh
   node /path/to/herdr-brain/supervisor/supervisor.mjs promote R-N \
     --repo /path/to/project --org /path/to/record --role supervisor \
     --retry --why "Inspected and manually reconciled the retained native batch"
   ```

   This starts the normal worker via `promote.mjs --resume`; do not invoke
   `--drain` from the supervisor shell. The queue recognizes the new reconciliation
   marker only when it covers every original included run and exact integrated
   head, every explicit superseded attempt, and every historical exclusion. It
   retains the original native fingerprints and successful attempts, clears the
   interrupted batch and cleans the completed lanes. Incomplete or different-head
   manual coverage stays pending. Reopened items and newer runs retain their lanes.
   Later notices verify this marker as well. Markers from older runtimes without
   per-member heads cannot authorize this recovery; use the reviewed implementation.

Native record-bound requests and unbound Git requests form separate batches.
Each member derives the shared completion transaction before any gate; invalid
members are refused individually. The final fast-forward guard rechecks each
original completion fingerprint while holding the record lock. Native enqueue
supports `--superseded-runs '["R-OLD"]'` with `--if-current-run R-NEW` to name older
open attempts explicitly; omitted attempts refuse admission and remain intact.

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

# Completion, acceptance and progress

`record show ID --json` exposes `conditions`; the local project page includes
those same facts and `phase`. Each condition has True/False/Unknown, a reason,
observed run/report/claim generation and transition evidence. These are read-only
projections over the record. They grant no native effect or release authority.

- Completed: the latest run has a done report, independently of review or cleanup.
- SourceDelivered: a source landing belongs to that run, project and claim.
- Accepted: code needs its existing async review's exact run/report/head/base/claim
  judgment and covered commits. An old item/head-only PASS accepts nothing new.
  Plans use a completed report with no outstanding question, blocker or review.
  Corrections use the finding discharge below. A missing result is Unknown.
- Progressing: owned source transitions provide positive record evidence. An
  explicit available observation interval with no transition is False; missing,
  foreign or unavailable observations are Unknown. Finished runs are False.
  There is no inactivity timer, stop, replacement, counter-based acceptance or
  claim of native liveness. ENG-1033 owns the bound observation/counter feed.

The phase is derived: pending, working, ready-for-review, in-review, needs-work,
accepted. There is no setter. Existing historical item status is preserved;
completion, source, native retirement and acceptance remain separate facts.

In that same async review report, a fulfilled result is declared as:

```yaml
acceptance:
  fulfilled: true
  source_run: R-1
  source_report_sha256: ACTUAL_ORIGINAL_REPORT_SHA256
  head: FULL_CAPTURED_HEAD
  claim_generation: 123
```

The review owns this judgment; the producer cannot self-accept code. Intake
binds it to the original capture and actual report. This also lets an existing
native-landings capture retain its source-only evidence while the same reviewer
names the actual producer result it assessed. Missing report/result means Unknown;
finish with its missing-proof owner in the report, without waiting or starting
another review. A bare PASS remains historical review evidence, not acceptance.

## Dependencies and existing consumers

`record block CONSUMER --by PRODUCER` retains existing completion semantics,
including negative-verdict holds, declined questions and legacy child reviews.
The async queue's sibling review metadata creates no new completion hold.
`--requires accepted` opts a new edge into acceptance as an additional requirement.
Unknown never releases it. Existing edges are not migrated; change a requirement
only by explicitly removing and recreating its edge. Saved accepted edges name
consumer, wake facts and stuck owner. The existing record/status reader is the
consumer; no new evaluator, watcher or background process is installed.

The state dependency resolver, `record show/status --json`, blocker explanations
and project page share the conditions. Existing conditional close, completion
reconciliation, promotion, release and physical cleanup keep their native controls;
this projection does not replace their gates. In particular an original negative
verdict hold remains until its existing owner disposes of it, even when correction
evidence establishes accepted outcome. Worker landing and retirement do not wait
for acceptance. No historical done item is reopened or selected by these views.

## Single correction discharge

The existing report ingestion can emit `correction.discharged` after verifying
proof for each original `review.finding-linked` key. The immutable report retains
all declarations, including missing or failed proof. A done correction alone,
a selected command, assertions, a moving counter or a prose claim does not discharge.

Example report frontmatter extension (replace every example value with actual
owned findings, run, claim, landed head and existing check receipt; the rebase
exception below applies only to a selected unrun final-head correction control):

```yaml
correction_discharge:
  review_key: ENG-1:FULL_ORIGINAL_REVIEW_HEAD
  run: R-4
  claim_generation: 123
  findings:
    - key: review-finding/v1:ORIGINAL_KEY
      result: PASS
      head: FULL_LANDED_CORRECTION_HEAD
      command: "ACTUAL_COMMAND_FROM_GATE_JSON"
      requirement: Exact original required Major check text
      evidence: /owning/.org/evidence/correction/gate.json
      sha256: SHA256_OF_GATE_JSON_BYTES
      prior_checks: # every earlier receipt for this command in this run/lane
        - head: FULL_EARLIER_HEAD
          next_head: FULL_LANDED_CORRECTION_HEAD
          reason: Required rebase onto advanced main
          command: "ACTUAL_COMMAND_FROM_EARLIER_GATE_JSON"
          evidence: /owning/.org/evidence/correction/earlier-gate.json
          sha256: SHA256_OF_EARLIER_GATE_BYTES
          log:
            evidence: /owning/.org/evidence/correction/earlier.log
            sha256: SHA256_OF_EARLIER_LOG_BYTES
          execution_receipt:
            evidence: /owning/.org/evidence/correction/earlier.execution.json
            sha256: SHA256_OF_EARLIER_EXECUTION_BYTES
```

Copy each `command` verbatim from that receipt's `gate.json`, including quoting
and embedded newlines, rather than from the command typed after `check --cmd`.
For example, a pinned-source change can append the compatibility runner, and an
exact gate records its planned compound command. Intake compares the declaration
with `gate.command` exactly; using the typed command instead leaves discharge
Unknown. To obtain a YAML-compatible quoted value with newlines preserved:

```sh
node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).command))' /owning/.org/evidence/correction/gate.json
```

Intake checks the original correction/finding/run binding, claim and landed head,
receipt hash, command, executed green result, log hash and actual execution result.
The receipt must survive lane removal in the owning record's evidence directory;
its original log and execution sidecar remain retrievable. Majors must name their
original required-check text. Missing, red, changed and unrun controls produce no
discharge, without refusing or rewriting the report. Intake uses the same guarded
record mutation; it does not run checks, retarget findings or start another review.
A discharge can establish accepted outcome while preserving the original FAIL.
The release owner still judges whether the specific Major control proves its
correction and runs final-release/live coverage.

### Required rebase after a correction check

Formal correction context automatically authorizes the worker to run the same
selected affected command through `lane check --cmd` on the clean committed
rebased candidate when a required rebase moves the head after its check. No
supervisor authorization is needed. This is the supported final-head check path,
including for a byte-identical owned diff; intake still requires
`gate.head = finding.head = landing.head`. Diff equivalence alone accepts nothing.

Before checking, preserve every earlier gate JSON, log and execution receipt in
the owning record evidence directory, and record the old/new heads, rebase reason
and selected command. Each finding's `prior_checks` supplies the preserved gate,
log and execution sidecar with their byte hashes. A changed head names `next_head`
(the final landed head) and a nonempty `reason`; same-head failed attempts still
retain their receipts. Earlier results need not be green. Intake compares these
copies with the actual common-directory receipts and rejects omitted or changed
evidence, even if the worker hashes its changed copy again.

Validation records each executed or reused receipt independently under
`lane-validation/history/BRANCH_HASH/`, using exclusive creation. The cache and
lane-local gate may advance without replacing those observations. Copy the gate
at its `history_receipt`, plus its log and execution receipt; legacy gates without
that field use their keyed receipt. Intake selects the recorded lane's command
receipts observed since this run started, up to report intake. New gates
use the branch-specific history; legacy gates also inspect the keyed inventory.
Other lanes, commands and earlier runs do not create preservation obligations.
This verifies retained validation evidence; it does not cryptographically attest
the worker's reason or recover evidence deleted from the source inventory.

Run only that control once per new head. Reuse an existing
green final-head receipt instead of replaying it for another receipt; the lane's
existing tree/environment cache may also supply a reused receipt with the current
head and original execution evidence. Another required rebase makes a different
head's control unrun under the same rule. Red, failed and unrun evidence stays in
the ledger, with the existing fix limits and failing/affected/unrun selection.
The report names the landed head, its receipt and the original Major requirement.

This narrow exception to the green-replay rule applies only to formal corrections
with assigned findings. It authorizes no ordinary continuation, broader suite,
new review or release and changes no native, claim, source, STOP/HOLD or guarded
landing checks. Workers should rebase before their first selected check when
possible; they never run a second check just to create a receipt on the same head.
The next real rebased correction remains the live witness: its existing report
intake must discharge without supervisor action. A fixture is not that witness.

ENG-1037's residual obligation is to witness this exact producer-to-intake-to-release
handoff with a real assigned correction: inherited finding/check, one captured
result, discharge and existing negative-hold disposition. It should fix a concrete
remaining consumer gap if observed, without adding a reviewer or overriding saved
runtime pins. Old pinned intake without this new fact leaves acceptance Unknown;
activation/migration remains with its actual owner. ENG-1035's bounded packet
selects a check but supplies no result; it accepts nothing. Its real independent
cold-reader observations remain with its single existing queued review.

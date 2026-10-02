---
run: R-115
outcome: done
summary: |
  Fixed the native pane_focused envelope mismatch and added a regression proving
  that a transient owned move fails even when every sample is unchanged.
  Applied the supervisor's destination-specific correlation rule: unrelated
  navigation remains external even during another call, is reported, and
  re-baselines the monitor. Retained startup replay before the baseline and
  switched sampling to the native global pane.current read. Full acceptance
  passed all 27 cases while the operator worked normally, with 1,551 samples,
  eight external changes, and zero harness changes or monitoring errors.
headline: Acceptance preserves focus while the operator works normally
blockers: []
proposals: []
learnings:
  - Herdr protocol 20 subscribes with pane.focused but delivers pane_focused envelopes; native-shaped fixtures must exercise the envelope spelling.
  - Herdr 0.8.2 starts subscriptions with retained events and delivers one matching event per polling cycle; retain and drain startup replay before taking the baseline or starting candidate work.
  - Temporal overlap alone is diagnostic context. Correlation requires the destination pane or workspace to match a call's target or native creation result.
  - Creation-result ownership must survive cleanup, and a transient creation-time event may arrive before the ownership ledger is updated.
  - Native pane.current without caller_pane_id reads global UI focus and avoids collecting metadata for every background pane on each sample.
artifacts:
  - "Commit: Handle native Herdr focus event envelopes"
  - "Commit: Drain retained focus events before acceptance starts"
  - "Commit: Correlate focus changes with their specific destinations"
  - "Commit: Sample only the globally focused Herdr pane"
  - "Commit: Report native focus acceptance and destination correlation"
  - "Branch: lane/operator-focus"
  - "docs/briefs/BRIEF-ENG-98-operator-focus-20261002.md"
  - "docs/reports/ENG-98-operator-focus-r3-20261002.md"
  - "docs/reports/ENG-98-operator-focus-r3-evidence-20261002/candidate/summary.json"
  - "docs/reports/ENG-98-operator-focus-r3-evidence-20261002/candidate/screen.txt"
  - "/private/tmp/eng98-r115-focused-gate/herdr-acceptance-NXJCHJ/evidence/01.jsonl through 27.jsonl"
  - "/private/tmp/eng98-r115-focused-gate/herdr-acceptance-NXJCHJ/evidence/focus-summary.json"
  - "/private/tmp/eng98-r115-focused-gate/herdr-acceptance-NXJCHJ/evidence/focus-trace.jsonl"
  - "/private/tmp/eng98-r115-focused-gate/herdr-acceptance-NXJCHJ/evidence/focus-calls.jsonl"
  - "/private/tmp/eng98-r115-focused-gate/herdr-acceptance-NXJCHJ/evidence/discovery-usage.json"
  - "/private/tmp/eng98-r115-focused-gate/herdr-acceptance-NXJCHJ/evidence/discovery-{french,german,routing,routing-apply}.{prompt.txt,jsonl,txt,boundary.json,sources.json,entry.json}"
  - "/private/tmp/eng98-r115-focused-gate/herdr-acceptance-NXJCHJ/evidence/cleanup-residue.json"
  - "/private/tmp/eng98-r115-focused-gate/herdr-acceptance-NXJCHJ/evidence/implicit-source-cleanup/{verification.json,closure.json,focus-summary.json,focus-trace.jsonl,remaining-scratch.json}"
  - "/private/tmp/eng98-r115-full-gate/herdr-acceptance-wyBnXc/evidence/summary.json"
  - "/private/tmp/eng98-r115-rerun/herdr-acceptance-FjhzKA/evidence/summary.json"
  - "/private/tmp/eng98-r115-destination-gate/herdr-acceptance-CWlVkW/evidence/summary.json"
  - "/private/tmp/eng98-r115-final-gate/herdr-acceptance-LxWKgi/evidence/summary.json"
  - "/private/tmp/eng98-r115-regressions-before.log; /private/tmp/eng98-r115-regressions-after.log"
  - "/private/tmp/eng98-r115-correlation-before.log; /private/tmp/eng98-r115-destination-regressions.log"
  - "/private/tmp/eng98-r115-acceptance-focused-read.log; /private/tmp/eng98-r115-after-tests.log"
  - "Final validation command: node lanes/lane.mjs check; log: /private/tmp/eng98-r115-final-lane-check.log; exact committed-HEAD receipt: .lane/gate.json"
decisions:
  - text: Subscribe using pane.focused and consume the native pane_focused envelope.
    category: prover
    why: The review identified a silent miss of native transient events. The regression now delivers the actual envelope and requires failure with requested and transported call attribution despite unchanged samples.
  - text: Retain startup events and establish a settled baseline before any candidate work.
    category: prover
    why: Native retained replay otherwise assigns historical navigation to current calls. Four quiet polling cycles are required within a bounded five seconds; uncertainty remains PENDING and live events are never discarded.
  - text: Fail owned destinations and specific call-targeted or call-created destinations, retaining unrelated temporal overlap only as diagnostics.
    category: prover
    why: The supervisor explicitly requires normal operator activity. Matching opaque native IDs distinguishes this run's destinations from unrelated navigation, including named agent targets and creation events arriving before ledger registration.
  - text: Sample global focus with pane.current and an empty parameter object.
    category: prover
    why: Two complete native runs had pane.list request timeouts while the global inventory contained 328 panes. The focused-only read preserves the global sampling contract and completed the full gate without errors; missing reads still cannot pass.
questions: []
challenges:
  - premise: Review finding 2 requires failure on every global focus change, including external navigation.
    evidence: The ENG-98 supervisor decision recorded at 11:29 explicitly allows external changes to be reported and re-baselined. The supervisor repeated that decision for R-115 and clarified its scope during this run; the lane brief now includes the amendment.
    resolution: Finding 2 is superseded. Keep external recording, reporting and re-baselining. Fail destinations owned or created by the harness, or specifically targeted or created by a concurrent harness or candidate call.
  - premise: A focus event overlapping any harness call is correlated with that call, or the operator must keep focus still for a valid gate.
    evidence: The second attempt misattributed navigation to w271:p1 while unrelated input targeted w273:p2. In the successful run, navigation to w272:p3 overlapped creation of w29N:p2 in workspace w29N; the exact destinations differ.
    resolution: Narrow correlation to matching destinations and retain other nearby calls for diagnosis. The operator worked normally throughout the successful gate; no quiet-focus condition was imposed.
  - premise: Every event delivered after subscription acknowledgement belongs to the current run.
    evidence: Herdr 0.8.2 starts the native subscription cursor at zero. The initial attempt received historical events; the successful run retained 18 startup events before its baseline and eight subsequent live events.
    resolution: Drain and retain startup replay before candidate work, then observe every native focus event for the remainder of the run, including cleanup.
  - premise: Zero attributed harness changes proves focus preservation even when sampling has errors.
    evidence: The two pane.list attempts had zero harness changes but 17 and 21 request errors, respectively; both correctly returned 26 PASS and one PENDING.
    resolution: Do not count those attempts as successful acceptance. The final pane.current run has complete samples, zero errors and 27 PASS.
  - premise: The receipt-owned cleanup audit covers implicit source workspaces.
    evidence: Each attempt left one implicit default-cycle source workspace outside the runner's ownership ledger, the existing ENG-99 gap. Each was independently proved by pre-run absence, a successful native creation receipt, scratch containment and canonical Git identity.
    resolution: Close only the independently verified run-created source under a separate focus monitor. Retain the existing ENG-99 follow-on without a duplicate proposal.
---

The native event mismatch from finding 1 is fixed. Its regression sends the
protocol-20 envelope, moves focus to a scratch pane and back between unchanged
samples, and requires a failing verdict naming both the requested and actual
call. It failed against the reviewed implementation and passes with the fix.
The R-113 and R-114 reports are unchanged.

The new correlation controls cover both supervisor-required cases: an external
move during an unrelated active or completed call passes and re-baselines,
while a move to a concurrent call's exact target fails. Additional controls
cover the most recently completed matching workspace call despite a newer
unrelated completion, a named agent's native-resolved pane, and a transient
creation-time move before ownership registration. The unrelated-overlap,
matching-completion and creation controls failed against the preceding
implementation. Creation receipts retain opaque IDs for the whole run,
including after cleanup removes them from the live ledger.

Native replay is retained separately before the baseline. The bounded drain
uses four quiet 100 ms polling cycles; inability to establish that boundary
remains a harness limitation. This follows Herdr's
[subscription cursor implementation](https://raw.githubusercontent.com/herdrdev/herdr/v0.8.2/src/api/subscriptions.rs)
and [native polling loop](https://raw.githubusercontent.com/herdrdev/herdr/v0.8.2/src/api/server.rs).
The sampler uses `pane.current` with `{}`, so no caller identity redirects it
away from global UI focus. The
[native pane-current implementation](https://raw.githubusercontent.com/herdrdev/herdr/v0.8.2/src/app/api/panes.rs)
provides that behavior; the fixture rejects caller-scoped sampling.

| Validation | Result |
| --- | --- |
| Baseline `npm test`, before edits | 683 pass, 0 fail, 11 skip |
| `npm test` after the correlation change | 683 pass, 0 fail, 11 skip |
| Offline acceptance after the final sampler change | 81 pass, 0 fail, 0 skip |
| Full acceptance of the committed candidate | 27 pass, 0 fail, 0 pending |

The full gate used the candidate from **Sample only the globally focused Herdr
pane** and lasted **440 seconds**. Its focus summary retained **1,551 samples,
eight live events, 18 startup events, eight external changes, zero harness
changes, zero forbidden attempts and zero errors**. The summary's total elapsed
time, including startup, is **439,746 ms**. Initial and final focus were
**wFN:pY6**. Eight external moves occurred in between; equality of the endpoints
is not the proof. The complete samples and event stream establish zero moves
to owned or specifically correlated destinations under the amended rule.

For example, during cutover an external event moved from w271:p3 to w272:p3
just after a tab creation in w29N. The receipt names the newly created
w29N:p2. The trace retains that creation in `nearbyCalls`, leaves `calls` empty,
classifies the move as external, and re-baselines to w272:p3. This is the
supervisor's required treatment of unrelated time overlap.

```sh
ACCEPTANCE_TMPDIR=/private/tmp/eng98-r115-focused-gate node acceptance/run.mjs \
  --candidate HEAD \
  --bch-cloak /Users/rewt/development/bastian/bch-cloak \
  --npm-cache /Users/rewt/.npm \
  --discovery-model gpt-5.6-luna --discovery-effort low --keep
```

All four measured discovery sessions used **gpt-5.6-luna / low** and exited
successfully. Prompts, transcripts, source and permission receipts, usage,
numbered case logs, and raw native/focus calls remain under the successful
scratch evidence directory named in `artifacts`. Only its `summary.json` and
`screen.txt` are newly tracked in the repository.

The four earlier attempts are retained as diagnostic evidence. The first
returned **26 PASS / 1 FAIL / 0 PENDING** because historical replay entered the
live stream; the second returned the same counts because broad temporal
correlation misattributed unrelated navigation. The following two returned
**26 PASS / 0 FAIL / 1 PENDING** because of native sampling timeouts. Those
attempts are not accepted as green evidence. The focused-only sampler removes
global inventory enumeration; the final gate supplies the complete native
witness.

The runner removed authentication copies and reported no receipt-owned
workspace residue or cleanup errors. Its implicit source workspace was then
independently verified and closed. The separate cleanup trace has **three
samples, zero harness or external changes and zero errors**, preserves wFN:pY6,
and retains an empty remaining-scratch workspace list. The same verified
cleanup was performed for every diagnostic attempt. The ownership-ledger gap
remains the existing ENG-99 work item.

The report is checked and committed before the final configured
`node lanes/lane.mjs check`. That check runs `npm test` on the clean, committed
report HEAD and records its result in `.lane/gate.json`; its log path is listed
above. Live bch-cloak, shared lane configuration, releases and the operator's
bin were not changed. No push or publish was performed.

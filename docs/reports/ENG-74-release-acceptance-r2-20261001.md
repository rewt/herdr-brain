---
run: R-50
outcome: blocked
summary: |
  Fixed all six release-gate review findings: copied code fails closed on live paths and record escapes, real discovery projects and sessions are isolated, policy delivery requires source evidence, workspace metadata is polled before wrappers, missing tools are named pending, and owned agent send-keys checks cwd. The final main and v0.1.3 runs remain NOT READY: entering agents discover no product policy, edit shared main and leave no record; background metadata remains absent during the bounded wait. Only summaries and screens are retained in Git; raw evidence and all measured discovery costs stay in scratch. No live record, project or release was changed.
headline: The gate safety fixes are complete, but fresh projects still do not discover the workflow
blockers:
  - "Fresh-project record and routing require hand setup; the default dispatch/watch cycle is unproved. Both real discovery cases have no product source witness, no separate lanes or recorded work, and no recorded human routing decision. Existing follow-up: ENG-77."
  - "Canonical background workspace metadata did not appear within the 15-second poll on either candidate, so wrapper execution was refused. Round-three correction: after the shell cwd is ready, identity is still absent for the idle background copy while the active main fixture has it; this is a bounded background/activity publication gap, not the initial cwd race. Existing follow-up: ENG-79."
  - "Housekeeping encounters an automatically added pane outside creation receipts; the boundary refuses it. Complete closure and the ten cutover behavioral canaries/rollback remain unproved. Existing follow-up: ENG-78."
proposals: []
learnings:
  - "Native Codex 0.159.3 accepts a named permission profile extending :workspace, with :root denied, :minimal read, :slash_tmp denied, own workspace/temp writable and installed tools read-only. Resolve the native executable symlink first: the filesystem helper otherwise fails before inference."
  - "A successful native boundary probe is not a successful model session. Require turn.completed usage, a successful exit and a structured final answer before asserting discovery."
  - "Installed adapter developer instructions are a legitimate policy source when captured at the host/native transport boundary. Do not require the agent to rediscover an injected policy by reading a repository file."
  - "Node resolves scratch script paths through ancestor lstat calls; copied-script sandboxing must permit metadata traversal while denying external file contents and writes. A regression launches a real scratch file, not only node -e."
  - "The routing answer phase was not reached. The prior scratch primitive proof used other with ask; tooling auto-answer in this organization must never substitute for an actual human routing decision."
artifacts:
  - "Commit: Close release acceptance safety and discovery review gaps"
  - "Commit: Report isolated release acceptance and correct prior evidence"
  - acceptance/security.mjs
  - acceptance/record-shim.mjs
  - acceptance/native-transport.mjs
  - acceptance/run.mjs
  - acceptance/live.mjs
  - acceptance/live-worker.mjs
  - acceptance/herdr.mjs
  - acceptance/test/security.test.mjs
  - acceptance/test/boundary.test.mjs
  - acceptance/README.md
  - docs/reviews/release-acceptance/c7397cf-r1.md
  - docs/reports/ENG-74-release-acceptance-20261001.md
  - docs/reports/ENG-74-acceptance-evidence-r2-20261001
  - "/private/tmp/herdr-acceptance-84BHSW/evidence"
  - "/private/tmp/herdr-acceptance-1K7rxH/evidence"
  - "/private/tmp/eng74-r46-evidence-archive-x3zjgyx3/ENG-74-acceptance-evidence-20261001"
  - "/private/tmp/eng74-r50-all-discovery-costs.json"
  - "npm test before: 371 passed, one explicit skip, zero failed; /private/tmp/eng74-r50-before.log"
  - "npm test after: 371 passed, one explicit skip, zero failed; /private/tmp/eng74-r50-after-final.log"
  - "node --test acceptance/test/*.test.mjs: 10 passed, zero failed; /private/tmp/eng74-r50-boundary.log"
  - "record check this report, commit it, then node lanes/lane.mjs check last; final check result is reported at turn completion"
decisions:
  - decision: Fail closed before any copied code executes, then enforce an independent kernel boundary.
    why: Text relocation alone cannot constrain a dynamically computed record or code path. Require a matched launcher replacement, audit every transitive copied file before each invocation, pin a scratch ORG_DIR and deny external writes and host project contents.
  - decision: Separate fresh project parents from all harness and candidate artifacts, and require actual product policy attribution.
    why: First-round find .. exposed candidate AGENTS.md and module READMEs. A reported lane string or no-policy assertion is insufficient; successful tool output or a captured installed-adapter delivery must substantiate the source.
  - decision: Use the candidate's machine installer and native entry shim when shipped, with a transparent transport receipt.
    why: Bypassing the installed entry adapter would falsely reject project-entry delivery. The transport contributes no policy; it records supplied developer instructions, refuses foreign roots and reapplies the native permission boundary to validation.
  - decision: Keep the unresolved metadata finding bounded and revise the historical report and proposal.
    why: Immediate lookup was an inadequate test. The final poll found no worktree metadata in 85 main samples and 78 older-release samples over a 15-second timeout, so wrappers were not run. Later readiness remains possible.
questions: []
challenges:
  - premise: The first-round agents saw only the scratch project's README.
    verdict: wrong
    evidence: Retained find .. output listed neighboring candidate/AGENTS.md, module READMEs and release-source policy files. The original no-policy inference is withdrawn, and the original report now discloses the exposure.
  - premise: A whole-scratch writable root is an adequate real-session safety boundary.
    verdict: wrong
    evidence: It included the ownership ledger, launchers, done markers and other sessions' authentication homes. Final native probes deny parent traversal, candidate policy, harness reads/writes and direct live Herdr socket connection; only own project and session temp are writable.
  - premise: Background workspace identity failed only because of an immediate-startup race.
    verdict: partly
    evidence: Asynchronous population is plausible and the original test did not wait. Both corrected cold-workspace probes still timed out after 15 seconds, with ordinary OSC cwd/title announcements enabled. This does not prove metadata can never appear.
  - premise: Scripted workers establish agent discovery and human routing adoption.
    verdict: wrong
    evidence: They establish configured mechanics. Six final real Luna sessions completed measured turns but provided no product policy witness, separate lanes or record IDs; routing produced only Markdown, so scripted approval and real configuration application were not reached.
---

Round-three correction (R-52): the round-two discovery verdict was not a
usable judgment of an installed discovery candidate. Its native profile denied
Git metadata writes, and housekeeping refused a late default-layout pane; these
were harness limits, not missing product behavior. A rerun alone could not settle
ENG-77 until the gate allowed scratch Git capabilities and used the actual
installed entry adapter and bounded Git parent. The corrected gate captures the
product adapter's delivered policy instead of treating model paraphrases as the
source of truth. The historical screens below remain the original results.

The corrected case-16 reproduction waits for the shell cwd to equal the copied
project before its 15-second metadata poll. Main still exposes no identity for
that idle background workspace, while the active configured fixture carries
canonical worktree metadata during the same poll. ENG-79 is therefore a real,
bounded idle/background workspace identity gap, not the transient initial cwd
race. The finding does not establish indefinite absence or wrapper failure; the
wrappers are refused before execution. Investigate activity/focus-dependent
publication without synthesizing identity or focusing an operator pane. The
round-three report contains the new samples and the narrowed handoff.

All six findings in the [independent review](../reviews/release-acceptance/c7397cf-r1.md)
are addressed by **Close release acceptance safety and discovery review gaps**.
The code fix is delivered; release acceptance remains blocked by the existing
follow-ups above. No duplicate proposals are created.

The final main snapshot is **Brief for ENG-77: agents discover the workflow in any
project**. The older snapshot, v0.1.3, is **Add the console-fold review, round 2
(PASS)**. Neither snapshot contains the project-entry machine installer. These
runs therefore establish failure on those snapshots, not a verdict on unpromoted
ENG-77 work. The gate now uses the actual candidate installer when present and
accepts a captured installed policy delivered as developer instructions. That
conditional installation branch was not exercised by these two candidates; its
source-attribution rules have offline regression coverage. Round-three review found that this rerun first requires correcting the native
Git permission boundary and actually exercising the machine entry adapter; see
the correction above and the round-three report.

Final commands, outside npm test:

```sh
node acceptance/run.mjs --candidate main \
  --bch-cloak /Users/rewt/development/bastian/bch-cloak \
  --npm-cache /Users/rewt/.npm
node acceptance/run.mjs --candidate v0.1.3 \
  --bch-cloak /Users/rewt/development/bastian/bch-cloak \
  --npm-cache /Users/rewt/.npm
```

Both exit 1 because failures or pending cases keep the gate closed. Main took
185 seconds; v0.1.3 took 106 seconds. Summary/screen pairs are retained under
[the round-two evidence directory](ENG-74-acceptance-evidence-r2-20261001).
The two final one-screens are reproduced verbatim:

```text
Release acceptance: main (185s) — 13 pass / 7 fail / 2 pending — NOT READY
PASS    01 Candidate snapshot
FAIL    02 New project: record discovers and populates
FAIL    03 New project: routes resolve without config
FAIL    04 New project: discover dispatch/watch/default cycle
PASS    05 Real Herdr boundary and configured fixture
PASS    06 Configured cycle: dispatch/report/ingest/promote/close
PASS    07 Failure path: missing worker
PASS    08 Failure path: invalid worker
PASS    09 Failure path: blocked worker
PASS    10 Fix round: same worker, fresh durable run
PASS    11 Watch cutover: idle grace and exclusive watcher
FAIL    12 Housekeeping closes only eligible finished workers
PASS    13 Scratch release build/activate/rollback/restore
PASS    14 Full console dependency build (offline)
PASS    15 Existing project: copy live calls and inventory drift
FAIL    16 Existing project: routing and both wrapper dry runs
PASS    17 Existing project: org PATH consumers
PENDING 18 ENG-64: every file switch and rollback
PENDING 19 ENG-64: final contrib removal and restoration
FAIL    20 Real discovery: concurrent lanes and promotion
FAIL    21 Real discovery: routing question waits and answer applies
PASS    22 Cleanup and scope audit
Evidence: /private/tmp/herdr-acceptance-84BHSW/evidence (NN.jsonl; summary.json has reasons)
```

```text
Release acceptance: v0.1.3 (106s) — 7 pass / 4 fail / 11 pending — NOT READY
PASS    01 Candidate snapshot
FAIL    02 New project: record discovers and populates
PENDING 03 New project: routes resolve without config
PENDING 04 New project: discover dispatch/watch/default cycle
PASS    05 Real Herdr boundary and configured fixture
PENDING 06 Configured cycle: dispatch/report/ingest/promote/close
PENDING 07 Failure path: missing worker
PENDING 08 Failure path: invalid worker
PENDING 09 Failure path: blocked worker
PENDING 10 Fix round: same worker, fresh durable run
PENDING 11 Watch cutover: idle grace and exclusive watcher
PENDING 12 Housekeeping closes only eligible finished workers
PASS    13 Scratch release build/activate/rollback/restore
PASS    14 Full console dependency build (offline)
PASS    15 Existing project: copy live calls and inventory drift
FAIL    16 Existing project: routing and both wrapper dry runs
PASS    17 Existing project: org PATH consumers
PENDING 18 ENG-64: every file switch and rollback
PENDING 19 ENG-64: final contrib removal and restoration
FAIL    20 Real discovery: concurrent lanes and promotion
FAIL    21 Real discovery: routing question waits and answer applies
PASS    22 Cleanup and scope audit
Evidence: /private/tmp/herdr-acceptance-1K7rxH/evidence (NN.jsonl; summary.json has reasons)
```

Review fixes and evidence:

| Finding | Change and verification |
| --- | --- |
| Copied scripts could invoke live code or write a live record | Required launcher replacement must match. All copied files, including transitive callers, are relocated and audited before every execution; live paths, unresolved home forms and symlinks refuse execution. Every invocation requires an existing scratch ORG_DIR. PATH record shims reject pin changes and symlink escapes; the kernel denies all external writes and user/project/temp file contents, with scratch and trusted tools as exceptions. Tests cover changed spelling, a new live-path callee, pin/symlink escapes, computed external reads and writes. Final case 17 passes for both candidates under this boundary. |
| Discovery could read neighboring repository policy | Each project has a different /private/tmp/herdr-discovery-*/ parent containing only that project. Native permissions deny listing the parent and reading the candidate checkout. A read-only runtime installation excludes repository AGENTS.md, READMEs, docs, tests and kit. Final answers require exact product-source/excerpt witnesses; self-reports, neighboring policy and forged compound CLI output are refused. Raw sources.json records empty claimed/witnessed sources for all six final sessions. |
| Real sessions could alter the ledger, launchers, markers or authentication | Only the shared scratch project and each session's own distinct temp dir are writable. All harness capabilities, entrypoint launchers and runtime authentication homes remain outside those roots. Environment is allowlisted with no HERDR/ACCEPTANCE keys and no inherited record/routing/credential overrides. Six native sandbox probes deny harness read/write and a direct connect to the actual live Herdr socket with EPERM/EACCES; no socket message is sent. |
| Wrapper identity lookup could be a race | Poll owned workspace list for canonical checkout/repo identity before executing any wrapper. Save every sample. Main: 85 samples, last at 15,013 ms, no worktree metadata. v0.1.3: 78 samples, last at 14,870 ms, followed by timeout. Normal scratch-shell OSC cwd/title announcements were enabled. The wrappers and copied routing tests were not executed after timeout. |
| Missing rg/python3 became opaque failures | README names both tools and all other prerequisites. Startup probes them before candidate execution, and missing tools produce a named PENDING result. A regression hides only rg and verifies missing prerequisite: rg, no resolved candidate and no candidate case execution. |
| agent send-keys was unsupported | Permit only receipt-owned panes/agents with the same live cwd containment check as pane run. Tests verify owned success, foreign denial and denial after the owned pane's cwd moves out of scratch, with only one mutation reaching the fake API. |

What the real agents found:

Final main French and German sessions ran concurrently in
`/private/tmp/herdr-discovery-0lpfFj/project`. Both reported branch main and the
same checkout, with empty work/run IDs and policy_sources. They edited the
shared greetings file and tests. German preserved the observed French change,
but this does not establish isolated lanes or promotion. French attempted a
commit and native Git metadata protection denied index.lock. No sandbox bypass
was used. The main routing session worked in its own independent fresh project
and wrote MODEL_SELECTION.md and OPERATOR_QUESTION.md; its reported question ID
was a filename, not a record question. No recorded human-wait state existed.

The older-release French and German sessions likewise reported main, no record
IDs and no policy sources, and edited the shared scratch checkout. Its routing
session wrote MODEL_SELECTION_DECISION.md. In both candidates the cases fail at
product source attribution before the routing answer phase. The scripted human
yes and real application of approved routes were **not reached**. The prior
record-primitive proof of other/ask is retained in the first-round archive and
is not counted as real-agent discovery.

For a fresh project to pass, the installed product must deliver a discoverable
instruction source naming the canonical project record and automatic bootstrap,
separate worker lanes, actual task/run recording, check/rebase/green fast-forward
promotion, and supervisor dispatch/watch/default operation. It must carry the
portable route preset and cause an operator question proposing engineer
**gpt-6.1-sol high** and independent review **opus**, using a category/default that
waits for the operator. Product-created records and policy are allowed;
hand-configuring a discovery project to make it pass is not. ENG-77 owns this
existing gap. No policy was supplied by these test prompts.

ENG-79 and the earlier report:

The [first-round report](ENG-74-release-acceptance-20261001.md) now withdraws its
isolated no-policy inference, discloses the find .. exposure and broader writable
roots, and corrects both its metadata blocker and ENG-79 proposal to require a
bounded startup reproduction. The final worktree-list receipt still resolves
the same scratch repository while workspace-list omits worktree metadata during
the timeout. This is not evidence that wrappers themselves fail: they were
refused before execution. Investigate the bounded cold-start condition first;
metadata appearing after a longer delay remains possible. No identity was
synthesized and no operator pane was focused.

Main's configured record/dispatch/watch/report/fix-round/promotion cycle passes.
Housekeeping still encounters an extra automatically created pane outside its
creation grant, so the boundary refuses it and closure remains unproved. The
older release lacks the corresponding modules. All ten cutover edits and their
behavioral rollback canaries remain pending under ENG-78; byte/mode restoration
alone is insufficient. Both final existing-project PATH tests actually add and
ingest through the candidate record CLI under the pin/kernel boundary, then stop
at the intentionally missing Draft section before review-desk dispatch. This
proves that bounded compatibility path, not the entire settle/review handoff.

Raw evidence remains in scratch:

- Main: `/private/tmp/herdr-acceptance-84BHSW/evidence`.
- v0.1.3: `/private/tmp/herdr-acceptance-1K7rxH/evidence`.
- In each: NN.jsonl for case commands/results, workspace-metadata-probe.json,
  discovery-installation.json, discovery-*.boundary.json, discovery-*.sources.json,
  prompts, native JSONL transcripts, answers, usage, ownership and Herdr traces.
- Every formerly committed first-round raw artifact, including the mechanics
  rerun and cost ledger, is archived at
  `/private/tmp/eng74-r46-evidence-archive-x3zjgyx3/ENG-74-acceptance-evidence-20261001`.
- All round-two attempt costs and scratch evidence locations are listed in
  `/private/tmp/eng74-r50-all-discovery-costs.json`.

Only summary.json and screen.txt per candidate remain in both repository evidence
directories. The mechanics-final raw directory and root raw logs were removed
from Git. Ignore rules prevent accidental new raw evidence additions. All final
created workspaces were closed; discovery projects, own temp dirs, scratch
runtime files and temporary mode-0600 authentication copies were removed. Only
scratch evidence survives. Live Herdr retains its normal service logs; this is
not a separate Herdr server or a claim of zero operating-system side effects.

Measured discovery token cost:

All model turns used **gpt-5.6-luna low**, without route escalation, and ran outside
npm test. Cached input is included in input; reasoning is included in output.
These are native CLI usage counts, not a dollar billing estimate.

| Candidate | Session | Input | Cached input | Output | Reasoning output |
| --- | --- | ---: | ---: | ---: | ---: |
| main | french | 64,145 | 44,800 | 1,219 | 167 |
| main | german | 89,354 | 68,864 | 1,604 | 250 |
| main | routing | 64,951 | 47,872 | 1,502 | 353 |
| v0.1.3 | german | 52,854 | 38,912 | 993 | 139 |
| v0.1.3 | french | 94,266 | 73,984 | 1,912 | 140 |
| v0.1.3 | routing | 53,318 | 39,936 | 1,202 | 222 |

Final main: **218,450 input / 4,325 output**. Final v0.1.3:
**200,438 input / 4,107 output**. Debugging and reruns also consumed tokens:

| Scratch run (under /private/tmp; raw evidence in its evidence/) | Purpose | Completed turns | Input | Output |
| --- | --- | ---: | ---: | ---: |
| herdr-acceptance-3mG3JT | Mechanics only; initial relocation check | 0 | — | — |
| herdr-acceptance-jmQd9O | Mechanics only; copied-shell temp fix pending | 0 | — | — |
| herdr-acceptance-29SqEo | Mechanics only; copied PATH case passes | 0 | — | — |
| herdr-acceptance-GasJGX | Native preflight blocked by OpenSSL config read | 0 | — | — |
| herdr-acceptance-uVczBP | Native helper cannot execute launcher symlink | 0 | — | — |
| herdr-acceptance-7fvcn2 | Same native helper failure on main | 0 | — | — |
| herdr-acceptance-MPJByV | First isolated main turns after canonical-executable fix | 3 | 182,148 | 3,911 |
| herdr-acceptance-2IkYYS | Older-release full run; copied script metadata traversal denied | 3 | 200,341 | 4,018 |
| herdr-acceptance-y0IfPU | Main full run; same copied script traversal issue | 3 | 221,654 | 4,159 |
| herdr-acceptance-1K7rxH | Final older-release run | 3 | 200,438 | 4,107 |
| herdr-acceptance-84BHSW | Final main run | 3 | 218,450 | 4,325 |

Total measured for R-50: **1,023,031 input**, including **708,608 cached input**,
and **20,520 output**, including **3,465 reasoning output**, across **15 completed
turns**. Six native startups have no completed-turn usage receipt; missing usage
is not a claim of billed zero. The preflight and debug prompt-input probes made
no model turns. Failed launches are retained as harness failures and are not
discovery evidence. An early kernel whitelist experiment prevented macOS loader
startup; final permissions preserve system reads while denying host data/code
locations, and final boundary/copy tests pass. The intermediate full-run case-17
failures were fixed by allowing metadata traversal without allowing file contents.

Validation and stop sequence:

Baseline npm test: **372 tests, 371 passed, one explicit skip, zero failed**,
31.98 seconds. Final npm test: **372 tests, 371 passed, one explicit skip, zero
failed**, 44.26 seconds. The separate safety suite: **10 passed, zero failed**,
7.60 seconds, including a real macOS kernel sandbox probe. git diff --check
passed before the code commit. Core modules, dependency boundaries, derived
status and contrib/settle-watch.mjs were not changed.

The report is checked with the record CLI, committed as **Report isolated release
acceptance and correct prior evidence**, and node lanes/lane.mjs check is run
last on the committed lane. Its result is reported when this turn stops; no
post-check edit or command is planned.

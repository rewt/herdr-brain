---
run: R-57
outcome: done
summary: |
  Added a dependency-free supervisor lookup that verifies canonical Git identity through native Herdr worktree list, then checks the returned workspace is still open. Background workspaces no longer need UI-published metadata. The full lane acceptance run passes case 16, with every other case status and origin unchanged from main: 20 pass, zero fail, three pending. The copied bch-cloak wrappers require the ENG-64 supervisor entry switch to open-session.mjs; that exact scratch switch passes and restores its original bytes and mode. Frozen contrib and all live project, record, workspace and release state remain untouched.
headline: Background supervisor callers now resolve canonical workspaces without UI metadata
blockers: []
proposals: []
learnings:
  - "Native worktree list --cwd exposes a canonical checkout's open workspace ID even while workspace list omits its worktree metadata; verify repo_key against Git's real common directory before using the receipt."
  - "The frozen contrib caller cannot benefit from the new lookup; existing bch-cloak callers need the already planned ENG-64 entry-target switch to supervisor/open-session.mjs."
  - "Copied wrapper HOME isolation changes native Herdr's default socket. The acceptance adapter now pins its original verified socket in the ownership ledger and overrides the subprocess socket environment."
  - "Unbounded parallel offline tests stalled watcher fixtures under concurrent lane load. A scratch Node wrapper limiting test-file concurrency let the complete unchanged suite finish; two-file runs still exposed three unrelated watcher timeout failures, while the serial final run passed."
artifacts:
  - "Commit: Resolve background supervisor workspaces through native Git identity"
  - "Commit: Report background workspace identity and scratch cutover acceptance"
  - supervisor/workspace.mjs
  - supervisor/open-session.mjs
  - test/workspace.test.mjs
  - acceptance/run.mjs
  - acceptance/herdr.mjs
  - docs/reports/ENG-79-workspace-identity-evidence-20261001
  - "/private/tmp/herdr-acceptance-OGoDNF/evidence"
  - "/private/tmp/herdr-acceptance-j33Gc7/evidence"
  - "/private/tmp/herdr-acceptance-JcC3NM/evidence"
  - "/private/tmp/herdr-acceptance-AitFdC/evidence"
  - "/tmp/eng-79-baseline-bounded.log"
  - "/tmp/eng-79-final-tests-serial.log"
  - "/tmp/eng-79-lanes-tests.log"
  - "/tmp/eng-79-boundary-final.log"
  - "Final action after the checked report commit: PATH=/tmp/eng-79-test-bin:$PATH node lanes/lane.mjs check; result reported at turn completion"
decisions:
  - decision: Resolve canonical identity through the native Git resolver instead of waiting for UI metadata publication.
    why: The background shell reached its exact cwd, but no worktree metadata appeared in the following 15-second window. Native receipts already identify the canonical checkout and open workspace without focusing panes or publishing invented metadata.
  - decision: Verify the receipt against Git and reject conflicting workspace metadata.
    why: Labels and session metadata cannot authorize a supervisor target. The lookup requires the real common directory, canonical root and checkout, a single non-linked canonical row, and its still-open opaque workspace ID; foreign or stale metadata refuses.
  - decision: Exercise only the supervisor entry-target switch on audited scratch copies and restore it before other cases.
    why: The brief freezes contrib and allows this fix to belong in the ENG-64 cutover. Both copied wrappers retain their route declarations, model/effort flags and plumbing while using the candidate open-session implementation. The remaining switch and retirement gates stay independent.
questions: []
challenges:
  - premise: Canonical project identity is unavailable until workspace list publishes worktree metadata.
    verdict: wrong
    evidence: Native worktree list resolves the background workspace through its Git common directory. Both copied wrapper dry runs select the created workspace after switching the scratch entry target, despite zero background metadata samples in the bounded poll.
  - premise: Changing only the scratch entry target is sufficient to make the harness pass.
    verdict: wrong
    evidence: The updated harness run against main still fails case 16 at the old open-session lookup after that exact switch; the candidate passes with the new verified native lookup.
---

The implementation reuses lib/project.mjs to obtain real Git identity without project configuration. supervisor/workspace.mjs calls worktree list with explicit canonical --cwd, validates its source and canonical row, then verifies the returned workspace still exists. Missing UI metadata is allowed; conflicting metadata, a linked caller, a foreign common directory, missing or duplicate canonical rows, closed IDs and native failures refuse. Each launch resolves again, so Herdr restarts do not leave a cached workspace ID. The existing launcher uses this lookup for pruning and new-tab creation. No core event-fold or lane lifecycle behavior changes.

Case 16 retains shell-cwd and 15-second UI metadata evidence, executes the frozen contrib callers to demonstrate their identity refusal, then changes exactly one target in the copied launch-supervisor.mjs from the candidate contrib entry to the candidate supervisor entry. Both continue.sh and arm-watch.sh dry runs must succeed and name the created background workspace. All 17 copied routing tests run before and after the switch. The original launcher bytes and mode are restored in finally, and workspace-identity-cutover.json records refusal, switch, successful calls and restoration. Native socket pinning fixes a previously hidden harness failure exposed only once wrappers actually execute with their isolated HOME; offline coverage proves a caller override cannot change the pinned endpoint.

Full acceptance commands, from this lane:

```sh
node acceptance/run.mjs --candidate main \
  --bch-cloak /Users/rewt/development/bastian/bch-cloak --npm-cache /Users/rewt/.npm
node acceptance/run.mjs --candidate lane/workspace-identity \
  --bch-cloak /Users/rewt/development/bastian/bch-cloak --npm-cache /Users/rewt/.npm
```

| Evidence | Main | Candidate |
| --- | ---: | ---: |
| Full results | 19 pass / 1 fail / 3 pending | 20 pass / 0 fail / 3 pending |
| Case 16 | FAIL | PASS |
| Exact shell cwd ready | 36 ms | 44 ms |
| Subsequent UI metadata samples | 70 | 65 |
| Background workspace with metadata | 0/70 | 0/65 |
| Configured comparison with metadata | 70/70 | 65/65 |
| Full elapsed time | 308 s | 321 s |

An automated comparison of the full summaries confirms all other 22 case names, statuses and origins match. Cases 18, 19 and 22 remain pending, so both full commands correctly exit 1 and the overall release remains NOT READY. Each cleanup passes, closes all workspaces that run created, removes temporary authentication, and leaves empty credential-residue and retained-discovery-root arrays. Only summary.json and screen.txt for the two full candidates are copied into the tracked evidence directory; raw logs and receipts remain in the scratch paths above.

The updated harness also ran main with --skip-live: /private/tmp/herdr-acceptance-JcC3NM/evidence, 17 pass / 1 fail / 5 pending. Its switched open-session caller fails at the old canonical lookup. The positive mechanics-only directory snapshot is /private/tmp/herdr-acceptance-AitFdC/evidence, 18 pass / zero fail / 5 pending; its final committed equivalent is the full candidate run. Two earlier diagnostics remain in /private/tmp/herdr-acceptance-pQDJ3U/evidence (outer sandbox denied native socket access) and /private/tmp/herdr-acceptance-nvq7kY/evidence (isolated HOME selected the wrong native socket). Neither diagnostic called a model, and neither is claimed as successful acceptance.

Offline validation: npm test was run before editing; initial unrestricted parallel attempts stalled in watcher fixtures under host load and were terminated only within this run's process trees. A scratch snapshot of the original main completed the full baseline with 399 passed, zero failed, two explicit skips. Final serial npm test completed with 403 passed, zero failed, the same two skips (optional native sandbox check and absent local console dependencies). A scratch PATH wrapper at /tmp/eng-79-test-bin/node adds only --test-concurrency=1 to node --test, preserving the complete npm test command and every test. The baseline used two-file concurrency. Before the final serial run, one two-file run exposed the discovery launcher stub's missing new receipt (fixed), and another had three watcher timeout failures; those logs remain /tmp/eng-79-final-tests.log and /tmp/eng-79-final-tests-2.log. npm run test:lanes passes all 146 tests without skips; the separate node --test acceptance/test/*.test.mjs passes all 29 tests without skips. Unit coverage includes configured and background workspaces, symlink aliases, changed opaque IDs, linked callers, foreign identity with the same project basename, conflicting metadata, missing/closed/ambiguous receipts, and native failures. The offline suites never call a model.

The two full runs made eight measured discovery sessions, all gpt-5.6-luna low, each with exit 0 and one complete turn. No additional model calls were made by the mechanics runs. Usage from the raw discovery-usage.json receipts:

| Run | Input tokens | Cached input tokens | Output tokens | Reasoning output tokens |
| --- | ---: | ---: | ---: | ---: |
| Main, four sessions | 480,334 | 373,248 | 9,460 | 878 |
| Candidate, four sessions | 554,756 | 468,480 | 11,075 | 956 |

Cached input is included in input; reasoning output is a reported output subset. No billing rates are inferred.

The fix for existing bch-cloak callers belongs in the already planned ENG-64 switch to open-session.mjs. This run proves canonical identity and routing for those dry-run calls; it does not claim the remaining live watcher, settle/review handoff, retirement or default-cycle canaries. contrib/settle-watch.mjs is byte-identical to main. No bch-cloak repository, record or live workspace, shared .lane.json, activated release, operator bin or launchd configuration was written, and no pane was focused. No push, publishing, promotion or project-wide housekeeping was performed.

Implementation commit: **Resolve background supervisor workspaces through native Git identity**. This report and its compact evidence are checked using read-only record check and committed as **Report background workspace identity and scratch cutover acceptance**. The requested last action is lane check on that clean committed head; its result is reported at turn completion.

---
run: R-65
outcome: done
summary: |
  Fixed the independent review's sole Major finding: project preparation, validation and main-checkout native workers now receive read-only exclusions for the shared record and entry coordination state. The trusted parent supplies both aliases and resolved record targets; only its own request queue and validation temporary directory receive the necessary writable exceptions. Real native sandbox regressions pass for default and linked records, through preparation, validation and both installed transports, without calling a model. All npm test cases pass with test concurrency two, and all 146 lane tests pass. Default npm test still hits the same pre-change watcher receipt timeout tracked by ENG-86. The fix is committed on this lane, rebased onto current main; no promotion, installation outside scratch or publication was performed.
headline: Main checkout workers and validation can no longer overwrite shared state
blockers: []
proposals: []
learnings:
  - "Ignored shared-state corruption can leave HEAD, Git status and realpaths unchanged; those checks cannot establish byte integrity."
  - "Protect both record aliases and resolved component targets, including an event-log symlink into an otherwise writable source directory."
  - "A main-mode native worker needs filesystem exclusions around the harness process as well as its validation commands; both transports must retain their own bounded request queue."
  - "The default watcher receipt timeout reproduced before and after this change; ENG-86 already tracks the fixture cleanup, so no duplicate follow-on is proposed."
artifacts:
  - "Commit: Guard shared record and entry state in main-checkout sessions"
  - "Commit: Report native shared-state confinement and review fixes"
  - "Branch: lane/entry-settings"
  - docs/reviews/entry-settings/e3c1134-r1.md
  - discovery/confinement.mjs
  - discovery/runtime.mjs
  - discovery/session.mjs
  - discovery/validate.mjs
  - discovery/test/confinement.test.mjs
  - discovery/test/settings.test.mjs
  - discovery/README.md
  - /tmp/eng82-r65-baseline.log
  - /tmp/eng82-r65-targeted.log
  - /tmp/eng82-r65-native-full.log
  - /tmp/eng82-r65-final-npm.log
  - /tmp/eng82-r65-final-concurrency2.log
  - /tmp/eng82-r65-final-lanes.log
  - /tmp/eng82-r65-lane-check.log
  - .lane/gate.json
decisions:
  - text: Carry parent-resolved shared-state exclusions into every preparation and validation sandbox.
    category: security
    why: The requested review fix requires closing the write boundary around ignored record data and coordination receipts. Protecting aliases, resolved components and the canonical .lane directory also prevents redirection by renaming shared directories.
  - text: Wrap main-mode native workers in a filesystem guard shared by both transports, leaving only their own request queue writable within protected coordination state.
    category: security
    why: The requested protection must survive ordinary native worker execution. The outer guard preserves native arguments, account and cache activity, and the harness's own tool sandbox and approval settings; privileged record and Git writes remain in the fixed-operation parent broker.
  - text: Verify denied writes with the installed native sandbox and model-free transport stand-ins.
    category: tooling
    why: Profile inspection alone cannot prove kernel enforcement. Scratch fixtures exercise actual write, rename and unlink refusal while checking allowed source, temporary and bounded-client operations.
questions: []
challenges:
  - premise: A clean committed checkout and unchanged realpaths establish shared-state integrity during validation.
    verdict: wrong
    evidence: The reviewed write profile allowed changes to ignored record and entry receipt contents without changing those checks. The new native regressions require EPERM or EACCES for those writes and confirm unchanged record and routing snapshots after preparation and validation.
---

The sole Major finding in the supplied public review is accepted and fixed in
**Guard shared record and entry state in main-checkout sessions**. The supplied
review copy is preserved unchanged and committed with the fix.

The session parent resolves the selected record, its event log, configuration,
run and report directories, and canonical entry coordination paths. It passes
these exclusions directly to validation and the native launch guard. Preparation
and validation retain workspace writes and disabled network access; main-mode
native launches add the shared-state exclusions around the original harness.
Their fixed-operation broker remains outside the child sandbox. The source tree,
validation temporary directory and session's request queue remain usable.

Two native regression fixtures cover the default `.org` and a linked record with
a separately linked event log inside an ignored source directory. Each exercises
preparation, validation, installed Codex entry and installed Claude entry. They
require denied writes to the event log, routing receipt and another entry's
receipt path, denied coordination-directory renaming, and denied record-alias
unlinking in the linked fixture. Ordinary source edits, validation temporary
writes and bounded `start` requests succeed. Git stays clean after the probes.
The always-on transport cases also assert the exclusions and writable queue in
the guard arguments; missing or relative exclusion paths are rejected.

The lane was rebased before implementation onto the landed workspace-identity
work and again after the fix commit onto **Brief for ENG-87: every review yields
a public copy**. The second rebase added only that brief, so it does not change
the tested implementation or test cases.

| Verification | Result |
| --- | --- |
| Baseline `npm test` | 420 passed, 1 watcher timeout, 2 expected skips |
| Final default `npm test` | 421 passed, the same watcher timeout, 4 expected skips |
| All npm test cases with concurrency two | 422 passed, 0 failed, 4 expected skips |
| Settings and confinement cases without native opt-in | 12 passed, 0 failed, 2 native skips |
| Explicit native sandbox and confinement suites | 4 passed, 0 failed, 0 skipped |
| `npm run test:lanes` | 146 passed, 0 failed, 0 skipped |
| Report record check | Checked immediately before the report commit |
| Final lane check | Runs last after the report commit; committed-head receipt in `.lane/gate.json` |

The default-concurrency failure is the existing watcher case "a mismatched report
is invalid even when org check passes", at its three-second receipt wait. It
reproduced before edits and passes when running the same full npm test globs with
`--test-concurrency=2`. All tests remain included. ENG-86 already covers watcher
fixture cleanup. No child processes required termination in this round.

The native checks used the locally installed Codex sandbox on Darwin, isolated
runtime homes and scratch repositories, with no inference. They establish local
filesystem enforcement and transport behavior, not live-model compliance,
Linux enforcement or release acceptance. `contrib/settle-watch.mjs` is unchanged;
work stayed in this lane and scratch directories. The final lane check uses the
same complete npm test globs with concurrency two and runs after this report is
checked and committed.

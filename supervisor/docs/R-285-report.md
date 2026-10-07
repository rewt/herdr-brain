---
run: R-285
outcome: done
summary: |
  Added monitor chat PROJECT and the console C key to open or focus one supervisor conversation per canonical fleet project in a single control workspace. Chats launch the installed supervisor adapter in the project's checkout under a distinct chat name; project ops remains the notice recipient through dispatch, cycle commands, watcher recovery and native restore. The launcher only reads project files, retains machine chat receipts, and preserves focus for background opens. Focused offline tests passed; implementation is committed and this report is committed before the final lane check.
headline: Each fleet project now has a quiet supervisor chat tab in one control workspace.
blockers: []
proposals: []
learnings: []
artifacts:
  - efe0096cb3153716f8d25605ff8ac774ebaac44a - implementation, documentation and offline regressions
  - lane/project-chats
  - supervisor/chats.mjs
  - supervisor/test/chats.test.mjs
  - supervisor/docs/R-285-report.md
  - node --test supervisor/test/chats.test.mjs - 9 passed
  - node --test console/test/modern.test.mjs console/test/minimal-input.test.mjs console/test/controller.test.mjs - 65 passed
  - node test/helpers/run.mjs supervisor/test/chats.test.mjs supervisor/test/entry.test.mjs supervisor/test/supervisor.test.mjs watch/test/args.test.mjs - 86 passed before the two additional chat regressions
  - node test/helpers/run.mjs --test-name-pattern='^dispatch defaults to project ops' dispatch/test/dispatch.test.mjs - 1 passed, 37 unrelated cases skipped
decisions:
  - text: Keep one control workspace and one chat receipt per canonical Git common-directory identity in the fleet home, separate from project files and display labels.
    category: tooling
    why: Reopening can focus the same tab after label changes without modifying another project's files or using session metadata to authorize work.
  - text: Launch installed supervisor entry with a chat agent name and a separately bound project ops recipient; dispatch and cycle commands honor that recipient by default.
    category: tooling
    why: Operator conversations remain quiet while notices retain their existing ops destination and survive native restore.
  - text: Retain failed startup tabs for inspection and never replay a launch into an uncertain pane on reopen.
    category: tooling
    why: An operator retry must not create duplicate tabs or type another launch into an existing session.
questions: []
challenges: []
---

Read the ask, ENG-247/ENG-248, fleet and supervisor entry/recipient documentation,
and the console's native session links. Implemented the command in discovery's
operator CLI and the native launcher in supervisor/chats.mjs, keeping the core
dependency-free and foreground. C works in full, minimal and classic consoles;
all three snapshot profiles explicitly refuse it under --print.

The default control workspace is a uniquely named Herdr Brain workspace, created
with --no-focus when absent. --workspace or HERDR_MONITOR_CONTROL_WORKSPACE
selects an existing workspace on first use. Machine receipts hold the workspace,
tab and pane IDs plus canonical checkout/record bindings. Labels remain display
text. Reopening validates the live pane and occupant before focusing it; a closed
tab can be recreated while other projects retain their tabs. All workspace/tab
creation is in the background; focus occurs only for a requested foreground open.

New chats invoke the installed monitor-codex or monitor-claude with --role
supervisor and --repo pointing at the project's canonical checkout. Native
arguments and accounts use that project's route layers. Worker request/config
and plugin context variables are removed before launch. No initial prompt is
sent and the launcher never accepts hook trust or other startup dialogs. The
supervisor adapter owns its normal entry policy and native lifecycle binding.

--to OPS overrides the project's route-environment MONITOR_SUPERVISOR_AGENT,
then the existing supervisor-herdr fallback. An inherited recipient from another
project is ignored. Non-default projects can pass their existing ops name, e.g.
monitor chat bch-cloak --to supervisor-opus. Reopening retains the existing
session's harness and recipient; close its tab to choose a fresh launch. This
change does not infer ops names from unrelated sessions or rewrite project config.

Chats use distinct chat- names derived from Git identity and never enroll as
notice recipients. Dispatch previously hard-coded supervisor-herdr despite the
adapter's separate recipient variable; it now honors MONITOR_SUPERVISOR_AGENT,
with explicit --to winning. Supervisor cycle glue also forwards that variable.
Existing watch defaults and durable supervisor pane receipts preserve the ops
recipient through startup, resume, clear and compact. The protocol explicitly
addresses awaited landings to ops as well. Digest and ephemeral ops-head work
remain with the already-existing sibling items.

Offline fake-Herdr regressions cover shared workspace creation and reuse, distinct
same-basename repositories, quoted paths/native args, renamed labels, canonical
identity mismatch, stale/excluded/disabled projects, ambient recipient isolation,
ops overrides, startup failure, shell readiness, conflicting/moved occupants,
closed-tab recreation, focus preservation and snapshot refusal in every profile.
Project file snapshots stay byte-identical across opens; tests never call a model.
The new chat file is included in the promotion tier. Existing supervisor/watch
tests passed, including explicit chat/ops separation through native restore.

An initial direct dispatch-test invocation lacked the runner's fixture group
leader. The supported runner then passed the regression, but sandboxed teardown
could not inspect processes. The focused runner was rerun with read-only process
inspection available and exited successfully. All fake launch and test records
remained in scratch; no live harness, project housekeeping loop, installation,
release activation or external-project edit was performed.

After record check and committing this report, the final command is:

    node lanes/lane.mjs check --cmd 'npm run test:fast && node test/helpers/run.mjs supervisor/test/chats.test.mjs console/test/minimal-input.test.mjs && node test/helpers/run.mjs --test-name-pattern="^dispatch defaults to project ops" dispatch/test/dispatch.test.mjs'

The lane command records the final clean-commit gate result in .lane/gate.json.
No report edit follows that final check.

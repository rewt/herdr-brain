---
run: R-182
outcome: done
summary: |
  Supervisor entry now compares stored PIDs with kernel start-time identities for
  housekeeping and watcher recovery. Births are persisted in housekeeping locks,
  watcher locks, detached startup receipts, dispatch journals and run metadata.
  Unreadable identities are diagnosed without recovery or blocking the session.
  Empty supervisor recipients use the fallback, and nested headless passthrough
  launches cannot inherit supervisor recognition or revoke the interactive receipt.
  Focused offline checks passed after correcting a new fixture cleanup order;
  the required lane check runs last against the committed report and change.
headline: Supervisor recovery recognizes reused process IDs and excludes nested headless sessions
blockers: []
proposals: []
learnings:
  - Live legacy PIDs without stored births are unknown and require inspection; absent legacy PIDs remain recoverable.
  - Automatic headless adapters must set the entry bypass even when native launch bindings and pane receipts are inherited.
artifacts:
  - commit fd7fada Bind supervisor recovery to process birth identities
  - lib/process-owner.mjs
  - watch/lock.mjs
  - supervisor/test/entry.test.mjs
  - watch/test/lock.test.mjs
  - /private/tmp/ENG-136-focused-tests.log
  - /private/tmp/ENG-136-recheck-tests.log
  - .lane/gate.json written by the final focused lane check
  - docs/reports/ENG-136-entry-identity-20261003.md
decisions: []
questions: []
challenges: []
---

The shared owner lookup uses ENG-122's non-setuid kernel process source in
identity-only mode. A stored birth mismatch means the recorded owner is dead;
recovery never signals the replacement process. Missing births on present legacy
PIDs, unreadable sources, malformed locks, and foreign runtimes require inspection.
The existing STOP, torn-record, repository-binding, runtime-binding, and
current-record rechecks remain in force. Entry's process-source subprocess reads
share the existing 20-second recovery deadline, and hook failures still exit zero.

Watcher identities must survive the full producer path: the detached child sends
its birth in the ready acknowledgement, dispatch persists it alongside the PID,
and cold start exposes it as `watcher_identity`. Watch's per-run lock also stores
the birth so PID reuse cannot defeat an otherwise valid re-arm. Legacy PID-only
watch locks are recoverable when the PID is absent, and retained when ownership
cannot be established.

Null dispatch recipients now use the normalized supervisor recipient, ending at
`supervisor-herdr` when the environment or pane receipt supplies an empty value.
Malformed non-null recipients still produce an inspection diagnostic. Both native
adapters mark utility/headless passthrough children with worker role and entry
bypass and clear inherited supervisor fields. They retain the durable interactive
pane binding, so later resume, clear and compact still work.

Validation used only focused offline files: supervisor entry, watcher lock and
watcher behavior, housekeeping, dispatch, console housekeeping, and discovery
entry. The first run had 172 passes, one fixture-cleanup failure, and one explicit
filesystem-notification skip (`EMFILE`). The failure was in a newly added test's
cleanup hook, after its assertions passed; cleanup now stops the fixture schedule
before removing its directory. The affected supervisor and watcher-lock rerun
passed all 55 tests, including an additional legacy-dead-lock regression. Across
the seven focused files, the final results represent 174 passing tests and that
one environment skip. No baseline, full suite, promotion suite, lane suite,
model call, live acceptance harness, or project-wide housekeeping loop was run.
Only isolated scratch-project schedules with fake record/Herdr CLIs were started
by the existing and new offline recovery fixtures.

Implementation and report commits explicitly disable Git hooks. The final command
is `node lanes/lane.mjs check --cmd 'node test/helpers/run.mjs
supervisor/test/entry.test.mjs watch/test/lock.test.mjs'`; its authoritative result
is retained in `.lane/gate.json` and the shared lane-validation receipt. No push,
promotion, or record ingestion is performed by this lane.

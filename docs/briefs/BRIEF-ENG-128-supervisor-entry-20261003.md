# ENG-128: one standard supervisor entry

Read ENG-128 (record show). On 2026-10-03 the project supervisor came back through a /clear in a pane Herdr restored
after a reboot; no entry step ran, so housekeeping stayed stopped for six hours and a stale promotion lock was found by
hand. Make supervisor entry identical however a project supervisor session begins: fresh launch, Herdr restoring it,
chat clear, context compaction. Use each harness's native session-start hook (Claude Code SessionStart fires for
startup, resume, clear and compact; this repo already wires one in .claude/settings.json for the canary; use Codex's
equivalent where it exists, and say plainly where it does not). Entry is idempotent and only: prints the cold start
(supervisor/supervisor.mjs brief), restarts housekeeping when its config says enabled and resume, re-arms watch for
open runs whose watcher is dead, and reports stale promotion/settle/release locks whose owner is gone (report only,
never delete). It must recognise a supervisor session reliably and never run for workers or lane sessions.

Failure-path acceptance: entry run twice changes nothing the second time; a worker session never triggers it; a
dead watcher for a run that already reported is not re-armed; a lock with a live owner is not reported stale; entry
never blocks the session from starting when something fails (it prints why).

How to work (operator, 2026-10-03: right the first time, then verify; minimal and native): write the acceptance tests first, including the failure paths named below, watch them fail, then implement. Ship the change with the tests that prove it; run the tests you write while developing as you see fit. The process requires no other test runs in the lane: do not run a baseline, npm test, test:promotion or test:lanes. Testing before merge happens once, at promotion, like CI on a pull request. Never the live harness. Before reporting, review your own diff against this brief. Commit, write the report, record check it, commit it, run lane check last. Then stop. Keep evidence in the repository (docs/reports/...), not only in /private/tmp.

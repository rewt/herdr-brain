# ENG-142: finished tabs close automatically

Operator, 2026-10-03: lanes and tabs pile up and they cannot tell which sessions are working without clicking each tab.
supervisor/tidy-tabs.mjs already closes only provably finished tabs (finished workers with recorded results, finished
reviews and settle sessions; never a working, blocked or unnamed agent, never the operator's chats); run by hand it
closed 18 tabs safely today. Make housekeeping run it on every tick for the project, so a finished tab closes within a
minute and an open lane tab means something is running. Scope: housekeeping/ and supervisor/tidy-tabs.mjs only (other
lanes are changing lanes/lane.mjs). Keep housekeeping's dry-run and preview modes honest (they report, never close).

Failure-path acceptance: a working, blocked or unnamed agent's tab is never closed; the operator's own tabs are never
closed; a tidy failure is logged and never stops housekeeping; dry-run closes nothing. Ship with those tests; run them and
the files you touch only. Commit, write the report, record check it, commit it, run lane check last. Then stop.

# ENG-140: no tracked hook may stop an unattended worker

Read ENG-140 (record show) and ENG-128 on main (supervisor/session-hooks.mjs, supervisor/session-start.mjs, discovery adapters).
Remove the tracked .codex/hooks.json; keep supervisor entry for Codex through the adapter's launch argument and for
Claude through its SessionStart wiring. Add a test that fails if the repository tracks a Codex project hook, and one
that the adapter still injects the hook for a supervisor. Small and native; no other changes. Ship with those tests;
no baseline or full-suite runs. Commit, write the report, record check it, commit it, run lane check last. Then stop.

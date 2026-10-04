# ARCH-18: keep each session inside its project, natively

Read ARCH-18's operator decision (record show ARCH-18: minimal and native; no broker, tokens, wrapper or grant
machinery; the Herdr socket stays as Herdr designs it), docs/design/ARCH-18-sandbox-20261003.md, and the fleet
(ARCH-17: fleet.json lists each project's checkout, record, worktrees and temp). Build only:
1. Per-run temp inside the project's fleet area with a short path (socket paths are limited to ~104 bytes on macOS;
   Node truncates silently): TMPDIR, TMP and TEMP set at launch for workers and validation; refuse a temp root longer
   than 60 characters.
2. Generate each harness's native sandbox settings at launch so a session writes only its worktree, its project's
   record and its own temp: Codex writable roots or permission profile (discovery/confinement.mjs already generates
   write guards), Claude Code sandbox write paths via a per-session settings file. Optionally a short native read-deny
   list for ~/Documents, ~/Desktop, ~/Downloads and ~/.ssh.
3. Extra directories come only from the harness's own option (Claude --add-dir, Codex writable roots) in project
   config. Do not touch the Herdr socket.

Failure-path acceptance: a session cannot write another project's checkout, record or temp; a too-long temp root is
refused with the reason; a harness without sandbox support runs with a visible warning, never silently unconfined;
the Herdr agent-status hook still works.

How to work (operator, 2026-10-03): right the first time, then verify; minimal and native; worktree = branch, promotion = pull request. Write the acceptance tests first, including the failure paths named below, and ship the change with them; run them while developing as you see fit. The process requires no other test runs in the lane: no baseline, no npm test, test:promotion or test:lanes; the promotion batch runs the full suites once. Never the live harness. Review your own diff against this brief before reporting. Commit, write the report, record check it, commit it, run lane check last. Then stop. Keep evidence in the repository, not only in /private/tmp.

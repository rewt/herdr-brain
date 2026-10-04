# ENG-136: supervisor entry trusts process identity, not bare PIDs

Read ENG-136 (record show) and supervisor/entry.mjs and supervisor/session-start.mjs on main (ENG-128), plus ENG-122's
non-setuid identity source now on main. After a reboot a recorded housekeeping or watcher PID can be reused by another
process; entry must use pid plus start-time identity, so a reused PID reads as dead and the watcher is re-armed or
housekeeping restarted. Also: an empty MONITOR_SUPERVISOR_AGENT with a null receipt recipient must not deliver to an
empty target; a nested headless session started from the supervisor's own shell must not be recognised as the supervisor.

Failure-path acceptance: a reused PID with a different start time is treated as dead; an unreadable identity is reported,
not guessed; entry never blocks the session. If a Codex hook-trust dialog appears, dismiss it with Escape and do not trust
hooks. Ship with those tests; run them and the files you touch only; no baseline or full-suite runs. Commit, write the
report, record check it, commit it, run lane check last. Then stop.

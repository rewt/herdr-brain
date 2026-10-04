# ENG-157: CI under 5 minutes

Read ENG-157 (record show) and ENG-135's report (docs/reports/ENG-135-suite-pass-20261003.md on main: per-file timings and
the test inventory). CI is the promotion tier, run once per batch before main moves; it now takes about 12 minutes.
The release gate runs once per release. Move to the release tier every test whose cost is real processes, real
wall-clock waits, PTYs, sandboxes, copied products or live-ish Herdr servers, unless it protects a correctness rule that
must hold at every merge; keep fast logic tests in CI. Do not delete coverage: every moved test still runs in the
release tier (package.json's tier commands and the release gate's prepare step). Measure CI before and after once,
holding the host test slot, and report both numbers and the moved list with reasons.

This is a subtraction task: no new framework, no new modules. Commit, write the report, record check it, commit it,
run lane check last. Then stop.

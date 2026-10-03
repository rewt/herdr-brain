# ENG-116: the cycle notices memory pressure, not only load average

On the night of 2026-10-02 bch-cloak's work plus several herdr-brain lanes swapped out system daemons: bluetoothd
aborted three times with its memory fully swapped out, and an orphaned PTY test leaf spun a core for an hour. The
cycle's load checks look at load average only. Dispatch, settle reviews, promotions and the release gate should also
wait while the machine is short of memory (swap in use, or free memory low; read it portably on macOS and Linux),
showing the reason and proceeding when it clears, the same way load already defers work. Budgets stay advisory:
surface and defer, never refuse work outright. Help the supervisor see which processes hold memory or CPU, so leaked
fixtures are easy to spot. ENG-118 (host test slot) runs in parallel; don't duplicate it.

Offline tests only, simulating pressure; no model calls; never the live harness. Run npm run test:fast and the suites
you touch. Commit, write the report, record check it, commit it, run lane check last. Then stop.

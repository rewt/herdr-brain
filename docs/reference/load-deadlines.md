# Response allowances under load

The [reached-limit register](limit-register.md) records source, installed and
saved-consumer limits beside actual latency, sample counts and missing evidence.
Use its consumer/version distinction before interpreting a timeout or changing
an allowance. It replaces this page's obsolete timeout enumeration.

`lib/deadline.mjs` samples the one-minute OS load average when a caller invokes
`loadTimeout`. Its multiplier is
`max(1, load / min(4, availableParallelism))`; timers remain finite and below
Node's overflow limit. For example, a base five-second response wait at load 24
on at least four CPUs becomes 30 seconds. This formula describes response waits
that call it, not worker lifetimes, ownership leases or every native timer.

Current gate/file/suite execution wall limits are zero. The shared watch can
stop only after measured silence **AND** confirmed inactivity; unknown activity
does not prove a freeze. Session observation windows, admission/lock contention,
explicit native command options, notice thresholds and planning targets retain
their distinct meanings. Load and elapsed time grant no native authority.

Saved jobs and installed consumers retain their own selected bytes and options.
Do not rewrite a receipt, pin, watcher or in-flight runtime to make it agree with
a newer default. Fresh native process birth, claim, source, CAS, STOP/HOLD and
archive checks remain at mutations. A finite response failure or an uncertain
native result retains its original evidence and never authorizes input replay.

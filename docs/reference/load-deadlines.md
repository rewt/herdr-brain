# Response deadlines under load

`lib/deadline.mjs` samples the one-minute OS load average at each response wait.
Its multiplier is `max(1, load / min(4, availableParallelism))`. Limiting the
capacity divisor to four accounts for serialized Git, CLI and IPC work on larger
hosts. At load 24 on four or more CPUs, a 5-second allowance becomes 30 seconds.
Timers stay finite and below Node's overflow limit. Load never grants authority. Npm file/suite overrides scale as well; deliberate
cancellation regressions use `--fixed-deadlines` to request exact timers.

| Response wait | Base allowance | Handling |
| --- | --- | --- |
| Detached watch / dispatch acknowledgement | 10 seconds | Scale; still require ready after run lock and configuration read |
| Promotion, inbox and housekeeping startup | 5 seconds | Scale; preserve uncertainty, queue and lock recovery |
| Housekeeping evidence and supervisor Herdr calls | 10 seconds | Scale; failures still prevent input/closure |
| Promotion queue and notice journal lock contention | 5 seconds | Scale; never remove live or unidentified owners |
| Settle Git ref transaction response | 15 seconds per protocol response | Scale; CAS, clean-tree checks and uncertain checkout locks remain |
| Lane shell, agent launch and ready observations | 60 / 20 / 30 attempts | Scale the finite attempt counts; respect a caller's review deadline |
| Supervisor legacy session start / working acknowledgement | 120 / 60 seconds | Scale; shell-start retries also back off |
| Board requests, reads and subscription handshake | 2 seconds | Scale; subscription reconnect already backs off |
| Test process identity lookup | 2 seconds | Scale; at most three timeout-only attempts, doubling allowance and backoff |
| Test synchronous command and per-test caps | 15 / 60 seconds | Scale at each call, including explicitly shorter fixture limits |
| Test file/suite watchdogs, default child and pipe-drain waits | Existing base limits | Scale; coordinator/worker share a sample; lower file concurrency under load |
| PTY owner and detached-fixture compilation | 10 seconds | Scale; retain native cleanup and fixture cancellation boundaries |

Production promotion validation Git calls already have no imposed deadline;
its test-only command cap caused the observed 15-second failures. Validation and
preparation remain uncapped in production and keep every post-check guard.

Caller-selected review budgets, explicit child cancellation bounds, report
stability intervals, long-run notices, inbox input caps and housekeeping schedules
retain their declared duration. They express policy or evidence, rather than an
internal non-response deadline. Neither notice retries nor launch uncertainty
permits replaying a mutation. Only read-only `ps` timeouts retry automatically;
refused, partial and malformed output is discarded, and each signal still needs
a fresh matching start time and command.

`contrib/settle-watch.mjs` retains its path, flags and behavior under the explicit
compatibility boundary in AGENTS.md and the task brief. Its legacy 120/60-second
Herdr flags are therefore unchanged; the maintained supervisor launcher has the
load-aware equivalents. Offline tests use fake transports and owned scratch Git
repositories. No release harness, model, live pane or project schedule is needed.

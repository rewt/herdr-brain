# Memory gate

Dispatch, independent settle reviews, and direct or queued promotion wait before
launching work while swap use is at least 5% of physical RAM and available memory
is below 25% of RAM, or available memory is below the larger of 256 MiB and 5%
of physical RAM. They print the reason to stderr,
sample again every five seconds, and proceed automatically when it clears.
There is no timeout, refusal budget, model call, or host test slot in this gate.
An already running operation is not stopped by a later pressure sample.

Linux reads `MemAvailable` and `SwapTotal - SwapFree` from `/proc/meminfo`.
macOS reads `vm_stat` with its reported page size and `sysctl -n vm.swapusage`.
Available memory includes free, inactive and speculative pages; purgeable pages
are not added again. Cumulative swap-in/out counters are not current swap use.
Cold swap alone does not defer work: swapped pages and swap files can linger
after pressure clears. Native commands have a two-second response allowance.

If swap cannot be read, its value is unknown and a visible advisory says why;
macOS still uses its measured available pages. If `vm_stat` fails, available
memory is unknown with a visible advisory; raw macOS free pages omit reclaimable
cache and cannot establish low-memory pressure. On other platforms, OS free/total
memory supplies the fallback low-memory check. Unknown measurements alone do not
refuse work or cause an endless wait.

Dispatch checks the canonical project's `.lane/supervisor/STOP` at both waits,
including after a clearing sample, and returns `result: stopped` without opening
a lane or launching a worker at that stage. The request remains resumable with
`--retry` after STOP clears. Settle retains its correction stage and returns its
existing stopped handoff when dispatch stops during a wait.

The release `--once` operation returns `result: deferred` with the memory reason,
as it already does for load. The supervisor retries at the next quiet point;
no candidate, tag or gate receipt is created by that deferral. Memory is sampled
again under the project promotion lock for release's one-shot deferral. Lane
promotion waits before acquiring that lock and starting validation, then finishes
the cheap fast-forward without a second memory wait. The existing fresh ref,
cleanliness and record guards still run before integration.

Supervisor `brief` and `brief --json` show the current memory measurement, reason,
probe advisories, and the largest memory and CPU consumers. Process rows carry
PID, parent PID, resident bytes, CPU percentage and a bounded command, so a
fixture leaf or worker can be identified. This is read-only, machine-wide
diagnostic evidence; it never authorizes signalling or infers work status.

Offline fixture policy supplies healthy native memory readings, and pressure
regressions replace those readings until an owned fixture file changes. Tests do
not allocate memory or depend on the host's actual swap state.

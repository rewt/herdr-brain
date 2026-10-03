# Memory gate

Dispatch, independent settle reviews, and direct or queued promotion wait before
launching work while current swap use is nonzero or available memory is below
the larger of 256 MiB and 5% of physical RAM. They print the reason to stderr,
sample again every five seconds, and proceed automatically when it clears.
There is no timeout, refusal budget, model call, or host test slot in this gate.
An already running operation is not stopped by a later pressure sample.

Linux reads `MemAvailable` and `SwapTotal - SwapFree` from `/proc/meminfo`.
macOS reads `vm_stat` with its reported page size and `sysctl -n vm.swapusage`.
Available memory includes free, inactive and speculative pages; purgeable pages
are not added again. Cumulative swap-in/out counters are not current swap use.
Any swap in use defers work even if it is cold: the machine must clear it before
the gate resumes. Native commands have a two-second response allowance.

If swap cannot be read, its value is unknown and a visible advisory says why;
macOS still uses its measured available pages. If the memory probe fails entirely,
OS free/total memory supplies the low-memory check, with a visible advisory.
Unknown swap alone does not refuse work or cause an endless wait.

The release `--once` operation returns `result: deferred` with the memory reason,
as it already does for load. The supervisor retries at the next quiet point;
no candidate, tag or gate receipt is created by that deferral. Memory is sampled
again under the project promotion lock. Before promotion's fast-forward,
the memory check runs before the existing fresh ref, cleanliness and record
guards, so clearing pressure never substitutes for validation or authority.

Supervisor `brief` and `brief --json` show the current memory measurement, reason,
probe advisories, and the largest memory and CPU consumers. Process rows carry
PID, parent PID, resident bytes, CPU percentage and a bounded command, so a
fixture leaf or worker can be identified. This is read-only, machine-wide
diagnostic evidence; it never authorizes signalling or infers work status.

Offline fixture policy supplies healthy native memory readings, and pressure
regressions replace those readings until an owned fixture file changes. Tests do
not allocate memory or depend on the host's actual swap state.

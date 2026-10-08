# Memory gate

Dispatch, independent settle reviews, and direct or queued promotion wait before
launching work while swap use is at least 5% of physical RAM and available memory
is below 25% of RAM, or available memory is below the larger of 256 MiB and 5%
of physical RAM. They print the reason to stderr,
sample again every five seconds, and proceed automatically when it clears.
The initial wait has no timeout, refusal budget, model call, or host test slot.
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
existing stopped handoff when dispatch stops during a wait. Correction dispatch
stderr is inherited by settle and supervisor handle so both new requests and
retries show wait reasons as they happen. Failed dispatches also emit their reason
and request path on stdout, preserving that evidence in settle's error and handoff.
Settle review waits also check STOP and retain the review stage.

Coordinated `lane dispatch` and `lane review` receive `--memory-checked`: the
parent owns the visible wait before recording a launch attempt, so there is no
second pressure sample after entering `launching` or `reviewing`. Both lane
commands validate arguments before waiting, still check canonical STOP before
launch and return a stopped receipt (dispatch exit 0, review exit 3);
the parent restores `worker` or `review` so ordinary retry remains safe. Direct
lane commands keep their own visible memory wait and check STOP throughout it.

The release `--once` operation returns `result: deferred` with the memory reason,
as it already does for load. The supervisor retries at the next quiet point;
no candidate, tag or gate receipt is created by that deferral. Memory is sampled
again under the project promotion lock for release's one-shot deferral. Lane
promotion waits before acquiring that lock and starting validation, then finishes
the cheap fast-forward without a second memory wait. The existing fresh ref,
cleanliness and record guards still run before integration.

Queued batches wait for memory and check STOP before taking promotion resources.
For a declared gate profile, the host adapter owns this initial wait before the
external kernel lock and shared test slot; an unprofiled batch waits before the
project promotion lock. Each subsequent check at a lock boundary has a five-second
wait allowance, sampling every second (native probes retain their two-second
response allowance). Persistent pressure returns `PROMOTION_MEMORY_PRESSURE`,
releases the acquired locks and slot, and delivers the ordinary per-lane refusal
notice. No gate runs, red evidence or bisection is recorded; main and lane tips
are preserved, and the lanes can be enqueued again after pressure clears. STOP
is checked throughout both waits, including the clearing sample. A resumed plan
with an earlier attempt retains its recovery checkpoint rather than replacing
possibly integrated work with a fresh pre-execution refusal.

Supervisor `brief` and `brief --json` show the current memory measurement, reason,
probe advisories, and the largest memory and CPU consumers. Process rows carry
PID, parent PID, resident bytes, CPU percentage and command basename only, so a
consumer can be identified without exposing process arguments or their secrets.
This is read-only, machine-wide
diagnostic evidence; it never authorizes signalling or infers work status.

Offline fixture policy supplies healthy native memory readings, and pressure
regressions replace those readings until an owned fixture file changes. Tests do
not allocate memory or depend on the host's actual swap state.

# Host proving reservations v1

This is the shared host contract for ENG-424, ENG-389 and ENG-354, amended under
[Astra's binding 2026-10-20 ruling, section 4](/Users/rewt/development/rewt/.org/evidence/ASTRA-RULING-BC-CONTRACTS-20261020.md)
(SHA-256 `70d464f77cbee41c2832b76c9fa70738138a662b1c61982f2b4676f191c094b2`).
The ruling accepts the separate schema and existing exclusive bridge subject to
these amendments; it is not an independent review of their implementation.
BCH adoption remains a separate BCH-owned change, outside proving in flight.

## Classes and authority

`proving` is the only blocking class. A reservation covers one declared proving
step, exclusively acquired through the existing legacy/workspace slot bridge.
Gates, builds, tests, reviews, releases and engineering publish informational
`occupancy/v1` with `class: "shared"`; admitted shared work continues. There is no memory
reservation class. `reserveGib` is display-only, never a memory admission floor.
Brain declares no proving profiles.

A legacy lock holder or queue ticket without a proving reservation does not pause
Brain. Shared runners, nested runners and a held promotion memory re-check never
consult reservations for admission. Existing memory measurements and thresholds
remain unchanged; ordinary work inherits neither BCH's 17 GiB floor nor a quiet
host requirement. No running worker is preempted.

Only the launch gates wait: dispatch before lane open and worker launch; lane
review and dispatch; lane promotion before its lock; and the unheld promotion
host gate. The wait precedes the existing memory wait and remains within its
existing timing kind (`memory_open` or `memory_worker` in dispatch). STOP is checked
before reading and on every iteration, including before a deadline deferral.
Expired or unknown rows never pause an ordinary launch. No background process,
model, separate scheduler or queue is added.

`waitForProvingHold` requires a finite monotonic caller `deadline`, separate from
the wall-clock reservation timestamps. Dispatch and direct lane dispatch/review
reuse the existing one-minute dispatch admission allowance, load-scaled once.
Promotion uses the profile's existing `wait_seconds`; without a profile it uses
`MONITOR_TEST_SLOT_WAIT_SECONDS`, then its legacy counterpart, then the existing
train default of 7200 seconds. Explicit promotion allowances are not load-scaled.
Each adopting gate samples its deadline once. Successive files, renewals, a new
reason, record expiry or wall-clock corrections never restart that budget.
The next sleep ends at the earliest poll interval, record expiry or caller deadline.
These bounds apply to reservation coordination; ordinary memory-pressure waits
and execution watchdogs retain their existing policies.

An exhausted wait throws `HOST_RESERVATION_WAIT_EXPIRED`, with reason and
`elapsed_ms`, before any launch grant. Dispatch and direct lane CLIs return a
named `deferred` result and exit 75; a fresh promotion train records the same code
as a pre-execution refusal with no validation attempt. Saved integration
checkpoints are preserved. A zero budget allows one immediate observation: no
live proving row proceeds, while a live row defers without sleeping. STOP takes
precedence over deadline exhaustion. A resumed train's existing STOP recovery
can proceed when no reservation blocks it; an actual reservation wait still
cancels promptly under STOP and leaves its saved checkpoints intact.

Compatible ticketed exclusive participants follow their existing FIFO queue.
Legacy zero-wait pollers that do not honor tickets can still jump that queue;
there is no host-wide starvation guarantee. Adopted proving workflows must use
the existing compatible ticketed exclusive path. A reservation reduces pressure from new launches;
shared work continues and unrelated host work is outside this protocol, so it
does not guarantee free memory or a quiet machine.

## Namespace and fields

Each proving step owns one independently named JSON file in
`<compat-lock>.occupancy/`, beside shared occupancy. The directory is created with
mode 0700; files with mode 0600. Publish and update use a hidden same-directory
temporary file followed by rename. Readers skip dot files. Records are at most
1 MiB; readers open only bounded regular files with `O_NOFOLLOW`. Unrelated schemas
are skipped without deletion. Unsupported `host-reservation/*` versions are
visible as neutral unknown rows and are never pruned. Reservation fields must never be added to v1 shared
occupancy: BCH's reader enforces its closed key set.

`schema` is the first serialized field. The version is `host-reservation/v1`:

| Field | Meaning |
| --- | --- |
| `schema`, `class` | Exactly `host-reservation/v1`, `proving`. |
| `pid`, `processStart`, `processBirth` | Positive owner PID; nullable start and kernel birth identity. |
| `pgid`, `groupStart`, `groupBirth` | Nullable foreground group ID and identity. Published before the payload starts. |
| `acquiredAt` | ISO acquisition time. |
| `expectedEnd` | Required ISO estimated finish. An already passed estimate marks a live step overdue, never extends its authority. |
| `expiresAt` | Required ISO expiry at or after acquisition, capped at acquisition plus six hours. Equal timestamps mean an already-expired immediate attempt, with no waiting authority. Both writers and readers apply the cap. |
| `project` | Informational canonical Git common directory via `occupancyProject`; cwd basename fallback if discovery is unavailable. |
| `label`, `cwd`, `host` | Bounded display/ownership context; never command text or a token. |
| `reason` | Required nonempty bounded text, up to 1024 characters, normally item/run. |
| `reserveGib` | Optional finite nonnegative display estimate. Never admission authority. |

Identity strings are nullable and bounded to 256 characters; project, label, cwd
and host are nonempty and bounded to 4096 characters. Control characters are
refused. Additional v1 reservation fields are ignored by readers. Removing a
required field, especially expiry, makes the row unknown and nonblocking.

`publishProvingReservation({lockPath, label, reason, expectedEnd, expiresAt,
reserveGib})` returns `{path, record, setGroup, renew, release}`. The default
`lockPath` is the configured compat lock. Only the creating process/handle can
update, renew or release its unchanged record. `renew({expiresAt, expectedEnd})`
updates the estimate and expiry atomically; it cannot move the acquisition time or
extend the six-hour cap. This is an owner capability, not a cross-project request
API. Consumers must not mutate the returned display record.

## Liveness, release and reader duties

PID and group liveness reuse occupancy's kernel identity rules. Owner ESRCH or a
successfully established identity mismatch proves the owner gone. A failed probe
or unavailable identity reserves the owner conservatively. Null identities do not
prove reuse. After the owner is gone, a surviving matching group leader or group
member retains presence. A successful leader identity mismatch proves that group
gone. Group numbers are never permission to signal another process.

| State | Launch behavior and retention |
| --- | --- |
| `live` | Owner/group present before estimate and expiry; pause launches. |
| `overdue` | Past expected end, still present and unexpired; pause launches and show overdue. |
| `expired` | Owner/group present but capped expiry reached; ignore for ordinary launch coordination, flag, retain bytes. |
| `gone` | Owner and all groups proven gone; ignore. Optional pruning requires exact unchanged bytes. |
| `unknown` | Malformed, unreadable, missing expiry or invalid required fields; flag, never pause or prune. |

After payload start, `release()` retains the record while its owned group
survives, even if its wrapper exits or dies. The legacy/workspace locks remain
held under their existing owner/group liveness rules. Ordinary shared occupancy
follows the same group retention rule. Before payload start, supported cancellation
removes only unchanged owned state after its barrier group is confirmed gone;
an abrupt death leaves recoverable state subject to those same liveness checks. A
crashed owner needs no cleanup daemon: readers stop waiting once owner/group are
gone or expiry arrives. Neither expiry nor a legacy holder permits deletion of a
live owner's file. Expiry is not process-death evidence: it never authorizes a
second prover, lock takeover, deletion or retirement while an owner/group may
live. Exclusive arbitration still requires the legacy/workspace bridge and native
prover guards, independently of whether launch coordination ignores a row.
All pruning is explicit and opt-in; the board and launch gates
never prune. Retirement observes both schemas read-only and retains matching live
references, including expired reservations whose owner/group still lives.
If the CLI's reservation was removed or changed externally, release emits
`HOST_RESERVATION_RELEASE_WARNING` and preserves those foreign bytes. Once its
group is confirmed gone, it still releases its own bridge locks and preserves
the payload's exit code.

The launch wait emits one stderr line whenever the set/state of live reservations
changes, naming project, reason, capped expiry, elapsed wait and remaining caller
budget. A successful wait ends with `proving reservation ended; proceeding` and
elapsed wait; exhaustion returns the named deferral instead. `HOST_RESERVATION_EXPIRED:` and
`HOST_RESERVATION_UNKNOWN:` are emitted once per affected file/state in one wait.
The board reads workspace and compat occupancy directories, deduplicated by
realpath, and shows project, reason, age, GiB, expected end, expiry and state. It
adds no reservation fields or lines when none exist. Unsafe display text remains
withheld through the board's existing presentation validators.

## Paths, codes and start barrier

The default legacy/compat path remains `/private/tmp/bch-cloak-test-slot.lock` on
macOS (`/tmp/bch-cloak-test-slot.lock` elsewhere). Environment names remain
`MONITOR_TEST_SLOT_PATH` and `MONITOR_TEST_SLOT_COMPAT_PATH`; `--lock-path` selects
both. Readers may observe any configured location. A writer may override compat
only inside an existing private scratch directory strictly under
`realpath(os.tmpdir())`, owned by its uid, with no group/other write. On macOS,
the OS-reported per-user temporary root (`getconf DARWIN_USER_TEMP_DIR`) is also
accepted after verifying its ownership and private mode. This preserves private
scratch when exact validation omits `TMPDIR`; pathname patterns grant no authority.
Every ancestor below the selected temporary root must meet the same ownership/write
condition. Failure to discover the OS root grants no additional location.

Workspace, compat and explicit paths refuse symlinks, nonregular files, the
basenames `apnt-gnark-r2-proof-<n>.lock`, `bch-cloak-sp1-prover-exclusive-v1`,
`.prover.lock`, and inode aliases of known prover claims. The default known claims
are the uid's gnark file, the SP1 file and `~/proof-scratch/.prover.lock`. The
validator's prover list is injectable for offline callers/tests; no new path
environment variable is introduced. Invalid paths fail before any lock, ticket
or occupancy publication with `TEST_SLOT_LOCK_PATH_INVALID` and exit 75.

A declared EXCLUSIVE runner first acquires the unchanged legacy and workspace
locks and publishes its reservation. The payload starts behind a dedicated fd 3
foreground shell read barrier. Only after its group is atomically recorded in both locks and
the reservation does the parent grant the barrier and exec the payload in that same PID/group.
The barrier uses the host's `/bin/bash` in POSIX `sh` mode with startup files
disabled and `execfail` enabled: exec failures return 127, while a successful exec
preserves payload exits (including 126) and signals. Any
initial or group publication failure prevents payload execution. Missing commands
still exit 127. Existing `TEST_SLOT_HELD`/`TEST_SLOT_HOLDER_UNKNOWN` exit 75,
watchdog exits and legacy `.queue`/`.takeover` semantics are unchanged.

CLI metadata: `--reason TEXT`, `--expected-seconds N`, `--reserve-gib N`. The
runner estimates the end from expected seconds (default: watchdog wall limit)
and expires at wall limit plus 30 seconds grace, subject to the six-hour cap.
Before a permitted timeout retry, the runner renews expiry from the retry's
current time with the same wall limit and grace; the original six-hour cap remains.
Those metadata options never change shared admission.

## Proving-step admission

An exact resource stanza may declare `memory_floor_bytes`, a safe integer >= 0,
only with explicit `admission_class: "EXCLUSIVE"`. The calling project owns its
floor and margin data; Brain supplies no BCH number. `M_bytes` remains the unknown
execution envelope and `reserveGib` remains display-only. A SHARED stanza with a
floor gets `TEST_SLOT_PROFILE_REJECTED`, remains shared and never samples/waits
for that floor. An invalid floor-bearing EXCLUSIVE declaration, including an
invalid command binding, refuses with that code and exit 75 before taking locks.
`--no-slot` cannot bypass a declared proving floor.

The foreground order is one admission deadline (`run` entry + `--wait` seconds),
ticketed compat then workspace acquisition, owned proving reservation, cancellable
memory wait, fresh ownership and floor confirmation, group publication/start
barrier, then payload. Both locks and the floor consume that one deadline; a
second lock, sample or renewal never restarts it. Execution starts its own
declared watchdog after admission. An EXCLUSIVE descendant already covered by
an exclusive token or ancestry takes no second lock, reservation or floor.

The floor wait polls `readMemory().available` asynchronously at intervals of at
most one second, capped by the remaining budget. A fresh nonnegative safe-integer
sample must meet the floor, with both lock tokens and exact owned reservation
bytes revalidated before grant. Low measured memory waits until the deadline,
then returns `TEST_SLOT_MEMORY/75` without a payload. An unreadable/invalid sample
immediately returns `TEST_SLOT_HOLDER_UNKNOWN/75`; unknown is never measured zero.
`--wait 0` permits exactly one immediate sample, with no sleep. The waiting
reservation expires at the admission deadline; if acquisition has exhausted the
budget, including an immediate attempt, a zero-duration row is already expired.
It cannot pause launches. Only a successful floor grant renews the reservation
for the execution wall allowance plus 30 seconds, before group publication and
barrier release. The original six-hour maximum still applies, including retries.
No admission retry resets the deadline; an authorized execution retry stays
inside the existing exclusive hold.

INT, TERM and HUP cancel the asynchronous wait promptly with their signal status
(128 + signal). Before payload start, owned cleanup releases the reservation,
both locks and any tickets, and writes no grant receipt. After start, cancellation
and owner death preserve every live owned group under the same release rules.
The reservation remains live during a nonzero floor wait, so named new-launch
gates pause while compatible exclusive tickets retain their FIFO order. This
reduces new launch pressure; admitted shared work continues, and legacy pollers
can still jump ticketed participants. Neither memory availability nor host-wide
starvation freedom is guaranteed.

Nested proving admission under SHARED is deferred (D1). The entry refuses this
context with `TEST_SLOT_PROFILE_REJECTED/75`, before a second record, lock or
payload, including when the inherited occupancy path avoids an ancestry read.
Never clear tokens to make a nested process appear top-level. BCH must verify
the actual launch graph/runtime binding puts its proving command in its own
top-level gate, outside `LANE_VALIDATE` and ordinary full/no-proof suites.

For floor-bearing calls, `TEST_SLOT_MEMORY_ADMISSION` logs profile/binding, floor,
deadline and wait budget; `TEST_SLOT_MEMORY_WAIT` logs each changed measurement;
`TEST_SLOT_MEMORY_GRANTED` or the named refusal records the result. The bound
request/profile and execution receipt identify candidate, exact command and Node
runtime. A grant receipt is written only after successful admission. Existing
output for runs without a floor is unchanged, apart from the newly refused
EXCLUSIVE-under-SHARED case. Richer floor receipt fields (D4), the capability
fingerprint exclusion (D2), and shared-parent sampling cleanup (D3) are deferred.

BCH mapping: its `withProvingStep` becomes a declared EXCLUSIVE `test-slot run`;
MEMORY maps to `TEST_SLOT_MEMORY`; HELD and HOLDER_UNKNOWN use Brain's existing
`TEST_SLOT_HELD` and `TEST_SLOT_HOLDER_UNKNOWN` semantics. PROVER_RESERVED stays
inside BCH's gnark/SP1/`.prover.lock` guards. Brain emits no `BCH_*`, NESTING or
BRIDGE_FENCE codes, and acquires no inner prover claim. Shared occupancy count is
never an admission predicate.

## Mixed versions

| Reader/writer | Shared occupancy | Proving reservation |
| --- | --- | --- |
| New Brain | Writes BCH's exact v1 key set beside compat; reads both directories. | Writes only for declared proving; launch gates read the separate schema. |
| Pinned older Brain with occupancy/v1 | Reads its existing namespace; unknown schemas are skipped and never pruned. | Skips and preserves; does not gain the new launch pause until upgraded. |
| BCH ENG-1526 C local admission | Writes beside legacy; closed v1 keys; shared work never queues. | Its existing reader skips and preserves. Future `withProvingStep` adoption must use this owner/expiry/barrier contract. |
| Legacy BCH test-slot | Continues honoring the legacy lock and ticket protocol where supported. | Ignores the occupancy directory. A bare holder does not identify proving. |

The legacy holder still has no `schema` or `version` field. Live older/BCH v1
holders with nullable birth identity are waited for, never taken over by age.
Installed older exclusive runners and the floor runner exclude one another
through the same bridge. Older reservation readers that require strictly positive
duration classify immediate-attempt rows as unknown/nonblocking and preserve
their bytes; they read execution renewals normally. Older runners do not enforce
the new stanza floor: adopting callers must bind to a release implementing it.
No FIFO admission ledger, drain, v2 lock record, named claims or new namespace is
introduced. Construction here does not activate BCH callers.

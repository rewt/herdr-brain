# Host proving reservations v1

This is the shared host contract for ENG-424 and ENG-389, amended under
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
| `expiresAt` | Required ISO expiry after acquisition, capped at acquisition plus six hours. Both writers and readers apply the cap. |
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

## Mixed versions and the later admission protocol

| Reader/writer | Shared occupancy | Proving reservation |
| --- | --- | --- |
| New Brain | Writes BCH's exact v1 key set beside compat; reads both directories. | Writes only for declared proving; launch gates read the separate schema. |
| Pinned older Brain with occupancy/v1 | Reads its existing namespace; unknown schemas are skipped and never pruned. | Skips and preserves; does not gain the new launch pause until upgraded. |
| BCH ENG-1526 C local admission | Writes beside legacy; closed v1 keys; shared work never queues. | Its existing reader skips and preserves. Future `withProvingStep` adoption must use this owner/expiry/barrier contract. |
| Legacy BCH test-slot | Continues honoring the legacy lock and ticket protocol where supported. | Ignores the occupancy directory. A bare holder does not identify proving. |

ENG-354 remains a follow-up: no FIFO admission ledger, drain, v2 lock record,
named claims or new namespace is introduced. That protocol can absorb these
step-scoped records and display metadata without changing the legacy lock or
adding keys to shared occupancy/v1. Schema adoption and reader upgrades require
the cross-project review above; construction here does not activate BCH callers.

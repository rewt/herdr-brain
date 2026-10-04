# Fast logic correction audit — R-206

The independent review found that whole-file deferrals also removed fast logic.
Audited the test bodies, shared fixtures and helpers in all 43 deferred files,
including matrix cases and `actorTest`/`caseTest` wrappers. Restored 32 cases
from 12 files to the existing `test:promotion:logic` command. The other 31 files
retain real CLI/Git/process, elapsed wait, copied-product, PTY or server costs in
their test setup or assertions. No test body, runner, release command or lifecycle
rule changed. The source audit uses cost, including setup, rather than duration
alone: for example the cheap PTY argument case still executes a real shell/Node
child, and validation profile cases initialize and commit a real Git fixture.

`npm run test:promotion:logic` passed **62 tests**, with **304 name-filter skips**,
zero failures or cancellations, and a TAP duration of **6.011 seconds**.
The compressed log records every selected and skipped runtime title. This is a
focused correction check, not a new measurement of complete promotion CI.
A host-slot attempt refused with exit 75 because an existing promotion held it;
the focused logic check ran directly, as permitted for lane development.
No full-suite, baseline, promotion chain or live acceptance command ran here.
The R-199 measurements (991.282 s before, 179.497 s after) remain unchanged
historical evidence. The corrected promotion command still requires the next
batch's normal validation before main moves.

Static coverage checks verified that all 43 audited files remain covered by the
full `test:core`, `test:cycle`, `test:lanes` or `test:acceptance` release globs,
and that the 31 wholly deferred files are absent from both promotion file lists.
Release preparation still invokes `npm run test:release` through the existing
prepare declaration. `moved-files.json` now lists only wholly deferred files;
`moved-tests.md` lists expensive cases from the mixed files and now includes
previously omitted `actorTest` and `caseTest` definitions.

## Restored runtime titles

### console/test/session.test.mjs

- answers are passed as an argument array
- a missing configuration becomes an example that must be edited

### acceptance/test/load-round2.test.mjs

- retry context and cutover aggregate preserve heavy-load PENDING
- retry context and cutover aggregate preserve normal-load FAIL

### acceptance/test/cleanup.test.mjs

- cleanup closes main and linked workspaces after pass, including an unfurled creation receipt
- cleanup closes main and linked workspaces after fail, including an unfurled creation receipt
- failed inventory still attempts every owned receipt and audits the actual residue by ID and label
- unreceipted scratch workspace is named by the raw audit without gaining closure authority
- cleanup recovers implicit main and linked workspaces from a confined creation intent when the reply is lost
- a malformed journal entry does not prevent closing other receipt-owned workspaces

### acceptance/test/cutover.test.mjs

- rollback restores every file byte and executable mode
- contrib cannot retire with an extra executable caller, and scans refuse symlinks
- all eleven edits apply to relocated inventory scripts and refuse premise drift
- retirement scans nested Python, executable extensionless and notify entry callers
- only unreferenced timestamped script backups qualify as historical material
- executable shell case arms cannot hide contrib callers or references to historical backups
- referenced mode-0644 script backups are enumerated, retained transitively and prevent retirement

### acceptance/test/focus.test.mjs

- owned changes need no correlated call and incomplete monitoring never passes

### acceptance/test/recovery.test.mjs

- cleanup reconciles again when a lost-reply workspace appears after the first inventory
- a matching caller label with a foreign native path never grants recovery authority

### discovery/test/owner.test.mjs

- each bundled target matches its checksum, current source and native architecture
- verified owner bytes are copied into private scratch with restricted modes
- staged owner preserves the installed validation transport lifetime protocol

### discovery/test/review-r2.test.mjs

- retained Claude discovery evidence marks unauthenticated cases pending on HUM-19

### discovery/test/review-r3.test.mjs

- x64 seccomp denies io_uring, unknown syscalls and socket creation by default
- arm64 seccomp denies io_uring, unknown syscalls and socket creation by default
- lifetime markers reject redirected scratch roots before provider construction

### dispatch/test/dispatch.test.mjs

- fake watcher receipt refuses PID reuse before registration and retains ownership across retries
- real watcher journal refuses PID reuse before registration and retains ownership across retries

### housekeeping/test/auto-tidy.test.mjs

- conflicting agent tab/workspace and duplicate pane topology cannot authorize a close
- supported review routes need a matching topic verdict newer than their session

### watch/test/watch.test.mjs

- every terminal condition has a distinct, compact supervisor notice

## Every whole-file deferral audited

| File | Result | Remaining cost |
| --- | --- | --- |
| `acceptance/test/boundary.test.mjs` | Entire file remains release-only | Native confinement, socket, focus, load or release cleanup integration. |
| `acceptance/test/cleanup.test.mjs` | 6 fast cases restored | Native adapter reply/layout processes and signal cleanup children. |
| `acceptance/test/cutover.test.mjs` | 7 fast cases restored | Executing copied cleanup and tidy scripts against CLI transports. |
| `acceptance/test/focus.test.mjs` | 1 fast cases restored | Real socket monitor processes, native events and elapsed sampling/replay. |
| `acceptance/test/load-round2.test.mjs` | 2 fast cases restored | Real TAP children, delegated fixtures and elapsed receipt/queue deadlines. |
| `acceptance/test/recovery.test.mjs` | 2 fast cases restored | Signal/producer processes, elapsed producer drain and supervisor cleanup. |
| `acceptance/test/validation.test.mjs` | Entire file remains release-only | Native confinement, socket, focus, load or release cleanup integration. |
| `acceptance/test/verification.test.mjs` | Entire file remains release-only | Native confinement, socket, focus, load or release cleanup integration. |
| `console/test/session.test.mjs` | 2 fast cases restored | Real record CLI setup/answers, Herdr transport and session interaction. |
| `discovery/test/acceptance.test.mjs` | Entire file remains release-only | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `discovery/test/entry.test.mjs` | Entire file remains release-only | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `discovery/test/lifecycle.test.mjs` | Entire file remains release-only | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `discovery/test/owner.test.mjs` | 3 fast cases restored | Copied products, source fallback subprocesses and detached descendant cleanup. |
| `discovery/test/review-r2.test.mjs` | 1 fast cases restored | Git fixtures, provider guards, native filters and copied/installed probes. |
| `discovery/test/review-r3.test.mjs` | 3 fast cases restored | Real detached children, kernel sandbox/syscalls/network and probe subprocesses. |
| `discovery/test/review.test.mjs` | Entire file remains release-only | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `discovery/test/sandbox.test.mjs` | Entire file remains release-only | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `discovery/test/settings.test.mjs` | Entire file remains release-only | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `dispatch/test/dispatch.test.mjs` | 2 fast cases restored | Real record/Git/dispatch/watch CLI lifecycles, waits and process recovery. |
| `housekeeping/test/auto-tidy.test.mjs` | 2 fast cases restored | CLI and fake-server tidy actions, current occupant/record rechecks and scheduling. |
| `lanes/test/workspace-native.test.mjs` | Entire file remains release-only | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `release/test/release.test.mjs` | Entire file remains release-only | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `settle/test/config.test.mjs` | Entire file remains release-only | Full review/correction, recovery or transport integration; rebase and current-record guards remain in CI. |
| `settle/test/memory-boundaries.test.mjs` | Entire file remains release-only | Full review/correction, recovery or transport integration; rebase and current-record guards remain in CI. |
| `settle/test/recapture.test.mjs` | Entire file remains release-only | Full review/correction, recovery or transport integration; rebase and current-record guards remain in CI. |
| `settle/test/receipts.test.mjs` | Entire file remains release-only | Full review/correction, recovery or transport integration; rebase and current-record guards remain in CI. |
| `settle/test/round-cap.test.mjs` | Entire file remains release-only | Full review/correction, recovery or transport integration; rebase and current-record guards remain in CI. |
| `settle/test/settle.test.mjs` | Entire file remains release-only | Full review/correction, recovery or transport integration; rebase and current-record guards remain in CI. |
| `settle/test/teardown.test.mjs` | Entire file remains release-only | Full review/correction, recovery or transport integration; rebase and current-record guards remain in CI. |
| `settle/test/validation-tiers.test.mjs` | Entire file remains release-only | Full review/correction, recovery or transport integration; rebase and current-record guards remain in CI. |
| `supervisor/test/supervisor.test.mjs` | Entire file remains release-only | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `test/brain-start.test.mjs` | Entire file remains release-only | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `test/console-launch.test.mjs` | Entire file remains release-only | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `test/fleet.test.mjs` | Entire file remains release-only | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `test/mcp.test.mjs` | Entire file remains release-only | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `test/open-session.test.mjs` | Entire file remains release-only | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `test/plugin-install.test.mjs` | Entire file remains release-only | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `test/pty.test.mjs` | Entire file remains release-only | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `test/release.test.mjs` | Entire file remains release-only | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `test/settle-watch.test.mjs` | Entire file remains release-only | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `test/startup-deadlines.test.mjs` | Entire file remains release-only | Real elapsed response, watchdog or descendant-cleanup integration. |
| `test/test-hangs.test.mjs` | Entire file remains release-only | Real elapsed response, watchdog or descendant-cleanup integration. |
| `watch/test/watch.test.mjs` | 1 fast cases restored | Detached watchers, record/Herdr delivery, real file events and elapsed grace windows. |

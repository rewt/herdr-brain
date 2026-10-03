# Release gate deadline inventory (ENG-134)

Audited `acceptance/*.mjs`, `acceptance/test/*.mjs`, and the helpers they call.
Response allowances use `lib/deadline.mjs`: sample the one-minute load at the
operation, divide by at most four CPUs, never shrink below the base allowance,
and cap at Node's largest finite timer. Load 24 on an 18-CPU host therefore gives
factor 6: a 60-second command receives 360 seconds. An operation does not keep
extending its deadline while waiting. No session metadata controls the factor.
`acceptance/deadline.mjs` bridges the shared implementation; scratch workers get
an unchanged copy of `lib/deadline.mjs` beside their other runtime modules.

| Location | Original fixed allowance | Disposition |
| --- | --- | --- |
| `run.mjs`: `run`, `node`, `runCopy`, Git, npm, sandbox-exec, verification and discovery calls | 60s default; explicit 10/60/90s | All pass through `loadAwareCommand`, sampled once per child; `timeoutMs` records the effective allowance. Default SIGKILL prevents a child ignoring SIGTERM from defeating the synchronous deadline. Nonzero product assertions retain precedence. |
| `run.mjs`: `until` and every explicit report/topology/queue wait, including calls from `live.mjs` | 25s default; 15/30/60/90/200s explicit | `waitUntil` scales once from the operation's current sample, retaining operation-specific failure evidence. |
| `run.mjs`: watcher drain | 15s | Scaled once; cleanup still refuses an unconfirmed drain. |
| `run.mjs`: busy-refusal elapsed assertion and native `agent wait --timeout` | 10s each | Both scale; the elapsed assertion freezes its allowance before invocation. |
| `herdr.mjs`: ownership lock | 10s | Scaled; receipt persistence and cleanup authority unchanged. |
| `herdr.mjs`: each native child and TERM-to-KILL grace | 35s + 1s | Both scale; forceful termination remains finite. |
| `herdr.mjs`: cwd, stand-in registration, PTY acknowledgement, shell startup | 50/60/100 attempts at 100ms (nominal 5/6/10/10s) | Converted to elapsed, load-scaled deadlines. Native probes have their own bounded response allowance. |
| `worker.mjs`: scripted commands and TERM-to-KILL grace | 90s default; Git add/commit 15s; grace 1s | All scale on invocation. |
| `live-worker.mjs`: real session runtime and termination grace | 180s; stop grace 1s | Both scale. Runtime expiry now also escalates to SIGKILL after the grace, including sessions that ignore TERM. |
| `focus.mjs`: IPC ready/stop waits and replay startup | 70/7/60s | Already load-aware; retained. |
| `focus.mjs`: destination creation receipt and subscription-ready waits | 3s each | Converted to load-aware allowances. |
| `probe.mjs`: generated direct-socket denial proof | 2s | Generated immediately before native execution with a sampled load-aware allowance. Permission failures remain product failures. |
| `producers.mjs`, via `cleanup.mjs` and `run.mjs`: producer drain | 120s default, optional test override | Scaled once even when explicitly overridden; cleanup still refuses live producers. |
| `plugin-entry.mjs`: child commands, native readiness and `agent start --timeout` | 20s default/25s Herdr, 10s poll, 15s native start | All scale. The interactive UI and named server persist intentionally until their owned workspace/server is closed. |
| `settle.mjs`, `supervisor.mjs`: delegated child commands and report/queue waits | Fixture commands 15s; waits 8/10s | Commands scale through `loadAwareCommand`; waits scale through `waitUntil`. |
| `settle/test/fixture.mjs`: watcher cleanup | 2s | Converted to load-aware allowance. Its 15s command base is scaled by the acceptance wrapper exactly once. The fixture's explicit 0.02/2s input-confirmation/poll/wait settings script the transport protocol; they are fixture behavior, not a release response deadline. |
| `test/helpers/run.mjs`, `bounded-test.mjs`, `pty.mjs`, `child.mjs`, `processes.mjs`, `inbox.mjs` | Suite 300/360s (CLI maxima 480/540s); test 60s; command 15s; PTY 15s + 3s cleanup; child 15/35s + 500ms pipe drain; lookup 2/4/8s; inbox 5s | Already load-aware defaults and caps. Child helper explicit allowances are absolute by contract, to permit deliberate watchdog tests. Ordinary acceptance fixture command overrides below now scale before being passed to these helpers. Runner `--fixed-deadlines` intentionally remains fixed for cancellation regressions. |
| `lanes/board/herdr-client.mjs`, used by the focus monitor | 2s request/pane-read/subscription socket; 250ms–5s reconnect backoff | Response and socket allowances already scale. Backoff remains a cadence, bounded by the monitor startup allowance. |
| `test/helpers/suite.mjs`, fixture policy and native PTY owner | No additional fixed response allowance | Pass existing runner/PTY allowances through. Retry counts and byte/row limits are structural bounds, not timeouts. |
| `acceptance/test/verification.test.mjs` | 20s child | Converted to load-aware allowance. |
| `acceptance/test/cleanup.test.mjs` | 15s child | Converted to load-aware allowance. |
| `acceptance/test/security.test.mjs`, `load-round2.test.mjs` ordinary TAP fixture, `recovery.test.mjs` ordinary/generated children and active-creation wait | 10s | Converted to load-aware allowances. Security's missing-tool probe exits during preflight, before a candidate is resolved; it is not a gate pass. |
| `acceptance/test/validation.test.mjs` | 60s test option | Already scales through `bounded-test`; retained. |
| `acceptance/test/boundary.test.mjs` | Implicit 15s child cap | Receipt-wait scenarios now receive the enclosing test's compound allowance of scaled 45s, so a scaled 10s receipt wait can finish and report its intended error. |
| `acceptance/test/load.test.mjs`, `load-round2.test.mjs` stalled-child watchdogs | 100ms | Intentionally fixed. These prove timeout classification/cancellation, so scaling the timer would change the stimulus and slow a deliberate failure test. |
| `acceptance/test/deadlines.test.mjs` hung-child regression | 50ms base | Scales to 300ms at simulated load 24. Actual sandbox-exec on macOS launches a TERM-ignoring child; SIGKILL ends it within the finite allowance. |
| `acceptance/test/recovery.test.mjs` deliberate producer drain | 50ms base | Retained as a deliberately short test stimulus; the production drain helper still scales it. |

The remaining timers are observation/fixture cadence, not response deadlines:
`load.mjs` samples each second and polls at 150ms; `focus.mjs` samples at 200ms,
polls receipts at 25ms and requires a 400ms quiet replay window; producers and
worker-stop detection poll at 25ms; adapter/native-canary polls use 25/100ms.
The runner's 300ms lifecycle pause and 1s idle-grace observation, the worker's
1/1.5/4s scripted state delays, test focus socket/event delays and
100–1100ms blocked-parent intervals, and recovery's 150ms delayed receipt after
a signal deliberately construct races or observable state transitions. Retain
them: expanding observation cadence would reduce detection fidelity. Test
assertion/replay counts, cutover's 900s idle grace and explicit zero startup grace
are semantic behaviors under test, not responsiveness allowances. Copied legacy
scripts and `kit/` retain their original protocol timers as compatibility input;
the release gate bounds their command and report windows, rather than rewriting
historic/live consumers. Short shell polling sleeps in the test helpers also
remain fixed. Files not listed above introduce no timers/deadlines; their child
operations use the runner, or intentionally persist under an owning child/PTY
allowance and explicit cleanup.

Offline proof is in `acceptance/test/deadlines.test.mjs`. Cases 19 and 20 use the
shared cutover inventory and command path with simulated load 24 and a virtual
70s response (beyond the old 60s deadline). Actual copied naming/tidy scripts run
through sandbox-exec on macOS with scratch-only record/Herdr stand-ins; all eleven
file changes, exact rollback, late-log recovery, negative caller refusal and
contrib removal/restoration are checked. This does not claim live PTY dispatch
or model-session evidence; those remain the release candidate's single live
gate. A real TERM-ignoring sandbox child tests bounded non-response separately.

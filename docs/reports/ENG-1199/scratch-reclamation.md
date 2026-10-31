# Scratch reclamation ownership

ENG-1199 / R-1596, 31 October 2026. This is an ownership disposition and a
follow-up design boundary. It installs no reaper and authorizes no historical
deletion. The observation and landing receipts belong in the owning run's report
and `.org/evidence/ENG-1199/R-1596/`.

## Existing owners

| Scratch or evidence | Reclamation owner and event |
| --- | --- |
| A process's `gh-*` isolation root | That process's `isolateGateHistory` exit callback in `test/helpers/gate-history.mjs`. It checks history isolation and removes its own root on ordinary exit. |
| Coordinator `oh-*`, including its `lifetime-*` children and native guard cache | The process that created the offline root, through `offlineHerdr`'s returned cleanup and exit callback in `test/helpers/offline-herdr.mjs`. A child inheriting the root receives a no-op cleanup; it does not own the enclosing root. |
| Standalone `fixture-lifetime-*` | Its creating process's exit callback in `test/helpers/fixture-lifetime.mjs`. Under an offline root, the enclosing offline-root owner reclaims it. |
| Roots registered to a joined suite | The runner coordinator's `recoverScratch` call after that suite has exited and drained. Existing path, owner-birth, group-absence and nested-root protections continue to govern removal. |
| Scratch journal, recovery receipts, TAP, timings and completion evidence | The producing record/check's evidence owner. These are retained evidence, excluded from disposable-scratch recovery. |

A coordinator is still alive when it writes a suite recovery receipt. Its
`gh-*` and `oh-*/lifetime-*` registrations are outside that joined suite, so
`no joined owning group` is expected. The receipt precedes the coordinator's own
exit callbacks. Two retained registrations are neither two proven leaks nor two
roots authorized for a later process to remove. Ordinary assertion failure also
permits exit callbacks; SIGKILL, process abort or a cleanup error can prevent
them. Source inspection alone does not prove every callback completed.

## Interrupted coordinators and the historical F1 receipt

Responsibility for recovering genuine leftovers belongs to the **Brain test
harness**, under the project supervisor's existing ownership of the runner
cleanup exception. It does not belong to an unrelated suite, the pass-journal
rotation feature, or a machine-wide temporary-directory janitor.

The project supervisor `supervisor-herdr` owns selecting a harness engineer for
any remaining recovery work. The engineer must bind recovery to the original
attempt journal and original owner; the supervisor owns resolving missing
ownership or authority through the existing decision route. This assignment does
not grant a worker deletion authority or activate housekeeping. Any new cleanup
contract needs its applicable technical decision and boundary review.

For F1, the starting manifest is
`.org/evidence/ENG-1149/R-1541/scratch-recovery-initial.json`. Its 4,199 retained
registrations were a historical classification after a refused native inventory,
not a current directory count. R-1541 already assigned that exception to the
project supervisor. Preserve the original red gate, journal and pending notice
`R-1541:exception:check-cleanup`; do not replay its delivery.

The next event is consumption of R-1596's exact-path observation by that owner:
absent paths need no deletion; replaced or unreadable paths remain held; existing
matching roots remain candidates requiring fresh ownership/lifetime proof. The
observation sends no signals, performs no process lookup, and provides no removal
eligibility. It cannot establish descendant exit or current disk usage.

If a separately selected recovery implementation follows, its acceptance must
include a real interrupted coordinator, a normal completion and an assertion
failure, plus refusal on live/reused/unknown owners, substituted paths and
retained nested roots. Preserve evidence outside scratch. Retrying recovery after
proof becomes available must produce an explicit disposition without erasing the
original retention receipt. A process's old PGID, a matching directory prefix,
age or a dead PID alone must never authorize removal; a historical coordinator's
group may contain unrelated live work. Actual deletion waits for a supported,
reviewed ownership proof and the current native/record guards.

## Bounded evidence and limits

R-1596 selects one read-only observation of the exact paths in the archived
ENG-1158 success, assertion, lost-reply, denied-ps and unknown-group witnesses,
and every registration in the F1 receipt. It compares canonical path and
device/inode/birth against the original registration and records absent,
matching, changed or unavailable. It enumerates no temporary-directory namespace
and measures no recursive byte totals. The owning report contains the actual
counts and immutable check receipt; this page makes no future observation a PASS.

The success/assertion witnesses test ordinary completion and failure. The
unknown-group pair demonstrates refusal of recovery when proof is unavailable,
preserving the original success/failure result. Reusing that producer evidence
does not rerun or upgrade it, and later absence does not identify which actor
removed a root. A live interrupted-coordinator recovery remains unproven.

R-1593 passed ENG-1158 with three Minor notes, no Major and no formal correction.
ENG-1199 arose from its ordinary proposal. The generated ask also copied the
three Minor findings into its acceptance; this disposition does not claim their
discharge, alter the verdict, weaken fail-closed recovery or start another review
chain. Broader suites, killed-worker coverage and installed/live acceptance stay
with their existing release owner and retain their recorded unrun status.

# Multi-fixture teardown Major: correction disposition

ENG-638 / R-892 is the single formal correction under REV-9. The original
source item remains ENG-635, producer run R-880. The Major at
`test/helpers/session-live.mjs:100` is corrected by the existing landed source;
this change records its disposition and binds the specific correction evidence.
It does not implement a second fix or change the captured review verdict.

## Preserve the failed review

R-889's FAIL remains bound to base
`eb0ba252714f4556d21a5fd87a00023a64474bf8` and head
`dcd04839184dfeeeefe713db7a74783d531a738a`. At that head, each fixture captures
the environment left by its predecessor. Creation-order teardown can therefore
restore HOME and HERDR_MONITOR_FLEET to a deleted earlier fixture directory.
The single-fixture regression at the captured head does not detect this case.

The complete immutable review target, including report/diff digests and original
dispatch, is retained in [binding.json](binding.json). REV-9, its original source
reference, and its existing attempts remain unchanged. The correction described
below must never be substituted for that captured head or called a new PASS
verdict on it. No new review or automatic re-review chain is requested.

## Bind the already-landed correction

R-880's `landing.json` records the original local fast-forward from
`eb0ba252714f4556d21a5fd87a00023a64474bf8` to
`59e96da75d9912db1e9287fe853278b1cbf87609`, including the captured head and
the later correction commit. Its `rebased-source.diff` records the corrected
implementation and regression:

- A WeakSet identifies each test context that owns environment restoration.
  Only its first fixture captures the caller's HOME and HERDR_MONITOR_FLEET and
  registers the restoration hook. That hook runs before fixture homes are removed.
- The nested isolation regression creates a second fixture in the same child
  test, checks its distinct scratch HOME, then checks the true caller environment
  after the child test and all its teardown hooks finish.

The helper and regression blobs are identical in the tested correction at
`d83b7e4de75d1e37b505968b3ece02a4165cbac0`, the recorded corrected landing,
and this lane's starting baseline `291c4da2e2dfecda82c8626588ae841d7cc21a28`:

| File | Identical Git blob |
| --- | --- |
| `test/helpers/session-live.mjs` | `6ea2b30a3c6e3a41b0e0204fd196e875b0c53b2d` |
| `test/session-fixture-isolation.test.mjs` | `63489a78fc67e76b804c04fe73adb260766d2a3a` |

## Specific correction evidence for release

The retained producer evidence directory is
`/Users/rewt/development/rewt/.org/evidence/ENG-635/R-880/`.
The binding attaches SHA256 references for `landing.json`, `rebased-source.diff`,
`focused-gate.json`, `focused-execution.json` and `focused.tap`.
The original producer/verifier is `lane-line-eng-635--d52c9a-d3d5ba`;
the disposition verifier is `lane-line-eng-638--245092-f14c55`.

The focused command recorded in the gate used Node v20.19.4 and a 256 MB heap
ceiling through `test/helpers/run.mjs`, preserving these two file groups:
`test/session-fixture-isolation.test.mjs` and `test/session-live.test.mjs`.
Its name filter was
`^(fake-native fixture|in-process planning|STOP or terminal replacement|A2 opted-in)`.
The execution receipt records one attempt, exit 0, with no signal; the gate and
TAP record **4 passes, 0 failures, 44 skipped controls**, in 19.870 seconds.
The passing controls cover the outer fixture regression, its nested in-process
planning/child isolation control, STOP or terminal replacement during shell
readiness, and opted-in supervisor/chat human-typed launches.

This evidence is sufficient for this correction disposition because both changed
file blobs match the recorded corrected landing and no executable source changes
here. The ask explicitly permits reuse: no new tests, lane check, tier or green
replay is selected for this documentation/evidence-only change. The skipped 44
controls remain unrun by that focused execution; this is not full-file or release
coverage. The earlier heap failure and interrupted diagnostics remain preserved
in the producer/reviewer evidence. Promotion under the current landing waiver is
not a passing test execution.

Before release, the release coordinator must consume this Major-specific
correction disposition and its bound focused evidence, complete full final-release
coverage and actual live acceptance, and resolve any other outstanding obligations.
This disposition authorizes no activation or release. The project-specific
supervisor exception address supplied to this run is UNKNOWN; no recipient,
native binding, or supervisor identity has been invented.

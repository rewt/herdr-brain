# Release acceptance

`node acceptance/run.mjs --candidate TAG|REF|DIRECTORY [--source REPO] [--keep]`
is the optional live candidate gate (`release.sh build TAG --live`). Run it at most
once per release candidate from the operator's
release context. Lane workers run focused offline tests and never run the live gate.
Tests never call a model.

The gate snapshots candidate code into owned scratch storage and exercises:

- Record discovery and population, default routes and foreground supervisor context.
- Scripted workers and supervisor in real Herdr panes, dispatch, watch, final report
  ingestion, fix rounds, and lane validation, promotion and closure.
- Promotion queue order, refusal, notices and housekeeping cleanup.
- Immutable scratch release build, activation, rollback and three launcher links.
- Offline settle and supervisor cycles using real product modules and scripted transport.
- Owned process, inbox and workspace cleanup, plus operator focus preservation.

Native Codex and Claude are launched by the product through Herdr; the acceptance
workers simulate lifecycle reports without starting either model. Acceptance owns
only scratch project roots, records, workspace receipts and subprocesses. Its
Herdr transport refuses foreign paths, panes and workspaces, journals creation
intent before calls, and reconciles lost replies before cleanup. Stop producers
before reading journals so late replies cannot escape ownership accounting.

`--skip-live` is retained as a compatibility option. The former real-model cases,
entry installation probes, generated permission-profile verification and copied
bch-cloak cutover rehearsals have been removed. The release lane supplies the
small offline consumer contract check.

The run retains numbered command logs, load samples and a summary under its
scratch evidence directory. PASS means the case completed. Product failures are
FAIL; unavailable host prerequisites and measured load timeouts are PENDING.
Cleanup failures retain their owned roots for inspection. `--keep` retains scratch
artifacts; credentials are always removed. Successful cleanup leaves only evidence.
The build passes `--summary-file FILE` to retain an exact copy of the final
summary before sealing its bundle; the ordinary evidence summary is still written.

The gate needs Node, Git, Bash, zsh, rg, tar, npm and Herdr. It never mutates a live
project record or operator pane. Focus monitoring and ownership checks remain
required for a complete live gate. Run `node --test acceptance/test/FILE.test.mjs`
for the changed offline contract tests.

The focus gate keeps every observation in `focus-trace.jsonl` and its classified
changes in `focus-summary.json`. A move to a call's destination while it is active
or within five seconds of its completion fails, even during operator navigation.
For an owned destination, a call targeting any pane in the same workspace also
attributes the move, including a new pane after a split or a sibling after a send.
This uses native pane ID workspace prefixes and applies only to owned destinations.
This fixed attribution window includes delayed create, split and send effects;
it extends the previous one-second completion window and is not load-scaled.
An unexplained move into a harness-owned pane or workspace also fails by default.

A distinct, uncorrelated move between two panes outside harness ownership is
evidence of operator activity for the next 60 seconds. During that window an
unexplained move into a harness workspace is retained as `not-attributable`,
including the preceding operator move, its age, ownership and nearest calls.
The check can pass with a visible `WARNING: NOT-ATTRIBUTABLE` count in its detail
and release screen. Such a warning means the source is unknown, not that focus
preservation was proved for that move. Sixty seconds covers the observed
55-second operator navigation gap without exempting the rest of a long build.
Harness visits, unchanged samples and returns from harness panes never renew the
window. Attributed moves, forbidden focus attempts and incomplete traces still
fail or remain pending as before; no later operator activity erases a failure.

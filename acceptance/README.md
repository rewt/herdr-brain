# Release acceptance

`node acceptance/run.mjs --candidate TAG|REF|DIRECTORY [--source REPO] [--keep]`
is the local candidate gate. Run it once per release candidate from the operator's
release context. Lane workers run focused offline tests and never run the live gate.
Tests never call a model.

The gate snapshots candidate code into owned scratch storage and exercises:

- Record discovery and population, default routes and foreground supervisor context.
- Scripted workers and supervisor in real Herdr panes, dispatch, watch, final report
  ingestion, fix rounds, and lane validation, promotion and closure.
- Promotion queue order, refusal, notices and housekeeping cleanup.
- Immutable scratch release build, activation, rollback and launcher restoration.
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

The gate needs Node, Git, Bash, zsh, rg, tar, npm and Herdr. It never mutates a live
project record or operator pane. Focus monitoring and ownership checks remain
required for a complete live gate. Run `node --test acceptance/test/FILE.test.mjs`
for the changed offline contract tests.

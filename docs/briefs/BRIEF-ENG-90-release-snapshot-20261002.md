# Brief: ENG-90, the harness runs against a release directory

Org item **ENG-90**. Read `AGENTS.md` and `acceptance/README.md` first.

## The outcome

`node acceptance/run.mjs --candidate /Users/rewt/.local/share/herdr-monitor/releases/v0.1.4 ...`
gives 22 pass / 2 fail, while `--candidate main` at the same commit (f476589) gives 24/0/0. The two
failures are the harness's own: release directories are immutable (read-only modes), the snapshot
copy keeps those modes, and cases 15 (`npm ci` into `candidate/console`) and 20 (removing
`candidate/contrib/settle-watch.mjs`) hit EACCES and are classified as product failures. Evidence:
`/private/tmp/herdr-acceptance-iY6Txe/evidence/summary.json` (read-only). Make the snapshot of any
candidate writable inside scratch (never touch the release directory itself), and classify
environment errors in the harness's own scratch as harness errors. Run the harness against the
v0.1.4 release directory and against main, and report both one-screens.

## Boundaries

Work only in this lane's worktree and scratch. Never write the release directories, bch-cloak, the
shared `.lane.json`, `~/.local/bin`, or panes you did not create. No push or publish.

## Reply

Commit on this lane; write the report at the path your prompt names, with `decisions`,
`questions` and `challenges` after `artifacts`; cite commits by subject; `record check` it,
commit it, and run `lane check` last. Then stop.

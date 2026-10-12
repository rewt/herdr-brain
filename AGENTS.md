# herdr-org agent instructions

- `bin/org.mjs` is the CLI. `lib/store.mjs` owns the event log and lock, `lib/state.mjs` the fold and
  derived status, `lib/report.mjs` report parsing, `lib/render.mjs` every view and brief. No dependencies.
- `console/` may depend on Ink, React and a markdown renderer. The core stays dependency-free. The console
  writes only through the `org` CLI (child process, argument arrays) and never appends to `events.jsonl`
  itself.
- `mcp/` is an optional foreground stdio adapter with its own dependencies. It calls the record CLI
  with argument arrays for every record operation and never appends to `events.jsonl` itself.
  Run `npm --prefix mcp ci` and `npm --prefix mcp test` when changing it; tests stay offline.
  Generated Codex worker/review permission profiles disable network for sandboxed commands.
  Run dependency installs such as `npm --prefix mcp ci` outside that sandbox (through the
  harness's approved command escalation) or on a Claude route; do not enable network or
  grant Herdr's control socket to a worker to install dependencies.
- `brain/` may call a model and run as a background service; it has no dependencies, keeps its own state,
  and never writes `events.jsonl`. `supervisor/` supplies the read-only cold start and generic protocol,
  foreground notice/queue glue, and legacy settle launchers. Workers never invoke its cycle mutations.
- Tests run once, before code merges into main: the promotion batch runs the merge checks, like CI on a
  pull request. Release preparation runs the full offline suites once per candidate. In a lane, ship
  the change with the tests that prove it and run them
  while developing as you see fit; do not run a baseline, `npm test`, `test:promotion` or `test:lanes`.
  Settle reviews code and runs no suite. Tests are offline and never call a model.
- Only the project supervisor, from the canonical checkout, starts the default
  project-wide housekeeping schedule with
  `node housekeeping/housekeeping.mjs --start` ([module guide](housekeeping/README.md)).
  Lane workers must never start the project-wide loop (`--start` or `--loop`).
  It discovers the project and record; no housekeeping config is required. For
  worker checks or tasks that forbid live pane mutations, use `--once --dry-run`
  with `--state-dir "$PWD/.lane/housekeeping-preview"` instead.
- The release acceptance harness (`acceptance/run.mjs`) runs once per release candidate, not per lane
  (operator, 2026-10-02); never run the live harness in a lane. A lane that changes `acceptance/` itself runs its offline tests and at most
  one `--skip-live` pass.
- bch-cloak runs `contrib/settle-watch.mjs` from the installed release
  (`~/.local/share/herdr-monitor/current/contrib/`), with `--model` and `--effort`, and runs
  `supervisor/reconcile.mjs` from this checkout on every promotion. Keep both files' paths, flags and
  behaviour, and keep shipping `contrib/` and `lib/cli-help.mjs` in every release (ENG-64).

Contract:

- Durability replaces conversational context; it must not add bureaucracy. Reasoning costs tokens;
  coordination should not.
- The core never calls a model, never runs in the background, and never branches on harness,
  provider or model. Those are opaque run metadata.
- Budgets are advisory: surface them, never refuse work because of them. Refuse only what would make
  the record inconsistent (unknown ids, cycles, a second different report for one run).
- Status is derived from events. Do not add stored status.
- Older folds must ignore event types they do not know.
- `record lessons [--path P]` lists what earlier sessions learned.

## `lanes/`

- `lanes/lane.mjs` and its tests stay dependency-free; Herdr-only checks skip explicitly when Herdr is absent.
- A lane is owned by its canonical Git common-directory identity, never a basename, remote or workspace label.
- Promotion requires clean worktrees, a clean rebase, green validation and a fast-forward; it never pushes or creates merge commits.
- Keep lifecycle safety checks intact. Unmerged work closed through the CLI remains recoverable through an archive tag.
- Session metadata is display-only and must never authorize, schedule, retry, validate, promote, push or delete work.

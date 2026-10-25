# herdr-org agent instructions

- `bin/org.mjs` is the CLI. `lib/store.mjs` owns the event log and lock, `lib/state.mjs` the fold and
  derived status, `lib/report.mjs` report parsing, `lib/render.mjs` every view and brief. No dependencies.
- The product has no npm dependencies. The console and MCP adapter were removed (archived at tag
  `archive/console-20261012` and in Git history); do not reintroduce a dependency-bearing module.
- The repository pins Node 20.19.4 through `.nvmrc`; the move to Node 22 is tracked separately in ENG-359.
- `brain/` is the foreground, model-free record signal digest for lesson distillation; it has no
  dependencies, keeps its own state and never writes `events.jsonl`. `supervisor/` supplies the read-only
  cold start and generic protocol and foreground notice/queue glue. Workers never invoke its cycle mutations.
- Native harness settings own sandboxing and permissions; the product installs no wrappers. Hooks are allowed
  for the hook-pull transport only for sessions Herdr Brain launches: Claude through a per-session `--settings`
  file at launch; Codex through each project's committed `.codex/hooks.json`, trusted once by that project's
  owner. Never machine-wide, never in another identity's config, and never in human-typed chat panes.
- Follow [decision routing policy v2](supervisor/DECISION-ROUTING.md) for authority and review defaults;
  project-specific constraints and standing directions belong in its appendix.
- Gate policy is the committed `.lane.validation.json`: one unique affected-file check for an assembled change; no broad promotion tier plus repeated full-file tail. Independent reviews overlap integration and run no suites. Preserve actual source/head/claim/lock/FF and real-error guards. Release uses the declared reduced entry and real acceptance; never label entry smoke a full suite.
- Operator direct hotfix exception 2026-10-25 12:27 CDT authorizes this gating-only hotfix directly on canonical main after an exact annotated pre-main archive, with changed-only focused proof once and a recorded one-command revert. This is not authority for unrelated repairs, publishing, push, secrets or permission changes. Never modify/cancel/replay an already admitted immutable batch.
- Only the project supervisor, from the canonical checkout, starts the default
  project-wide housekeeping schedule with
  `node housekeeping/housekeeping.mjs --start` ([module guide](housekeeping/README.md)).
  Lane workers must never start the project-wide loop (`--start` or `--loop`).
  It discovers the project and record; no housekeeping config is required. For
  worker checks or tasks that forbid live pane mutations, use `--once --dry-run`
  with `--state-dir "$PWD/.lane/housekeeping-preview"` instead.
- Releases: the project supervisor tags `main` and runs `bash herdr/release.sh ship TAG` as one bare
  command (build with the release gate, activate, check, roll back on failure); see supervisor/PROTOCOL.md.
  Lanes never run it. The release acceptance harness (`acceptance/run.mjs`) runs only with `build TAG --live`,
  never in a lane. A lane that changes `acceptance/` itself runs its offline tests and at most
  one `--skip-live` pass.
- bch-cloak runs `contrib/settle-watch.mjs` from the installed release
  (`~/.local/share/herdr-monitor/current/contrib/`), with `--model` and `--effort`, and runs
  `supervisor/reconcile.mjs` from the installed current release by default; manual `HERDR_BRAIN_ROOT`
  and explicit reuse `request.brain` can select alternate roots
  ([owner-confirmed inventory](docs/evidence/ENG-396/R-570/bch-confirmation.txt)). Keep both files' paths, flags and
  behaviour, and keep shipping `contrib/` and `lib/cli-help.mjs` in every release (ENG-64).
  bch-cloak's canonical `.lane/supervisor/HOLD-WORKER-TAB-CLOSE` hold file is honoured by retirement and lane cleanup.

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

## Identity desks

Agents never edit another identity's files. Send a short request to that identity's
`desk-<identity>` with `node supervisor/request.mjs <identity> "<text>"`: what,
why, how to tell it is done, and where the evidence is. The helper creates an
unfocused native Codex desk at `~/development/<identity>` if none exists; Codex
loads that identity's configuration from `.identity-root`. The desk records the
request in its own record, uses its own lanes and reviews, then replies.
Never forward anything your own harness refused (sandbox, permission or harness
settings); take that to the operator. See [the protocol](supervisor/PROTOCOL.md).

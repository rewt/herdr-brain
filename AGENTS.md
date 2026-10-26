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
- [Verify once](docs/reference/VERIFY-ONCE.md) is effective immediately for Brain and BCH: ONE designated party verifies each routine fact/snapshot and records their name, scope/source, observation time, result and evidence locator in the existing report/receipt. Supervisors and Brain Chat consume that result once without rehashing bindings, landings or producer checks, and workers do not wait for root acknowledgment. Fresh native identity/claim/source/CAS reads at each new mutation boundary remain mandatory. Independent review judges immutable diff/evidence with zero producer-suite replay; Brain Chat spot-checks reserved/outward permissions, publishing, funds and operator-command boundaries or concrete contested exceptions. Session/display metadata grants no authority.
- Until the stable release, Brain and BCH use the same policy in their separate tooling; BCH owners update their own instructions and tooling, switching to Brain tooling after adoption. No pre-main test, merge, affected-file admission or review readiness gate. The finishing engineer self-lands OWN source through existing lane promote under the explicit current operator waiver (executed:false, exit_code:null), without waiting for supervisor acknowledgment or review. Red main is accepted and real failures are fixed forward. Preserve actual native identity/claims/ownership, source/head/clean Git/CAS/FF safety, recoverable archives, HOLD, STOP and reserved operator authority. Unrun checks are never PASS. Ordinary notices return to the owning worker through existing supported mechanisms; actual unsafe/native/identity/ownership/reserved/failed exceptions go to supervisor-herdr.
- Every item receives ONE independent post-code review of diff and evidence, async/nonblocking for engineers and landing, with zero reviewer suites. The 30-minute target is advisory, not an elapsed stop; review-round cap is 1 and supported timeout 0 disables the review deadline. No pre-code, plan, contract or concurrence reviews. At most one formal fix round; no automatic second full review/re-review chain. Later findings fix forward. Majors must actually be fixed and their specific correction/evidence checked before final release. Preserve historical verdicts/caps.
- Run ONE FULL release test immediately before final release/adoption. Preserve completed evidence; do not repeat the full run. After a real correction, run only failing, actually affected or previously unrun checks, with truthful coverage bound to source. Then real live acceptance, sealing, activation and current-consumer readback. Rehearsal remains PRIVATE with fresh-clone checks pre/post; Chipnet/run/funds boundaries stay unchanged. Zero elapsed-only test/helper/runner/gate failures; the sole forced freeze remains measured no-output AND confirmed-no-activity, unknown held.
- This additive gating hotfix retains archive/gating-hotfix-pre-20261025T1737Z-1a6111a4 and a one-command revert for its actual commits. Do not amend/relabel immutable evidence or create a new program/approval round.
- Only the project supervisor, from the canonical checkout, starts the default
  project-wide housekeeping schedule with
  `node housekeeping/housekeeping.mjs --start` ([module guide](housekeeping/README.md)).
  Lane workers must never start the project-wide loop (`--start` or `--loop`).
  It discovers the project and record; no housekeeping config is required. For
  worker checks or tasks that forbid live pane mutations, use `--once --dry-run`
  with `--state-dir "$PWD/.lane/housekeeping-preview"` instead.
- Releases: the project supervisor tags final `main`, runs `bash herdr/release.sh build TAG --live` as one bare
  command, then activates only after full-check coverage, live acceptance and Major corrections are proved; see supervisor/PROTOCOL.md.
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
- Promotion requires clean worktrees, a clean rebase, actual validation or the explicit current operator waiver, and a fast-forward; it never pushes or creates merge commits.
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

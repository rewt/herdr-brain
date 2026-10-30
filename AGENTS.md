# Herdr Brain — worker instructions

Read this page and your item brief before starting. Supervisors use
[PROTOCOL](supervisor/PROTOCOL.md); technical references are consulted when the
task needs them, not as another admission stage.

Load procedures on demand from the [shared skills](skills/README.md):
`project-preflight`, `project-deliver`, `project-review`, `project-release`,
and `project-troubleshoot`. Both harnesses use the same source. These skills
do not grant authority or replace the guarded project tools.

## Build

- Use pinned Node **20.19.4**. Keep the product dependency-free; removed console/MCP
  modules stay archived. bin/org.mjs is the CLI; lib/store.mjs owns events/locking,
  lib/state.mjs the fold, and lib/render.mjs briefs/views.
- Work in your actual claimed project/lane. Preserve native identity, claim
  generation, real Git common-directory/worktree, clean rebase, expected head,
  main CAS/fast-forward, STOP/HOLD and recoverable archives. Display labels/session
  metadata grant no authority. Never edit another identity's files.
- **Land finished OWN source first**, under the existing waiver:
  `node lanes/lane.mjs promote TOPIC --expected-head-from-worktree`.
  This form applies the native worker/run/claim guard across the fast-forward;
  literal `--expected-head FULL_SHA` alone does not and is for external exact-head
  callers, not worker self-landing. Rebase moved main in your lane, record the
  resulting committed head, and verify the command's captured head matches it;
  then report.
  No report-first promotion flag, fabricated report, push or release.
- Routine protected commands request require_escalated from the outset. The
  approved general forms use `git rebase -- UPSTREAM`, mode-only `git rebase
  --continue` / `--abort`, `git merge --ff-only -- UPSTREAM`, and `kill -0 -- PID`.
  Matching prefix rules run OUTSIDE the sandbox, like commits; no broader authority.
- Run only your selected affected checks once through the existing runner/lane
  check. No baseline/default/full suite or green replay. Preserve failures; after
  a fix run only failing, affected or unrun controls. Unrun is never PASS.
  Line limits are planning advice. Real errors remain real errors.

## Review and handback

- Hand immutable landed base/head and evidence through the report to the existing
  record queue-review path. ONE async post-code diff/evidence review, cap1,
  about30-minute planning target, zero reviewer suites. When a worker report is in,
  the owning line's existing finite report/closeout turn releases its session and
  clean worktree in the same step through the source-bound guarded closer, which
  records preservation and native/Git effect receipts. This is the handback path
  for every consumer project; do not hand-close panes or hand-remove worktrees or
  branches to satisfy this rule. The closer deletes a branch only if it is already
  on main, otherwise keeps it so a fix can continue, and keeps a folder with unsaved
  changes. A held or failed closeout remains with its original binding and owner;
  route the exception rather than bypassing it. Historical hand removals are
  recorded as such, never counted as clean line-release witnesses or retrofitted
  with successful closeout receipts. See the [finite closeout contract](line-service/README.md#finite-report-and-closeout-turns).
  Reviews and fixes start fresh from the record and may resume a saved session by
  its ID; nothing stays open waiting. No pre-code or serial concurrence stages. One
  formal correction; later findings fix forward. Majors require specific correction
  checks before release.
- Verify each routine fact once and name verifier/evidence in the normal report.
  Consumers reuse it; fresh native/claim/source/CAS checks remain at mutations.
  Keep the existing watcher and immutable receipts.
- Replies, status and milestones go to the owning item/run record as notes or the
  report. Routing policy: routine notices go to the line and recorded owner
  through existing callbacks, never to a chat. Legacy line-service launches can
  still use `--to brain-chat`, and `supervisor/line-notice-aggregate.mjs` still
  selects brain-chat notices. ENG-939 owns the runtime migration; these
  instructions alone do not activate it. Exceptions go to the PROJECT SUPERVISOR
  at its recorded address, using the brief's durable supervisor-inbox command before
  native input (`--project-supervisor`); record the exception on the item/run too.
  Never send exceptions with a direct `herdr agent prompt`. Missing supervisor
  bindings stay pending under the original notice ID. A native input refusal
  stops that effect: preserve it, no retry/alternate executor/identity substitution.
  Other independent work continues.
- Operator messages use the owning record's messages send: plain headline,
  explanation, action (usually Nothing needed), then one Details line for codes.
  Only a genuinely reserved pending human question pushes once; digest is pulled.
  Use [messaging](messages/README.md) for the supported source entry.
- One operator chat writes requests and authority directly to the record for the
  owning decision/engineering session. The operator selected Quiet Chat (w3PD:p4)
  on ENG-933: genuine operator questions only, one short message with a
  recommendation; status, milestones, logs and FYIs stay in the record. ENG-939
  owns applying that choice through the supported native routing path; this
  instruction does not activate it. The retired brain-chat binding is not a
  delivery fallback. Preserve saved callbacks, watchers and original pending,
  refused or uncertain deliveries; do not replay them or add a chat relay.
- Until standing sessions retire, their owners prepare a short recorded handoff
  around **200K context tokens** and recycle at a verified safe boundary. Include
  active work, decisions, unresolved deliveries, watcher/job owners and next steps.
  Token count alone authorizes no reset; preserve live work and callbacks. See
  [slot handoffs](supervisor/README.md#slot-handoffs-and-safe-point-observations).

## Boundaries

The core never calls a model or runs a background loop; services run the line.
Status derives from events, budgets are advisory, older folds ignore new events.
Do not restart services/watchers or edit saved runtimes/pins. Only the canonical
supervisor starts housekeeping or releases. Routine runtime updates use landing
checks, with full coverage and per-candidate live acceptance explicitly UNRUN;
they may activate with the existing rollback and pin separation. Full coverage
runs once before a stable release that a consumer project adopts, reusing valid evidence and
rerunning only failed, affected or unrun controls. Actual live acceptance of that
stable candidate and corrected Majors precede stable adoption. Publishing, secrets,
funds and adoption retain their actual outward/native checks.
Use [decision routing](supervisor/DECISION-ROUTING.md) for judgment boundaries.
Automatic main-health reverts start only after Phase 2 is implemented; until then
real failures are fixed forward. These instructions alone authorize no pipeline
code changes.

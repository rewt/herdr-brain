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
  `node lanes/lane.mjs promote TOPIC --expected-head FULL_SHA`.
  Rebase moved main in your lane and capture the resulting head; then report.
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
  about30-minute planning target, zero reviewer suites. When a worker report is in, close its session and remove its worktree folder in the same step; delete its branch only if it is already on main, otherwise keep the branch so a fix can continue from it, and keep the folder only if it has unsaved changes. Reviews and fixes start fresh from the record and may resume a saved session by its ID; nothing stays open waiting. No pre-code or serial concurrence stages. One
  formal correction; later findings fix forward. Majors require specific correction
  checks before release.
- Verify each routine fact once and name verifier/evidence in the normal report.
  Consumers reuse it; fresh native/claim/source/CAS checks remain at mutations.
  Keep the existing watcher and immutable receipts.
- Replies, status and milestones go to the owning item/run record as notes or the
  report. Routine notices go to the line and recorded owner through existing
  callbacks, never to a chat. Exceptions go to the PROJECT SUPERVISOR at its
  recorded address, using the brief's durable supervisor-inbox command before
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
supervisor starts housekeeping or releases. Full final-release coverage, actual
live acceptance and corrected Majors precede activation. Publishing, secrets,
funds and adoption retain their actual outward/native checks.
Use [decision routing](supervisor/DECISION-ROUTING.md) for judgment boundaries.
Automatic main-health reverts start only after Phase 2 is implemented; until then
real failures are fixed forward. These instructions alone authorize no pipeline
code changes.

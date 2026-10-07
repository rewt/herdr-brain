---
run: R-308
outcome: done
summary: |
  Implemented the operator-approved default-deny steward policy with per-launch
  Claude PermissionRequest HTTP hooks and native Codex command hooks. Only proven
  Claude file reads inside the verified project can be approved; every other
  request is declined with a record-ask nudge, and never-list requests alert.
  Added private argv-only iMessage alerts alongside the local notification,
  durable decision audits and circuit breakers, and fixed all four ENG-251
  findings. Focused offline tests pass; operator alert setup and native hook
  trust remain operator actions, and no live setup alert was sent.
headline: The steward can resolve permission requests safely and keep later supervisor blocks visible
blockers: []
proposals: []
learnings: []
artifacts:
  - "Implementation commit: 158405e (lane/steward-policy)"
  - "brain/lib/permission-policy.mjs"
  - "brain/lib/permission-audit.mjs"
  - "brain/lib/permission-fallback.mjs"
  - "supervisor/permission-hooks.mjs"
  - "brain/bin/steward-imessage.mjs"
  - "brain/README.md"
  - "node --test brain/test/permission-policy.test.mjs: 8 passed"
  - "node --test brain/test/steward.test.mjs: 26 passed, plus 2 additional focused alert/setup cases passed"
  - "node --test discovery/test/native-sandbox.test.mjs supervisor/test/entry.test.mjs: 103 passed, 3 optional native probes skipped"
  - "Native Codex 0.161.0 offline app-server config/read: per-launch PermissionRequest hook accepted, 1 passed"
  - "Final exact-screen fallback check: 1 passed"
decisions:
  - text: "Use the approved native-read class only; never approve shell commands, MCP tools, search/glob traversal, persistent permission updates or native hook trust."
    category: security
    why: "The operator approved only read-only tools on resolved project paths; a shell command cannot prove that property."
  - text: "Keep the fsynced decision audit in Brain state and leave record questions to denied sessions through record ask."
    category: design
    why: "Brain never writes record events directly; the native denial and the durable terminal nudge tell the session to record its question via the CLI."
questions: []
challenges: []
---

Implemented the approved decisions on ENG-245 and the alert fixes assigned from
ENG-251. The policy resolves fresh Git common-directory identity and filesystem
paths before approvals. Only Claude's built-in Read of an existing regular file
in its checkout, project lanes, record or this launch's private temp can pass.
Foreign projects, sibling run temps, unresolved targets, credential aliases,
shell commands, Codex Bash/apply_patch/MCP requests and unknown tool inputs deny.
Never-list decisions carry the action category, a record-ask nudge and an alert.

Claude uses a launch-owned authenticated loopback PermissionRequest HTTP endpoint;
its launcher awaits readiness. Hosts refusing loopback use the identical command
protocol. Codex uses a stable PermissionRequest command, with the launch binding
in the environment so each random temp path does not create a new trust digest.
Native hook trust remains the operator's responsibility. Registration lives in
its own module; session-hooks.mjs only exports it, preserving the parallel
question-hook edit surface. Native question/lifecycle hook groups are retained.
No persistent native settings or trust files were written. Existing native
execpolicy prohibitions remain in place; no shell allow-prefix rule or permission
amendment is generated because no shell approval class is permitted.

Permission receipts are fsynced before returning a native decision, capped at 512
events plus 128 launch circuit counters. Three identical read approvals or 32
approvals in one launch open the circuit and return a denial. Never-list alert
attempts consume durable caps/debounce receipts before channel execution. A broken
audit, binding or configuration cannot grant a request. Record question creation
is explicitly left to the denied session through record ask; no product code in
this change appends events.jsonl.

The terminal fallback declines only the exact captured four-option Claude
outside-read request. It requires session/terminal/pane identity, fresh exact
screen comparisons and repeated occupant checks. The recording nudge is durable
before key 3; persistent allow/block options are never selected. A consumed key
intent is not retried after a lost acknowledgement. Unknown dialogs and native
trust review remain on the existing route/alert path rather than receiving an
invented key. Hooks apply to new native launches, not existing native processes.

Both alert channels receive only project/session/kind, as one literal JSON argv
argument. The recipient is operator-local steward.json configuration. The
bundled Messages helper uses fixed AppleScript and separate recipient/message
arguments. Independent channels have ten-second deadlines. The operator runs
`node brain/bin/brain.mjs steward --test-alert` once and grants Messages Automation;
development exercised fake channels only. No live iMessage, notification, model,
service activation, publishing, promotion or project housekeeping was performed.
Bch-cloak was not modified.

ENG-251 resolved:

- Alert caps are per captured block/notice episode, with occupant debounce. The
  regression exhausts a stalled supervisor cap and verifies its later block alerts.
- Retired alert receipts have seven-day/newest-256 retention. Saturated retired
  history compacts and routing continues; genuinely corrupt/full journals refuse
  effects and attempt a separately receipted operator failure alert once per day.
- Non-fleet sessions wait the stall threshold before unresolved-route alerts.
- Routing Git identity lookups use a 30-second, 512-entry cache. Approval checks
  deliberately bypass that cache and resolve fresh identity.

Validation was offline and limited to changed behavior and launch integrations.
The two HTTP-specific cases initially hit the workspace sandbox's loopback bind
restriction, then passed with local-listener permission; the complete eight-case
permission file also passed there. The launcher tests passed in the workspace
sandbox using the command-hook fallback. The installed Codex app-server was used
only for config/read, never a model turn. Optional live/native boundary probes
were not enabled. Alert setup, privacy, independent channel failure and exact
screen/occupant changes are covered by fake transports.

The report is checked and committed before the final lane check, as requested.
The final gate receipt belongs to the report commit; the terminal run result is
reported separately so recording it cannot invalidate that gate's commit.

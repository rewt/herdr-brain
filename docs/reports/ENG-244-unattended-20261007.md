---
run: R-307
outcome: done
summary: |
  Added a model-free per-launch question guard for Claude AskUserQuestion and Codex request_user_input. Operations and dispatched workers deny blocking questions with record-ask, safe-default and continue instructions; project chats and explicitly combined chat/ops sessions ask normally until macOS idle reaches fifteen minutes, the screen locks or presence is unknown. Launch receipts retain conversation kind for restore, and worker guards override inherited chat metadata. Focused offline checks passed. Implementation is committed; this report is checked and committed before the required final lane check.
headline: Unattended sessions can record questions and continue instead of opening blocking dialogs.
blockers: []
proposals: []
learnings:
  - ENG-248 has landed in this lane's base. Project chats still use the supervisor workflow role and carry MONITOR_SESSION_KIND=chat; that explicit launch kind distinguishes chat from ops.
  - The current macOS IOConsoleUsers entry omits IOConsoleSessionScreenIsLocked when unlocked. Presence requires one logged-in console session matching the process user; unreadable or ambiguous state defaults away.
  - Native bypass launches are the path used by dispatched and headless workers, so registration only in fresh workflow entry would miss autopilot-started sessions.
artifacts:
  - 'Implementation commit: 378c9e8 on lane/steward-unattended'
  - supervisor/unattended.mjs
  - supervisor/operator-presence.mjs
  - supervisor/test/unattended.test.mjs
  - supervisor/test/entry.test.mjs
  - discovery/test/native-sandbox.test.mjs
  - docs/reports/ENG-244-unattended-20261007.md
  - '/tmp/R-307-unattended-tests.tap: 6 passed, 0 failed'
  - '/tmp/R-307-native-tests.tap: 1 selected case passed, 0 failed'
  - '/tmp/R-307-entry-tests.tap: 12 selected cases passed, 0 failed'
  - '/tmp/R-307-entry-launch-tests.tap: 8 affected launch cases passed after the final effective-environment adjustment, 0 failed'
decisions:
  - text: Register a question-only native PreToolUse denial through session-hooks, with policy and presence in separate modules.
    category: tooling
    why: Implements the operator's unattended-mode decision and keeps the shared registration edit small for the parallel permission-hook slice.
  - text: Default operations and unknown presence to record-and-default; retain explicit chat and combined kinds in the existing canonical pane launch binding.
    category: tooling
    why: A blocked dialog can strand overnight work; explicit launch identity survives restore without making display metadata authoritative.
questions: []
challenges: []
---

Read ENG-241 and ENG-244, the handoff, run context, session launch hooks and
supervisor/discovery/brain guides. ENG-248 is present: chats launch as supervisors
with `MONITOR_SESSION_KIND=chat`. `combined` is the corresponding explicit launch
kind for a supervisor that still hosts the operator's conversation. Unmarked ops
supervisors and bypassed workers use operations policy. Hook selection uses the
child's effective launch environment, so a fresh explicit supervisor launch can
override inherited worker flags while a dispatched worker cannot inherit a chat
exception. Restored chat kind comes only from a verified canonical launch receipt;
old, missing or stale receipts default to operations.

The hook denies the question tool, tells the model to record each question with
an action category, recommendation and reason without `--wait`, and continue safe
independent work. Funds/chain, publishing, credentials and permission expansion
default to no. A recommendation does not answer an operator question or authorize
the dependent action. If recording fails, retain the question in the report.
The hook never writes record events, grants permission, starts a daemon, chooses
an operator answer or modifies persistent settings/trust. Per-launch settings
retain Claude's supplied hooks, SessionStart and sibling-lane guards. The new
offline policy tests are included in the promotion tier.

Presence is re-read for each conversational question using absolute, bounded
`ioreg` commands. Tests cover 899/900-second boundaries, lock, unreadable and
malformed output, wrong users, ambiguous console sessions, timeout/read failures,
non-macOS, and return to normal asking. An initial malformed-session fixture found
an overly permissive parser; the parser now rejects unmatched session structure.
Additional checks cover both native denial payloads, path quoting, no record
writes, worker bypass, fresh launches, restored chat identity, resume/continue,
headless supervisor guards, and native settings merging. These checks are offline
and call no model. The test runner reported a sandbox-denied process-snapshot
cleanup diagnostic on one native fixture run; the selected case passed and no
signal was sent. `git diff --check` passed.

Claude's [PreToolUse contract](https://code.claude.com/docs/en/hooks#pretooluse-decision-control)
explicitly covers AskUserQuestion denial. Codex receives a matching per-launch
PreToolUse hook for its blocking `request_user_input` local function; the
registration follows the documented [local function hook contract](https://learn.chatgpt.com/docs/hooks#tool-coverage).
That documentation warns that specialized paths may opt out. The offline checks
prove the generated matcher and native hook command protocol, not that a live
Codex question invocation reaches this hook. The async question channel remains
nonblocking and is not matched. Native hook trust review, disabled hooks and
managed restrictions still apply; no trust records were changed or approvals
bypassed. A native proving check belongs to release acceptance, not this lane.

Read bch-cloak's native settings and `scripts/lane/launch-supervisor.mjs` only.
Its launcher delegates to the activated release's compatibility settle-watch
path. No bch-cloak file, pane or session was changed. Existing sessions are not
retrofitted and existing dialogs are not dismissed; adopting the updated adapter
and the explicit combined launch kind belongs to bch-cloak's release-gated switch.
The compatibility path, flags and behaviour remain intact.

The final `node lanes/lane.mjs check` runs after the checked report commit, as
requested. Its result is retained by lane validation rather than claimed in this
pre-check report. No promotion, push, release suite, live acceptance run or
project-wide housekeeping loop was performed.

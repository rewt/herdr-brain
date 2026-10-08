---
run: R-322
outcome: done
summary: |
  Rebased the reviewed steward-policy lane onto main, preserving role-based
  grants, the question guard and contender-safe notice-lock release/recovery.
  Claude launches, passthrough and resumes now compose permission and question
  hooks in one settings argument; Codex retains both event hooks. Denial alerts
  start in the decision worker immediately after their durable receipt, and
  approval receipts require acknowledgement of emitted allow output. Credential,
  secret and seed-phrase data files deny with alerts while source/docs stay
  readable. All seven requested files passed their assertions; the runner found
  a hanging-alert fixture teardown leak, which was fixed and verified by a clean
  17-test permission-policy rerun. The final lane check runs those same seven
  files against the clean report commit and supplies the final gate evidence.
headline: Steward permission hooks compose safely and preserve alerts through timeouts
blockers: []
proposals: []
learnings: []
artifacts:
  - "Implementation commit: 27db9cdc8ae8785edb4f3407cf37448d415faa13 (lane/steward-policy)"
  - "brain/lib/permission-policy.mjs"
  - "brain/lib/permission-audit.mjs"
  - "supervisor/permission-hook.mjs"
  - "supervisor/permission-hooks.mjs"
  - "discovery/native-sandbox.mjs"
  - "supervisor/notice-lock.mjs"
  - "brain/test/permission-policy.test.mjs"
  - "discovery/test/native-sandbox.test.mjs"
  - "brain/README.md"
  - "Focused seven-file run: 183 tests, 178 passed, 0 failed assertions, 5 explicitly skipped native-binary checks; runner rejected the surviving hanging-alert fixture."
  - "Clean permission-policy rerun after fixture teardown fix: 17 passed, 0 failed, 0 skipped; runner exit 0."
  - "docs/reports/ENG-245-steward-policy-R-322.md"
decisions:
  - text: "Apply the requested final correction while retaining main's role grants, question policy and safe notice-lock ownership handling."
    category: security
    why: "The handoff explicitly authorizes hook composition and the two never-list fixes on the reviewed policy lane."
questions: []
challenges: []
---

Completed the four requests in the final handoff. The rebase kept main's Claude
adapter and session-hooks module unchanged. Notice-lock differs from main only
in its optional absolute deadline and unscaled wait propagation; removeOwner
release and dead-owner recovery retain main's contender-safe implementation.
No role-grant, chat, coordinating Codex preflight or question-guard behavior was
replaced. No push, promotion, project housekeeping loop or release suite ran.

The permission hook is added in nativeSandboxLaunch, shared by normal adapter
launches, native passthrough and interactive resumes. Claude's existing merge
folds it together with PreToolUse and applicable SessionStart hooks into the
single final settings file. Existing native hooks and question matchers survive.
Codex adds hooks.PermissionRequest alongside hooks.PreToolUse, including when
the operator selects a native policy instead of generated worker confinement.
Its trust fingerprint stays stable and native hook trust is never bypassed.
Tests cover a supervisor with and without project entry hooks, composed operator
hooks, inherited-role interactive resumes and headless/passthrough paths.

auditPermission invokes the alert starter immediately after file and directory
fsync, before releasing its lock. The decision worker spawns the detached,
argv-only child there; the watchdog no longer owns notification delivery. A
post-audit blocked lock release cannot consume debounce and then drop the alert.
All alerting decisions remain denials. A fault-injection test holds lock release
past the eight-second deadline and proves the durable alert starts even though
the worker is killed and the native output denies.

Allow decisions reserve circuit capacity with pending receipts. The parent
acknowledges only after its native allow output has been written successfully;
the worker then confirms the approval under the audit lock. A watchdog denial
leaves a pending reservation, zero approvals and no allow event. Interrupted
confirmations remain conservative reservations and still count toward the
32-grant cap. Confirmation cleanup gets at most one additional second after the
decision has already been emitted, within the native hook's 15-second timeout.
The corresponding fault-injection test proves an overrun after durable audit
cannot leave a false approval; ordinary emitted allows confirm normally.

Resolved credential-store matching remains intact. Credential-, secret- and
seed-phrase-named files with json, yaml, yml, toml, txt, p12, pfx, jks or keystore
extensions deny and alert. The restored credentials.json and seed-phrase.txt
cases pass, along with every listed data extension and a symlink alias.
wallet.tsx and wallet.mjs still allow without alerts; source and documentation
credential names also remain safe reads.

Only the requested permission-policy, steward, native-sandbox, supervisor entry,
unattended, notice-lock and control-socket test files ran. Before changing main's
native-sandbox test, its unmodified main version passed with the offline runner;
an initial sandbox-restricted attempt could not create local fixture sockets.
The seven-file run had no failed assertions but its runner correctly rejected a
surviving hanging-alert fixture. Its earlier scratch teardown had deleted the
PID marker before the kill callback. Teardown now retains both owned alert PIDs
in memory, and the isolated permission-policy rerun passed with no survivors.
The final lane check uses an explicit seven-file command, avoiding the default
fast tier and all promotion/release/live tests. Its GATE output and .lane/gate.json
are the final result; this report is checked and committed before that check.

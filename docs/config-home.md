# Configuration and adoption

Run `record config` in a project to inspect effective policy, its scope, exact
source file/key and effect. `--json` also includes the type/default reference.
The [binding contract](contracts/CONFIG-HOME.md) and its reader table describe
source precedence and the existing domain references describe nested keys.

Home files win one whole file at a time. Missing unpublished files retain their
own legacy fallback. Invalid or unexpectedly missing published home files hold
the project. Linked worktrees share canonical policy and its original path bases.
Legacy fields `entry`, `chat`, `always_args`, `host_suites` and `tier_suites`
retain their documented no-effect treatment.

`record config set dispatch.max_sessions 8 --who-asked R-123` changes a project
override. `validation.fast`, `promote.max_batch`, `housekeeping.enabled` and
`pin.release` select their separate files; lane keys retain their existing names.
Use `--scope identity` explicitly for shared defaults, literal argv `launch`,
canonical `project_access` grants and `brain_write` consent. Brain edits no
native sandbox, credentials, trust or Git identity. The optional argv prefix
precedes the owner's `herdr agent start` command, in the project directory;
launch snapshots preserve it. Prefix words are never shell expressions.

`record config history` reads the existing project record. Identity history uses
`record config history --scope identity` and one identity `.org/` record. Owning
reads, including session inspection, setup diagnostics and planning, audit hand
edits before changed policy is consumed. Invalid bytes are recorded as a marker
and digest, never raw input. An unresolved file/audit pair holds effects; retry
the original command. Reads never start a model, pane action or schedule.

Adoption is an owner operation from the canonical checkout. First run
`record adopt . --inspect --expires <ISO-date>` in the native supervisor. It
saves the exact scope and presents migration sources. Before enrollment, the
workspace owner/operator answers a human record question whose
`meta.adoption_authorization` contains that scope unchanged. Then run
`record adopt . --scope <saved-file> --decision <question-id>:<answer-sequence>`.
An explicit separate routing declaration uses `--routing <source-file>` during
scope capture. The command observes only: it does not prompt, spawn, close,
rename, reset or resume anything. Setup continues to expose all other holds.
`sessions authorize` remains separate and retains its original action list.

Every repo source remains readable. `config` and `adopt` warn when a home file
differs from its retained repo copy and name both paths. `config set` also warns
that project scripts reading repo files will not see the change. Retained copies
are rollback policy, not synchronized mirrors. Owners drain conflicting old
writers before adoption and follow the contract's explicit rollback procedure;
new launchers refuse a release without home support and READY acceptance.

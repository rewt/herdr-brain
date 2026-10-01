---
run: R-47
outcome: done
summary: |
  Fixed both independent review findings. Live schedule startup now refuses linked-worktree script or record-CLI code and linked target checkouts; AGENTS.md and the supervisor/module guides restrict startup to the supervisor in the canonical checkout. Lock owners record the resolved script and record CLI paths, and missing, different or legacy runtime identities cannot report already-running. Replaced the interruption banner regex with a linear row scan and added the forty-blank-row old-banner regression. Offline tests pass; no real panes or production schedules were changed.
headline: Housekeeping startup now uses stable code and interruption checks cannot hang
blockers: []
proposals: []
learnings:
  - "Canonical project discovery alone does not make the executable stable: a detached loop can still import its script and record CLI from a removable linked worktree. Startup must check both code provenance and the target checkout."
  - "An existing live PID is insufficient for idempotent startup: the lock must identify the script and record CLI, verify their paths still exist, and match the requested runtime."
  - "The former banner regex timed out after one second on the old interruption plus forty blank rows and later final-reply fixture; the replacement drops blank/feedback rows and checks the last remaining row without multiline backtracking."
artifacts:
  - "Commit: Guard housekeeping startup and scan interruption banners linearly"
  - "housekeeping/housekeeping.mjs"
  - "housekeeping/test/housekeeping.test.mjs and housekeeping/test/fixtures/old-interruption.txt"
  - "AGENTS.md, housekeeping/README.md and supervisor/KICKOFF.md"
  - "docs/reviews/housekeeping/9998467-r1.md preserved unchanged as review evidence"
  - "Baseline npm test: 355 passed, 0 failed, 1 explicit skip"
  - "After-change npm test: 368 passed, 0 failed, 1 explicit skip; includes 53 housekeeping tests"
  - "git diff --check passed; final lane check runs after this report commit"
decisions:
  - decision: Refuse live startup from linked worktree code instead of silently re-executing another checkout's script.
    why: A worker's checkout must not install unreviewed code as the project schedule. Refusal makes the runtime choice explicit while allowing the supervisor to use canonical code or an installed plugin/release without project configuration.
  - decision: Apply the provenance guard to both --start and --loop, including a record CLI override, and require a canonical target checkout.
    why: Guarding only the detached wrapper leaves a foreground-loop bypass or a removable record executable. Lane workers retain isolated --once --dry-run previews.
  - decision: Include resolved script and record_cli paths in lock ownership and refuse mismatched, missing or legacy runtime identities.
    why: Later callers must not mistake a surviving PID running removed lane code for a healthy matching schedule. Refusal preserves the old lock and never kills an existing process; the supervisor can inspect and stop it before restarting.
  - decision: Recognize a current interruption by scanning backward through trailing blank and feedback-hint rows, then checking one banner row.
    why: This preserves the current-banner distinction while making processing linear in the visible screen size and avoiding synchronous lock-holding hangs.
questions: []
challenges:
  - premise: Every entering lane agent should start the default project-wide schedule.
    verdict: wrong
    evidence: The review identified removable unreviewed lane code being pinned into a live timer. AGENTS.md now explicitly says only the project supervisor in the canonical checkout starts it, and lane workers must never use --start or --loop. Default discovery and optional overrides remain unchanged.
  - premise: The current-banner multiline regex safely rejects an old interruption above a final reply.
    verdict: wrong
    evidence: A bounded offline reproduction timed out on the requested forty-blank-row fixture. The linear replacement rejects that fixture in the bounded regression subprocess while continuing to accept a current banner with a feedback hint and wheel-only composer.
---

## Per-finding results

1. **Major — removable lane runtime and overly broad startup instruction: fixed.**
   The startup guard resolves the script and record executable paths and checks
   whether they belong to a linked Git worktree. Live `--start` and `--loop` refuse
   that code before creating state, acquiring a lock, spawning a schedule or
   invoking Herdr. A linked target checkout also refuses live startup even when
   the executable is canonical. Installed copies outside Git are supported.

   `lock/owner.json` now stores `script` and `record_cli` alongside its existing
   project/record/config/PID identity. Existing owners with missing paths,
   differing runtime paths or no runtime identity refuse instead of returning
   `already-running`. The old lock is preserved and no owner is killed.
   The detached child receives the same resolved script and record override that
   were validated and recorded.

   Regression tests cover linked script and linked target refusals for both
   modes, a record CLI override inside a lane, dry-run preview support, and all
   five missing/different/legacy owner cases using a live test PID. Positive
   tests start canonical and installed-copy runtimes, remove an unrelated lane,
   verify the runtime paths still exist, confirm idempotent startup, and stop
   through the optional configuration override. All use disposable Git
   repositories and fake Herdr/record executables.

   `AGENTS.md` explicitly limits live startup to the project supervisor from the
   canonical checkout and prohibits lane workers from starting the project-wide
   loop. The module and supervisor guides carry the same instruction.

2. **Minor — exponential banner backtracking: fixed.**
   `interruptedComposer` now scans rows before the composer backward, discards
   trailing blank and feedback-hint rows, and tests only the last remaining row
   for the interruption banner. Its existing wheel-only composer and wrapped
   input protections remain in place.

   The tracked `old-interruption.txt` fixture contains an old banner, forty blank
   rows, a later final reply and wheel text in the composer. A regression runs
   the actual parser in a subprocess with a two-second bound and requires
   `false`. A separate bounded reproduction of the original regex on the same
   fixture timed out after one second. Existing current-banner cases and a
   separate feedback-hint case still pass.

Both fixes are in **Guard housekeeping startup and scan interruption banners
linearly**. The supplied public review copy is preserved unchanged and committed
with this report so the final lane check has a clean tree and retains its source
evidence.

## Verification and operation

Ran `npm test` before edits: **355 passed, one explicit skip**. Ran it after the
fixes: **368 passed, one explicit skip**, including all **53 housekeeping tests**.
The earlier focused housekeeping run passed all 52 tests then present; the full
suite also verifies the added installed-copy startup case. `git diff --check`
passed. Tests remain offline and make no model calls.

After review and promotion, the supervisor should run
`node housekeeping/housekeeping.mjs --start` from the canonical checkout using
that checkout's code or an installed plugin/release. No project-specific
configuration is required. If a prior owner predates runtime identity or points
at removed code, inspect its owner record and logs, stop that schedule, then
remove its stale lock before restarting. This run did not start or stop a real
project schedule, close/resume/type into real panes, or modify bch-cloak, shared
lane configuration, releases, launchd or local binaries.

The report is validated with `record check` and committed. `node lanes/lane.mjs
check` is the final command after that commit; it validates the clean final lane
HEAD and writes its result to ignored `.lane/gate.json`. Existing console and
installed-agent discovery follow-ups remain ENG-75 and ENG-76; no duplicate
proposals were added.

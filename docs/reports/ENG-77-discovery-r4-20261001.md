---
run: R-55
outcome: done
summary: |
  Fixed all three round-three discovery review findings. Untouched-lane cleanup now includes ignored files and compares commits against the creation base; retained lanes print their reason and Git removal never forces. Both adapters forward SIGHUP, register the native PID before allowing execution, and recover stale untouched entry lanes on the next entry using fresh ownership, Git and record checks. Symlinked homes and operator worktree-root prefixes resolve before no-follow creation. Required suites and native sandbox verification pass. Installed smoke cases 02–04 pass; no new live-agent or release acceptance result is claimed.
headline: Discovery preserves local files and recovers interrupted entry sessions
blockers: []
proposals: []
learnings:
  - "Git worktree remove accepts ignored files without force; cleanup must inspect git status with ignored and untracked-files=all before treating a lane as untouched."
  - "The creation base must remain the cleanup reference: later integration of a lane's commits must not make that lane eligible for untouched-lane deletion."
  - "A native child can outlive its parent. Launch must wait for its ownership receipt, then exec in the same PID, so crash recovery cannot delete a lane under an unregistered agent."
  - "Resolve the operator home and existing worktree-root prefix before no-follow creation; agent-writable descendants still require the hardened boundary."
artifacts:
  - "Commit: Preserve ignored lane files and recover interrupted project entry"
  - "Commit: Report discovery lifecycle recovery and root compatibility verification"
  - "Branch: lane/discovery"
  - docs/reviews/discovery/0b4ad8e-r3.md
  - discovery/README.md
  - discovery/lifecycle.mjs
  - discovery/session.mjs
  - discovery/test/lifecycle.test.mjs
  - lib/files.mjs
  - "/private/tmp/eng77-r55-evidence-NkhWqc/summary.json"
  - "/private/tmp/eng77-r51-evidence-oFdxBU/R-49-raw"
decisions:
  - decision: Require file-free checkout state, no run and no commits beyond the original base before non-forced lane cleanup.
    why: Ignored configuration and notes are real local work. Git's ordinary cleanliness check and current integration ancestry cannot prove an entry lane is untouched.
  - decision: Recover stale creation receipts in the foreground under coordination and record locks.
    why: SIGKILL and crashes bypass close handlers. Protected creation controls identify candidates; fresh process, Git and complete record facts decide retention. Display-only session metadata is never consulted.
  - decision: Record queue paths before creation and native ownership before execution.
    why: Interrupted setup must leave enough information for recovery, and a native child must never begin work before its PID is durable. A launch gate waits, then execs the native binary in that same PID.
  - decision: Resolve only operator-selected root prefixes before entering the no-follow filesystem boundary.
    why: Symlinked homes and configured roots are legitimate operator choices; agent-created redirects below those roots remain refused.
questions: []
challenges:
  - premise: A clean Git status without ignored files proves an entry lane can be deleted.
    verdict: wrong
    evidence: Ignored .env and .lane notes survive close and stale recovery; retention prints a reason. A committed lane remains even after its commits are integrated, because it contains work beyond its creation base.
---

All three findings from the review of **Report discovery path compatibility and
entry cleanup verification** are addressed by **Preserve ignored lane files and
recover interrupted project entry**. This report is committed as **Report
discovery lifecycle recovery and root compatibility verification**.

| Finding | Result and regression evidence |
|---|---|
| Ignored local files | Cleanup uses porcelain status with untracked-files=all and ignored, plus the original creation base. Ignored .env and .lane notes remain with a retention message. Modified, untracked, committed and already-integrated work remains. Git removal never forces. |
| Hangup and crash recovery | SIGHUP reaches both mock native clients through the real adapters; exit removes untouched lanes, queues and Git metadata. Next entry sweeps killed owners under locks and retains live parents/children and recorded work. Killing a parent during ownership handoff cannot start an unregistered native process. Stale inspection also refuses executable Git filters before status. |
| Symlinked roots | A child process with symlinked HOME uses the real default root. An explicit linked root with multiple missing directories resolves its existing prefix and creates its lane successfully. Existing agent-symlink refusal and operator-record compatibility regressions stay green. |

Verification used unrelated scratch projects outside repository trees, with no
model calls or live Herdr pane mutations:

| Check | Outcome |
|---|---|
| Baseline / final npm test | 392 / 399 passed; both 0 failed, 2 expected skips |
| npm run test:lanes | 146 passed, 0 failed, 0 skipped |
| New lifecycle regressions in final npm test | 7 passed |
| Installed-shim dispatch regression after launch change | Passed |
| Explicit native Codex sandbox regression | Passed: validation, promotion, conflict recovery, outside-write and linked .git write denial |
| Installed-product smoke | Cases 02–04 passed; 20/21 pending with --skip-live, hence intentional exit 1 |

These checks ran on Darwin; no Linux host run is claimed. R-52's real discovery
results remain historical, and the read-only release harness has a round-three
NEEDS-WORK review. This run makes no new live-agent or release acceptance claim.
Unknown, invalid or unreceipted worktrees are preserved. Existing follow-on items
cover machine installation, native Herdr interception and real Claude coverage.

Only summaries remain in repository evidence. Current raw logs and summary.json
are in `/private/tmp/eng77-r55-evidence-NkhWqc`; the summary names the separate
installed snapshot and scratch-project evidence paths. Historical attempt-1..4
raw evidence remains at `/private/tmp/eng77-r51-evidence-oFdxBU/R-49-raw`.

The report is checked with the record CLI before its commit. Lane check follows
as the final command; `.lane/gate.json` records the committed HEAD. No push,
release activation, shared configuration change or housekeeping loop was run.

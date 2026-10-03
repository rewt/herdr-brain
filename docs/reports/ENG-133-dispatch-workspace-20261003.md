---
run: R-168
outcome: blocked
summary: |
  Implemented the missing-project-workspace dispatch fix and both review Minors.
  Targeted offline tests pass, and a real Herdr scratch project dispatches into
  one renamed agent tab with zero observed focus changes. The single permitted
  acceptance --skip-live pass remains red beyond dispatch; release acceptance
  cannot be claimed. A scratch TMPDIR defect found in that pass is now fixed
  and covered offline, but the full pass was not repeated.
headline: Dispatch works without a project workspace, but release acceptance remains red.
blockers:
  - Acceptance cases 06 and 08-13 time out waiting for notices because the scripted supervisor screen fails the production empty-composer check.
  - Acceptance case 07 encountered another lane's host test slot; case 27 observed a later focus change into an owned workspace without a correlated tooling call.
  - Case 23 failed scratch environment verification before the subsequent tested TMPDIR fix; the one-pass limit prevents a second acceptance execution in this lane.
proposals:
  - role: engineer
    title: Align scripted release acceptance with supervisor composer readiness and owned inbox cleanup
    why: The model-free stand-in returns a blank pane screen, which production correctly treats as unreadable. Cases 06 and 08-13 consequently time out despite successful dispatch and generated reports. Cleanup also left two receipted inbox owner workers, which this run stopped after verifying their live identities.
  - role: engineer
    title: Resolve release acceptance promotion contention and unattributed focus failures
    why: The single pass's queue fixture encountered the shared test slot, and its focus audit reported an owned-destination change with no nearby or correlated calls. Keep the focus safety assertion intact and determine the cause before claiming a green release candidate.
learnings:
  - Herdr worktree open accepts --cwd with the canonical checkout even when that project has no open workspace; dispatch must not require a parent workspace id.
  - Herdr PTY workers inherit the server environment rather than the acceptance runner's TMPDIR; scripted child dispatch must set TMPDIR to the scratch root.
artifacts:
  - '3102c26: unchanged independent review record, committed first'
  - '1161128: dispatch fallback, review regression tests, native scratch reproduction, scoped acceptance adapter'
  - '39026b4: tested supervisor TMPDIR confinement and retained acceptance evidence'
  - docs/reports/evidence/ENG-133/dispatch-red.tap
  - docs/reports/evidence/ENG-133/dispatch-green.tap
  - docs/reports/evidence/ENG-133/native-red.tap
  - docs/reports/evidence/ENG-133/native-green.tap
  - docs/reports/evidence/ENG-133/acceptance-offline.tap
  - docs/reports/evidence/ENG-133/acceptance-summary.json
  - docs/reports/evidence/ENG-133/acceptance-focus-summary.json
  - docs/reports/evidence/ENG-133/acceptance-dispatch-receipts.json
  - docs/reports/evidence/ENG-133/supervisor-tmpdir-green.tap
  - docs/reports/evidence/ENG-133/inbox-cleanup.json
  - 'LANE_HERDR_WORKSPACE_TEST=1 node --test lanes/test/workspace-native.test.mjs'
decisions: []
questions: []
challenges:
  - The acceptance pass is not a green gate. Dispatch succeeded in cases 06 and 08-13, but their notice/completion checks failed; isolated native dispatch focus evidence does not override the broader pass's focus failure.
---

Rebased onto main first (already current). Committed the supervisor's review
record unchanged before other commits. No shared Git configuration or excludes
were edited. Reviewed the final code diff against the ask and lane safety contract.

`ensureHerdrWorkspace` retains the existing verified parent-workspace path and
falls back to `worktree open --cwd CANONICAL_ROOT --path LANE --no-focus` when no
parent workspace exists. Identity validation, snapshot refresh, invocation-owned
initial-pane reuse, environment readiness, start, persistence and final rename
remain in order. It creates no extra lane tab for a POSIX shell.

The fake pane shell now has an independent input. Tests disagree with `SHELL` in
both directions and use an actual sh pid while an rc child occupies the reported
foreground, exercising `/bin/ps`. A rejected final rename exits 1 with the
partial-success diagnostic, retains exactly one recorded session/start/prompt,
and performs no replay, close or focus operation.

The acceptance adapter now admits receipt-owned tab renames and only the exact
private lane environment handoff. Offline checks reject foreign panes/tabs,
outside paths, symlinks, loose file permissions, altered source/verification
scripts, extra commands and changed cleanup targets. The scripted supervisor
TMPDIR fix keeps the same boundary for child dispatch.

Verification:

- Targeted dispatch regressions: 12 pass, 0 fail (other tests explicitly filtered).
- Targeted offline acceptance files: 82 pass, 0 fail; two adapter checks pass,
  including the subsequently added live-cwd confinement check.
- Environment validator: 8 pass; focus invariants: 2 pass.
- Native scratch reproduction: old CLI fails with the reported missing-workspace
  diagnostic; fixed CLI passes with one tab, one scripted agent start and zero
  observed tooling focus changes. No model was called. The native test skips
  explicitly under ordinary offline execution or when Herdr is absent.
- Subsequent scratch-TMPDIR regression: red before the fix; all 15 recovery tests
  pass after it.
- One `node acceptance/run.mjs --candidate "$PWD" --skip-live --keep` execution:
  9 pass, 10 fail, 3 pending, 5 skipped, exit 1. Summary and dispatch receipts are
  retained here. No live harness, baseline or repository full suite was run.

The acceptance run passed workspace cleanup with no workspace residue or copied
credentials. Its two detached inbox owner workers were stopped separately using
only durable scratch receipts and verified live process identities. The native
reproduction also closed its own scratch workspaces. An initial reproduction
used the default worktree destination; that exact test-created checkout was
verified and removed, and the retained reproduction explicitly confines all
worktrees to its temporary scratch root.

The report is checked with the record CLI before its commit. The final action
is the configured fast `lane check`; its exact-head gate receipt and log live in
the normal lane validation store. This report does not preclaim that result.

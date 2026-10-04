---
run: R-234
outcome: done
summary: |
  Fixed both independent-review findings. Shared entry lesson selection now matches literal filesystem paths without applying CLI selector restrictions, so bracket-bearing directories launch through both installed adapters with empty or populated lesson records. The release gate requires an interactive native UI to remain running across observations and rejects premature completion, including successful exit codes. All 15 focused offline regressions passed with no skips. The fixes are committed; after checking and committing this report, the final action is the focused lane check recorded below.
headline: Both entry adapters handle bracket directories and the gate rejects failed launches
blockers: []
proposals: []
learnings:
  - Literal filesystem entry paths can contain characters forbidden in lesson selectors; match supported lesson prefixes without validating the directory as a CLI selector.
  - PTY scrollback retains startup banners after exit; require interactive readiness and consult the completion receipt before accepting fresh entry delivery.
  - Fresh automatic-entry fixtures must clear inherited MONITOR_ENTRY_BYPASS, MONITOR_REQUEST_DIR and HERDR_INTEGRATION_ID or they can silently bypass entry.
artifacts:
  - "Implementation commit: 51af09c1bce4c60c7c2c2a9333d7c01e931b0524"
  - "Branch: lane/lessons-entry"
  - discovery/lessons.mjs
  - discovery/test/lessons.test.mjs
  - acceptance/lessons.mjs
  - acceptance/test/lessons.test.mjs
  - docs/reports/ENG-173-lessons-entry-R-234.md
  - "Final lane check: node lanes/lane.mjs check --cmd 'node test/helpers/run.mjs discovery/test/lessons.test.mjs acceptance/test/lessons.test.mjs mcp/test/server.test.mjs'"
decisions: []
questions: []
challenges: []
---

Resolved the two findings in `docs/reviews/lessons-entry/fdba420-r1.md`.
The inherited validation log had no failing tests; this correction adds the
missing negative coverage.

Entry reads the selected record's active lesson rows through the existing core
API, then matches their supported prefixes against the original literal entered
path in shared discovery code. Exact matches and longest matching ancestors
precede broad lessons, preserving scope/ID tie breakers and the existing bounded
renderer. Unrelated paths and module-only lessons remain excluded. The core,
adapters, supervisor and brain need no changes.

Installed-adapter regressions start both automatic commands in fresh offline
PTYs from `area/[slug]/deep`. With no lessons, native launch receives its ordinary
entry policy without a lessons section. With a populated record, it receives
ancestor, whole-tree and broad project lessons in order, excludes unrelated
lessons, and preserves the lesson events.

The release witness requires native branding plus an interactive prompt or
fresh-home setup choices, retained across observations for at least 250 ms.
It checks the completion receipt before and after screen reads and again before
accepting readiness. Any premature completion fails, whether exit code zero or
nonzero. Screens and completion receipts are retained as evidence. Cleanup still
stops owned sessions, closes their workspaces and releases producer receipts.
The existing native argument/policy receipt remains required.

Offline gate regressions use real installed entry adapters with native stand-ins.
Both Codex and Claude banner-then-exit cases at codes zero and one fail the gate
after receiving the planted active lesson. Prompt-then-exit cases also fail.
The successful interactive case and proposed-lesson rejection remain covered.

Validation before the implementation commit:

- `node test/helpers/run.mjs discovery/test/lessons.test.mjs acceptance/test/lessons.test.mjs`: 15 passed, zero failed, zero skipped.
- `git diff --check`: passed.

The macOS kernel/PTY regressions ran outside the enclosing agent sandbox because
it denies nested `sandbox-exec`. They stayed offline and used scratch projects
and fake native executables. Initial iterations exposed the sandbox restriction,
inherited automatic-entry bypass metadata, and an overly broad assertion about
normal entry routing bootstrap events; those fixture issues were corrected
before the passing run. MCP is unchanged by this correction; its eight offline
regressions are included in the final focused lane check.

No live acceptance harness or skip-live harness pass ran. Native UI compatibility
with the release candidate's real CLIs remains for the canonical release gate.
After the report is checked and committed, run the recorded lane check last and
stop; promotion and release validation belong to the supervisor.

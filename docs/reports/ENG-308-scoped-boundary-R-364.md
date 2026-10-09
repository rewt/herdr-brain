---
run: R-364
outcome: blocked
summary: |
  Investigated committed chat mode, installed read-wrapper protections, chat receipts, native sandbox launch and the installed Herdr CLI/schema. Arbitrary run/input into ordinary sibling shells bypasses a wrapper's tab checks because those shells execute outside the chat sandbox and can call raw Herdr. Committed a dependency-free offline counterexample and implementation prerequisites; production scoped mode and its native exclusion probe remain unimplemented pending confinement of target shells.
headline: Scoped chat control needs confinement of the shells receiving its input.
blockers:
  - The required read-only boundary outside the chat tab cannot be enforced by target checks while arbitrary commands and keystrokes reach ordinary unrestricted sibling shells. The exposed Herdr split/input interfaces provide no verified confinement contract for those shells, including existing wallet-host panes.
proposals:
  - role: architect
    title: Establish shell confinement before enabling scoped chat control
    why: |
      Define and supply an OS confinement boundary for root terminal shells and all descendants in scoped chat tabs, denying the unrestricted Herdr socket and protecting launcher/binding code. Cover creation, splits, presets and interruption back to the shell; specify migration or a bounded stop operation for existing wallet hosts. Then the scoped wrapper can validate caller birth/ancestry and live membership without allowing indirect foreign control. The offline counterexample in docs/reports/evidence/R-364 demonstrates the prerequisite; also require atomic membership validation with mutation or a documented server guarantee against target moves.
learnings:
  - Native Claude sandbox exclusions constrain the chat process, but input typed into another pane executes with that destination process's OS permissions. Sandboxing only pane run leaves send-text plus Enter as an equivalent escape route.
artifacts:
  - "7e1413b: Document scoped chat terminal input boundary blocker"
  - docs/reports/evidence/R-364/scoped-boundary.md
  - docs/reports/evidence/R-364/scoped-input-probe.mjs
  - docs/reports/evidence/R-364/scoped-input-probe.json
  - "node docs/reports/evidence/R-364/scoped-input-probe.mjs: passed four offline counterexamples and direct-target/own-pane refusal assertions"
  - "git diff --check: passed"
decisions: []
questions: []
challenges:
  - The ask assumes a sandbox-excluded wrapper can provide full command/input control inside the tab while maintaining read-only access elsewhere. Even perfect binding and direct target checks do not constrain the authority of an unrestricted destination shell.
---

The probe uses a pinned fake Herdr executable and actual shell children entirely
inside a disposable temporary directory. Direct close, run, send-text and
send-keys requests to foreign targets are rejected; the same close operation
issued through an allowed sibling's run or text/Enter succeeds. Both another
workspace and another chat's tab are covered. Own-pane input and close are also
rejected. This is a counterexample to the proposed boundary, not validation of
a production scoped wrapper. No live panes or wallet processes were touched.

The current full/read implementation remains unchanged and continues rejecting
the unsupported scoped configuration. No native probe, broad suite, promotion
tier, release tier, acceptance harness or host test slot was run. The required
final lane check will validate the clean committed report/evidence using the
targeted offline probe command.

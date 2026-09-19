# Determine whether terminal mouse focus is practical

This optional Phase 3 research brief accompanies the OpenSpec initiative. It is not
a proposed product capability and does not require an invented delta spec.

## Outcome

Run a time-boxed SGR mouse tracking experiment in a Herdr pane and record a go/no-go/defer recommendation. Ship no product mouse code or dependency.

## Repository context and authorization

Read `AGENTS.md`, `README.md`, `docs/REFERENCE.md`, `HANDOFF.md`, and
`openspec/README.md`, then the method below.
Follow the shared delivery rules in `openspec/README.md`.

Prerequisites: board-ux promoted; optional and not a dependency of idea-cli or idea-composer.
Contract approval: No product amendment beyond A4; only research and a public-safe report are authorized.

This is a dispatchable future engineering brief, not authorization to implement it
in the planning session. When dispatched by the operator, work only in the current
`lane/board-mouse` worktree; commit the authorized result; never push, publish,
promote, or close another lane. Do not edit the product contract unless the operator
has approved the exact amendment. One build/test at a time on the machine.

## Scope and limits

A public-safe report in docs/ and HANDOFF.md; disposable untracked prototype under .lane/ only.

No mouse product implementation, UI dependency upgrade, indefinite investigation, or prerequisite for the composer.

Suggested route: `engineer`. Suggested effort: Medium; hard two-hour wall-clock cap including write-up.
Use the route's configured agent/model; do not change routing defaults.

## 1. Lane-sized task

- [ ] 1.1 Deliver this change's outcome and all applicable scenarios; verify the checks below, write `docs/reports/board-mouse.md` and a dated HANDOFF entry, commit, then obtain a passing GATE against the final commit.

## Acceptance checks

Deliver the evidence matrix, measured time spent, go/no-go/defer decision, public-safe reproducible procedure, cleanup result, and a proposed follow-up scope only if GO. Observe at least one deliberate negative decoder/coordinate control when a prototype can run; otherwise state why no probe ran. The docs-only final suite count must equal its baseline.

This lane changes no product behavior; do not add artificial runtime tests for prose.
`npm test` must pass, `git diff --check` must be clean, and the complete diff must
contain no host-specific/private source text. All code tests are offline and clean
up system-temp fixtures. Preserve Node 20, git 2.38, and the dependency-free core.
Record skips precisely rather than reporting unexercised live behavior as passed.

## Handoff and promotion boundary

The report must list files/behavior, negative controls, test counts, measurements,
remaining limits, and any needed approval. Use a public-safe reviewed-SHA record in
`docs/reviews/board-mouse/` if an independent review is requested; review is never
an automated promotion gate.

After the final report/HANDOFF commit, run `lane check` and paste the exact GATE
line in the conversation. Keep that final line out of a new tracked commit.
The operator promotes independently using the unchanged validated fast-forward
workflow. Record the research outcome in the report; there is no product delta to
sync or OpenSpec change to archive for this research-only brief.

## Experiment method and decision rule

### Time box and method

Spend at most 30 minutes on installed Ink 5/Herdr capability inspection, 60 minutes
on an ignored disposable prototype, and 30 minutes on cleanup/report. Verify the
installed version; do not repeat the unqualified claim that every Ink version has
no mouse support. The current optional UI is pinned to Ink 5; do not upgrade it
for this experiment.

Probe basic press/release and SGR coordinates (terminal modes 1000 and 1006),
click-to-row mapping, pane offsets, scroll/resize, split Herdr panes, and restoring
terminal selection/clipboard behavior when tracking is disabled. Use explicit
caller context and only an authorized disposable test pane. Do not send input to
other agents or change another client's workspace. Always disable tracking and
restore raw/alternate-screen state on exit and interruption.

Evidence matrix: direct terminal vs Herdr pane; click coordinates; resize/scroll;
interference with text selection; keyboard operation while tracking; normal and
Ctrl-C cleanup. Sanitize captured bytes and omit all local paths/account/session
names. Synthetic decoder/hit-test negative controls belong to the disposable
experiment, not a new root runtime test dependency.

### Decision rule

GO requires repeatable correct targeting through Herdr, working keyboard fallback,
clean exit/interruption, and no unacceptable selection interference. Any failed
required check is NO-GO. No suitable TTY, missing Herdr, or expiry of the two-hour
cap is DEFER with the exact missing evidence. Every outcome completes this research
lane. A GO report proposes a separate reviewed implementation change; it does not
authorize shipping prototype code or block later phases.

---
run: R-22
outcome: done
summary: |
  Corrected every finding from the first independent review of the console design prototype.
  Session scrolling now keeps the selected row visible and clickable, task states use plain words,
  draft authorship and peek navigation are accurate, Delete input works, and the prototype source is readable.
  The generated design renders and snapshots were refreshed, with focused regression coverage for each behavior.
headline: The console design prototype is corrected and ready for another independent review
blockers: []
proposals: []
learnings:
  - A repeated repository label consumes viewport capacity and must be included when centering the selected session.
  - Draft authorship must follow the source of the displayed text, not merely the queue row's stored fields.
  - A focus test must identify the focused region and selected row; matching any disclosure marker is not evidence.
  - Forward Delete arrives as CSI 3 tilde and is otherwise swallowed by the generic CSI decoder.
artifacts:
  - console/proto/
  - docs/design/console-screens-2026-09-18.md
  - docs/reports/console-design-r2.md
  - node --test console/proto/prototype.test.mjs
  - python3 console/proto/smoke-pty.py
  - npm test
  - npm --prefix console test
---

## Correction result

All seven review findings are addressed:

1. The sessions viewport now reserves a line before prepending a repeated repository label, then recalculates its offset at the reduced capacity. The selected final session stays rendered and has a click target in readers at 80x30, 100x40 and 140x45, and in the all-project overview at 100x39.
2. Task rows use the plain state words `active`, `blocked` and `ready`. The remaining `>` and `*` selection marks are explained in the design's visual system, prototype help, and prototype README.
3. A displayed in-memory or unsent operator reply is labeled `Your draft`; only a suggestion is labeled `Agent draft`.
4. Focus tests now locate the focused region, its selected row, the row's click target and the exact `>` markers. Session reachability is checked at every target size and in the all-project overview.
5. Enter is inert once a peek is open, the Peek button is absent there, and one Back returns directly to the source reader.
6. The incremental decoder recognizes forward Delete (`CSI 3~`) and delivers `key.delete` to the editor reducer.
7. Every prototype module was reformatted into ordinary, one-statement-per-line source with the same module boundaries as the current console. The mockup generator then regenerated all 21 frames and the design document from the corrected renderer.

No file under `console/lib/` changed, no dependency changed, and the prototype remains fixture-only. It starts no process, calls no model or network service, and writes no organization data. Its actions remain explicitly simulated in memory.

## Validation

- Baseline `npm test`: 160/160 passed before the correction.
- Final `npm test`: 162/162 passed.
- Final `npm --prefix console test`: 95/95 passed.
- `node --test console/proto/prototype.test.mjs`: 11/11 passed.
- `python3 console/proto/smoke-pty.py`: passed keyboard, click, fragmented mouse input, reply cancellation, stack return, lanes, resize, wheel, quit and terminal cleanup.
- Direct `--print` renders at 80x30, 100x40 and 140x45 produced the requested row counts; the frame tests verify exact display-cell width on every line.
- `node console/proto/render-mockups.mjs` regenerated 21 snapshots and the document's exact-render section.
- `git diff --check`: passed.

The two extra root tests are the new prototype regressions for operator-draft attribution and idempotent peek. Existing prototype coverage was strengthened rather than merely increasing the count: visible focus and session reachability now assert the exact row and hit target that the first review found could disappear.

## Operator questions and recommended answers

1. **Should waiting items stay global or narrow in the third cascade column?** Recommend the delivered scoped third column with a never-hidden global count, explicit `!` route, and local-of-global message. If a short operator trial shows missed urgency, switch to alternative A, the permanent global list above the cascade.
2. **Is the task/open-item split right?** Recommend treating every non-human org item as a task, including ready work without a run, while open items are only operator questions, actionable stopped-session results, and explicitly unread finished results.
3. **Should sessions name what they serve?** Recommend `SERVES` at 100 and 140 columns and the task id on the 80-column continuation, with full task, goal and run context in session detail.
4. **Should opening a result mark it read?** Recommend no. Use an explicit Mark read action and design a durable receipt outside the event log before product integration.
5. **Should `y` prefer a draft or the recommendation?** Recommend that `y` always reviews the recommendation and `r` opens a clearly attributed operator or agent draft.
6. **Should stage filters hide future-stage human questions?** Recommend no. Stages narrow task browsing only; a real request for the operator remains counted and reachable.
7. **Should Esc close the overview?** Recommend explicit `q`/Quit, visible `b`/Back, and Esc only as an optional Back alias so the console does not fight the operator's learned agent-interrupt gesture.

## Cutover

None. This is still an isolated design object. Product integration, durable read receipts and drafts, live refresh, real pane focus and real session dispatch require a later implementation change after the operator chooses the layout.

---
run: R-23
outcome: done
summary: |
  Corrected all four findings from the second independent review of the console design prototype.
  Agent suggestions now keep agent attribution when the unsent-reply field is null, task states align in a fixed column,
  and the narrow sessions viewport renders only complete session pairs while keeping the selected continuation visible.
  Regenerated design evidence changes exactly nine task-bearing snapshots; the other twelve remain byte-identical.
headline: The console design prototype now passes its second review corrections
blockers: []
proposals: []
learnings:
  - A null unsent-reply field is absence, not evidence that the displayed suggestion belongs to the operator.
  - A narrow session viewport must choose complete main-and-continuation pairs, not arbitrary rendered lines.
  - Snapshot accounting is clearest when generator output is compared directly with the prior committed frames.
artifacts:
  - console/proto/frame.mjs
  - console/proto/prototype.test.mjs
  - console/proto/snapshots/
  - docs/design/console-screens-2026-09-18.md
  - docs/reviews/console-design/e701fc9-r2.md
  - docs/reports/console-design-r3.md
  - node console/proto/render-mockups.mjs
  - node --test console/proto/prototype.test.mjs
  - python3 console/proto/smoke-pty.py
  - npm test
  - npm --prefix console test
---

## Correction result

All four round-two review findings are addressed:

1. Draft attribution now treats both `null` and `undefined` as an absent operator draft. Q-2, whose fixture has `unsent: null` and an agent suggestion, renders `Agent draft / never sent`; an operator draft still renders `Your draft / never sent`. A focused regression test verifies the label, text, and absence of the wrong label.
2. Task titles are padded to their allotted width before the seven-cell state field. The words `active`, `blocked`, and `ready` therefore begin in one fixed column at 80, 100, and 140 columns. A focused test checks the column at all three widths.
3. At 80 columns, session viewport candidates begin at a group label or a session main row and end at a continuation row. Selection scoring accounts for a repeated group label, so every selected session retains its own `SERVES / UP / DOING` continuation. The reachability test now checks that continuation for every fixture session at 80x30.
4. The snapshot changes are fully accounted for below.

No file under `console/lib/` changed, no dependency changed, and the prototype remains fixture-only. The one-line waiting rows, Enter-for-detail behavior, goals-to-tasks-to-open-items cascade, reserved sessions organization, absence of a Task composer, and never-hidden global needs-you count are unchanged.

## Snapshot accounting

The generator rewrote all 21 frames and the design document's generated section. Compared with the prior committed, reformatted snapshots, exactly these nine files changed:

- `overview-80x30.txt`, `overview-100x40.txt`, and `overview-140x45.txt`
- `goal-picked-80x30.txt`, `goal-picked-100x40.txt`, and `goal-picked-140x45.txt`
- `task-picked-80x30.txt`, `task-picked-100x40.txt`, and `task-picked-140x45.txt`

Their only content change is spacing within task rows so every state word starts in the fixed state column. The draft-attribution fix does not alter the generated waiting frame because that scenario intentionally shows Q-1's real operator draft. The narrow viewport fix does not alter generated frames because their selected session is the first complete session in its group. Every other snapshot—twelve of the 21—is byte-identical to the prior commit after the round-two source reformat.

## Validation

- Baseline `npm test`: 162/162 passed before correction.
- Final `npm test`: 164/164 passed.
- Final `npm --prefix console test`: 95/95 passed.
- `node --test console/proto/prototype.test.mjs`: 13/13 passed.
- `node console/proto/render-mockups.mjs`: regenerated 21 frames and the document's exact-render section.
- `python3 console/proto/smoke-pty.py`: passed keyboard, click, fragmented mouse input, reply cancellation, stack return, lanes, resize, wheel, quit, and terminal cleanup.
- Direct inspection rendered Q-2 as `Agent draft / never sent` and rendered the selected `batch-retry` row immediately followed by its own `ENG-2 / 18m / Testing interrupted batches` continuation at 80x30.
- `git diff --check`: passed.

## Operator questions and recommended answers

1. **Should waiting items stay global or narrow in the third cascade column?** Recommend the delivered scoped third column with a never-hidden global count, explicit `!` route, and local-of-global message. If an operator trial shows missed urgency, switch to alternative A, the permanent global list above the cascade.
2. **Is the task/open-item split right?** Recommend treating every non-human org item as a task, including ready work without a run, while open items are only operator questions, actionable stopped-session results, and explicitly unread finished results.
3. **Should sessions name what they serve?** Recommend `SERVES` at 100 and 140 columns and the task id on the 80-column continuation, with full task, goal, and run context in session detail.
4. **Should opening a result mark it read?** Recommend no. Use an explicit Mark read action and design a durable receipt outside the event log before product integration.
5. **Should `y` prefer a draft or the recommendation?** Recommend that `y` always reviews the recommendation and `r` opens a clearly attributed operator or agent draft.
6. **Should stage filters hide future-stage human questions?** Recommend no. Stages narrow task browsing only; a real request for the operator remains counted and reachable.
7. **Should Esc close the overview?** Recommend explicit `q`/Quit, visible `b`/Back, and Esc only as an optional Back alias so the console does not fight the operator's learned agent-interrupt gesture.

## Cutover

None. This remains an isolated design artifact and fixture prototype. Product integration, durable read receipts and drafts, live refresh, real pane focus, and real session dispatch remain implementation work after the operator chooses the layout.

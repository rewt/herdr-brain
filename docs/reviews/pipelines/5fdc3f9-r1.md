**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: 5fdc3f9f605a6787355886c98906f45feac1ad0e
Topic: pipelines
Round: 1
Review ID: lr-8ea14adf011346c01a42d56c2aa9753d
Base branch: main
Base commit: a9a1ecfc8c4032278505790eb5091983adfbb360

## Findings
- [Moderate] console/modern/details.mjs:210 - Train result views still take their check log from the latest batch attempt (liveCheckLog is passed \`attempt?.gate ?? gate\`, which returns the last attempt's gate log) instead of the opened result's own gate, so after bisection a lane refused by an earlier red check shows another group's passing output under \`Check log - tail\` and \`Live log - latest\` while its Check and Elapsed lines describe its own failed gate; console/test/pipeline-details.test.mjs:32 asserts this wrong log, and R-251 left it unchanged; Fix: pass \`gate\` (the result gate when a result is opened) to liveCheckLog, fall back to the latest attempt only for batch descriptors, and make that test assert the result view shows \`isolated lane failed\` and not \`next group passed\`.
- [Minor] console/modern/pipelines.mjs:46 - The post-rebase train preparation step (batch phase \`preparing\` with attempt.phase \`prepared\` and no gate yet) shows Rebase done and CI waiting with no running link, and an interruption there falls through to the \`prepared ? get('fast-forward')\` fallback at line 72, drawing the failure on Fast-forward although integration was never reached; Fix: treat phase \`preparing\` with a prepared attempt and no finished gate as CI running, and make the interrupted fallback pick CI when the attempt is prepared but has no finished green gate.
- [Minor] console/modern/minimal-session.mjs:229 - Run and batch details open with focus on the first chain link, and Up and Down then only move between chain links and clamp at the ends, so arrows no longer scroll the run report as before (detail-view tests clear \`detailFocus\` by hand to keep the old scroll assertions passing); Fix: keep Left and Right for link selection and let Up or Down past the first or last chain link release focus and scroll, with a test that presses Down repeatedly from an opened run detail and observes scrolling.
- [Minor] console/modern/pipelines.mjs:135 - A release candidate whose gate has started (\`candidate.started\` set, \`gate\` still null) is drawn as waiting with an unknown duration, so a running candidate gate never gets the running mark and an interrupted one looks the same as one not yet started; Fix: when a matching candidate has \`started\` and no \`gate\`, mark the link running with \`started\_at\` from \`candidate.started.at\` and include the candidate id in its detail.
- [Minor] console/modern/details.mjs:186 - The Landed and fallback Train evidence pages match the promotion only by \`r.run === descriptor.run\`, while runPipeline and runDocument also match older results by lane topic and settled final head, so a landed run with such a result shows a done Landed link that opens \`No promotion recorded.\`; Fix: reuse runPipeline's promotion matching (including the topic and source\_head fallback and the retrying rule) in runLinkDocument.

## Re-executed
```json
[]
```

## Non-claims
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.
- Deferred CI on the promotion batch is not claimed; the promotion queue runs the promotion tier before main moves.
- Live visual operation of the console in a real Herdr pane is not claimed by the worker or this review.

## Unverified
- Whether the escape change prevents a recurrence of the R-250 projection failure is not established: the sanitizer rejects any non-ASCII character in reviewer-written fields, the retained R-250 private review is pure ASCII and the worker reports it now projects, so the original offending payload is not available and the root cause of that failure remains unidentified.
- The worker's 324-test console run and the projection-check evidence script were read from committed evidence files only; the zero-command budget permits no re-run.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->

**PASS**
Schema: lane-review/v1
Reviewed commit: f9cdf95f3b5edc12681c9ecd544ceb32a18f14e9
Topic: console-ink
Round: 1
Review ID: lr-68fccf2fde7fbfa1349ae46e24e3608a
Base branch: main
Base commit: 48c1ecbd0459f9fb05c9c661e63bf73c41351741

## Findings
- [Moderate] console/modern/minimal-session.mjs:205 - In the minimal session raw input path any ESC byte followed by a byte that is not a CSI or SS3 sequence leaves the session and drops the rest of the chunk, so legacy Meta/Alt keys such as Option+Enter (ESC CR), Alt+b, Alt+f and Alt+Backspace never reach the agent and instead return to the table, unlike the full console which forwards them; Fix: treat ESC followed by exactly one further byte in the same chunk as a Meta key and forward both bytes, leave only on a chunk-final bare ESC, a partial ESC-bracket or the CSI-u Esc encodings, and update the minimal-input test that currently expects ESC q to return
- [Minor] console/modern/minimal-session.mjs:81 - activate opens the control stream at the dashboard layout width, which is capped at 116 cells, while SessionView uses the full pane width up to 400, so on panes wider than 116 columns the stream starts at the wrong width and is resized on the first render, forcing an extra agent redraw; Fix: compute the initial control size with the same viewport formula SessionView and view use for the output screen
- [Minor] console/modern/table.mjs:64 - The selected Runs row is marked only by bold text, which is the same styling as the header row and the panel titles, so keyboard selection is hard to see before pressing Enter; Fix: mark the selected row distinctly, for example inverse or a leading selection marker in Table rows and Panel rows, and assert it in table.test.mjs

## Re-executed
```json
[]
```

## Non-claims
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.
- Deferred CI: the new console test files are not in the explicit promotion tier list; the worker filed this as a proposal and it is outside this lane's console-only file scope.

## Unverified
- The live screen in the operator's console live tab was not observed; the worker reports that tab still runs the canonical checkout, so on-screen flicker, resize and colour behaviour rest only on inherited offline tests.
- Live session control against a real Herdr pane, including the Ctrl+backslash interrupt and Back release, was not exercised; the zero-command budget permits no execution and the worker reports only offline coverage for it.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->

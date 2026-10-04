---
run: R-238
outcome: done
summary: |
  Fixed autopilot exception wakes to deliver the complete original notice unchanged, followed by the autopilot reason and receipt on their own line. Routine notices remain handled without chat delivery. All 63 autopilot tests and both previously failing promotion tests passed; the promotion tests are unchanged. Implementation is committed as aaa7287. This report is checked and committed before the required final fast lane check.
headline: Supervisor wakes now preserve the complete original notice
blockers: []
proposals: []
learnings:
  - "Autopilot wakes must preserve the exact original notice, including promotion outcome and lane cleanup details, because foreground handle --notice consumes that text. Policy reasons and receipts belong on an appended line."
artifacts:
  - "Implementation commit aaa7287 on lane/autopilot"
  - "supervisor/autopilot.mjs"
  - "supervisor/test/autopilot.test.mjs"
  - "supervisor/README.md"
  - "supervisor/PROTOCOL.md"
  - "docs/reports/ENG-177-wake-notice-20261004.md"
decisions: []
questions: []
challenges: []
---

The wake summary previously replaced the report narrative or the entire promotion
notice. It now starts with the original message without trimming, reformatting or
reconstructing its envelope, then appends a newline and an `[autopilot]` reason
with the receipt path. This shared formatter covers normal exceptions, replay and
receipt errors. Existing inbox handling still consumes routine results before
Herdr delivery. Documentation now describes the same delivery contract.

The delivery regression exercises report, promotion and unknown notices through
the existing input gate. It verifies the exact original prefix, including repeated
spaces, embedded newlines, trailing spaces and lane cleanup details, followed by a
separate policy line. All three cases failed against the old implementation before
the fix. Existing wake assertions now require the original notice as well. Neither
of the promotion tests named in the ask was edited.

Focused offline validation:

- `node test/helpers/run.mjs supervisor/test/autopilot.test.mjs`: 63 passed,
  zero failures, zero skips. This includes routine notices staying out of chat,
  replay safety and the real scripted CLI landing paths.
- `node test/helpers/run.mjs '--test-name-pattern=^(crash during batch cleanup resumes without repeating the gate or trusting saved freshness|direct gate overlapping queued cleanup prevents queue and direct close from deleting its lane)$' promote/test/promote.test.mjs`:
  both requested cases passed, zero failures, 22 unrelated cases skipped.
- The first promotion invocation failed at `fs.watch` with sandbox `EMFILE`,
  before reaching the notice assertions. A minimal temporary-directory watcher
  reproduced that restriction. The unchanged tests passed when rerun outside the
  sandbox through the same offline helper.
- `git diff --check` passed before the implementation commit.

The report is validated with the canonical record CLI and committed separately.
The last operational command is `node lanes/lane.mjs check` at the clean report
commit; its output and `.lane/gate.json` retain the final gate result. No full
project suite, promotion tier, lanes suite, live acceptance harness or project
housekeeping schedule is run by this lane.

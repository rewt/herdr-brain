---
run: R-290
outcome: done
summary: |
  Corrected all three minor findings from the prior review: blocked sessions now follow the current run's report outcome, watch blocks describe timestamped recorded evidence, and the foreign-project cursor test changes only the cursor's org field. The text decisions section now uses one-sentence summaries, abbreviates commit hashes, and counts routine autopilot settlement and promotion authorization notes by action. JSON retains every decision's full text and explicit summary. The implementation is committed, ten focused offline checks passed, and a read-only live-record smoke check confirmed the quieter text. This report precedes its separate validation and commit, followed by the final focused lane check.
headline: Chat digests now show accurate block evidence and quieter decision summaries.
blockers: []
proposals: []
learnings:
  - Decision summaries must remain separate from full text in the digest JSON; replacing text with the summary loses evidence.
  - Watch sends no resume notice, so a retained prompt-block notice must be phrased as timestamped recorded evidence.
artifacts:
  - "Implementation commit: 7fbc256a02d5748e52dd2dea7e2582c8eafdb8a7 on lane/chat-digest"
  - "lib/digest.mjs; lib/render.mjs; test/digest.test.mjs; supervisor/README.md"
  - "Focused validation: node test/helpers/run.mjs test/digest.test.mjs test/sanitization.test.mjs (10 passed, 0 failed)"
  - "/private/tmp/R-290-focused-tests.log"
  - "Read-only smoke: ORG_DIR=/Users/rewt/development/rewt/.org node bin/org.mjs digest --since 3h --width 72"
  - "/private/tmp/R-290-digest-smoke.txt"
  - "Report validation transcript: /private/tmp/R-290-report-check.log"
  - "Lane report copy: docs/reports/chat-digest-fix1.md"
  - "/Users/rewt/development/rewt/.org/runs/R-290/report.md"
decisions: []
questions: []
challenges: []
---

Read the correction ask, run brief, and canonical review at
`.lane/reviews/chat-digest/4f8bf12-r1.md` before implementing the correction.

Record blocks require a current, non-abandoned run on an unclosed item with a
blocked or needs_human report. A done report on a reopened, link-blocked item
does not create a blocked session. Needs-human reports retain their outcome even
when dependency status is blocked. Watch evidence carries its complete notice
timestamp in JSON and displays its UTC time and date in text. Existing report,
replacement-run, abandonment, closure and later-watch resolution rules remain.

Decision text uses an explicit summary when present, otherwise the first sentence,
with the existing length bound and terminal sanitization. Forty-character hashes
are abbreviated in the text summary. Recognized supervisor-autopilot settlement
and promotion authorization notes are counted by action outside the individual
decision limit. Other judgments, including other actors' settlement decisions,
remain individual summaries. Section totals include the counted notes, omission
counts cover only undisplayed individual decisions, and JSON retains all facts.

The focused offline tests cover done versus blocked/needs-human reports under
unresolved and resolved dependency links, timestamped stale watch wording,
foreign cursor identity isolation, multi-sentence summaries, note/report full
JSON text, autopilot counts, retained individual judgments, abbreviated hashes,
section limits, narrow wrapping, existing cursor/read-only behavior, and terminal
sanitization. Early development failures were errors in the new test assertions
(missing show --json, tie-order assumptions, and matching a journal warning);
these were corrected before the ten-test green run.

The brief's lesson to execute the unchanged test on main cannot apply to this
new digest suite: `git ls-tree main test/digest.test.mjs` returns no entry. No
baseline, full suite, promotion tier, release gate or live acceptance harness ran.

After validating and committing this report, the final operation is:

    node lanes/lane.mjs check --cmd 'node test/helpers/run.mjs test/digest.test.mjs test/sanitization.test.mjs'

The resulting gate receipt is `.lane/gate.json`; the final command's output is
the evidence of that check. No promotion is performed by this run.

---
run: R-247
outcome: done
summary: |
  Fixed embedded-session Esc isolation and detail navigation in commit f35a5ff.
  Bare, repeated, partial and encoded Esc now return without forwarding any
  bytes from their input chunk. Complete Meta, CSI, SS3 and Alt-arrow input
  retains its bytes; the explicit interrupt shortcut remains available.
  Shift reverses only Tab. The dependency-free session parser has 43 mandatory
  promotion-tier checks. All 303 console and tier checks passed with UI packages;
  without them, 272 passed and 31 optional UI checks skipped, with every parser
  check exercised. This report precedes its record check, commit and final lane check.
headline: Escape safely returns from agents and its input rules now run in merge checks.
blockers: []
proposals: []
learnings:
  - Embedded session input must be parsed completely before any controller write; a return key discards the entire chunk, including preceding typing or an interrupt shortcut.
  - A doubled Esc is bare input unless the second Esc begins a complete CSI or SS3 sequence; this preserves Alt-arrow bytes while rejecting bare key repeat and partial sequences.
  - console/test/session-input.test.mjs uses node:test directly and belongs to the explicit promotion list, so Esc isolation runs without optional Ink or React packages.
artifacts:
  - "commit f35a5ff: Keep bare Esc out of embedded agents and enforce parser safety in CI"
  - branch lane/console-ux
  - console/modern/session-input.mjs
  - console/modern/minimal-session.mjs
  - console/test/session-input.test.mjs
  - console/test/minimal-input.test.mjs
  - console/test/detail-view.test.mjs
  - test/helpers/tier.mjs
  - test/tier-plan.test.mjs
decisions: []
questions: []
challenges: []
---

Addressed both findings in `docs/reviews/console-ux/6b89f2c-r1.md` and the
fix-round brief. Stage durations remain assigned to the deferred follow-up.

`session-input.mjs` owns the byte parser and the existing mouse/Back splitter.
`control.mjs` re-exports the splitter for its current callers. The minimal
session controller parses before sending input and releases immediately on
return. Partial CSI and SS3 prefixes are rejected instead of being treated as
Meta pairs. Complete Alt-prefixed CSI/SS3 sequences remain supported as the
review requested. Ink rendering continues to load lazily.

The dependency-free regressions cover repeated and coalesced Esc, input before
Esc, CSI-u press/repeat/release and modified Esc, modifyOtherKeys Esc, partial
sequences, Meta input, ordinary CSI/SS3, Alt arrows, exact UTF-8 and binary bytes,
local mouse reports, Back and explicit interrupt mappings. Installed UI tests
also assert zero controller writes and return to the table on double Esc, plus
Shift direction for scrolling and link selection and reverse Tab navigation.
The tier-plan test asserts that the parser suite remains in promotion CI.

Validation used the required offline fixture runner:

| Command | Environment | Result |
| --- | --- | --- |
| `node test/helpers/run.mjs console/test/session-input.test.mjs` | Installed checkout | 43 passed, zero skipped, exit 0 |
| `node test/helpers/run.mjs console/test/*.test.mjs test/tier-plan.test.mjs` | Installed checkout | 303 passed, zero skipped, exit 0 |
| Same console command | Isolated copy of tracked and changed files without `console/node_modules` | 272 passed, 31 optional UI checks skipped, exit 0 |

The isolated copy was `/private/tmp/ENG-193-no-ui-_00mzgod`; the installed
checkout's dependencies were left in place. TAP transcripts are at
`/private/tmp/ENG-193-parser.tap`, `/private/tmp/ENG-193-console-with-ui.tap` and
`/private/tmp/ENG-193-console-without-ui.tap`. Initial sandboxed installed runs
passed their tests but failed the runner's process audit with `Operation not
permitted`; rerunning with process inspection available completed successfully.
An initial focused run also caught an incorrect expected section in the new
navigation test; the expectation was corrected before the successful full runs.

After checking and committing this report, the final `node lanes/lane.mjs check`
records the clean delivered commit in `.lane/gate.json`. No promotion, release
suite or live acceptance harness was run in this lane.

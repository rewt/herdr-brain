**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: a2be47e5e3cd3f10f3d8a494dd319304b1c65cd4
Topic: console-ux
Round: 1
Review ID: lr-b843022e7366774cc697c0fd097dd6df
Base branch: main
Base commit: 48c1ecbd0459f9fb05c9c661e63bf73c41351741

## Findings
- [Moderate] console/modern/session-input.mjs:25 - The deliberate interrupt (Ctrl+\\ byte 0x1c, and the CSI-u forms matched on line 34) is now appended as an ESC byte into the same forwarded buffer as the surrounding bytes, so one chunk becomes one terminal.input write: a coalesced double press or key repeat of Ctrl+\\ reaches the agent as the bytes 1b 1b in a single write (the exact Esc Esc rewind or clear hazard the must-fix targeted), and an interrupt followed by typing becomes a Meta chord (Ctrl+\\ then b is delivered as Meta-b, Ctrl+\\ then an arrow as Alt-arrow) instead of an interrupt; the round 1 code at 6b89f2c sent the interrupt ESC as its own controller write, the README still says Ctrl+\\ sends Esc, and the new test at console/test/session-input.test.mjs:57 codifies the fused a ESC b output under the name translate to a bare Esc; Fix: have parseSessionInput return ordered byte segments (or an interrupt flag) so minimal-session.mjs input() writes each interrupt ESC as a separate controller.input call, collapse consecutive interrupts within one chunk to a single ESC, and add parser tests asserting that two Ctrl+\\ bytes in one chunk yield exactly one standalone ESC segment and that Ctrl+\\ followed by b never produces the two-byte Meta-b segment.

## Re-executed
```json
[]
```

## Non-claims
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.
- The inherited gate log is npm run test:fast (15 files, 178 pass, 0 fail, 0 skipped, 0 cancelled, 0 todo); the new parser suite is a promotion-tier file and does not run in the fast tier, so that log proves only that the tier-plan assertion listing the parser suite under promotion passed, not the parser cases themselves.
- Deferred promotion CI on the batch is not claimed here.
- Stage durations remain deferred to ENG-197 as the ask directed; not reviewed as a requirement of this round.

## Unverified
- The worker TAP transcripts in the system temp directory report 43 of 43 parser checks, 303 of 303 console checks with UI packages and 272 pass with 31 skipped without them, matching the report, but they are self-reported and were not re-executed under the zero budget.
- Live terminal behaviour (real Esc and Alt-arrow bytes from a terminal, real Herdr pane delivery, Shift-Tab parsing by Ink) was checked only by code reading.
- The report-commit-then-lane-check ordering: the gate record names head a2be47e with exit 0 for test:fast, consistent with the claim, but the record check step itself was not observed.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->

---
run: R-313
outcome: done
summary: |
  Fixed all four independent review findings on the existing steward-policy lane.
  Claude now uses only a per-request command hook; dependency failures deny with
  exit 2 and the record-ask nudge, and invalid bindings produce audit receipts.
  Project reads no longer trigger action-keyword alerts, and concurrent audit
  writers wait briefly for the lock. Focused offline tests pass, including the
  retained alert-path fixes for ENG-251. Native trust and Messages setup remain
  operator actions.
headline: Permission decisions survive launcher loss and safe project reads avoid false alerts
blockers: []
proposals: []
learnings: []
artifacts:
  - "Implementation commit: ab171e577196a618dd016156bfc78bba591df1f1 (lane/steward-policy)"
  - "supervisor/permission-hook.mjs"
  - "supervisor/permission-hooks.mjs"
  - "discovery/native-sandbox.mjs"
  - "brain/lib/permission-policy.mjs"
  - "brain/lib/permission-audit.mjs"
  - "brain/test/permission-policy.test.mjs"
  - "node --test brain/test/permission-policy.test.mjs: 11 passed"
  - "node --test --test-name-pattern='project Read paths' brain/test/permission-policy.test.mjs: credential refinement passed"
  - "node --test brain/test/steward.test.mjs discovery/test/native-sandbox.test.mjs supervisor/test/entry.test.mjs: 131 passed, 3 optional native probes skipped"
  - "docs/reports/ENG-245-steward-policy-R-313.md"
decisions:
  - text: "Use only the per-launch command hook as Claude's structured permission decision path."
    category: security
    why: "The approved policy needs a denial when the adapter disappears; an adapter-owned HTTP listener can fail back to an interactive dialog."
  - text: "Keep action receipts in Brain state and leave operator questions to the denied session through record ask."
    category: design
    why: "The existing ownership contract forbids Brain from appending record events, and the denial supplies the recording nudge."
questions: []
challenges: []
---

Resolved the review at docs/reviews/steward-policy/71b81f1-r1.md and inspected
the inherited R-308 validation log (139 passed, no failures, three skipped).
The previous report has not been altered.

The Major finding is resolved by removing servePermissionHook, all loopback
listener code, the post-write settings replacement, and both adapter readiness
waits. Claude settings retain the command registration and existing question,
lifecycle and permission groups. The command remains usable after launch cleanup;
the regression invokes it again and receives a denial. Each request has its own
process, without depending on an adapter event loop or listener.

The command entry point imports its decision dependencies dynamically inside
the try block. Its emergency JSON and nudge have no checkout dependencies. A
missing module, syntax error, missing transitive import, thrown handler or oversized
input emits a single denial and exits 2 with the nudge on stderr. Missing or
malformed binding JSON goes into handlePermission as null and is audited;
malformed input and stale project identity also have denial receipts. Alert
failure after a response cannot emit a second decision. If the audit graph
cannot load, the emergency response cannot write the normal local audit;
stderr retains the failure and tells the denied session to record the question.

Read requests use resolved credential targets, fresh project identity and
containment. Action keyword matching applies to non-read inputs. The regression
approves release, push, deploy, publish, trust and transfer filenames without
any alert. Credential files and aliases still deny; resolved seed-phrase and
keychain targets remain protected after removing raw Read keyword matching.

Permission audit locking now waits 2000 ms. Two independent child processes
contend with a held live lock, then both preserve their approvals and receipts
when it releases. Corrupt audit and disabled configuration still deny. Existing
approval circuit breakers and exact-screen denial-only fallback still pass.

The earlier ENG-251 fixes remain in this same change: per-episode alert caps
with occupant debounce, bounded retired-receipt retention and journal-failure
alerts, delayed escalation for non-fleet sessions, and cached routing identity
with fresh identity for approvals. The complete offline steward tests pass,
including the exhausted-stall-cap/later-supervisor-block regression and private
argv-only iMessage payload tests.

Validation is offline and model-free. Three native probes were skipped: Codex
config/read, Claude native permission matchers, and Codex filesystem boundaries.
The inherited log also skipped the Codex config reader; it does not substantiate
the previous report's passing native-config claim. This run makes no claim of
native hook execution under operator trust or a live Messages send. The operator
still configures their local recipient, grants Messages Automation and runs the
setup alert. No persistent harness settings or trust records were changed, no
project-wide housekeeping was started, and bch-cloak was not modified.

The report is checked and committed before the final lane check. That last check
runs the four focused test files against the report commit and records its result
in .lane/gate.json; its GATE output supplies the result without amending this report.

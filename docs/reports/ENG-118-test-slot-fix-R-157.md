---
run: R-157
outcome: done
summary: |
  Corrected nested timeout retries so a child or ancestor can spend the single retry allowance without stacking more attempts. Promotion now retains the host slot while npm test and the remaining heavy suites retry only their own timed-out step. Commands that start and exit 75 record failed validation receipts; only a pre-execution slot refusal omits them. Added regressions and fixed settle fixtures that accidentally discarded temporary slot paths. Focused offline checks pass; the final promotion-tier lane check follows this checked report's commit and supplies the full-suite receipt for the submitted head.
headline: Test slot retries are bounded and validation failures retain their evidence
blockers: []
proposals: []
learnings:
  - "Containing wrappers observe TEST_SLOT_TIMEOUT_RETRY and suppress another replay. An ancestor's retry exports MONITOR_TEST_SLOT_TIMEOUT_RETRIED=1 so descendants cannot start a third attempt; that coordination variable is excluded from validation fingerprints."
  - "runTestSlotSync supplies attempts metadata after command execution. Promotion treats exit 75 as a slot refusal only when that metadata is absent; started commands returning 75 retain failed receipts and are never reused."
  - "Retry scope is the wrapped command. npm test wraps core and cycle separately; promotion holds the slot across npm test, lanes and offline acceptance, with each heavy step owning its retry."
  - "settle/test/fixture.mjs clears MONITOR variables when resetting project inputs. It must then assign a fixture-owned temporary slot and legacy compatibility path; otherwise offline gates can contend with the actual host holder."
artifacts:
  - "Branch: lane/test-slot"
  - "89b1aa7: Limit nested timeout retries and retain command failure receipts"
  - "0a24570: Isolate settle fixture slots and retry npm test by heavy step"
  - "test-slot/test-slot.mjs, test-slot/README.md, package.json: bounded nested retries and per-step scope"
  - "lanes/validation.mjs and lanes/test/validation.test.mjs: command exit 75 produces failed receipts in fast and promotion tiers"
  - "release/release.mjs: distinguish pre-execution refusal using attempts metadata"
  - "test/helpers/bounded-test.mjs and settle/test/fixture.mjs: isolated fixture coordination"
  - "/private/tmp/R-157-slot-native.log: 48 passing offline tests, including two-attempt nested holders and timed-out-step-only promotion retry"
  - "/private/tmp/R-157-fast.log: npm run test:fast, 143 passed, zero failures"
  - "/private/tmp/R-157-rebase.log: 16 rebase-path and rebase tests passed after fixture isolation"
  - "Final command after this report's checked commit: ORG_ACTOR=R-157 MONITOR_TEST_SLOT_WAIT_SECONDS=600 node lanes/lane.mjs check --tier promotion"
  - "/private/tmp/R-157-promotion.log and .lane/gate.json: final promotion validation evidence; the lane receipt names the final submitted head and its durable full-suite log"
decisions:
  - text: "Suppress retries both above a child's emitted retry marker and below an ancestor's second attempt."
    category: tooling
    why: "The retry allowance must remain one across nested validation adapters, including when measured load differs between wrappers."
  - text: "Preserve npm test in promotion while wrapping core, cycle, lanes and offline acceptance separately."
    category: tooling
    why: "Retry only the timed-out heavy step while keeping one host holder across the complete promotion chain."
  - text: "Give each settle fixture its own temporary slot after clearing inherited project inputs."
    category: tooling
    why: "Offline fixture gates must not contend with real host validation or other lanes' fixtures."
questions: []
challenges:
  - "The baseline npm test passed slot, copied-entry and core checks, including plugin-install and load-deadlines, but cycle finished with five failures. Inspection found settle fixtures were clearing their temporary slot paths while other lanes were running suites; the focused rebase rerun passed after correcting that isolation."
  - "A redirected sandboxed slot-test attempt could not inspect native process identities. Its identified runner was stopped, and the native-access offline rerun passed all 48 tests."
---

The independent review's retry, refusal-classification and retry-scope findings
are resolved. A three-wrapper regression proves exactly two leaf attempts when
the inner wrapper retries and when an ancestor retries; only one retry marker
is emitted. A promotion-chain regression injects a core timeout and proves core
runs twice while slot, cycle, lanes and offline acceptance run once. Existing
serialization, nesting, legacy-lock bridge and release-deferral tests remain in
the full promotion command.

The final promotion check runs the canonical npm run test:promotion declaration
on the exact clean report commit. Its chain includes npm test, npm run test:lanes
and npm run test:acceptance. The durable lane receipt and its log, plus the
captured promotion log listed above, are the authoritative full-gate result.
No live acceptance harness or model is called. The bch-cloak checkout remains
read-only. The previous report is unchanged.

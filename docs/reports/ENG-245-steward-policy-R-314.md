---
run: R-314
outcome: done
summary: |
  Fixed the two findings in the narrow steward-policy correction. Permission
  decisions now have an unscaled eight-second watchdog, bounded Git calls and
  audit/recovery lock waits. Alerts run in a detached child after their durable
  cap/debounce receipt and the native decision, so delivery never delays the hook.
  Resolved credential matching now covers credential stores rather than generic
  wallet, secret or credential names; ordinary wallet source reads allow without
  alerts. The touched offline test file passed all 15 tests, and the strengthened
  extreme-load lock regression passed separately.
headline: Permission hooks exit promptly and ordinary wallet source reads avoid false alerts
blockers: []
proposals: []
learnings: []
artifacts:
  - "Implementation commit: 7b004bf566f081c599de7354579f66d21ea9d0ff (lane/steward-policy)"
  - "supervisor/permission-hook.mjs"
  - "supervisor/permission-alert.mjs"
  - "supervisor/permission-hooks.mjs"
  - "supervisor/notice-lock.mjs"
  - "lib/project.mjs"
  - "brain/lib/permission-audit.mjs"
  - "brain/lib/permission-policy.mjs"
  - "brain/test/permission-policy.test.mjs"
  - "brain/README.md"
  - "node --test brain/test/permission-policy.test.mjs: 15 passed, 0 failed, 0 skipped"
  - "node --test --test-name-pattern='held audit' brain/test/permission-policy.test.mjs: strengthened extreme-load regression passed"
  - "docs/reports/ENG-245-steward-policy-R-314.md"
decisions:
  - text: "Implement the requested bounded decision lifetime, detached alerts and narrower credential-store classification."
    category: security
    why: "The authorized correction prevents timeout fallthrough to interactive dialogs and false operator alerts for ordinary project source files."
questions: []
challenges: []
---

Resolved only the two findings in docs/reviews/steward-policy/754c81c-r1.md,
following the ENG-245-fix2 handoff. The registered native hook timeout remains
15 seconds and its stable command and launch binding remain unchanged.

A dependency-independent parent owns an unscaled eight-second timer, starting
before input and decision-module loading. It runs decision work in a child so
synchronous locks, filesystem operations or blocked imports cannot stop the
watchdog. The same absolute deadline reaches audit acquisition and recursive
dead-owner recovery. These waits are unscaled when a deadline is supplied;
other notice-lock callers retain their existing behavior. Every permission-path
Git subprocess has a one-second timeout, capped by the remaining deadline, and
uses SIGKILL. The parent checks the deadline again before accepting a result.
Deadline exhaustion kills the decision worker, emits one denial with the
record-ask nudge and exits 2; it cannot accept a late approval.

Normal decisions still require the fsynced audit and circuit-breaker receipt.
The decision child returns an alert descriptor only after the cap/debounce
intent is durable. The parent writes the native decision, starts the alert
entry point using argument arrays and literal JSON with ignored stdio,
detached=true and unref(), then exits without awaiting delivery. Delivery errors
remain in the detached process and cannot change or repeat the native decision.
The existing private operator-alert payload and channel implementation remain.

Resolved file matching now recognizes .ssh/ and .aws/ contents, dot-env files,
keychain database files, private-key files and wallet.dat. Generic wallet,
secret, credential and keychain substrings no longer identify credential stores.
Regression coverage allows packages/app/src/wallet.tsx and tools/wallet.mjs
without an alert, alongside ordinary source and documentation names. It denies
and alerts on wallet.dat, .env.local, id_ed25519, .ssh/config, .aws/credentials,
PEM/key files and keychain databases. The retained symlink regression still
classifies the resolved credential destination. Non-read action classification
and the rest of the reviewed policy remain unchanged.

Offline evidence: the touched permission-policy test file passed all 15 tests.
The hanging alert fixture records its own PID, literal payload and the already
persisted audit before refusing to return; the hook exits with a denial in about
0.3 seconds and a repeated request consumes no new alert intent. Held live audit
and recovery locks return denials while preserving the holder. After the initial
pass, that regression was strengthened with a preload simulating load average
10000 and one available CPU; it passed with waits below four and seven seconds,
respectively. A dependency whose decision handler spins forever is stopped by
the watchdog with a single emergency denial and exit 2 in about 8.1 seconds.
A Git fixture that ignores SIGTERM is killed by its own timeout and denies in
about 1.2 seconds. No broader, promotion, release or live acceptance suites ran.

The report is checked and committed before the final lane check. That last
command runs only node --test brain/test/permission-policy.test.mjs against the
report commit; its GATE output and .lane/gate.json supply the final result without
amending this report. No live native-hook trust or Messages-send claim is made.

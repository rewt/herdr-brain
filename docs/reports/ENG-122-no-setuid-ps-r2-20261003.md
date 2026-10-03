---
run: R-171
outcome: done
summary: |
  Fixed both findings from the first no-setuid process review. Darwin identity reads now use sysctl KERN_PROC_PID so unprivileged callers can compare root and other-user process births without setuid execution, while denied or incomplete identity reads still fail closed.
  Restored PID 1 in stale-holder recovery and added coverage for foreign group-id reuse and denied foreign identity reads. Rebuilt both Darwin executables and their manifest.
  The two regression cases failed before implementation. The focused run then passed 65 tests with zero failures and two nested-seatbelt skips. Full suites remain reserved for promotion; lane check follows the checked report commit as the final action.
headline: Process identity checks now recover stale locks when another user reuses a PID
blockers: []
proposals: []
learnings:
  - Darwin PROC_PIDTBSDINFO restricts unprivileged identity reads to same-user processes; sysctl KERN_PROC_PID supplies kinfo_proc births and ancestry across users without setuid.
  - PID 1 identity is readable through KERN_PROC_PID from this sandbox as uid 501. This supersedes the first report's observation that foreign identities remained unreadable with proc_pidinfo.
  - Seatbelt cannot nest in this worker sandbox; both existing seatbelt acceptance cases explicitly skipped and remain the promotion host's responsibility.
artifacts:
  - "Fix commit: aa2e4c6 (Read Darwin process births across user identities)"
  - "Branch: lane/no-setuid-ps"
  - "Review addressed: docs/reviews/no-setuid-ps/8cc3df9-r1.md"
  - "Implementation: lib/process-source.c; rebuilt lib/native/process-source-darwin-arm64 and lib/native/process-source-darwin-x64; lib/native/manifest.json"
  - "Tests: test/no-setuid-processes.test.mjs and test-slot/test/test-slot.test.mjs"
  - "Documentation: lib/native/README.md and test-slot/README.md"
  - "Evidence: docs/reports/evidence/ENG-122-no-setuid-ps-r2/regressions-red.log (two intended failures)"
  - "Evidence: docs/reports/evidence/ENG-122-no-setuid-ps-r2/focused-green.log (65 passed, zero failed, two nested-seatbelt skips)"
  - "Evidence: docs/reports/evidence/ENG-122-no-setuid-ps-r2/build.log (rebuild success, source and binary hashes verified, no setuid/setgid bits)"
  - "Final command after the checked report commit: ORG_ACTOR=eng122-r171-lane-check node lanes/lane.mjs check; receipt in .lane/gate.json"
decisions:
  - text: Use KERN_PROC_PID for both identity reads surrounding Darwin command lookup, including identity-only requests.
    category: tooling
    why: This preserves the seconds and microseconds birth format and race checks while allowing stale holder and group comparisons across users.
  - text: Keep denied or incomplete identity reads as unknown and retain their slot locks.
    category: tooling
    why: An unreadable identity cannot prove that a recorded holder has exited or that its PID has been reused.
  - text: Run only focused process and slot tests during development, then lane check last after the report commit.
    category: prover
    why: The operator explicitly reserves baseline and full-suite validation for promotion.
questions: []
challenges: []
---

The native reader obtains `p_starttime` seconds and microseconds, `p_pid`,
`e_ppid`, `e_pgid`, `p_stat` and the kernel command name from `kinfo_proc`.
It validates the returned record and compares PID plus both birth components
after command lookup. A zero-length successful kernel response or an explicit
absence error denotes exit; denied, truncated, malformed or changed identities
refuse. Full argv reads retain their permission checks and the existing
exec/exit fallback. Runtime compilation and setuid execution remain unnecessary.

The new native integration case reads root-owned PID 1 twice from an
unprivileged caller and checks its birth and ancestry. The restored recovery
table uses PID 1, distinct from `process.pid`, and explicitly asserts `gone`
before acquiring a stale slot. It also covers a stale group ID now owned by PID
1. A separate denied-source regression verifies that a stale PID 1 record stays
in place and acquisition refuses with `TEST_SLOT_HOLDER_UNKNOWN`.

Commands and results retained in the committed evidence directory:

```sh
node --test --test-name-pattern='Darwin identity-only reads|takes over a record whose' test/no-setuid-processes.test.mjs test-slot/test/test-slot.test.mjs
# Before implementation: exit 1, two intended failures, 58 tests excluded by pattern.
node lib/native/build.mjs
# Exit 0; both Darwin targets rebuilt with the manifest's recorded compiler flags.
ORG_ACTOR=eng122-r171-focused node --test test/no-setuid-processes.test.mjs test-slot/test/test-slot.test.mjs test-slot/test/no-setuid.test.mjs
# Exit 0: 65 passed, zero failed, two nested-seatbelt skips.
```

Self-review checked the source, tests, native bundles, manifest and documentation
against the ask and both review findings; `git diff --check` passed. No baseline,
`npm test`, `test:promotion`, `test:lanes` or live acceptance harness ran. This
round makes no new full-suite seatbelt or physical Linux-host claim. The final
lane check is deliberately after report validation and commit, so its receipt
is stored in `.lane/gate.json` for the final committed head.

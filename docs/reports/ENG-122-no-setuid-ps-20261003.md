---
run: R-163
outcome: done
summary: |
  Replaced the shared test-runner ps dependency with bundled, verified non-setuid Darwin kernel readers and Linux proc reads, preserving fresh PID, birth, command and group-leader checks.
  Updated the promoted host test slot to share that reader, retain the bch-cloak UTC/C wire format, and record precise kernel births for new holders and command groups.
  Test-first failures and passing focused receipts are retained in the repository. All 17 final host acceptance tests passed, including real seatbelt execution, PID reuse refusal and unavailable-source refusal. Full suites remain the promotion batch's responsibility under the operator's testing instruction.
headline: Process checks now work inside macOS sandboxes without setuid tools
blockers: []
proposals: []
learnings:
  - Darwin proc_pidinfo supplies start seconds and microseconds without setuid execution; KERN_PROCARGS2 supplies argv, and kernel status distinguishes stopped processes and zombies.
  - Darwin argv can be unavailable with EINVAL or EIO during process transitions; a freshly confirmed kernel command name keeps snapshots usable, while permission failures still refuse.
  - Seatbelt cannot nest inside this worker sandbox; the focused kernel acceptance ran on the host and applied its own nontrivial profile.
  - Native identity-only reads let the slot compare births and ancestry without depending on argv access. Some other-user identities, including PID 1 in this sandbox, remain unreadable and therefore unknown.
  - Linux durable slot births need the boot UUID as well as start ticks; kernel births remain authoritative when the wall clock changes.
artifacts:
  - "Commit: Read test process identities without setuid ps (b91011b)"
  - "Commit: Use kernel birth identities for the host test slot (1beab29)"
  - "Branch: lane/no-setuid-ps; rebased onto main after the supervisor promoted test-slot"
  - "Source and rebuild path: lib/processes.mjs, lib/process-source.c, lib/native/build.mjs, lib/native/manifest.json, lib/native/README.md"
  - "Acceptance tests: test/no-setuid-processes.test.mjs and test-slot/test/no-setuid.test.mjs"
  - "Evidence: docs/reports/evidence/ENG-122-no-setuid-ps/process-tests-red.log; five intended failures before implementation, one nested-seatbelt skip"
  - "Evidence: docs/reports/evidence/ENG-122-no-setuid-ps/slot-tests-red.log; two intended failures before slot implementation, one nested-seatbelt skip"
  - "Evidence: docs/reports/evidence/ENG-122-no-setuid-ps/focused-runner.log; 62 passed, one nested-seatbelt skip, zero failures"
  - "Evidence: docs/reports/evidence/ENG-122-no-setuid-ps/cleanup-and-pty.log; 33 passed, zero failures or skips"
  - "Evidence: docs/reports/evidence/ENG-122-no-setuid-ps/host-slot-regressions.log; 53 passed, one nested-seatbelt skip, zero failures"
  - "Evidence: docs/reports/evidence/ENG-122-no-setuid-ps/host-seatbelt-acceptance.log; 17 passed, zero failures or skips"
  - "Final smoke command after this report commit: ORG_ACTOR=eng122-r163-lane-check node lanes/lane.mjs check; receipt in .lane/gate.json"
decisions:
  - text: Share the dependency-free kernel reader in lib and ship both Darwin architectures with source and binary checksums, with no runtime compiler fallback.
    category: tooling
    why: The runner and installed host slot both need reliable process identities inside the OS sandbox, and the existing distribution already includes lib.
  - text: Preserve legacy UTC/C start strings and add precise birth fields to new slot records; retain unknown locks when identity reads fail.
    category: tooling
    why: This keeps bch-cloak interoperability while distinguishing same-second PID reuse and Linux reboots without weakening refusal behavior.
  - text: Run the written and adapted focused tests during development and reserve full suites for promotion; run lane check last.
    category: prover
    why: The operator's explicit brief supersedes the older baseline and full-suite lane instructions. No baseline, npm test, test:promotion, test:lanes or live harness was run.
questions: []
challenges: []
---

The public test-helper imports continue to expose `lookupProcess` and
`parseProcessLookup`; registration, receipt ownership, fresh signal confirmation
and group auditing retain their existing interfaces. The shared reader emits
complete JSON records on Darwin and brackets Linux argv reads with two `/proc`
start-tick reads. Malformed, duplicate, truncated, denied or changed identities
never become signal evidence. Missing/damaged/stale/redirected native bundles,
unsupported platforms and unavailable sources refuse clearly. Darwin binaries
are checked for architecture and executable type as well as hashes and forbidden
setuid/setgid bits.

Both direct fixture `ps` calls were replaced, and deadline, cancellation and slot
failure injections were adapted to the new sources. Cleanup testing found and
resolved transient Darwin argv failures. The native reader preserves stopped
states for inbox teardown. One audit fixture now remains alive for 50 ms so its
intentional background-child leak is established before ownership registration.

The final seatbelt acceptance applies `(version 1)(allow default)(deny network*)`.
It demonstrates actual refusal of `/bin/ps`, successful bounded suite execution
and teardown, and host-slot operation with token-free nested acquisition. The
slot's new UTC/C timestamp was compared directly with the old `ps` output outside
that profile. Missing-source tests verify that the runner starts no fixture and
that a fresh slot creates neither a lock nor its command. Other cases cover
identical argv with changed microsecond births, malformed/truncated proc data,
orphan group members, stopped states, Unicode and multiline argv, Linux boot UUIDs,
and refusal to alter live ambiguous legacy locks.

Focused commands retained in the receipts:

```sh
ORG_ACTOR=eng122-final-focused node test/helpers/run.mjs test/no-setuid-processes.test.mjs test/processes.test.mjs test/load-deadlines.test.mjs test/inbox.test.mjs
ORG_ACTOR=eng122-cleanup-fixed node test/helpers/run.mjs test/test-hangs.test.mjs test/pty.test.mjs
ORG_ACTOR=eng122-slot-verified node --test test-slot/test/test-slot.test.mjs test-slot/test/no-setuid.test.mjs
ORG_ACTOR=eng122-host-final node --test test/no-setuid-processes.test.mjs test-slot/test/no-setuid.test.mjs
```

The last command ran outside the enclosing worker sandbox solely so the tests
could apply their own seatbelt boundary. Linux behavior was verified with injected
proc/clock/boot data on this Darwin host; no physical Linux-host result is claimed.
The full `npm test` run under the promotion profile remains deferred to promotion
as instructed. This report claims focused kernel and caller acceptance, not a
completed release gate. The self-review covered the complete diff against the
brief and `git diff --check` was clean. The final lane smoke follows the report
check and commit, so its exact committed-head receipt lives in `.lane/gate.json`.

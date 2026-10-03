**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: 8cc3df963c8f056d25ee1c8ecd4be8baa0c54621
Topic: no-setuid-ps
Round: 1
Review ID: lr-4fc829e2127d3b5ac3cc63f0a82307e4
Base branch: main
Base commit: 61be51b51911b1b713434071d5989585c40b5ecc

## Findings
- [Moderate] lib/process-source.c:30 - Every Darwin identity read, including the identity-only reads used by the host test slot, goes through proc\_pidinfo with PROC\_PIDTBSDINFO, which the kernel restricts to same-user targets for unprivileged callers (the engineer report records PID 1 as unreadable); setuid ps could read any process, so a stale slot lock whose holder PID or group id has been reused by another user's process now turns into TEST\_SLOT\_HOLDER\_UNKNOWN instead of gone, and that refusal lasts as long as the foreign process lives, which regresses the brief's requirement to keep test-slot working; Fix: in the native source read the identity fields through the unprivileged sysctl CTL\_KERN KERN\_PROC KERN\_PROC\_PID kinfo\_proc record (p\_starttime seconds and microseconds, e\_ppid, e\_pgid, p\_stat), at least for identity-only reads, keep the same seconds:microseconds birth format, rebuild both binaries and the manifest, and restore a foreign-uid reuse regression case.
- [Minor] test-slot/test/test-slot.test.mjs:245 - The dead-holder recovery case labelled pid reused another start time was changed from PID 1 to process.pid, so it now duplicates the last row of the same table and no longer covers a holder PID reused by a process the reader cannot fully inspect, which hides the regression above; Fix: restore the PID 1 (foreign-uid) case and assert gone, or, if foreign identities stay unreadable by design, assert and document the unknown outcome in test-slot README instead of dropping the case.

## Re-executed
```json
[]
```

## Non-claims
- This review does not claim that any test passes; no build, test or check command was run.
- This review does not claim the committed Darwin executables were rebuilt from the committed C source; only their SHA-256 values were compared with the manifest.
- This review does not claim behavior on a physical Linux host.

## Unverified
- No Review run budget was granted in the supplemental brief, so the run budget was zero; no focused, seatbelt, slot or gate command was re-executed and all test evidence is inherited from committed logs and the npm run test:fast gate.
- The acceptance item that npm test runs under a seatbelt profile forbidding setuid exec is covered only by a single-fixture bounded-runner smoke and a slot smoke under sandbox-exec; the full suite under seatbelt was not run in the lane per operator instruction and is not proven by this review.
- The same-user restriction of PROC\_PIDTBSDINFO outside a sandbox was not exercised empirically here (zero budget); it rests on kernel behavior knowledge and the engineer's recorded observation that PID 1 is unreadable.
- Reproducibility of the committed arm64 and x64 executables from the C source with the recorded flags was not checked because rebuilding is a build command outside the zero budget; checksums match the manifest and the arm64 binary is ad hoc linker-signed.
- Linux legacy start strings computed from btime plus start ticks were not compared with a real procps lstart on Linux; procps derives boot time from uptime and may differ by one second from btime for records written by an older ps-based runner.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->

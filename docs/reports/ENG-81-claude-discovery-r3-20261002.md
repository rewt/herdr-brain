---
run: R-93
outcome: blocked
summary: |
  Fixed all three round-three findings with regression tests: validation seccomp now denies by default, validation cleanup contains detached descendants using positive kernel identities, and pending-only Claude probes emit Linux evidence with setup cleanup. Host and native sandbox checks pass, as do all 148 lane tests. Full npm test repeatedly fails an unchanged settlement fixture teardown with ENOTEMPTY. Live Claude proof remains PENDING on HUM-19; no credentials or model sessions were accessed.
headline: The sandbox review fixes pass, but settlement teardown still blocks full validation.
blockers:
  - Live Claude discovery and integration proof remains PENDING until the operator answers existing question HUM-19; its absence is not a code failure.
  - Actual Linux bubblewrap and asynchronous socket proof requires the Linux host tracked by existing item ENG-92.
  - Full npm test is not green because the unchanged settlement fixture teardown fails with ENOTEMPTY after the recorded-correction recovery case; an isolated main control passes, so a main-branch reproduction is not claimed.
proposals:
  - role: engineer
    title: Make settlement fixture teardown wait for owned watcher exit
    why: Full npm test fails the same ENOTEMPTY teardown in three runs, including a serial run, at settle/test/fixture.mjs after the recorded-correction recovery case. The fixture and test are identical to main. Establish positive watcher ownership and finish bounded teardown before removing the root so validation and promotion can pass reliably.
learnings:
  - Network namespaces do not hide host filesystem Unix sockets, and asynchronous io_uring operations can bypass a socket syscall blacklist; validation must deny unlisted syscalls by default.
  - New sessions and double forks escape process-group cleanup. macOS inherited kernel read-policy probes and generation-checked signals identify owned descendants without process names, environment matching or broad group signals.
  - Linux subreaper adoption preserves ownership of detached and double-fork descendants across parent exit; cleanup must continue until no adopted children remain.
  - A pending-only Claude probe needs no live platform guard, and evidence-writing failure must not bypass installed-snapshot cleanup.
artifacts:
  - 'Commit: Deny unknown validation syscalls and contain detached descendants'
  - 'Commit: Report validation boundary fixes and pending Claude proof'
  - 'Main rebase subject: Brief for ENG-94: the supervisor module'
  - 'Branch: lane/claude-discovery'
  - discovery/bubblewrap.mjs
  - discovery/syscalls.mjs
  - discovery/bounded.mjs
  - discovery/process-supervisor.c
  - discovery/lifetime.mjs
  - discovery/confinement.mjs
  - discovery/validate.mjs
  - discovery/git-driver.mjs
  - discovery/acceptance.mjs
  - discovery/test/review-r3.test.mjs
  - discovery/test/helpers/seccomp-network.c
  - discovery/test/helpers/lifetime.cjs
  - discovery/README.md
  - docs/reports/ENG-81-claude-discovery-r3-20261002.md
  - /private/tmp/eng81-r93-baseline.log
  - /private/tmp/eng81-r93-final.log
  - /private/tmp/eng81-r93-verified.log
  - /private/tmp/eng81-r93-serial.log
  - /private/tmp/eng81-r93-lanes.log
  - /private/tmp/eng81-r93-host.log
  - /private/tmp/eng81-r93-native.log
  - /private/tmp/eng81-r93-final-host.log
  - /private/tmp/eng81-r93-final-regressions.log
  - /private/tmp/eng81-r93-main-control.log
  - /private/tmp/eng81-r93-existing-review/0a2bbeb-r2.md
  - /private/tmp/eng81-r93-lane-check.log
  - .lane/gate.json
decisions:
  - text: Replace the socket syscall blacklist with explicit synchronous runtime syscall allowances and a default EPERM verdict.
    category: security
    why: The round-three instruction authorizes this boundary fix; io_uring, socket creation, BPF, ptrace and unknown syscalls receive no allowance, and incompatible ABIs fail closed.
  - text: Use a foreground native owner to clean every owned validation descendant across sessions and process groups, with kernel identity checks before signalling.
    category: security
    why: The round-three instruction requires positive ownership. Linux adopts orphans as a subreaper; macOS identifies the inherited private read policy and uses audit-token PID generations. Unknown processes are never cleanup targets.
  - text: Defer the macOS Claude guard until live execution is required and cover allocation, installation and evidence creation with cleanup.
    category: prover
    why: Pending-only probes must work without authentication on Linux, and setup failures must not leave installed snapshots or copied project roots.
  - text: Keep both unexecuted Claude live cases classified as PENDING.
    category: prover
    why: HUM-19 remains the operator prerequisite. No missing live session is counted as a code failure or successful acceptance.
questions: []
challenges:
  - All three requested code regressions pass, but the required full suite failed the same unchanged settlement teardown in both four-file and serial execution. The isolated main case passed. The report preserves these limits rather than treating a focused pass as full acceptance.
  - This macOS host cannot execute the Linux kernel io_uring regression. Its explicit skip is not evidence that the bubblewrap kernel boundary passed; ENG-92 remains pending.
---

The code is committed as **Deny unknown validation syscalls and contain detached descendants**. This report is committed as **Report validation boundary fixes and pending Claude proof**. The lane was rebased onto main before editing and again after main moved, picking up **Brief for ENG-94: the supervisor module**. No merge, push, promotion, release, shared-record event, user configuration or live pane mutation was performed.

| Finding | Fix and evidence |
| --- | --- |
| io_uring could create a host AF_UNIX socket despite the socket blacklist | `socketFilter` now emits an explicit x64/arm64 allow list and ends with EPERM. All three io_uring entry points and unknown syscalls are denied. The x32 number range is refused, foreign ABIs are killed, and clone3 is denied with ENOSYS so libc can use ordinary clone. BPF regressions cover both ABIs, runtime file IO and default refusal. The Linux C fixture first creates and connects a host filesystem socket asynchronously, then attaches the actual generated BPF and checks refusal of socket creation, setup, enter, register and an unknown syscall. That kernel fixture is explicitly skipped here. |
| Detached children survived completion and timeout | A foreground native owner waits for the command, then repeatedly stops and kills owned descendants before returning. Linux uses subreaper adoption and held child identities. macOS uses two private read probes to recognize the inherited policy, verifies stable kernel identities, and signals through PID-generation audit tokens. An ownership receipt precedes project execution; missing policy prevents execution. Private probes sit outside writable grants. The macOS policy denies signals to owners outside that sandbox, and a child cannot replace its inherited policy. Tests launch actual detached double-fork delayed writers and check cleanup after completion, deadline and wrapper death; an unrelated same-group writer survives. |
| Pending Linux probes failed before evidence and leaked setup | The live platform guard runs only when a live Claude session is required. Platform-simulated Linux no-auth and skip-live tests assert two PENDING rows, zero FAIL rows, no native invocation, empty usage and snapshot cleanup. Setup-error tests cover failed installation with keep enabled, failure of the second temporary-root allocation, and failure to create evidence. Cleanup removes snapshots and copied roots even when writing the summary also fails. |

The owner is built with the fixed system compiler in private no-follow-checked scratch storage, with compiler environment overrides excluded. Compilation is bounded to 15 seconds; project execution to 120 seconds; cleanup to three seconds. Missing compiler, missing ownership or unconfirmed cleanup refuses execution. No unbounded or unsandboxed retry was added. The core remains dependency-free and does not call a model. Existing provider settings, shared-state exclusions, filter identity behavior and managed native validation settings are retained.

Every privileged writable grant retains component-by-component lstat, realpath and O_NOFOLLOW checks. New private lifetime roots are checked before provider construction and redirected marker parents are regression-tested. Git metadata paths were checked with realpath and lstat before requesting sandbox exceptions for rebases and commits. The operator's private findings were read in place and were not copied into the repository. The pre-existing untracked sanitized review was preserved in the listed scratch directory so it would not be included in these commits or invalidate the clean gate.

Linux syscall numbers follow the primary [x86 syscall table](https://github.com/torvalds/linux/blob/master/arch/x86/entry/syscalls/syscall_64.tbl) and [generic syscall definitions](https://github.com/torvalds/linux/blob/master/include/uapi/asm-generic/unistd.h). These sources supplied the ABI mapping; the actual Linux kernel regression remains unexecuted on this host.

| Check | Observed result |
| --- | --- |
| Baseline npm test before changes | 506 total, 498 passed, 8 skipped, 0 failed; 56.7 seconds. |
| Full npm test after final fixes, four concurrent files | 554 total, 544 passed, 9 skipped, 1 failed; 164.0 seconds. The failure is the settlement teardown described below. |
| Full npm test, serial rerun | 554 total, 544 passed, 9 skipped, 1 failed; 191.1 seconds. Same settlement teardown. |
| npm run test:lanes | 148 passed, 0 failed, 0 skipped; 349.4 seconds. |
| Host sandbox alternatives plus round-two and round-three regressions | 39 total, 38 passed, 1 Linux kernel skip, 0 failed; 24.2 seconds. |
| Native Codex sandbox lane/promotion and confinement checks | 4 passed, 0 failed; 9.7 seconds. No model session. |
| Host alternatives plus owner-signal regression | 21 total, 20 passed, 1 Linux kernel skip, 0 failed; 8.4 seconds. |
| Final round-three regressions, including evidence-directory failure, against real macOS and native Codex policies | 14 total, 13 passed, 1 Linux kernel skip, 0 failed; 7.4 seconds. |
| Isolated recorded-correction recovery case against main | 1 passed, 9 name-filter skips, 0 failed; 9.9 seconds. |

The full-suite failure is `resolved blocker links allow recovery of only the recorded correction run`. Its assertions complete, but its teardown raises ENOTEMPTY from `settle/test/fixture.mjs:56` while removing its scratch root. Both settlement files have no diff against main. The initial four-file run also had the same failure (553 total, 543 passed, 9 skipped, 1 failed), before the last evidence-cleanup regression was added. Serial execution did not eliminate it, and the isolated main control passed; the evidence does not establish a fully reproduced defect on main. The proposal targets reliable, positively owned watcher teardown rather than weakening the assertions or claiming this suite is green.

Tests are offline, use their own ORG_ACTOR, and run under bounded subprocess or suite deadlines. Scratch npm script-shell helpers select four or one concurrent files; tracked package scripts and user configuration are unchanged. No token or cost measurement is claimed because no authenticated Claude turn ran. Live cases stay PENDING under HUM-19, separately from the actual full-suite failure.

The final lane check runs after this report is checked and committed. Its authoritative result is `.lane/gate.json` and `/private/tmp/eng81-r93-lane-check.log`; no result is predeclared here. Stop immediately after that gate, as instructed.

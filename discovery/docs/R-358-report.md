---
run: R-358
outcome: done
summary: |
  Fixed all four review findings. Host PTY access now uses Seatbelt's kernel-issued own-slave extension instead of a blanket terminal prefix grant, with terminal aliases denied and inherited stdin replaced by /dev/null. Native probes prove own-slave operations work while foreign opens, writes through opens, terminal-changing ioctls and stale-extension device reuse are denied. Host tests run automatically on capable macOS hosts and are included in promotion coverage. Session lane check options now refuse explicitly, and unborn repositories retain default validation while rejecting uncommitted host declarations. Focused tests passed; the final lane check follows the report commit as instructed.
headline: Host suites now confine terminal access to their own allocated devices
blockers: []
proposals: []
learnings:
  - Apple's installed application sandbox profile uses com.apple.sandbox.pty together with a slave-device predicate. This permits newly allocated slaves and their descendants without granting other sessions' devices; the native probe also verified denial after the same device name was recycled outside the sandbox.
  - Seatbelt does not revoke writes on an already inherited writable terminal descriptor. Host suites therefore receive /dev/null stdin and validation log output descriptors. State-changing foreign ioctls are denied; informational FIONREAD on a deliberately inherited read-only fixture descriptor is not a sandbox-mediated state mutation.
  - git rev-parse --verify --quiet HEAD exits one without stderr in an unborn repository. Treat that as absent committed host declarations while preserving refusals for local host authority that differs from committed content.
artifacts:
  - 'Implementation and evidence commit: ce450df on lane/host-suites'
  - discovery/confinement.mjs
  - discovery/host-validate.mjs
  - lanes/host-suites.mjs
  - discovery/README.md
  - discovery/test/host-suites.test.mjs
  - lanes/test/validation.test.mjs
  - docs/evidence/ENG-295-R-358/host-suites.tap
  - docs/evidence/ENG-295-R-358/validation-and-confinement.tap
  - docs/evidence/ENG-295-R-358/lane-focused.tap
  - discovery/docs/R-358-report.md
  - /Users/rewt/development/rewt/.org/runs/R-358/report.md
decisions:
  - text: Restrict host PTY access to kernel-issued own-slave extensions and remove inherited terminal stdin.
    category: security
    why: The correction explicitly requires isolation from operator panes and other sessions. Apple's native facility enforces that boundary on this host; focused probes verify own use, foreign denial, descendant reopening and recycled-device denial without a broad terminal grant.
  - text: Enable host-profile tests automatically after a native macOS host probe and schedule the file in promotion coverage.
    category: tooling
    why: The correction requires automatic execution by the offline integration checks without an opt-in environment variable. Probe failures produce explicit skips; fixtures use private slots rather than the host slot.
questions: []
challenges: []
---

Validation before the implementation commit:

- Host suite file: 9 passed, zero skipped, using the automatic host probe with no opt-in variable. The native PTY test verifies openpty, raw mode, bidirectional slave traffic, FIONREAD, own-slave reopening and descendant use. Read/write opens through the actual foreign path and a symlink fail. Terminal configuration and keystroke injection ioctls fail on a separately inherited read-only foreign fixture descriptor. Reallocation of the exact same device name outside the sandbox also fails to reopen through the stale extension.
- Validation, ordinary native confinement, native deadline and tier-selection files: 24 passed, zero skipped. The new unborn-repository regression checks defaults, ordinary local validation configuration and refusal of uncommitted host authority.
- Focused lane CLI cases (`check ` and `usage exits`): 8 passed; 145 unrelated cases excluded by the name selector. The new session-option regression additionally runs in the host suite file and proves unsupported options create no request files.
- Syntax and whitespace checks passed. README and each PTY host-suite receipt/log disclose the terminal boundary. The end-to-end host case verifies null stdin, receipt limits, preserved socket/write/network confinement and tree-bound evidence; the watchdog case verifies temp cleanup.

The native tests ran through approved host command escalation because sandbox-exec cannot apply a second sandbox from this worker profile. They use offline fixture repositories, their own PTYs and private fixture slots. No operator terminal was targeted. No baseline, full npm test, promotion/release tier, live acceptance harness or real host test slot was run.

The required sequence is implementation commit, this report, record check, report-copy commit, then lane check last. This report does not claim promotion or integration into main.

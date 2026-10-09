---
run: R-356
outcome: done
summary: |
  Added committed canonical host-suite declarations, name-only lane check requests to the session parent, and a macOS host validation runner with private temp, scoped Unix sockets, raw PTYs, process enumeration, protected writes and denied external outbound traffic. Named checks and fast/promotion tier selections produce ordinary tree-bound validation receipts and immutable logs under the shared slot and watchdog. Targeted offline checks passed. TCP listener limits are disclosed in every host-suite receipt and the README, following the supervisor's explicit approval. Nonempty external allowlists fail closed because Seatbelt cannot enforce specific external destinations. The final lane check follows the report commit as instructed.
headline: Declared host suites now run with protected writes and recorded network limits
blockers: []
proposals:
  - role: engineer
    title: Enforce declared external host and port allowlists for host validation
    why: The host-suite declaration accepts an external_network endpoint list, but the current runner refuses nonempty lists because macOS Seatbelt supports only localhost or wildcard address rules. A separately enforcing transport is needed before an external suite can run; no current bch-cloak gate suite needs it.
learnings:
  - Seatbelt localhost bind predicates also admit wildcard local addresses. A same-host nonloopback connection was accepted by a wildcard listener even with attempted remote inbound filters; inbound filtering cannot be claimed from those rules.
  - Raw PTYs need pseudo-tty and PTY device ioctl/read/write grants. The fixture exercises openpty, slave raw mode and FIONREAD, rather than only opening a terminal device.
  - Private run temp must be owned by the receipt parent so watchdog group termination cannot bypass cleanup. TMPDIR, TMP, TEMP and os.tmpdir point there; project-specific scratch and bind variables belong in declared commands.
artifacts:
  - 'Implementation commit: 5cd282f on lane/host-suites'
  - discovery/host-validate.mjs
  - lanes/host-suites.mjs
  - discovery/test/host-suites.test.mjs
  - discovery/README.md
  - docs/evidence/ENG-295-R-356/host-final.tap
  - docs/evidence/ENG-295-R-356/host-and-deadlines.tap
  - docs/evidence/ENG-295-R-356/lane-validation.tap
  - docs/evidence/ENG-295-R-356/sandbox-logic.tap
  - docs/evidence/ENG-295-R-356/watchdog-config.tap
  - /Users/rewt/development/rewt/.org/runs/R-356/report.md
decisions:
  - text: Allow host TCP listeners with external outbound traffic denied and disclose the wildcard inbound limitation in each receipt.
    category: security
    why: Supervisor-herdr explicitly approved option 2 in this run. It is tighter than the prior unconfined manual reruns; bch-cloak suites bind 127.0.0.1 explicitly. The worker session sandbox remains unchanged. The supervisor owns the listener-auditing follow-up.
  - text: Load host commands and capabilities only from committed canonical declarations and refuse lane-edited host policy.
    category: security
    why: A name-only request must not let a worker select a command, checkout or broader capability. Both parent planning and runner launch revalidate canonical authority and the exact committed tree.
  - text: Accept external endpoint declarations but refuse their execution until a specific destination allowlist can be enforced.
    category: security
    why: Both a primary runtime source and a direct sandbox-exec compiler check confirm that specific external hosts/IPs cannot be used in the native address predicate. A wildcard grant would violate the requested boundary.
  - text: Keep ordinary native validation deadlines and use a separate twelve-hour host transport envelope around the shared slot and ENG-274 command watchdog.
    category: tooling
    why: A named host suite must not inherit the ordinary fast step's 120-second transport cutoff while waiting for a slot or running a longer test. Host command wall and idle limits still apply, and native containment remains bounded.
questions: []
challenges:
  - The external allowlist format is implemented, but declared external execution remains unavailable and refuses before the slot or command. This follows the ask's fail-closed requirement; current gate suites need no external network.
  - Host selections support fast and promotion tiers, including merge-train validation. Release uses its separate snapshot/gate declaration and cannot select host suites through tier_suites.
---

Implemented and committed the requested parent-run path without changing native worker settings, installing dependencies, invoking a model, running a live acceptance harness, or acquiring the real host test slot. Applicability tests use their own private fixture slots and repositories.

Validation:

- Final host profile file: 7/7 passed. An actual sandboxed `lane check --suite sockets` sends only `{op: check, suite: sockets}` to the parent; the parent executes the canonical declaration. The probe opens/connects localhost TCP and private-temp Unix listeners, creates raw PTYs with FIONREAD, lists a child with pgrep, signals its child, refuses signalling an unrelated parent, refuses external outbound connections, and refuses writes outside checkout/temp, to shared /private/tmp, Git metadata, canonical .lane and the record. Receipt, log, tier reuse and watchdog cleanup are verified.
- Combined host and ordinary native deadline regressions: 9/9 passed, including real descendant cleanup in the copied ordinary validation stack.
- Lane validation regressions: 17/17 passed, with private fixture slot contention, reuse, failed receipts and tree/command changes.
- Watchdog configuration compatibility: focused case passed. It preserves legacy configuration inspection in non-Git scratch directories.
- In the worker sandbox, host syscall applicability skips explicitly; the logic/refusal cases passed.
- Final isolated 100-PTY fixture: direct 21.7985 ms; profile 35.5913 ms (13.7928 ms aggregate difference). These are one-run measurements under current machine load, not a general timing guarantee. There is no JavaScript mediation per PTY syscall; the profile is applied once per suite.

An initial pgrep full-argv match did not identify the fixture process; the final deterministic parent-PID enumeration verifies the intended process-listing capability. Initial sandbox watcher EMFILE failures in two existing lane cases disappeared when the same focused file ran from the host with private fixture slots. The configuration-only non-Git regression found during development was fixed and rechecked.

The canonical project must commit its host declarations before a worker rebases and requests them. The implementation does not edit bch-cloak's checkout. Its fixed /private/tmp fixture names still need to move to TMPDIR on that project's side. No HOST, BIND or project-specific scratch variable is guessed by the runner; those can be assigned explicitly in the canonical suite command.

As requested, the implementation commit precedes this report, then record check and a committed report copy precede the final lane check. This report does not claim promotion or integration into main.

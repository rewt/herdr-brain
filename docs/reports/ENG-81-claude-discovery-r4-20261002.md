---
run: R-99
outcome: blocked
summary: |
  Implemented the supervisor's round-four scope decision. Bubblewrap is disabled by default, never selected automatically, and requires an explicit experimental validator selector. Existing Codex installs retain their native provider; Linux auto validation otherwise refuses clearly. New regressions cover gating and actual macOS/Codex applicability, and both required suites pass. The two Linux findings remain on ENG-92. Live Claude proof stays PENDING under HUM-19; no live Claude session or credential access was attempted.
headline: Bubblewrap now requires explicit experimental selection while macOS and Codex validation remain available.
blockers:
  - Live Claude discovery and integration proof remains PENDING until the operator answers existing HUM-19; missing live proof is not a code failure.
  - Experimental Linux bubblewrap's reviewed mount race, file-copy support and actual kernel proof remain deferred to ENG-92 on a Linux host. The provider stays disabled by default.
proposals: []
learnings:
  - An ordinary bubblewrap path is not an experimental opt-in; the explicit selector must survive installation and bounded Git filter transport before the provider command is constructed.
  - Bubblewrap's presence on PATH never authorizes automatic selection. Existing native Codex installation defaults remain independent of the experimental Linux adapter.
  - Actual macOS and native Codex policies support nonempty Node file copies. After a validated temporary root is redirected outside the checkout, macOS denies the write and Codex rejects the writable root before project execution.
artifacts:
  - 'Commit: Gate bubblewrap behind explicit experimental selection'
  - 'Commit: Report experimental bubblewrap gating and pending Claude proof'
  - 'Main rebase subject: Brief for ENG-94: the supervisor module'
  - 'Branch: lane/claude-discovery'
  - discovery/confinement.mjs
  - discovery/bubblewrap.mjs
  - discovery/install.mjs
  - discovery/README.md
  - discovery/test/review-r4.test.mjs
  - discovery/test/alternatives.test.mjs
  - discovery/test/review-r2.test.mjs
  - docs/reports/ENG-81-claude-discovery-r4-20261002.md
  - /private/tmp/eng81-r99-baseline.log
  - /private/tmp/eng81-r99-final.log
  - /private/tmp/eng81-r99-verified.log
  - /private/tmp/eng81-r99-lanes.log
  - /private/tmp/eng81-r99-host.log
  - /private/tmp/eng81-r99-native.log
  - /private/tmp/eng81-r99-launcher.log
  - /private/tmp/eng81-r99-focused.log
  - /private/tmp/eng81-r99-existing-review/8399269-r3.md
  - /private/tmp/eng81-r99-lane-check.log
  - .lane/gate.json
decisions:
  - text: Require experimental-bubblewrap followed by an absolute executable path as the explicit validator selector, and remove all automatic bubblewrap discovery.
    category: security
    why: The supervisor's scope decision and R-99 instruction authorize this gate until the Linux provider's outstanding findings and proof are resolved on ENG-92. Ordinary paths and symlink aliases cannot activate the adapter implicitly.
  - text: Preserve existing native Codex installation defaults and make Linux auto validation refuse with the supported-provider and experimental-selection instructions.
    category: design
    why: Without an opt-in, validation must use the existing provider or refuse clearly; it must never execute an ordinary shell as a fallback.
  - text: Verify the reviewed behaviors on the actual macOS and native Codex paths while leaving Linux mount and syscall repairs to ENG-92.
    category: prover
    why: This Mac can prove file copying and outside-write refusal for those providers, but cannot establish the Linux kernel boundary.
  - text: Keep unexecuted live Claude cases PENDING under existing HUM-19.
    category: prover
    why: The operator prerequisite remains unanswered and this run's evidence is offline.
questions: []
challenges:
  - The Linux findings are gated rather than repaired here, as instructed. Experimental opt-in does not establish safety or successful Linux file copying.
  - An initial focused run inside the agent tool sandbox could not initialize nested macOS policies. The correctly scoped host rerun outside that sandbox passed; the failed nested run is retained as execution-context evidence rather than a product regression.
---

The code is committed as **Gate bubblewrap behind explicit experimental selection**. This report is committed as **Report experimental bubblewrap gating and pending Claude proof**. The initial rebase onto main was clean and already up to date with **Brief for ENG-94: the supervisor module**. Main remained an ancestor through the required tests and code commit.

The public opt-in is:

```sh
--validator experimental-bubblewrap:/absolute/path/to/bwrap
```

The installer and either entry adapter accept that exact validator value. The installer preserves it in the launcher and installation receipt. Selection keeps the marker intact through bounded Git filter transport, and `sandboxCommand` alone converts it into the experimental mount command. The internal `bubblewrap.mjs` launcher requires its own explicit `--experimental-bubblewrap` argument and an absolute executable before allocating the filter or launching a provider. A stub-launch regression proves that legacy arguments launch nothing, while explicit opt-in reaches the selected stub; this is not Linux kernel proof.

| Selection | Result |
| --- | --- |
| macOS auto | Existing sandbox-exec provider. |
| Default installation containing Codex | Existing native Codex provider, including managed settings. |
| Linux auto, even with bwrap and Codex on PATH | Clear refusal directing the user to an explicit native Codex validator or the experimental selector. No PATH discovery of bubblewrap. |
| Bare bwrap, absolute bwrap path, or renamed symlink to bwrap | Refused as experimental and disabled by default. |
| Explicit experimental selector with an absolute executable | Accepted for experimental use and retained through installation and filter transport. |
| Relative, empty or NUL-containing experimental executable | Refused. |

There is no ambient environment enablement. Disabled selection is checked at the shared provider boundary, including preparation, validation, main-mode guards and nonempty Git filters. Installer checks reject ordinary bubblewrap selection before writing a launcher. Platform-simulated Linux regressions prove that default validation and Git filters invoke neither the project command nor the provider. Existing tests for opt-out, pending-only probes, filter identity, no-follow grant checks and confinement remain green.

Both round-three review findings concern the experimental Linux implementation: source/destination mount resolution after path inspection, and the omitted synchronous copy syscalls. Neither Linux repair was attempted here, and the syscall table remains unchanged. They remain on ENG-92. Documentation describes the unresolved limitations and confines opt-in guidance to experimental scratch testing.

Applicability was checked on the real host and native Codex paths. Each test copies nonempty binary data both within the checkout and into a temporary exception beneath a protected .lane directory. It then replaces the validated temporary directory with an external symlink after profile construction and attempts to overwrite an outside sentinel. macOS starts the probe but its workspace predicate denies the redirected write. Native Codex refuses the symlinked writable root before project execution. Both preserve the sentinel. These checks establish those specific supported-provider behaviors; they do not prove the Linux mount race or a Linux kernel boundary.

| Validation | Observed result |
| --- | --- |
| Baseline npm test before changes | 554 total, 545 passed, 9 skipped, 0 failed; 194.8 seconds. |
| First full npm test after changes | 562 total, 551 passed, 11 skipped, 0 failed; 155.1 seconds. |
| Final full npm test including the positive experimental launch check | 562 total, 551 passed, 11 skipped, 0 failed; 189.9 seconds. |
| npm run test:lanes | 148 passed, 0 failed, 0 skipped; 361.8 seconds. |
| Actual macOS/Codex applicability plus alternative and review regressions | 49 total, 48 passed, 1 explicit Linux-only skip, 0 failed; 25.9 seconds. |
| Native Codex confinement, managed settings, lane validation and promotion | 4 passed, 0 failed; 11.6 seconds. |
| Positive and negative direct experimental launcher control | 1 passed, 7 name-filter skips, 0 failed; 0.3 seconds. |

The full-suite skips include the two optional actual-host applicability cases, which passed in the explicitly enabled host run. The existing Linux io_uring kernel regression explicitly skips on this Mac. All new cases assign their own ORG_ACTOR and have a 20-second test bound; subprocesses and full suites have additional bounds. Scratch npm script-shell configuration selects four concurrent files without changing tracked package scripts or user configuration. No model or token measurements are claimed.

All privileged writable-path checks remain intact: component lstat, realpath and O_NOFOLLOW verification precede provider exceptions. Git metadata and gate paths were also checked component by component before sandbox exceptions for lifecycle commands. The private findings were read in place and were not copied into the repository. The pre-existing untracked sanitized review was preserved in the listed scratch directory for a clean commit and gate.

Live Claude cases remain PENDING under HUM-19. This run accessed no Claude credential source or model session and did not change the historical live evidence. Existing ENG-95 teardown work was not repaired by this change; the green suite counts above are this run's observations.

This report is checked and committed before the final lane check. The gate's authoritative result is `.lane/gate.json` and `/private/tmp/eng81-r99-lane-check.log`; no result is predeclared in this report. Stop immediately after that check, as instructed.

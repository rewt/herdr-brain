---
run: R-80
outcome: blocked
summary: |
  Added macOS and Linux host sandbox alternatives, Claude-only installation, bounded Git clean/smudge/process filter transport, and a Claude Haiku variant of the independent discovery probe. Offline and actual macOS/Codex sandbox checks pass. Real Claude discovery remains unproven: the scratch sessions returned Not logged in, with zero model tokens and zero cost. Automatic approval review refused credential extraction without specific authorization; that permission remains pending. The implementation is committed on this lane and rebased onto main.
headline: Host validation and Git filters work while live Claude proof awaits authentication
blockers:
  - "Real Haiku discovery needs usable operator-authorized authentication. The active Claude profile reported no login, the file credential inspected for expiry was expired, and the empty scratch profiles returned Not logged in. Keychain access was rejected by automatic approval review and no permission to proceed has arrived."
proposals:
  - role: engineer
    title: Prove the bubblewrap validation and Git filter boundary on a Linux host
    why: Linux argv and refusal rules are covered offline, but this Darwin machine cannot establish real mount, namespace and linked-state behavior on Linux. Run the retained kernel fixture on a host with bubblewrap before treating that provider as proven.
learnings:
  - "A filesystem guard must protect both a shared-record symlink's path and its resolved target. Protecting only the target permits unlinking the alias in a writable parent."
  - "Bubblewrap bind mounts cannot protect a writable shared-state symlink inode. This adapter refuses that layout rather than weakening the shared-state boundary."
  - "Claude's variadic allowedTools option can consume a trailing positional prompt. The live probe places the prompt before its option list."
  - "Native Claude can emit a result with subtype success and is_error true for Not logged in; acceptance must reject is_error, even when usage is present."
  - "The default full-suite concurrency encountered watcher timeouts under simultaneous lane tests; four concurrent files completed the full suite with no failures."
artifacts:
  - "Commit: Add host validation sandboxes and bounded Git filter entry"
  - "Commit: Report host sandbox validation and blocked Claude discovery proof"
  - "Branch: lane/claude-discovery"
  - discovery/README.md
  - discovery/acceptance.mjs
  - discovery/confinement.mjs
  - discovery/bounded.mjs
  - discovery/bubblewrap.mjs
  - discovery/git-driver.mjs
  - discovery/test/alternatives.test.mjs
  - docs/reports/ENG-81-claude-discovery-evidence-20261002/summary.json
  - "/tmp/eng81-final.log"
  - "/tmp/eng81-kernel-final.log"
  - "/tmp/eng81-acceptance-offline-final.log"
  - "/tmp/eng81-baseline.log"
  - "/private/var/folders/st/gcpbkfdj1hbb618vgcf59j3w0000gn/T/monitor-projects-u5goB0/evidence"
decisions:
  - text: Add host sandbox providers outside the record core and allow Claude-only machine installation.
    category: security
    why: Validation must remain confined when Codex is absent. Missing providers and kernel setup failures never retry unsandboxed; existing Codex installs retain their managed profile.
  - text: Execute Git clean, smudge and process filters through the validation boundary and require successful filtering.
    category: security
    why: Refusing every active filter prevents legitimate project entry. Sandboxing the filter subprocess preserves Git's protocol while denying outside, shared-record and metadata writes; forcing required filtering prevents silent content changes after a denied filter.
  - text: Bound validation and filter process groups and terminate background descendants.
    category: security
    why: A shell timeout alone can leave grandchildren writing after the check returns. Every preparation, validation and filter process has a 120-second deadline, and trusted broker calls also have a 180-second deadline.
  - text: Keep the Claude live cases failed while authentication is unavailable.
    category: security
    why: A native CLI launch or offline prompt transport is not proof that a real model discovered and completed the workflow. No credential extraction was performed after automatic review rejected it.
questions: []
challenges:
  - premise: This run can mark real Claude discovery proven using the installed Claude executable.
    verdict: wrong
    evidence: All three final scratch sessions returned Not logged in with is_error true and zero input, cache, output and cost. The credential access request is pending, so cases 20 and 21 remain failed rather than passed.
  - premise: Every external Git filter can run inside the fixed validation sandbox.
    verdict: incomplete
    evidence: Local clean/smudge transformations pass entry, commit, check, promotion and ingestion. Filters needing network or metadata cache writes, such as Git LFS fetching into .git/lfs, still fail safely. External merge/diff drivers remain refused.
---

Implemented in **Add host validation sandboxes and bounded Git filter entry**;
this report is committed as **Report host sandbox validation and blocked Claude
discovery proof**. The lane was rebased onto main's **Brief for ENG-90: the harness runs against a release directory** after main moved. No promotion, push, activation,
user harness configuration write or live Herdr mutation was performed.

The entry parent now selects the native Codex provider or a fixed macOS
sandbox-exec / Linux bubblewrap profile. Claude-only installation defaults to the
host provider and creates no Codex launcher. Both native adapters accept an
explicit validator. No record-core module changed and the core remains free of
harness branches and dependencies.

Git's effective clean/smudge/process commands are encoded into bounded overrides
before global execution configuration is disabled. The broker carries those
overrides through the lane CLI, retains author identity, and keeps hooks,
fsmonitor and signing disabled. Canonical and lane driver configurations must
match. Filters preserve stdin/stdout and filename substitution; denial cannot
silently store unfiltered content. Metadata, record aliases/targets and canonical
coordination paths are read-only. The existing clean/rebase/green/fast-forward
promotion and recovery checks remain intact.

Validation evidence:

| Check | Result |
|---|---|
| Initial npm test in nested sandbox | Stalled watcher processes; stopped only this lane's test tree |
| Untouched committed baseline in scratch, bounded npm test | 464 pass, 1 watcher timing failure, 4 skips; 469 total |
| Full npm test before the final socket-guard addition, four concurrent files, five-minute deadline | 469 pass, 0 failures, 7 skips; 476 total |
| Discovery offline suite | 44 pass, 0 failures, 6 skips; 50 total |
| Actual macOS alternative kernel and descendant cleanup fixture | 8 pass, 0 failures, no skips |
| Existing actual Codex sandbox/confinement fixtures | 4 pass, 0 failures, no model calls |
| Offline acceptance safety suite outside the nested sandbox | 51 pass, 0 failures, no model calls |
| Installed Claude probe mechanics | Cases 02, 03 and 04 pass |
| Real Claude concurrent integration / routing | Cases 20 and 21 fail on unavailable authentication |

The macOS kernel fixture denies outside writes, writes through a symlink,
Git metadata writes, record writes/renames and network use, while permitting
ordinary project work. A real filter performs uppercase clean / lowercase smudge
transformations through checkout, commit, validation, fast-forward and ingestion.
The main-mode linked-record fixture denies both target writes and unlinking the
record alias while leaving native runtime and request-queue writes available.
The process-group fixture kills a grandchild before its delayed write. Bubblewrap
argv, host selection, network isolation, syscall-program verdicts and symlink refusals are tested offline;
no real Linux kernel run is claimed. Linux validation also denies socket creation
with seccomp, because filesystem Unix sockets survive network namespaces. Its
ABI checks follow the [Linux seccomp documentation](https://docs.kernel.org/userspace-api/seccomp_filter.html);
syscall numbers come from the [x64 table](https://github.com/torvalds/linux/blob/master/arch/x86/entry/syscalls/syscall_64.tbl)
and [generic arm64 definitions](https://github.com/torvalds/linux/blob/master/include/uapi/asm-generic/unistd.h).

The Claude probe installs a product snapshot separately from pristine unrelated
projects with no AGENTS.md, CLAUDE.md, record or project configuration. It sends
only bounded tasks; workflow policy comes from monitor-claude. The native Claude
tools run inside an additional scratch-only write guard, with empty settings,
plugins and MCP configuration. The probe uses Haiku low and records uncached
input, cache creation/read, output, model usage and CLI-reported cost. Its three
final sessions (French, German, routing) each reported **0 input, 0 cache creation,
0 cache read, 0 output tokens and $0 cost**. These are authentication failures,
not real model turns. The routing-apply session was never reached.

Raw final Claude evidence and the separate installed snapshot are named by the
tracked summary. Earlier scratch attempts exposed and fixed positional prompt
consumption by Claude's variadic option; no successful Claude result is hidden.
The initial baseline and first default-concurrency final runs encountered existing
watcher/open-session timeouts. The bounded four-file rerun passed every case;
no timing assertions were loosened in repository tests.

Automatic approval review rejected the Keychain lookup because reading
credential secrets was not specifically authorized by the user. The requested
permission would allow an existing credential to be read only into a temporary
scratch profile, without printing secrets or changing user configuration. That
request remains pending. Resume this item with usable authorized authentication
and run the retained Claude probe; successful real integration and operator-answer
cases are still required before ENG-81 can be considered done.

The report is checked with the record CLI before its commit. The final command
is lane check on the committed, rebased report HEAD; its exact result is recorded
in .lane/gate.json and the printed GATE receipt, rather than predicted here.

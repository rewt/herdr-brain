---
run: R-124
outcome: done
summary: |
  Validation uses checksummed prebuilt process-lifetime owners on macOS and Linux on arm64 and x64, eliminating the adoption requirement for a C compiler.
  The helper source and lifetime protocol are preserved; unavailable bundles try the existing bounded source build and refuse execution if that also fails.
  Adoption requirements and the scratch rehearsal preflight now verify bundled owners instead of requiring a compiler.
  Offline owner tests pass 19/19 and offline acceptance tests pass 81/81. The final full offline suite runs through lane check after this report commit.
  The operator moved live acceptance to once per release candidate; further live runs stopped. The earlier corrected gate passed both real discovery cases but was not READY: 25 pass, two legacy notification/retirement failures.
headline: Validation works without a C compiler on macOS and Linux
blockers: []
proposals: []
learnings:
  - Changing process-supervisor.c invalidates every old bundled target through its source checksum; rebuild affected targets and commit their manifest together.
  - macOS binaries need their normal LC_UUID load command on this host; disabling it produced a dyld refusal during native tests.
  - Installed runtime snapshots and release Git archives already carry the entire discovery tree, including native assets and license notices.
artifacts:
  - "Commit: Ship verified native validation owners without a C compiler (4b6f27c)"
  - "Commit: Preserve validation owner protocol mode in staged helpers (08474da)"
  - "Commit: Keep record verification fixture desk dependencies complete (8309298)"
  - "Commit: Report compiler-free validation and release gate for run R-124"
  - "Branch: lane/no-compiler"
  - "discovery/owner.mjs; discovery/bounded.mjs; discovery/native/; discovery/test/owner.test.mjs"
  - "README.md; docs/ADOPTING.md; discovery/README.md; docs/adoption/rehearse.mjs; docs/adoption/WALKTHROUGH.md"
  - "Final offline owner tests: 19 passed, zero failed/skipped; /private/tmp/eng105-owner-final.log"
  - "Full offline suite before transport correction: 710 passed, 11 explicit skips, zero failures (721 total, 351.556 seconds); /private/tmp/eng105-final-tests.log"
  - "Offline acceptance suite: 81 passed, zero failures/skips; /private/tmp/eng105-acceptance-offline-final.log"
  - "Actual copied validation transport plus compiler-unavailable owner tests: 22 passed; /private/tmp/eng105-transport-owner-fixed.log"
  - "Existing plugin-install tests isolated from live Herdr: 39 passed; /private/tmp/eng105-plugin-isolation.log"
  - "Actual macOS/Codex boundary regressions: 33 passed, one Linux-only skip, zero failures; /private/tmp/eng105-native-tests.log"
  - "Both Linux helper architectures: six bounded offline lifetime cases passed in an existing Docker Linux VM; /private/tmp/eng105-tools-k563egdl/linux-proof.json and linux-lifetime.c"
  - "Intel macOS owner smoke test: actual kernel lifetime boundary with /usr/bin/true exited zero under Rosetta"
  - "node discovery/native/build.mjs --check verified all four targets without a compiler"
  - "Rebased onto main 4c2f20b; this includes the operator policy at e0c5282 and the new ENG-106 through ENG-109 briefs"
  - "Prior corrected release gate at c140ae8: 25 pass / 2 fail / 0 pending, NOT READY; /private/tmp/eng105-release-gate-final.log and /private/tmp/eng105-gate-final/herdr-acceptance-WtRran/evidence"
  - "Retained initial and corrected gate summary/screen: docs/reports/evidence/ENG-105-no-compiler; raw numbered logs, transcripts, source/permission receipts and usage remain at each summary's scratch evidence path"
  - "Report: docs/reports/ENG-105-no-compiler-20261002.md"
  - "record check /Users/rewt/development/rewt/.worktrees/herdr-brain/lane-no-compiler/docs/reports/ENG-105-no-compiler-20261002.md"
  - "Final command after the report commit: ORG_ACTOR=eng105-r124-lane-check PATH=/private/tmp/eng105-offline-tools:$PATH node lanes/lane.mjs check --cmd 'npm test -- --file-timeout=480000 --suite-timeout=540000'; .lane/gate.json binds the committed report and implementation to the full offline suite"
decisions:
  - text: Ship the existing native helper for macOS and Linux on arm64 and x64, with static musl linking for Linux and an offline maintainer rebuild path.
    category: design
    why: Preserving the existing C source and protocol retains kernel process identity, subreaper adoption, readiness checks, deadlines and cleanup while adopters use bundled owners without a compiler.
  - text: Verify binary and source checksums and native architecture, then execute a private copy created with no-follow and exclusive flags.
    category: security
    why: The user explicitly requested checksums without weaker lifetime guarantees. Trusted installed source and manifest define the bundle; verification rejects damaged, stale or redirected files before execution and project code cannot replace the private helper.
  - text: Retain a clearly diagnosed bounded source-build fallback and refuse validation before project execution when both provisioning paths are unavailable.
    category: security
    why: Missing bundles on other Darwin/Linux architectures can still use the existing fixed /usr/bin/cc path, with environment overrides ignored and its 15-second deadline. No cleanup or sandbox guarantee is relaxed.
  - text: Use the test runner's existing longer bounded allowance for final validation under host load.
    category: prover
    why: The initial offline baseline reached its 360-second suite deadline under load around 33. The same full suite subsequently passed with a 540-second outer deadline; product execution deadlines remain independent.
  - text: Preserve the source-built owner's 0755 executable mode inside its private 0700 directory and add the installed transport check to the normal offline suite.
    category: security
    why: The acceptance transport pins that existing mode as part of its lifetime protocol. The initial 0500 copy was refused before execution; restoring the protocol mode retains the existing sandbox protection and makes compiler-free validation interoperable.
  - text: Include the existing settle module in the record verification fixture's source archive.
    category: prover
    why: The full offline acceptance suite found an older fixture omitted the record CLI's desk-command dependency and failed at import time. The completed fixture now proves the kernel-confinement regression instead of stopping before it.
  - text: Isolate final offline checks from the operator's Herdr with a rejecting scratch CLI shim.
    category: tooling
    why: Main's new ENG-107 brief records real workspaces leaked by older plugin-install tests. Those 39 tests pass with the shim; the final offline check uses it while the earlier native canaries used explicit owned resources.
  - text: Stop additional live acceptance runs and reserve them for the supervisor's integrated candidate.
    category: prover
    why: The operator's update supersedes the original lane brief. Main now requires npm test and offline acceptance checks in lanes; the acceptance change is a fixture repair, and its 81 offline tests passed, so no optional --skip-live pass was needed.
questions: []
challenges:
  - "The initial sandboxed baseline could not run ps for fixture ownership; authorized execution outside that sandbox reached the existing six-minute suite deadline before completion. The final full offline run passed with the runner's existing longer bound."
  - "The first full gate at b2a8ea3 finished 21 pass / 5 fail / 1 pending. Cases 21 and 22 exposed the staged-owner mode mismatch; cases 19, 20 and 23 involved a legacy delivery timeout, its dependent retirement check and a default dispatch timeout; case 27 had incomplete pane.current observations. Preserve validation owner protocol mode in staged helpers fixes the product mismatch, and the corrected gate passes both cases, the default cycle and the focus check."
  - "The first full offline acceptance run was 80/81 because its record fixture omitted settle/desks-command.mjs. Keep record verification fixture desk dependencies complete fixes that proof fixture; the rerun passes all 81."
  - "Linux proof ran in Docker's Linux VM on an Apple Silicon host, with arm64 native and x64 translated execution; the Intel macOS smoke test also used Rosetta. These receipts establish helper execution and cleanup on those transports, not a physical Intel-host or full Linux bubblewrap-provider proof."
  - "The corrected gate at c140ae8 was 25 pass / 2 fail / 0 pending, not a release approval. Only cutover-switches failed: legacy-canary (rollback: real restored notify canary): timeout: cutover final delivery; contrib-retirement preserves that prerequisite failure. The copied legacy watcher's root cause remains unproved. A later diagnostic attempt failed at mkdtemp because its scratch parent was absent, before any harness case or Herdr creation; no retry was made after the operator's update."
---

The implementation in **Ship verified native validation owners without a C compiler**
keeps discovery/process-supervisor.c byte-for-byte. Normal provisioning reads the
installed target's manifest, verifies the source and binary hashes and native
architecture, then stages only verified bytes in a private system temporary
directory. The runtime never downloads a helper or reads compiler override flags.
The staged executable retains the original 0755 mode inside a private 0700
directory, as required by the installed acceptance transport. The four binaries
total about 181 KB; the Linux copies are statically linked.
The manifest records build compiler versions and flags, and the native guide
provides verification, rebuild and notice-retention instructions.

Offline tests make /usr/bin/cc unavailable specifically to product provisioning,
while keeping the independent fixture toolchain available. Validation still runs,
including detached double-fork cleanup after completion, deadline and wrapper
death, and preserves unrelated same-group processes. Tests also exercise missing,
malformed, corrupt, stale and redirected bundles, a checksummed wrong-architecture
binary, successful bounded fallback, and missing/failed/timed-out compiler refusal
before the project command executes. The installed stable-runtime snapshot is
verified and executed through the same compiler-unavailable path.

Real host checks exercise both macOS Seatbelt and native Codex validation, with
shared-state, Git and network denials and the lifetime marker preserved. Separate
bounded offline Linux fixtures execute both bundled Linux binaries and verify
no late descendant write after completion, timeout or wrapper death, while an
unrelated process survives. Each fixture receives its own ORG_ACTOR.

The two full live gates preceded the operator's update. The initial gate exposed
an actual installed transport mismatch: the staged helper's 0500 mode failed its
existing 0755 lifetime pin before execution. **Preserve validation owner protocol
mode in staged helpers** restores that mode without changing the golden transport,
and adds its independent composition regression to the normal offline suite.
The corrected candidate passed real concurrent discovery/promotion, the real
routing question, the default cycle, the supervisor cases, cleanup and focus.
Its two failures are the restored legacy notify canary's final-delivery timeout
and the dependent contrib retirement check. These are retained as failed evidence,
not a READY release receipt; the legacy watcher's root cause was not established.

After the operator directed lanes to stop live acceptance, no further live harness
run and no optional --skip-live pass was performed. The fixture-only acceptance
change is covered by all 81 offline acceptance tests. No test:lanes run was needed
because lanes/ was unchanged. The final lane check runs npm test with the existing
bounded 480-second per-file / 540-second suite allowance and a rejecting scratch
Herdr shim, preventing older offline fixtures from creating objects in the
operator's session. Its receipt is written to .lane/gate.json after this report
commit and names the exact validated HEAD; its output is retained in
/private/tmp/eng105-lane-check-final.log.

No push, publication, shared configuration edit or project-wide housekeeping loop
was performed. Earlier acceptance runs used their own scratch copies, scratch
release activation fixtures and owned background resources; the activated product
release was unchanged. Main was checked before the candidate gate; the lane was
subsequently rebased cleanly onto main 4c2f20b, including the updated per-release
acceptance policy at e0c5282 and the new ENG-108/ENG-109 briefs.

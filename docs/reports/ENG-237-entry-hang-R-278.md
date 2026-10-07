---
run: R-278
outcome: done
summary: |
  Fixed generated entry wrappers to locate their directory using POSIX shell builtins rather than dirname from PATH. The unchanged dispatch regression passes in 2.3 seconds alone and in the full lane file (153/153). All 15 targeted wrapper-installing test files passed: 388 distinct passing checks, five opt-in provider skips, and no unresolved failures. Explicit native precedence and upgrades without reinstall remain covered. The implementation is committed; this checked report and evidence precede the final focused lane check.
headline: Entry wrappers launch successfully with minimal dispatch paths
blockers: []
proposals: []
learnings:
  - Dispatch fixtures deliberately supply a PATH with Git, head and fake Herdr only; generated entry wrappers must not require dirname or other unrelated PATH utilities.
  - A failed wrapper start can appear as a dispatch hang because dispatch retries failed agent starts until the enclosing fixture command timeout kills it.
artifacts:
  - "Implementation commit: 7723ab6"
  - "Branch: lane/entry-hang"
  - discovery/install.mjs
  - test/entry-upgrade.test.mjs
  - docs/reports/ENG-237-entry-hang-R-278.md
  - docs/reports/evidence/ENG-237-R278
  - ".lane/gate.json records the final focused lane check against the report commit"
decisions: []
questions: []
challenges: []
---

Read ENG-237 and ENG-229's histories before implementation.

Root cause: ENG-229 introduced `entry_bin=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd)` into all four generated Codex/Claude wrappers. The dispatch test's PATH contains only Git, head and fake Herdr. With no dirname, the wrapper emits “dirname: command not found”, then attempts to cd to an empty directory and exits 1 before resolving or launching its explicitly selected native. Dispatch's failed-agent-start retry loop (`lanes/lane.mjs:1265`, normally 20 attempts plus 500 ms delays) keeps retrying; the enclosing synchronous command reaches its timeout and returns status null. The native is not waiting on a TTY or resolving recursively.

The fix uses shell case/parameter expansion to take the directory from $0 and builtin cd/pwd to canonicalize it. It preserves physical directory resolution, root/bare-name handling, argument quoting and the caller's cwd. Native lookup, explicit selection provenance, managed-wrapper exclusion and stable launchers are unchanged.

Evidence:

- `before.tap`: unchanged targeted dispatch case failed after 16.139 seconds, status null.
- `wrapper-before.txt`: isolated installation and direct launches prove both automatic wrappers exit 1 with the missing-dirname/empty-cd errors on a minimal PATH.
- `after.tap`: unchanged targeted dispatch case passes in 2.295 seconds (2.373 seconds including the runner).
- `regressions.tap`: full lane file passes 153/153 in 456 seconds; the same dispatch case takes 2.273 seconds. Discovery settings/review/alternatives/lessons, entry/review-r4, copied-product acceptance, fleet, plugin installation and CLI help checks also pass.
- `remaining.tap`: corrected entry-upgrade test and zero-setup installation pass 27/27, offline live-session checks pass 3/3, and offline lesson canaries pass 21/21.
- `wrapper-inventory.txt`: requested discovery/install.mjs and entry-bin search, classified by tier, plus indirect wrapper-installing tests.

The added regression launches codex, claude, monitor-codex and monitor-claude through a directory alias containing spaces and brackets with no dirname on PATH and a nonempty CDPATH. It verifies selected native output and literal argument delivery. Its first fixture omitted Git as well; explicit monitor-* entry legitimately needs Git for checkout inspection and failed with ENOENT. The fixture now supplies only Git alongside the entry directory. The original dispatch test was not changed. The first batch stopped after that new-fixture failure, so the corrected entry-upgrade file and all remaining files were run in the second batch. Removing the seven duplicate passing entry-upgrade checks yields 388 distinct passes, five skips and zero unresolved failures.

The five skips are existing opt-in alternative-sandbox/native-provider applicability checks. All required wrapper, upgrade, explicit-precedence and PTY dispatch cases ran.

Commands (each ran inside the host test slot with MONITOR_TEST_SLOT_WAIT_SECONDS=3600; full offline checks used host permissions for native sandbox/process checks):

```sh
node test/helpers/run.mjs --file-timeout=480000 --test-name-pattern='^always_args sees the canonical model' lanes/test/lane.test.mjs

node test/helpers/release-suites.mjs --file-timeout=480000 --suite-timeout=540000 lanes/test/lane.test.mjs discovery/test/settings.test.mjs discovery/test/review.test.mjs discovery/test/alternatives.test.mjs discovery/test/lessons.test.mjs discovery/test/acceptance.test.mjs discovery/test/entry.test.mjs discovery/test/review-r4.test.mjs test/entry-upgrade.test.mjs test/fleet.test.mjs test/plugin-install.test.mjs test/cli-help.test.mjs test/zero-setup-install.test.mjs acceptance/test/live-session.test.mjs acceptance/test/lessons.test.mjs

node test/helpers/release-suites.mjs --file-timeout=480000 --suite-timeout=540000 test/entry-upgrade.test.mjs test/zero-setup-install.test.mjs acceptance/test/live-session.test.mjs acceptance/test/lessons.test.mjs
```

No baseline, npm test, test:promotion, test:lanes, live harness, model call or housekeeping loop was run. git diff --check passed. This report is written to the requested record path, checked with record check and committed with the evidence. The final operation after the report commit is:

```sh
node lanes/lane.mjs check --cmd 'MONITOR_TEST_SLOT_WAIT_SECONDS=3600 node test-slot/test-slot.mjs run entry-hang-final -- node test/helpers/run.mjs test/entry-upgrade.test.mjs'
```

Its gate receipt and validation log bind the final result to the report commit.

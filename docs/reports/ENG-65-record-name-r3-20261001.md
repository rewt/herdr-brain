---
run: R-32
outcome: done
summary: |
  All five round-2 review findings are fixed. The canary handoff now uses the repository-only
  herdr-monitor canary bin, restore preserves launchers replaced after activation, release
  lifecycle wording describes per-launcher memory, alias evidence distinguishes parse coverage
  from the successful workflow, and the console example uses an aligned plausible question.
  Release behavior was exercised only in test-created temporary directories.
headline: The record canary and release restore paths are now accurate and safe.
blockers: []
proposals: []
learnings:
  - The repository canary bin and the release launcher bin have deliberately different scopes; only release activation owns the latter.
  - A missing-before marker authorizes removal only while the launcher is still the activation-owned current symlink.
  - Complete command enumeration in the alias test proves parse-path parity; successful stateful parity is separate evidence.
artifacts:
  - "implementation commit: 1c4e15b (Fix record name round-two findings)"
  - herdr/release.sh and test/release.test.mjs (safe restore plus regular-file and user-link replacement coverage)
  - docs/reports/ENG-65-record-name-20261001.md (correct canary handoff and precise alias evidence)
  - README.md and herdr/release.sh (per-launcher lifecycle wording)
  - README.md (aligned modern-console sample question)
  - "npm test: 286 passed, 1 skipped, 0 failed"
  - "node --test test/release.test.mjs: 8 passed, 0 failed"
decisions:
  - decision: Keep canary and release command installation separate.
    why: herdr/canary-env.sh scopes the canary bin to this repository, while ~/.local/bin is the release launcher directory shared by other projects.
  - decision: Treat only an activation-shaped symlink into the release home’s current tree as removable when a launcher was originally absent.
    why: A regular file or user link installed later is new operator state and restore must not destroy it.
questions: []
challenges: []
---

# Round-2 findings

1. **Canary location:** the R-27 handoff now links `record` in
   `~/.local/share/herdr-monitor/canary/bin` beside the existing canary links. It explicitly leaves
   `~/.local/bin/record` to release activation so unrelated projects remain on the active release.
2. **Safe restore:** a launcher recorded as missing is removed only if it is still a symlink whose
   target is beneath the release home’s `current/`. Otherwise restore warns and leaves it alone.
   The regression test covers both a replacement regular file and a user-created symlink.
3. **Lifecycle wording:** the release header and README now say activation manages `record`, `org`,
   and `lane`, remembering each launcher the first time that launcher is managed.
4. **Alias evidence:** the R-27 report now says all 23 commands have invalid-option parsing parity,
   while the separate successful workflow proves `init`, `add`, `status`, and `show` end to end.
5. **Console sample:** the mechanically renamed question is now the plausible, same-width
   “Promote the modern console lane into main?” so the surrounding sample columns remain aligned.

# Verification

The focused release suite passed all eight tests. The complete offline suite passed 286 tests,
skipped one optional-dependency test, and failed none. `bash -n herdr/release.sh` and
`git diff --check` passed. No command activated or restored the live Herdr Monitor installation;
the release harness set `HERDR_MONITOR_HOME`, `HERDR_MONITOR_BIN`, and related paths to temporary
directories for every lifecycle test.

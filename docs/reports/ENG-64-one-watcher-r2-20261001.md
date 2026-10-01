---
run: R-38
outcome: done
summary: |
  Restored contrib/settle-watch.mjs and its original regression test byte-for-byte from main, preserving the CLI and behavior that bch-cloak's scripts/lane/launch-supervisor.mjs calls through the canonical checkout. Herdr Monitor's own supervisor still uses the new watch/watch.mjs plus explicit open-session split. Documentation now marks the contrib path as bch-cloak-only compatibility, and the cutover plan removes it last, after bch-cloak is repointed through an activated release and its canary passes.
headline: The bch-cloak compatibility path now survives main updates
blockers: []
proposals: []
learnings:
  - "bch-cloak's scripts/lane/launch-supervisor.mjs targets /Users/rewt/development/rewt/herdr-brain/contrib/settle-watch.mjs in the canonical checkout, not ~/.local/share/herdr-monitor/current."
  - "Moving Herdr Monitor main therefore changes bch-cloak unless contrib/settle-watch.mjs remains compatible, even though bch-cloak's fresh-session path is dormant."
  - "The restored compatibility script's Git blob is 014fe114e2d76606bb5aa0e88f2ac48297ca9829, exactly main's blob; its restored test is also byte-identical to main."
  - "The compatibility path must be the final old-watcher path removed, after bch-cloak no longer names it and the release-gated canary passes."
artifacts:
  - "31d2710 Preserve settle watcher compatibility"
  - "contrib/settle-watch.mjs and test/settle-watch.test.mjs restored from main"
  - "README.md and watch/README.md mark the compatibility-only boundary"
  - "docs/reports/ENG-64-one-watcher-20261001.md now makes compatibility removal the final cutover step"
  - "npm test: 287 passed, 0 failed, 1 explicit Herdr-only skip"
  - "Focused watcher and launcher tests: 20 passed, 0 failed"
decisions:
  - decision: Restore the original settle-watch implementation instead of building a forwarding shim.
    why: Exact restoration proves the hard-coded external caller retains its current CLI, waiting behavior, session handoff, brakes and route handling without relying on assumptions about which arguments bch-cloak uses.
  - decision: Keep the compatibility watcher out of Herdr Monitor's own supervisor flow.
    why: supervisor/arm-watch.sh still calls watch/watch.mjs and supervisor/settle.sh still calls open-session.mjs, preserving the one-watcher design inside this repository while the external caller transitions.
  - decision: Remove the compatibility file only after bch-cloak's release-gated canary succeeds.
    why: Removing it earlier makes a main fast-forward alter bch-cloak outside release activation; removing it last makes both the cutover and rollback explicit.
questions: []
challenges:
  - premise: Removing or renaming contrib/settle-watch.mjs now is safe because bch-cloak runs an activated release.
    verdict: wrong
    evidence: The copied launch-supervisor sets SETTLE_WATCH to the canonical herdr-brain checkout path, so it bypasses the activated release for this command.
  - premise: An equivalent shim is preferable to restoring the old implementation.
    verdict: wrong
    evidence: The old entrypoint combines watch, spawn, settle and continue modes with bch-cloak-specific forwarded arguments. Restoring the exact main blob is smaller-risk and directly testable.
---

## Correction

The round-one architecture remains intact for Herdr Monitor:

- `supervisor/arm-watch.sh` arms `watch/watch.mjs` and tells `supervisor-herdr`.
- `supervisor/settle.sh` and `supervisor/continue.sh` open model sessions through
  `supervisor/open-session.mjs` without observing worker lifecycle.
- Brain watch remains the distinct operator-queue capture service.

The correction restores `contrib/settle-watch.mjs` unchanged. It is not a newly selected watcher
for Herdr Monitor and no local supervisor script calls it. It is a compatibility surface for the
absolute path in bch-cloak's `scripts/lane/launch-supervisor.mjs`. Keeping it means a fast-forward
of this repository's main branch cannot silently switch or break bch-cloak.

Both restored files match main exactly:

| File | Working-tree blob | Main blob |
|---|---|---|
| `contrib/settle-watch.mjs` | `014fe114e2d76606bb5aa0e88f2ac48297ca9829` | `014fe114e2d76606bb5aa0e88f2ac48297ca9829` |
| `test/settle-watch.test.mjs` | `6c670310692305dfd8021375814dce8cf83a025e` | `6c670310692305dfd8021375814dce8cf83a025e` |

The original tests exercise its `--open` CLI, STOP handling, missing runtime-directory creation,
actor environment and Codex route construction. The new one-watcher test now asserts that the
compatibility entrypoint exists while also proving the local arm script does not call it.

## Corrected cutover invariant

The detailed file-by-file bch-cloak plan remains in
`docs/reports/ENG-64-one-watcher-20261001.md`, with this ordering constraint added:

1. Keep `contrib/settle-watch.mjs` unchanged while Herdr Monitor main moves and while bch-cloak
   still names its canonical-checkout path.
2. At a quiet point, activate the release, back up bch-cloak's untracked supervisor files, repoint
   its launch wrapper to the activated `supervisor/open-session.mjs`, and switch dispatch from
   `notify-watch.sh` to the activated `watch/watch.mjs` wrapper.
3. Run the bch-cloak canary and all delivery, queue, route and rollback checks. Do not run both
   worker watchers for one run.
4. Confirm with `rg` that bch-cloak no longer invokes either `notify-watch.sh` or the canonical
   `contrib/settle-watch.mjs` path.
5. Only then remove `contrib/settle-watch.mjs` from Herdr Monitor in a separate final cleanup
   commit. If rollback restores bch-cloak's old wrapper, restore the exact compatibility blob
   before moving main.

No bch-cloak file, activated release, Brain process, LaunchAgent, plist or external record was
changed in this run.

## Verification

`npm test` completed after the restoration with 287 passing, zero failing and one explicit
Herdr-only skip. The focused compatibility, open-session, one-watcher and watch-module suites
completed with 20 passing and no failures. The corrected round-one report still passes
`record check`, and `git diff --check` passes.

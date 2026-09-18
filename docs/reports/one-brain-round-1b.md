---
run: R-11
outcome: done
summary: |
  Folded the brain repository into brain/ with all eight original commits reachable, moved the settle prompt and entry scripts into tracked supervisor/, and documented the complete layout. The supervisor now keeps its checklist in the repository while explicitly keeping ledgers, the open-session lock, and STOP under ignored .lane/supervisor. Both test suites pass, the console frame renders, the Brain status command runs from its new path, and the watcher arm script completes its dry-run path.
headline: Brain and the supervisor now live together in herdr-org and all checks pass
blockers: []
proposals: []
learnings:
  - settle-watch previously derived the runtime ledger and STOP directory from the checklist directory, so tracking the checklist required a separate backward-compatible --ledger-dir option.
  - The Brain service plist is generated from the location of brain.mjs, so starting the service once from the folded-in CLI updates both its program path and working directory.
  - The current Brain status is "not watching · service on"; the command works at its new path, and the operator's post-promotion service restart performs the path cutover.
artifacts:
  - "branch lane/one-brain-fold: brain subtree commit 5116f4c and integration commit 46b79c1"
  - "node brain/bin/brain.mjs status: not watching · service on"
  - "npm test: 139 pass, 0 fail, 1 dependency-based skip"
  - "npm --prefix console test: 92 pass, 0 fail"
  - "env -u NO_COLOR node console/app.mjs --print 140x45 --project herdr-org: rendered successfully"
  - "sh supervisor/arm-watch.sh R-1 --dry-run: R-1 already has a recorded report; nothing to watch"
  - "git merge-base --is-ancestor for each of the eight source commits: all succeeded"
---

The fold is a real subtree merge rather than a copied snapshot. The source repository's eight
commits are parents of the branch tip, and the imported files live under `brain/`. No root
`bin/`, `lib/`, or dependency manifest changed. A write-site audit still finds `events.jsonl`
owned by `lib/store.mjs`; the console only watches it and writes through the org CLI.

`supervisor/SETTLE.md`, `supervisor/arm-watch.sh`, and `supervisor/continue.sh` are tracked. Both
scripts derive the checkout from their own location, point settle sessions at the tracked
checklist, and pass `--ledger-dir "$HERE/.lane/supervisor"`. The new option defaults to the old
checklist-adjacent behavior, so the unchanged bch-cloak caller of
`contrib/settle-watch.mjs` remains compatible. A regression test proves an explicitly separate
runtime directory supplies the STOP brake.

## Commits

- `15a0412` — brain: watch Herdr, capture what a session left behind, queue it.
- `2e5f7f6` — Separate a decision from an obstacle, and put stranded replies first.
- `b8e4648` — Stop paying a model to reword a dialog it can already read.
- `45d98c9` — Tell Claude's auto-suggest apart from what the operator actually typed.
- `1b09e44` — Give each result a handle that is actually unique.
- `01dc649` — Start a session when the operator asks: brain start.
- `fd89d5a` — Read results and org items the way the operator reads work.
- `98d9353` — Run the loop as an always-on service the console can see and switch.
- `5116f4c` — Add `brain/` from the source repository while retaining those eight parents.
- `46b79c1` — Track the One brain supervisor and paths.
- This report commit — Add the One brain round-one-b report.

## Cutover

- `~/.config/herdr-org/console.json` `brain_bin`: `/Users/rewt/development/rewt/brain/bin/brain.mjs` → `/Users/rewt/development/rewt/herdr-org/brain/bin/brain.mjs`.
- `~/Library/LaunchAgents/com.rewt.herdr-brain.plist` `ProgramArguments` script string: `/Users/rewt/development/rewt/brain/bin/brain.mjs` → `/Users/rewt/development/rewt/herdr-org/brain/bin/brain.mjs`.
- The same plist's `WorkingDirectory`: `/Users/rewt/development/rewt/brain` → `/Users/rewt/development/rewt/herdr-org/brain`. Running `node /Users/rewt/development/rewt/herdr-org/brain/bin/brain.mjs service start` after promotion applies both plist edits and restarts the loaded service.
- Settle checklist path: `/Users/rewt/development/rewt/herdr-org/.lane/supervisor/SETTLE.md` → `/Users/rewt/development/rewt/herdr-org/supervisor/SETTLE.md`; remove the old checklist after promotion.
- Operator arm command: `.lane/supervisor/arm-watch.sh R-n` → `supervisor/arm-watch.sh R-n`; remove the old ignored arm script after promotion.
- Operator continue command: `.lane/supervisor/continue.sh "focus"` → `supervisor/continue.sh "focus"`; remove the old ignored continue script after promotion.
- Keep `.lane/supervisor/deliver-r1.sh`, `sessions-*.log`, `STOP`, and the open-session lock as runtime state; they do not move into the tracked directory.
- No bch-cloak edit is required: its absolute target `/Users/rewt/development/rewt/herdr-org/contrib/settle-watch.mjs` is unchanged, and callers that omit `--ledger-dir` retain the old behavior.

Nothing under `~/.config`, `~/Library`, `/Users/rewt/development/bastian`, the live organization,
or the source brain repository was modified during this run.

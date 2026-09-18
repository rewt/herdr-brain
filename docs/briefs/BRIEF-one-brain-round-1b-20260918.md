# Brief: round one b of "One brain" (ENG-14)

Written 2026-09-18 by the operator's drop-in session. You are an engineer on
Codex. Read this whole file before touching anything.

## What you are doing, in one paragraph

The operator's tooling is spread over two repositories and one gitignored
directory, and they cannot tell where a feature lives. Fold the `brain` repo
into `herdr-org` with its history, move the supervisor scripts and prompt out
of the gitignored `.lane/supervisor/` into a tracked `supervisor/` directory,
and write one README section that says where everything lives. Nothing that
runs today may stop working; anything outside the repository that must change
is listed in your report for the operator, not edited by you.

## Where things are

- Canonical checkout: `/Users/rewt/development/rewt/herdr-org` (`main` at `fb33980`).
- Your worktree: `/Users/rewt/development/rewt/.worktrees/herdr-org/lane-one-brain-fold`
  on branch `lane/one-brain-fold`. Work only there.
- The brain repository to fold in: `/Users/rewt/development/rewt/brain` (clean, `main` at `98d9353`,
  8 commits). Read it; do not modify it.
- The scripts to move (read them in the canonical checkout, they are gitignored):
  `/Users/rewt/development/rewt/herdr-org/.lane/supervisor/SETTLE.md`, `arm-watch.sh`, `continue.sh`.
  Leave `deliver-r1.sh` and the `sessions-*.log` files where they are; they are runtime state.
- The organization (read-only for you): `ORG_DIR=/Users/rewt/development/rewt/.org`,
  CLI `node /Users/rewt/development/rewt/herdr-org/bin/org.mjs`. Never run a command that writes to it.
- Do not read or write anything under `/Users/rewt/development/bastian`, `~/Library`, or `~/.config`.

## Steps

1. **Fold brain in with history.** `git subtree add --prefix=brain /Users/rewt/development/rewt/brain main`
   (or an equivalent that keeps the 8 commits reachable). Result: `brain/bin/brain.mjs`,
   `brain/lib/*`, `brain/README.md`. Confirm `node brain/bin/brain.mjs status` runs from the
   worktree and reports the live watcher (it reads `~/.local/state/herdr-brain`, which is fine).
2. **Find every path that assumed the old layout.** `grep -rn "development/rewt/brain\|brain_bin\|\.lane/supervisor" --include='*.mjs' --include='*.sh' --include='*.md' --include='*.json' .`
   in the worktree. Fix the ones inside the repository. List the ones outside it
   (see "Cutover" below) without touching them.
3. **Move the supervisor into the tree.** Create `supervisor/` with `SETTLE.md`, `arm-watch.sh`,
   `continue.sh`, edited so they resolve the checklist from `$HERE/supervisor/SETTLE.md` and
   keep the ledger dir at `$HERE/.lane/supervisor`. Do not move `contrib/settle-watch.mjs`;
   bch-cloak's own `arm-watch.sh` points at it by absolute path and must keep working.
   Add one short header comment to each script saying what it does and who runs it.
4. **README: "Where things live".** One section in `README.md`, a table with one row per
   piece: `bin/org.mjs` (state CLI), `lib/` (core), `brain/` (watcher, queue, start),
   `console/` (the operator's screen), `contrib/settle-watch.mjs` (waits for a worker and
   opens a settle session), `contrib/tidy-tabs.mjs` (closes finished tabs), `supervisor/`
   (the prompt each settle session gets, and the scripts that arm it), `.lane/` (runtime
   state, ignored), and the two files outside the repo (`~/.config/herdr-org/console.json`,
   `~/Library/LaunchAgents/com.rewt.herdr-brain.plist`). One line each, plain words.
5. **Prove nothing broke.** `npm test` and `npm --prefix console test` pass.
   `node console/app.mjs --print 140x45 --project herdr-org` renders.
   `sh supervisor/arm-watch.sh R-1 --dry-run` runs its dry-run path from the worktree without error
   (it is allowed to say the run is already settled).
6. **Keep the rules the core has always had:** `bin/` and `lib/` gain no dependency; nothing
   but the org CLI writes `events.jsonl`; no push; no writes to any live organization.
7. **Stop** with the worktree clean and the report written.

## The report

Write it to `docs/reports/one-brain-round-1b.md` in the worktree and commit it on the
branch. Same front matter as round one (`run`, `outcome`, `summary`, `headline`,
`blockers`, `proposals: []`, `learnings`, `artifacts`). Then two sections:

- **Commits**: every commit, in order, one line each.
- **Cutover**: the exact edits the operator must make outside the repository after promotion,
  one line each, old value and new value. Expected at least: `brain_bin` in
  `~/.config/herdr-org/console.json`, the program path in the LaunchAgent plist, and the
  operator's habit of running `.lane/supervisor/arm-watch.sh` becoming `supervisor/arm-watch.sh`.

## Acceptance (what the reviewer will check)

- brain's 8 commits are reachable in the branch history and `node brain/bin/brain.mjs status` works.
- `supervisor/SETTLE.md`, `arm-watch.sh`, `continue.sh` are tracked and the scripts run from the worktree.
- `contrib/settle-watch.mjs` did not move; bch-cloak's absolute path to it still resolves.
- README has the "Where things live" section, accurate to the tree.
- Both test suites pass; the herdr-org frame renders.
- The report's Cutover section lists every outside-repo edit with old and new values.
- Nothing under `~/.config`, `~/Library`, or `/Users/rewt/development/bastian` was touched.

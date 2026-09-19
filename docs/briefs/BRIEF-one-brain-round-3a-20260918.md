# Brief: round three a of "One brain" (ENG-22)

Written 2026-09-18 by the operator's drop-in session. You are an engineer on
Codex. Read this whole file before touching anything.

## What you are doing, in one paragraph

The operator decided that herdr-lanes is finished as a separate product: its job
(dispatch work into visible Herdr worktrees, review it, fast-forward it into main)
now belongs to brain. This round only moves the code: fold the `lane` script into
`herdr-org` with its history so that a later round can hang it off `brain`. Nothing
behaves differently afterwards. The installed `lane` keeps working during your lane;
repointing it is the operator's cutover, not yours.

## Where things are

- Canonical checkout: `/Users/rewt/development/rewt/herdr-brain` (`main` at `3f2c589`).
- Your worktree: `/Users/rewt/development/rewt/.worktrees/herdr-brain/lane-fold-lanes`
  on branch `lane/fold-lanes`. Work only there.
- The repository to fold in: `/Users/rewt/development/rewt/herdr-lanes` (clean, `main` at
  `afb2bc6`). Read it; do not modify it and do not touch its GitHub remote.
- The installed tool you must not break: `~/.local/bin/lane` resolves to
  `/Users/rewt/development/rewt/.lane-releases/herdr-lanes/2026.09.16.1/core/lane.mjs`.
  Do not edit anything under `.lane-releases` or `~/.local/bin`.
- Config the tool reads: `/Users/rewt/development/rewt/.lane.json` (routes, dispatch defaults,
  `worktree_root`). Read-only for you.
- The organization (read-only for you): `ORG_DIR=/Users/rewt/development/rewt/.org`,
  CLI `node bin/org.mjs`. Never run a command that writes to it.
- Do not read or write anything under `/Users/rewt/development/bastian`, `~/Library`, or `~/.config`.

## Steps

1. **Fold herdr-lanes in with history.** `git subtree add --prefix=lanes
   /Users/rewt/development/rewt/herdr-lanes main`, then in follow-up commits remove what is
   not carried over: `board/app.mjs`, `board/cli.mjs`, `board/view.mjs`, `board/board.mjs`,
   `board/cli-client.mjs`, `board/process-lifetime.mjs`, `board/package.json`,
   `board/package-lock.json`, `board/node_modules`, the `board` verb in `lane.mjs`,
   `openspec/`, `config/`, `contrib/`, `HANDOFF.md`, `CLAUDE.md`, and under `docs/` everything
   except `REFERENCE.md`, `BRIEF_TEMPLATE.md` and `REVIEW_TEMPLATE.md`. Keep every `board/*.mjs`
   module that `lane.mjs` still imports after the `board` verb is gone (check the import
   block at the top of `lane.mjs`; `registry.mjs`, `actions.mjs`, `inventory.mjs` and
   `message-preview.mjs` are the likely survivors). Keep `lanes/test/` for what survives.
2. **Make it run from its new home.** `node lanes/lane.mjs status` from the worktree must
   print the same lanes as the installed tool (it reads the same `.lane.json` and git state).
   `node lanes/lane.mjs config` must match `lane config`. `lanes/package.json` keeps
   `"bin": {"lane": "./lane.mjs"}` so the operator can symlink it.
3. **Tests stay separate.** The lane suite takes about two minutes because one test drives
   Herdr, and `lane promote` validates every promotion with the root `npm test`. Add
   `"test:lanes": "node --test lanes/test"` to the root `package.json`; do not add the lane
   tests to `npm test`. Both `npm test` and `npm run test:lanes` pass (the Herdr-dependent
   test may skip when Herdr is absent; say which in the report).
4. **Docs.** `lanes/README.md` is `REFERENCE.md` cut to what remains (no board, no releases,
   no openspec). Root `README.md` "Where things live" gains one row: `lanes/` (worktrees,
   dispatch, review, promote; to become brain's dispatch layer). In `docs/north-star.md`
   add one line under the capability table dated 2026-09-18: herdr-lanes folded in as the
   dispatch layer. Merge the useful parts of `herdr-lanes/AGENTS.md` into root `AGENTS.md`
   as a short "lanes/" subsection; drop the rest.
5. **Nothing else moves.** `supervisor/`, `.claude/`, `.lane.json`, `console/`, `brain/`,
   `bin/`, `lib/` are untouched in this round. `bin/` and `lib/` gain no dependency; no push;
   no writes to any live organization.
6. **Stop** with the worktree clean and the report written.

## The report

Write it to `docs/reports/one-brain-round-3a.md` in the worktree and commit it on the
branch. Same front matter as earlier rounds (`run`, `outcome`, `summary`, `headline`,
`blockers`, `proposals: []`, `learnings`, `artifacts`). Then:

- **Commits**: every commit, in order, one line each.
- **Cutover**: the exact edits the operator makes outside the repository after promotion,
  one line each, old value and new value. Expected: `~/.local/bin/lane` from the
  `.lane-releases/...2026.09.16.1/core/lane.mjs` path to `herdr-org/lanes/lane.mjs`;
  `.lane-releases/herdr-lanes/2026.09.16.1` kept as the fallback; the GitHub repository
  `rewt/herdr-lanes` archived with a pointer to herdr-org.

## Acceptance (what the reviewer will check)

- herdr-lanes' history is reachable in the branch; `node lanes/lane.mjs status` and
  `config` from the worktree match the installed tool's output.
- The board app, openspec proposals, release config and old briefs are not in the tree;
  every module `lane.mjs` imports is.
- `npm test` is unchanged in scope and passes; `npm run test:lanes` exists and passes.
- README, north-star and AGENTS.md updated as in step 4; `lanes/README.md` exists.
- Nothing under `supervisor/`, `.claude/`, `.lane.json`, `~/.config`, `~/Library`,
  `.lane-releases`, `~/.local/bin` or `/Users/rewt/development/bastian` was touched.
- The report's Cutover section lists the symlink change with old and new values.

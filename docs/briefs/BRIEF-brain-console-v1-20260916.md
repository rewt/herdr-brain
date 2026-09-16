# Build Herdr Brain console v1 and the org records it needs

In plain words: build a terminal console the operator keeps in a Herdr pane, so
they can see and approve what agents decide without reading raw files or chat
logs.

## What to build

Everything in `docs/spec-brain-console-v1.md`, sections "The screen" through
"Acceptance":

1. **org core:** `org ask`, `org answer` (a declined blocker keeps its
   dependents blocked), approval categories and policy in `config.json`, note
   `--summary`, report `headline`, and `org today [--json]`.
2. **`contrib/settle-watch.mjs`:** pass `ORG_ACTOR=<session name>` to the
   sessions it opens.
3. **`console/`:** the isolated Ink app and `org console`.
4. **`contrib/console-pane.sh`.**
5. **Docs:** `README.md`, and the `AGENTS.md` amendment quoted in the spec.

Don't do the spec's "Cutover" section. The operator does it after review.

## Rules

- Follow `AGENTS.md`.
- Run `npm test` before you start and again at the end.
- Every behavior change needs a test that you saw fail first.
- Keep the core dependency-free. Only `console/` may add dependencies. Pin
  their versions and commit the lockfile.
- Read `/Users/rewt/development/rewt/herdr-lanes/docs/design/CONSOLE-UX.md`
  (state, density, width, keys) and `herdr-lanes/board/app.mjs` and
  `board/view.mjs` for the house style of an Ink app split into pure modules.
  Don't modify herdr-lanes.
- **Don't write to any live organization.** For manual checks, copy
  `/Users/rewt/development/bastian/.org` to a temporary directory and point
  `ORG_DIR` there. You may read the live transcripts and the bch-cloak ledger,
  read-only, to check session-note extraction. Never print their contents
  beyond a first line.
- Don't edit anything outside this worktree. That includes bch-cloak,
  `~/.config` and Claude settings. Don't push.
- Commit your work on this lane's branch in small, reviewable commits.
- When you finish, run `git status` in the worktree and make sure it's clean.

## When you stop

Write the report to the path your org brief names, starting with its org front
matter. Include `headline:`, the plain sentence the operator will read. Then
run `org check` on it. The body should cover:

- what you built;
- the test counts, before and after;
- the negative controls you observed;
- a screenshot-like text capture of the console at 100×30, taken against the
  temporary org copy;
- anything unverified, and every deviation from the spec, with the reason.

Stop at "ready for review". An independent reviewer and the operator decide
what happens next.

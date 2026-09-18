---
run: R-14
outcome: done
summary: |
  Brain-started sessions now inherit their agent name as ORG_ACTOR, and the existing settle watcher continues to do the same. The settle protocol now reads authority, round limits, and the five-condition promotion policy from goal decision notes; it uses named routes, finishes by tidying tabs, and has checkout-local promotion and push permissions. Abandoned runs now reject explicit late ingestion and are skipped by sync before their report is parsed. Both full test suites pass after rebasing onto current main.
headline: Settle sessions now follow goal-owned gates and abandoned reports stay out of the ledger
blockers: []
proposals: []
learnings:
  - ORG_ACTOR is consumed by the org CLI for event attribution, so passing the chosen agent name in both the new tab and agent-start environment makes later org log entries name the session instead of human.
  - Sync must test abandonment before parsing a report because an abandoned session may leave a malformed file at its report path; explicit ingest also refuses a valid late report.
  - The operator's global Git ignore excludes .claude, so the project permission file had to be deliberately force-added to become a tracked repository rule.
artifacts:
  - 529acef Attribute Brain sessions in org
  - eccc968 Skip reports from abandoned runs
  - 6599f9b Take settle gates from goal decisions
  - 3c5edec Set settle promotion permissions
  - 6fca42e Skip abandoned reports before parsing
  - npm test — 140 passed, 1 optional-dependency skip
  - npm --prefix console test — 92 passed
---

The branch is rebased on current `main`, the worktree is clean before this report, and `main` is an ancestor of the lane head. The core remains dependency-free: no package manifests changed, and the branch adds no `events.jsonl` writer.

## Commits

- `529acef` adds `ORG_ACTOR=<agent name>` to both environments used by `brain start`, with a fake-Herdr regression covering the tab and the launched agent.
- `eccc968` changes abandoned-run ingestion and its CLI messages, replacing the old regression that expected late reports to be retained.
- `6599f9b` rewrites the settle protocol around goal decision notes, named routes, the promotion policy, and the final tidy step.
- `3c5edec` adds the tracked checkout permission rules that allow `lane promote`, deny `git push`, and point to the goal's five-condition policy note.
- `6fca42e` makes sync skip abandoned report paths before parsing and extends the regression to cover both explicit ingestion and a malformed late file.

## Cutover

None. The operator's `supervisor/arm-watch.sh` and `supervisor/continue.sh` habits are unchanged, and neither script changed. New sessions started in the checkout read the tracked `.claude/settings.json` automatically; no external configuration or service restart is required.

## What a settle session now reads

The checklist tells a settle session to run these commands in order to find its gates:

```sh
org status
org show <R-n>
org show <ID>
org show <G-n>
lane routes
```

`org show <R-n>` identifies the item and lane. `org show <ID>` supplies the item acceptance, notes, and its `within: G-n` goal. `org show <G-n>` is the authority source: its decision notes provide what the session may decide alone, the send-back round cap, and every promotion-policy condition. `lane routes` supplies only the route names the checklist uses: `engineer`, `review`, and `settle`.

The final operational command in the checklist is:

```sh
node contrib/tidy-tabs.mjs --cwd "$CHECKOUT" --org "$ORG_DIR" --ledger-dir "$LEDGER"
```

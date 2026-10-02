# Brief: ENG-108, validation tiers and reuse

Org item **ENG-108**. Read `docs/north-star.md`, `docs/roadmap.md`, `AGENTS.md`, `settle/README.md`, `promote/README.md`, `supervisor/PROTOCOL.md` and `lanes/README.md` first; this brief is only the ask.

## The outcome

A lane's code is validated three or four times today: the worker's `lane check`, settle's `lane check`,
again after a rebase, and `lane promote`'s own validation. Under load each repeat can flake and retry.
Give every project three declared tiers (tracked config, defaults when absent): a fast lane check (what a
worker runs), a promotion check (what settle/promote run), and a release gate (see ENG-109). Key every
validation result by the exact tree it validated (the tree hash, plus the validation command and its
environment fingerprint) and reuse it: settle, a clean rebase that yields the same tree, and promote do
not re-run a tree that already passed the same tier. Show the tiers in `lane config` and the console's
desks. For this repo, propose which tests belong in the fast tier versus the promotion tier (the
supervisor is profiling `npm test` per file; ask for it in a question if you need it).

Judged by: offline tests for each behaviour; a scratch project exercising the cycle end to end without the live harness.

## Frame

For any project, with no special configuration: defaults when a project declares nothing, tracked
overrides when it does; discovery tells entering agents what they run (workers never run the release gate).
bch-cloak adopts the same cycle later through a release; it is not the design center. The operator's
direction (2026-10-02): "we don't need to run the test harness for every little task item... it should
only validate before a release... package promotions into releases", and the same cycle must be in the
product "so bch-cloak could accept the same cycle as well." Also in `AGENTS.md` (e0c5282).

## Boundaries

Work only in this lane's worktree and scratch. Do not run the live acceptance harness (offline tests and
at most one `--skip-live` pass if you touch `acceptance/`). Never write bch-cloak, the shared `.lane.json`,
the releases, `~/.local/bin`, or panes you did not create; create Herdr objects with --no-focus. Keep
`contrib/settle-watch.mjs` as `AGENTS.md` says. Every test sets its own `ORG_ACTOR` and is bounded. No push
or publish; never activate a release.

## Reply

Commit on this lane; write the report at the path your prompt names, with `decisions`,
`questions` and `challenges` after `artifacts`; cite commits by subject; `record check` it, commit
it, and run `lane check` last. Then stop. Rebase onto main yourself if it moves.

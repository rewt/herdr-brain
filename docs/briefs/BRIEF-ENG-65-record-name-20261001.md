# Brief: ENG-65, the record's name where people see it

Org item **ENG-65**, under Phase 2 (ARCH-7) of the platform roadmap (G-3). Read
`docs/north-star.md` first, then `docs/roadmap.md` and `AGENTS.md`. They are the context;
this brief is only the ask.

## The outcome

The product reads as **Herdr Monitor** and its state module as **record** everywhere a
person sees a name: the CLI they type, its help, the console's labels, the docs a new
adopter would read. `org` keeps working as a permanent alias, along with every other old
name (`.org/`, `ORG_DIR`, `ORG_ACTOR`, the `org` symlink bch-cloak uses).

## Why it matters, and to whom

The operator chose plain module names (HUM-15). "org" says nothing to someone adopting the
plugin; "record" says what it holds. The people who live with it:
- the operator, who types the command and reads the console;
- agents, whose briefs and habits say `org` and must not break;
- bch-cloak, which runs the activated release (v0.1.2) through paths that must not move;
- a future adopter, who meets the names first in help and docs.

## How the result will be judged

- `record <cmd>` and `org <cmd>` behave identically for every command, with tests that
  prove it rather than one spot check.
- A person reading `record help`, the console and the README meets "record" and
  "Herdr Monitor"; a person typing `org` is never told they are wrong.
- Nothing bch-cloak depends on moves or changes meaning. `npm test` is green.
- The diff is small for what it does. A rename that touches every line is a smell.

## Premises to test

Say for each whether it holds, with evidence.

1. "Renaming the data directory and env vars buys nothing." Maybe a new adopter's
   `record init` should create something other than `.org/`. Decide, and say why.
2. "`org` must remain forever." It might instead print nothing different but be
   documented as the legacy name. Decide what "permanent alias" should mean.
3. "Internal identifiers (file names like `bin/org.mjs`, event fields) should stay." Moving
   them may cost more than it is worth; or it may be cheap now and expensive later.
4. Anything in this brief you find wrong.

## Already decided

- Names: Herdr Monitor; module `record` (HUM-15). Not up for reopening.
- The record stays our own event log (ARCH-11).
- Phase 2 does not create module folders (ARCH-7's 14:48 decision).
- The contract in `AGENTS.md`.

## Boundaries

- Work only in this lane's worktree. Never write bch-cloak's repository or record
  (`/Users/rewt/development/bastian`), never touch `~/.local/share/herdr-monitor/releases`
  or `current`, never run `herdr/release.sh activate`.
- Leave `~/.local/bin` alone: installing the `record` command for the canary is the
  supervisor's step after promotion. Say in your report what it should be.
- No push, publish or account sign-up.

## Where you are free

How the alias works, what gets renamed and what stays, and how deep into the docs you go.
If something here is a bad idea, say so and do the better thing.

## Reply

Commit your work on this lane. Write the report at
`docs/reports/ENG-65-record-name-20261001.md` using the template in your run brief
(the path `org start` printed, also `org brief <R-n>`), with `decisions`, `questions` and
`challenges` after `artifacts` as in `docs/briefs/BRIEF-ARCH-11-item-layer-20261001.md`.
Run `org check` on it until it passes. Then stop.

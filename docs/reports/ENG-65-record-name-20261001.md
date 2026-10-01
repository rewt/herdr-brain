---
run: R-27
outcome: done
summary: |
  Herdr Monitor now presents its state module as record in CLI help and output, generated briefs,
  the console, and current adopter documentation. The record and org commands share one
  implementation and have parity coverage for every command; .org/, ORG_DIR, ORG_ACTOR, config
  fields, event fields, and bin/org.mjs retain their names and meaning. The live release,
  bch-cloak, ~/.local/bin, and the active release link were untouched. The full offline suite is
  green: 283 passed, one optional-dependency test skipped, zero failed.
headline: Herdr Monitor now uses record everywhere people see it while org remains an exact alias.
blockers: []
proposals: []
learnings:
  - Pointing both installed command names at bin/org.mjs makes exact alias behavior structural and avoids a thin launcher that breaks if copied away from the module tree.
  - Release restore previously had no way to distinguish a launcher created by activation from one that existed before it; missing markers make adding record reversible without changing existing launcher restoration.
  - Generated worker briefs are a user-visible naming surface too; changing only help, console labels and README examples would still teach new sessions to type org.
artifacts:
  - "implementation commit: 5d75562 (Name the public record CLI)"
  - bin/org.mjs exposed under both package and release launcher names
  - test/name-alias.test.mjs (help, package entry points, and byte-for-byte record/org parity for every command in the dispatch table)
  - herdr/release.sh and test/release.test.mjs (record launcher plus reversible restore)
  - README.md, docs/north-star.md, docs/roadmap.md, lib/render.mjs, and console/ (record and Herdr Monitor naming)
  - "npm test: 283 passed, 1 skipped because optional console dependencies are not installed, 0 failed"
  - "git diff --check: clean"
decisions:
  - decision: Keep .org/, ORG_DIR, ORG_ACTOR, the org project-config key, event fields and existing paths unchanged.
    why: They are durable compatibility and integration surfaces. Renaming them would split discovery and configuration into two sources without improving what an adopter sees.
  - decision: Define permanent alias to mean exact behavior, with no warning, deprecation message or org-specific output.
    why: Both entry points execute bin/org.mjs, and the parity test checks identical status, signal, stdout and stderr for every dispatched command.
  - decision: Keep bin/org.mjs as the implementation and expose it under both installed command names.
    why: Existing absolute paths and the bch-cloak symlink remain valid, while new users get the chosen name. A separate thin launcher would fail when copied away from the module tree; two aliases to one implementation are both simpler and exact.
  - decision: Add record to future release launchers and make newly created launchers removable by release restore.
    why: npm packaging alone would not install the command in the release path this project actually uses; restore must still return the machine to its exact pre-activation launcher set.
questions: []
challenges:
  - premise: Renaming the data directory and env vars buys nothing.
    verdict: holds
    evidence: record init still creates .org/ and discovery still has one precedence rule, ORG_DIR then nearest .org/. README and help explain these as retained compatibility names. Adding parallel names would create ambiguity over which record wins and would touch every integration for no operator-visible gain.
  - premise: org must remain forever.
    verdict: holds
    evidence: org is retained in package bins, the release launcher set and bin/org.mjs. test/name-alias.test.mjs enumerates all 23 dispatched commands and proves both entry points return byte-for-byte identical results; help calls org a permanent alias without treating its user as wrong.
  - premise: Internal identifiers such as bin/org.mjs and event fields should stay.
    verdict: holds
    evidence: The implementation file, storage layout, JSON/read-model fields and environment variables did not move. The public wrapper and presentation changes are sufficient, and keeping the old identifiers preserves bch-cloak and current tooling while keeping the diff localized.
  - premise: Help, the console and README are the complete human-visible naming surface.
    verdict: wrong
    evidence: lib/render.mjs emits status suggestions, snapshots and every worker brief, including executable lookup and report-check commands. Those surfaces were updated to record as well, and test/flow.test.mjs now verifies the generated brief points to record.
---

# The record name is a presentation boundary

`record` is the name a new operator or worker learns. `org` is not a deprecated spelling: it is
the permanent compatibility entry point into the same program. That distinction keeps the product
plain without forcing migrations into durable state or live automation.

The implementation follows that boundary directly. Package installation and future release
activation expose the unchanged `bin/org.mjs` under both names. Help, usage errors, generated
briefs and console language always say `record`, regardless of which alias launched them. Existing
code that invokes an absolute
`bin/org.mjs` path continues to work and gets the same output.

No alternate `.record/`, `RECORD_DIR` or `RECORD_ACTOR` was added. A second discovery vocabulary
would require precedence rules and could silently create two event logs for one project. The old
storage/configuration names are now explicitly documented as compatibility names, not accidental
branding.

## Evidence

The parity test mirrors the CLI's complete dispatch surface: init, add,
block, unblock, note, ask, answer, set, close, reopen, start, check, ingest, sync, abandon, brief,
status, snapshot, show, log, today, recap and console. For each it invokes both entry points and
compares exit status, signal, stdout and stderr. It also runs init, add, status --json and show
successfully through separately named `record` and `org` command links against separate temporary
records and compares their output and event logs.

The final `npm test` run passed 283 tests with zero failures. One console-launch test skipped
explicitly because the optional console dependencies are absent. Release tests prove activation
creates both command links, rollback keeps them on the selected immutable release, and restore
removes `record` when it did not exist before activation while restoring the old `org` link.

## Canary handoff

This run did not touch `~/.local/bin`, the installed releases, `current`, or bch-cloak. After this
commit is promoted, the supervisor should canary the command by first verifying
`~/.local/bin/record` is absent or a symlink, then link that command name to the promoted main
checkout's `bin/org.mjs`; it should not repoint `org` or `current`. When a release containing this
commit is later built and activated, `herdr/release.sh` will manage `record`, `org` and `lane`
together, and `restore` will return the launcher set to its pre-activation state.

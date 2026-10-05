---
run: R-257
outcome: done
summary: |
  Dispatch reads the Codex worker's visible screen before brief delivery and returns
  a specific blocked result for the hook-review dialog, with the affected profile,
  /hooks review instructions and ordinary retry guidance. The first brief remains
  unsent and the run, worker and live watcher are retained. Release activation now
  installs a stable current/ hook command and explicitly calls out per-profile review.
  The focused offline run passed 99 tests and found one existing packaging defect,
  proposed separately below. The required final lane check follows the report commit.
headline: Dispatch preserves briefs when Codex hooks need operator review.
blockers: []
proposals:
  - role: engineer
    title: Include the workflow runtime in the installed product inventory
    why: |
      lib/product-files.mjs omits workflow/ although promote/train.mjs imports
      ../workflow/engine.mjs. The relocated installed-runtime lane review test
      fails with ERR_MODULE_NOT_FOUND before the lane command runs. Both the
      omission and import exist at this lane's starting HEAD. Add the runtime
      to the shared distribution inventory and prove installed lane commands
      load after checkout relocation; this prevents broken plugin snapshots.
learnings:
  - Release hook commands must retain the literal current/ path rather than resolving it to a release directory; migration from the old command needs one operator review per profile.
  - Visible-screen reads avoid matching a resolved hook dialog retained in terminal scrollback; an unsent blocked request can stay at dispatch's existing prompt stage.
artifacts:
  - "Implementation commit: 499df79 (fix(dispatch): block briefs at Codex hook review dialogs)"
  - dispatch/dispatch.mjs
  - dispatch/hook-review.mjs
  - dispatch/test/dispatch.test.mjs
  - herdr/entry-install.mjs
  - herdr/release.sh
  - herdr/README.md
  - test/zero-setup-install.test.mjs
  - docs/reports/evidence/ENG-211-R257/focused.tap
  - "Final check command after the report commit: node lanes/lane.mjs check"
decisions: []
questions: []
challenges: []
---

Dispatch returns exit 1 and JSON `result: "blocked"`, code
`DISPATCH_HOOK_REVIEW`, run, worker/pane, journal and the actionable reason.
The same reason appears on stderr and in a durable run note. It names the
profile from the saved launch route (including `always_args`), or the configured
default profile when no explicit selector was present. The operator opens
`/hooks` in that worker session and reviews the hooks in that profile, then
uses `--retry R-n`. Dispatch sends no keys and writes no hook trust records.

The screen check precedes the `prompting` journal transition and the prompt
command. Normal blocked delivery stays at `prompt`; read failure also leaves
the brief unsent. An explicitly authorized resend is checked too, while an
earlier uncertain delivery stays `prompting` and retains its existing explicit
recovery requirements. Tests cover ANSI/bordered and wrapped titles, plural
counts, ordinary task prose, default and named profiles, saved-profile pinning,
repeated blocking, same-worker retry, one delivery, and screen-read failure.

Release activation passes its literal `$HERDR_MONITOR_HOME/current` hook
runtime to entry installation. Adapter receipts still pin the selected immutable
release. Existing hook ownership/preflight, transaction and rollback behavior
remain in use. The activation regression seeds the older release-specific hook,
checks migration, then verifies byte-identical Codex and Claude hook configuration
through upgrade and rollback, executes the stable command, and verifies that
default and named-profile configuration files were untouched. Printed setup
guidance and installation docs explain `/hooks`, per-profile trust, and the
one-time review needed when migrating to the stable command.

Validation command:

```sh
node test/helpers/run.mjs dispatch/test/dispatch.test.mjs test/zero-setup-install.test.mjs test/release.test.mjs test/plugin-install.test.mjs
```

Result: **99 passed, 1 failed**, 95.55 seconds; no skipped tests. All dispatch,
zero-setup installation (including the new activation case), and release tests
passed. The sole failure was `relocated installed runtime executes lane review
through its bundled template dependency` in the unchanged plugin test: the
installed copy lacks `workflow/engine.mjs`. Reading the starting HEAD confirms
the unchanged inventory omission and existing promotion import. No promotion
code was changed; the packaging repair is proposed above. `git diff --check`
passed. No live acceptance harness, project housekeeping, promotion or push ran.

Per the brief, the report is checked and committed before the final fast
`lane check`. That command writes its result to `.lane/gate.json`.

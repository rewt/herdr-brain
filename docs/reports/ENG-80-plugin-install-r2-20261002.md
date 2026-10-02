---
run: R-89
outcome: done
summary: |
  Fixed all five independent review findings with regression coverage for relocated plugin checkouts, actual older releases, selected-project supervisor entry, failed shell writes and namespaced rollback.
  Entry installation now writes a durable recovery journal before changing machine files, stages older installers without unsupported flags, and retains a stable runtime for Herdr's temporary-checkout builds. The build also installs pinned MCP dependencies alongside console dependencies.
  Rebased onto main, passed the full core and lane suites, and proved real Herdr plugin install/build/move plus native worker and manifest supervisor startup in an isolated scratch session. Code and evidence are committed; the report check and final lane gate follow the required commit sequence.
headline: Plugin installation survives relocation, older releases and failed shell writes
blockers: []
proposals: []
learnings:
  - Herdr builds a GitHub plugin in temporary Git staging and moves it after the build; entry adapters must retain a stable machine-owned runtime rather than that build path.
  - Manifest supervisor tabs start in the plugin root. HERDR_PLUGIN_CONTEXT_JSON supplies workspace_cwd and focused_pane_cwd; workspace get returns a summary without cwd. Git still determines canonical project identity.
  - The actual v0.1.4 discovery installer accepts its original install/remove flags but has no --check. v0.1.3 has no discovery installer. Scratch staging lets current preflight and recovery support both.
  - Recovery must include staged replacement paths as well as prior file bytes and modes, since termination can occur between writing a replacement and renaming it.
  - Git release identifiers can contain slashes; rollback must retain the complete identifier beneath the releases directory.
artifacts:
  - Commit subject Make plugin entry reversible across real installation paths on lane/plugin-install
  - Rebased main through commit subject Report release snapshot review fixes and offline comparisons
  - herdr/entry-install.mjs; herdr/entry-transaction.mjs; herdr/entry-runtime.mjs; herdr/supervisor.mjs; herdr/supervisor.sh; herdr/install.sh; herdr/release.sh
  - test/plugin-install.test.mjs; acceptance/plugin-entry.mjs; herdr/README.md; acceptance/README.md
  - docs/reports/ENG-80-plugin-install-r2-evidence-20261002
  - /private/tmp/e80-native-swVhPG/evidence
  - /private/tmp/eng80-r89-final-core-4.log; /private/tmp/eng80-r89-lanes-final-main.log
  - /private/tmp/eng80-r89-testbin-lnvox5qd/node
  - /private/tmp/eng80-r89-preserved-x4pdcbie/plugin-install/99fb258-r1.md
decisions:
  - text: Implement a content-addressed dependency-free entry runtime for plugin builds and retain existing immutable version directories as activation targets.
    category: design
    why: Herdr relocates its build checkout, while immutable version directories are stable and existing sessions need their original code to remain available.
  - text: Implement wrapper generation in scratch and apply validated machine changes through a durable recovery journal.
    category: design
    why: This supports the actual older installer contract and restores completed or staged writes after failure without overwriting user edits.
  - text: Resolve the explicit supervisor's invocation directory from Herdr context and verify canonical identity through Git.
    category: design
    why: The plugin pane's default working directory belongs to the plugin rather than the selected project; workspace labels and agent session metadata grant no authority.
questions: []
challenges:
  - The default-concurrency core run after the last rebase stalled in an existing lifecycle fixture when an orphaned fake native process retained stdout. Only that test run's isolated process group was terminated. The complete npm test suite passed with four workers supplied by a scratch Node launcher; no cases or assertions were excluded.
---

The five fixes are covered by concrete install boundaries:

| Boundary | Change and regression evidence |
| --- | --- |
| Herdr relocates its checkout | Plugin build installs read-only entry code under `entry/runtimes/<content hash>`. An offline test moves and then deletes the checkout, launches through a fresh shell, and restores. The native canary uses the real `herdr plugin install` staging/build/move workflow with a local Git remote substituted for GitHub transport. |
| Manifest supervisor starts in the plugin directory | The launcher uses `workspace_cwd` from invocation context and resolves linked worktrees to their canonical checkout. Missing or inconsistent context refuses. The native manifest tab opens without a cwd override: its returned initial cwd is the managed plugin checkout, while native Codex's receipt and ready UI identify the unrelated canonical project. |
| Older release installers reject newer flags | Preflight runs the selected actual installer into a disposable bin with its original flags, then validates the generated bytes itself. Regression copies the read-only installed v0.1.3 and v0.1.4 distributions into scratch, activates both, rolls back and forward across the candidate, and restores from v0.1.4. The source releases stay untouched. |
| Shell writes fail partway through installation | All writable destinations are checked first. A synced, exclusively created `.monitor-recovery.json` precedes runtime or live file changes and records before/after bytes, modes and temporary paths. Tests refuse a mode-0400 `.bashrc`, make it non-writable after the first snippet, terminate after that snippet, and terminate before the next replacement rename. Recovery restores prior state and removes staged files and the incomplete runtime; retry and removal work. |
| Previous release has a namespaced tag | Rollback retains the complete relative release identifier, validated as a Git tag name. A `series/first` regression includes an unrelated `first` release and proves rollback selects the correct directory. |

The additional MCP build regression verifies both real package locations receive
`npm ci --no-audit --no-fund --prefer-offline`, verifies `RELEASE_NO_NPM=1`
skips both, and verifies dependency failure stops before entry changes.
Older archives without an MCP package remain supported.

Validation: baseline `npm test` passed before edits (470 pass, 4 optional skips).
The final rebased `npm test` passed all 493 cases (488 pass, 5 optional skips)
with the scratch launcher setting four test workers; `npm run test:lanes`
passed all 147 cases. All 14 plugin-install tests ran, including the actual
older-release scratch tests. New tests each provide their own `ORG_ACTOR` and
time bounds. The five core skips are three opt-in native sandbox checks and
the console/MCP integrations whose optional dependencies are absent in this lane.

The final native canary passed against the installed native Codex executable:

```sh
ORG_ACTOR=eng80-r89-final-native node acceptance/plugin-entry.mjs \
  --candidate "$PWD" --native-codex /Users/rewt/.local/bin/codex
```

It delivered worker discovery and the supervisor-only housekeeping startup
instruction from the relocated install's stable runtime, restored original
shell bytes, uninstalled its plugin and stopped its own named server. Cleanup
has no errors. No prompt, inference or housekeeping loop ran. Its native UI
uses a dummy credential and a no-network, scratch-write sandbox. The committed
evidence contains policies, native cwd receipts, initial manifest cwd, invocation
context, local Git transport and UI captures. GitHub network access, actual npm
downloads, launchd, absolute native binary paths and desktop/remote entry remain
outside this canary; the latter transports are already tracked by ENG-93.

The pre-existing untracked review was preserved at the scratch path above so
the lane can be checked cleanly; external findings were not copied into the repo.
No live installation, operator harness configuration, shared lane config,
bch-cloak checkout or unowned Herdr pane was changed. Nothing was pushed.

After this report is record-checked and committed, the final command is
`lane check --cmd 'npm test'` with the same four-worker scratch launcher. Its
result is retained in `.lane/gate.json` for the report commit. Then this run stops.

---
run: R-97
outcome: done
summary: |
  Resolved both independent review findings with ten new regressions. Installation now retains the first inspected byte-and-mode snapshot for every destination, derives ownership and replacement plans from it, and refuses planning edits before publishing a recovery journal, including edits to unchanged files.
  Both release-test fixture paths now isolate HOME, ZDOTDIR and the entry bin and discard inherited installation overrides. A child release suite runs under a separate installed scratch parent's environment and proves its adapters, receipts and shell files retain every byte and mode.
  The fixes are committed on the lane. The full offline suite, all lane tests and the real native Herdr plugin entry canary passed. Main remains an ancestor of this lane; report checking, the report commit and the final lane gate follow.
headline: Plugin installation preserves planning edits and release tests stay inside scratch homes
blockers: []
proposals: []
learnings:
  - An installation mutex excludes installers but not editors. Ownership checks, planned replacements and recovery before-state must all use the same first inspected destination bytes and mode; rereading during planning can silently accept and discard an operator edit.
  - Validation must include inspected destinations whose replacement is unchanged, so an idempotent install cannot accept edits made after ownership preflight.
  - A scratch release home alone does not isolate machine installation. Release fixtures must own HOME, ZDOTDIR and HERDR_MONITOR_ENTRY_BIN and sanitize inherited installation and release controls on every invocation path.
artifacts:
  - Commit subject Preserve inspected entry state and isolate release fixtures on lane/plugin-install
  - herdr/entry-install.mjs; herdr/README.md; test/plugin-install.test.mjs; test/release.test.mjs; test/helpers/release-environment.mjs
  - docs/reports/ENG-80-plugin-install-r4-evidence-20261002/summary.json
  - /private/tmp/eng80-r97-red.log; /private/tmp/eng80-r97-release-witness.log; /private/tmp/eng80-r97-regressions.log
  - /private/tmp/eng80-r97-core.log; /private/tmp/eng80-r97-lanes.log
  - /private/tmp/e80-native-R6emZt/evidence; /private/tmp/eng80-r97-native-authorized.log
  - /private/tmp/e80-native-wXUfJs/evidence; /private/tmp/eng80-r97-native.log
  - /private/tmp/eng80-r97-runner.py
  - docs/reports/ENG-80-plugin-install-r4-20261002.md
  - /Users/rewt/development/rewt/.org/runs/R-97/report.md
  - /private/tmp/eng80-r97-final-gate.log; .lane/gate.json
decisions:
  - text: Retain one first inspected byte-and-mode snapshot per destination and reject later differences across the complete inspected set before publishing the journal.
    category: design
    why: Ownership checks and replacement plans must refer to the same state, including destinations that require no write.
  - text: Share sanitized installation environments across both release-test invocation paths and verify an inherited parent installation through a complete child suite.
    category: tooling
    why: Supported machine overrides must remain usable in the product while offline release fixtures stay inside their own scratch destinations.
questions: []
challenges:
  - The sandbox prevented the first native canary's isolated Herdr server from starting with Operation not permitted. The explicitly authorized scratch canary was rerun with approved access and passed with an empty cleanup-error list; no live installation or unowned pane was changed.
---

The first finding is fixed at the initial inspection boundary. The installer
caches each destination's bytes and mode before staging the discovery installer.
It parses receipts and checks adapter/snippet ownership against those snapshots,
then uses those same snapshots for replacement construction and transaction
before-state. After planning it compares every inspected destination with the
original snapshot, even when the planned diff is empty. Existing transaction
validation and per-write checks remain in place.

Nine regressions edit destinations just before the staged installer runs:
byte and mode edits to a first-install shell file, an installed adapter, an
installation receipt and an unchanged shell file, plus creation of an originally
absent adapter. Each proves refusal, retained operator edits, unchanged other
machine files, no recovery journal and no newly published runtime. All nine
failed against the prior implementation because installation succeeded.

The second finding is fixed in the test boundary. Both existing release fixture
paths share a sanitized environment and scratch home, shell directory and entry
bin. Their native installation overrides, release switches and optional Herdr
binary cannot come from the parent process. Release subprocesses and tests now
have time limits, and each scratch fixture sets its own actor. Plugin installation
fixtures use the same sanitation helper.

The tenth regression installs a separate scratch parent, then runs the complete
child release suite with that installation's overrides inherited. It clears
Node's inherited test-runner context and checks that the child suite executes
with no skipped cases. After the suite, every parent adapter, receipt and shell
file must retain its bytes and mode. Against the old release fixtures this
regression witnessed removal of the parent's installation receipt. With the
fixed fixtures it passes, including the fake-Herdr registration path.

Validation:

- Before changes, npm test passed 531 cases with zero failures and five optional
  skips, within its three-minute bound.
- The focused plugin-install and release suites passed all 41 cases with no skips.
- After changes, npm test passed 541 cases with zero failures and five optional
  skips. The skips remain the three opt-in native sandbox cases and two optional
  console/MCP dependency cases.
- npm run test:lanes passed all 148 cases with zero failures or skips. Full suites
  ran with isolated actors and a ten-minute process-group bound; the lane suite
  used the existing scratch launcher limiting Node test workers to four.
- The real native Herdr canary passed its actual temporary plugin checkout,
  manifest build, managed move, native Codex worker start, manifest supervisor
  entry from an unrelated pristine Git project, restore and uninstall. Native
  receipts show discovery policy and the supervisor-only default housekeeping
  instruction at the executable boundary. shell-restore.json records identical
  base64 before and after restoration, including malformed UTF-8 bytes; cleanup
  reports no errors.

The canary uses a dummy credential, denies network and restricts native UI writes
to scratch and terminal devices. It sends no prompt, calls no model and starts no
housekeeping loop. Local Git substitutes for GitHub clone transport. Actual npm
downloads and launchd remain outside this proof. Absolute native binary paths
need a harness entry hook or explicit launch adapter; desktop entry needs its
app's instruction/entry transport; remote entry needs installation on the remote
host or a remote harness hook. Those follow-on transports remain tracked by
ENG-93.

No previous report was altered, nothing was pushed or published, and no live
machine installation, shared configuration, harness configuration or unowned
Herdr pane was changed. Main remains at the reviewed base, commit subject Brief
for ENG-94: the supervisor module, and is an ancestor of this lane.

After record check and the report commit, the final action is lane check with
npm test. Its bounded log is /private/tmp/eng80-r97-final-gate.log and its commit
receipt is .lane/gate.json. Then this run stops.

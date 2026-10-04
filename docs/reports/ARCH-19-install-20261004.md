---
run: R-201
outcome: done
summary: |
  Implemented prerequisite checks before installation, Codex-only/Claude-only/both installation, reversible native user hooks, and repeat-install dependency reuse. First project entry joins the existing fleet and opens the console and supervisor without focus; Claude-only installs select the existing Claude supervisor entry and macOS validation provider. Added offline acceptance tests and a real macOS login mode to the adoption rehearsal. Focused validation passed; the operator still runs the fresh-account rehearsal and live UI observation before release acceptance.
headline: Installation supports either harness and is ready for the fresh account rehearsal
blockers: []
proposals: []
learnings:
  - Native macOS validation already supports Claude-only entry through auto selecting sandbox-exec; installing Codex is unnecessary for that case.
  - The existing native deadline stack already reserves 30 minutes for promotion validation and up to one hour for aggregate entry operations; its scaled offline test verifies timeout and descendant cleanup.
  - Herdr pane listings do not carry plugin entrypoint metadata. Opening returns result.plugin_pane with plugin_id, entrypoint and pane; control reuse compares the returned pane and terminal IDs under the verified project Git identity.
  - Native user SessionStart hooks provide fleet join and adapter guidance, while the installed adapters own bounded worker operations. Codex requires the user to review new or changed hook definitions through /hooks.
  - Installation test environments must clear inherited CODEX_HOME and CLAUDE_CONFIG_DIR as well as Monitor destinations, so native hook writes stay in their fixture account.
artifacts:
  - commit 80bc3cf on lane/install
  - test/zero-setup-install.test.mjs
  - herdr/prerequisites.mjs
  - herdr/native-hooks.mjs
  - herdr/native-entry.mjs
  - herdr/project-entry.mjs
  - herdr/dependencies.mjs
  - docs/adoption/rehearse.mjs
  - docs/adoption/account.mjs
  - docs/ADOPTING.md
  - docs/reports/evidence/ARCH-19-R201/acceptance-final.tap
  - docs/reports/evidence/ARCH-19-R201/install-final.tap
  - docs/reports/evidence/ARCH-19-R201/long-promotion.tap
  - docs/reports/evidence/ARCH-19-R201/herdr-contract.json
decisions:
  - text: Reuse the existing fleet join, native validation providers, promotion deadlines and supervisor housekeeping recovery rather than introduce another installer framework or scheduler.
    category: design
    why: These mechanisms already supply the required defaults and preserve the separation between worker entry and canonical supervisor housekeeping.
  - text: Install only a removable user SessionStart group and retain native hook trust review and existing permission settings.
    category: security
    why: Native hooks cover launches beyond PATH without project hook trust dialogs, changing sandbox policy or writing harness trust records.
questions: []
challenges:
  - The fresh-account and live agent-pane acceptance is intentionally left to the operator, as requested. This run proves the implementation with offline fixtures and does not claim that the account rehearsal has passed.
  - Linux Claude-only validation remains outside the macOS-first acceptance; the existing Linux provider requires native Codex. Discovery confinement and adapter sandbox settings were left untouched for the native sandbox lane.
---

Acceptance tests were written before implementation. Missing npm, Git, Python,
Herdr or both harnesses names the installation input and fails before shell or
native configuration changes. The plugin build preflights machine destinations
before dependency installation. Tests cover all three harness combinations,
default discovery with the other harness absent, repeated builds/entry installs,
exact original byte/mode restoration, preserving unrelated user settings,
refusing modified managed hooks and rollback of interrupted native config writes.

Native hook commands pin the installed runtime, entry bin and any explicit fleet
destination, so relocating Herdr's temporary checkout cannot break native entry.
Only the managed SessionStart group is owned. No project configuration, project
hook, stored item status, event-log writer, new scheduler or dependencies were
added. Product snapshots use the existing shared inventory, which carries the
new herdr modules automatically. Workers do not start housekeeping. The plugin
supervisor selects Codex when available or Claude otherwise, and uses the existing
explicit supervisor adapter and recovery hook.

The focused installer run passed **53/53** tests. The final acceptance rerun
passed **14/14**. Existing native promotion deadline tests passed **2/2**, including
a shorter fast/aggregate timeout followed by successful longer promotion and
checks that descendants cannot leave a late write. The first deadline attempt
was denied by the lane's outer macOS sandbox; its offline rerun outside that
sandbox passed. The two initial installer failures were an npm version fixture
and empty native config directories after rollback; both are fixed, with the
green rerun retained. Syntax checks and `git diff --check` passed. No baseline,
full npm suite, promotion tier, lanes suite, live release harness, model call or
project-wide housekeeping loop was run.

`--fresh-account` checks the real macOS account/UID and HOME, refuses root,
substituted HOME and existing Monitor state, and uses that account's actual home
and Herdr plugin registry. It records source commit, account, harness, commands,
task/report and restoration evidence. Either `--native-codex` or `--native-claude`
selects the mechanical worker; the reviewed cycle remains scripted. The operator
recipe is in [ADOPTING.md](../ADOPTING.md) and
[WALKTHROUGH.md](../adoption/WALKTHROUGH.md). After restoration, the retained
candidate can be activated with the real native harness for the UI observation.
Publishing and account creation remain operator work.

Native formats and limitations were checked against the primary
[Codex hook documentation](https://learn.chatgpt.com/docs/hooks),
[Claude hook reference](https://code.claude.com/docs/en/hooks), and
[Herdr CLI reference](https://herdr.dev/docs/cli-reference/). The installed local
Herdr schema excerpt is retained in the evidence directory. Confinement,
adapters' sandbox settings and test tier lists were not edited. The diff was
reviewed against the brief before reporting.

The required final command after committing this checked report is
`node lanes/lane.mjs check`; its local receipt is `.lane/gate.json` and output is
retained in `.lane/ARCH-19-install-check.log`. Promotion and release acceptance
belong to the supervisor/operator.

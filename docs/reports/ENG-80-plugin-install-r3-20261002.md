---
run: R-95
outcome: done
summary: |
  Fixed all three round-two review findings with nine added regressions: installation ownership now covers recovery, planning and application; stable runtimes include the lane review template; shell files remain raw bytes throughout installation and restoration.
  Recovery validates the complete plan before mutation, records durable write intent, and removes only runtime directories owned by that transaction. Shell and recovery receipts store bytes as base64, with compatibility for existing installed shell receipts.
  Rebased onto current main, passed npm test and npm run test:lanes, and repeated the real Herdr plugin install/build/move and native startup canary with non-UTF-8 shell content and byte-identical restoration. The fixes and evidence are committed; report checking, its commit and the final lane gate follow the required sequence.
headline: Plugin installation preserves shell bytes and serializes planning through recovery
blockers: []
proposals: []
learnings:
  - A journal that serializes writes cannot protect plans captured earlier. Installation ownership must precede machine-state reads and runtime existence checks, and last-minute validation must cover the complete plan before a journal is published.
  - Matching planned after-bytes do not establish ownership. Recovery needs durable per-file write intent and a transaction token on any runtime it may remove.
  - Shell startup files can contain malformed UTF-8. Buffer comparisons and byte splices preserve current content; base64 receipts preserve the exact original bytes through recovery.
  - Bundled commands require distribution assets as well as code. Lane review reads lanes/docs/REVIEW_TEMPLATE.md, and current main's supervisor policy references settle/settle.mjs.
artifacts:
  - Commit subject Serialize plugin entry planning and preserve shell bytes on lane/plugin-install
  - "Rebased main through commit subject Brief for ENG-94: the supervisor module"
  - herdr/entry-lock.mjs; herdr/entry-install.mjs; herdr/entry-transaction.mjs; herdr/entry-runtime.mjs; herdr/README.md
  - test/plugin-install.test.mjs; acceptance/plugin-entry.mjs
  - docs/reports/ENG-80-plugin-install-r3-evidence-20261002
  - /private/tmp/e80-native-soiOFB/evidence
  - /private/tmp/eng80-r95-before.log; /private/tmp/eng80-r95-rebased-regressions.log; /private/tmp/eng80-r95-core.log; /private/tmp/eng80-r95-lanes.log
  - /private/tmp/eng80-r95-native-bytes.log; /private/tmp/eng80-r95-tests-e67a3mio/node
  - /private/tmp/eng80-r95-preserved-05ldv0yj/plugin-install/1ad31ea-r2.md
decisions:
  - text: Hold a single installation mutex across recovery, planning, complete-plan validation and application, with durable write intent and runtime ownership tokens.
    category: design
    why: A later stale transaction must never interpret a successful predecessor's matching bytes or runtime as its own rollback work.
  - text: Keep startup file contents as buffers and encode owned receipts as base64, while accepting existing installed shell receipts.
    category: design
    why: Installation, upgrades, rollback and restoration must preserve operator bytes even when those bytes are not valid UTF-8.
  - text: Include the lane review template explicitly and include the newly landed settlement module in stable entry runtimes.
    category: design
    why: Installed supervisor commands must retain their code and data dependencies after Herdr relocates its build checkout.
questions: []
challenges:
  - Pending recovery journals from the older installer are retained and refused by the new driver. Their text encoding and absent ownership information cannot prove safe byte restoration; recover them with their original installer before upgrading. Existing installed shell receipts remain compatible.
---

All three findings have concrete regression coverage:

| Finding | Implementation and proof |
| --- | --- |
| Planning occurred outside installation ownership | The installer acquires a nonempty, atomically published directory lock before reading any machine state or deciding whether a runtime exists. Its unique owner file permits safe dead-owner reclamation. A two-process barrier test pauses the first installer during planning and proves the second attempts the lock without reading shell or installation state. Both complete with intact adapters, one shell snippet and the first runtime's ownership token. Separate stale-plan tests reject changed files and a newly appeared runtime before publishing a journal. Fault tests preserve an unstarted foreign file even when its bytes match the planned result, and preserve a foreign final runtime while removing owned staging. |
| Stable runtime omitted the review template | An explicit asset allowlist includes lanes/docs/REVIEW_TEMPLATE.md; a source distribution containing lane.mjs without the template refuses snapshot creation. The actual plugin build installs a runtime, the source checkout is moved, and the installed lane command opens a scratch lane and executes review. A byte witness proves the real command reads its bundled template before the expected offline dispatch refusal. The same relocated runtime executes the newly bundled settlement CLI. No reviewer or live pane is launched by this offline test. |
| Shell files lost non-UTF-8 bytes | Machine state, comparisons, appends, snippet removal, atomic writes and recovery all use buffers. Version-two shell and recovery receipts encode bytes as canonical base64. Tests cover all four startup files with malformed UTF-8, CRLF, no final newline and original modes; real build/activation upgrades and restore return every byte and mode exactly. Further tests cover failed-write rollback, terminated-install recovery, and preservation of later non-UTF-8 edits through legacy receipt migration. |

The recovery receipt is synced before any new runtime or machine entry file is
changed. Each write intent is synced before that write; recovery touches only
started changes and runtime directories bearing its token. Runtime construction
uses owned staging followed by atomic publication. Unexpected operator edits
still refuse recovery and retain its receipt rather than overwrite those edits.

Validation passed before changes: `npm test` had 488 passes and five optional
skips. After rebasing onto updated main, the final `npm test` had 531 passes,
zero failures and five optional skips; `npm run test:lanes` passed all 148 cases.
All 23 plugin-install cases ran, including the real read-only v0.1.3/v0.1.4
scratch-copy activation and rollback tests, relocated checkout paths,
non-writable shell refusal and pinned console/MCP dependency installation.
The nine new cases each use their own fixture actor and a 30-second bound.
The full suites use a scratch launcher setting four Node test workers, without
excluding cases, and an outer ten-minute process-group timeout. The five skips
are three opt-in native sandbox cases and two optional console/MCP integrations
whose dependencies are absent in this lane.

The native canary passed using the actual Herdr temporary-checkout plugin build,
managed move, native Codex worker entry, manifest supervisor entry from an
unrelated project, restore and uninstall. Its original `.zshrc` contains bytes
`ff c0 80` in a comment, and committed `shell-restore.json` records identical
base64 before and after restoration. Test-owned readiness markers are removed
with byte splices. Cleanup reports no errors. Native Codex uses a dummy
credential under a no-network, scratch-write sandbox; no prompt, inference or
housekeeping loop ran. GitHub clone transport is substituted with a local Git
repository. Actual npm downloads, launchd, absolute native paths and
desktop/remote entry remain outside this canary; entry transports beyond fresh
shell launches are already tracked by ENG-93.

The pre-existing untracked review was preserved in scratch at the artifact path
above. External findings were not copied into the repository. Work remained in
this lane and scratch directories; no live installation, shared project config,
harness user configuration or unowned Herdr pane was changed. Nothing was pushed.

After this report is checked with the record CLI and committed, the final command
is `lane check --cmd 'npm test'` with the same scratch launcher and an isolated
actor. Its result is retained in `.lane/gate.json` at the report commit. Then
this run stops.

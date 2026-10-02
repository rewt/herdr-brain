---
run: R-126
outcome: done
summary: |
  Offline suites now use refusal/fake Herdr executables, clear inherited live identities,
  and pin an absent scratch socket. Plugin fixtures install their fake before lane open.
  Acceptance persists creation receipts before follow-up reads, recovers implicit main
  and linked workspaces from confined creation intents, and audits the raw native inventory.
  Lane tests passed 151/151; offline acceptance passed 92/92. The isolated no-model
  mechanics pass preserved its workspace inventory and passed cleanup and focus checks.
  Core suite attempts encountered bounded timeouts under concurrent load; the two failed
  discovery tests passed separately. The final committed-head lane gate follows this report.
headline: Offline tests are isolated from Herdr and acceptance closes its created workspaces
blockers: []
proposals: []
learnings:
  - Herdr worktree create with --cwd can also open an implicit main-checkout workspace absent from its creation reply.
  - A successful native creation must be durably recorded before topology or shell-startup probes can fail.
  - A failed workspace get is not evidence of closure; audit the raw native workspace list.
artifacts:
  - 'Commit subject: Isolate offline tests and close every acceptance workspace'
  - 'Report commit subject: Report Herdr leak prevention for run R-126'
  - 'Branch: lane/herdr-leaks, rebased onto main including the release-only harness rule'
  - 'Implementation: test/helpers/offline-herdr.mjs, test/helpers/fixture-policy.mjs, test/plugin-install.test.mjs, acceptance/receipts.mjs, acceptance/cleanup.mjs'
  - 'Offline regressions: test/offline-herdr.test.mjs and acceptance/test/cleanup.test.mjs'
  - 'Lane suite: /tmp/eng107-lanes.log (151 passed, 0 failed)'
  - 'Acceptance offline suite: /tmp/eng107-acceptance-tests-green.log (92 passed, 0 failed)'
  - 'Core attempts: /tmp/eng107-baseline.log, /tmp/eng107-npm-test.log, /tmp/eng107-npm-test-final.log'
  - 'Discovery retry: /tmp/eng107-discovery-retry.log (2 passed, 0 failed)'
  - 'Final gate command: node lanes/lane.mjs check --cmd "npm test -- --file-timeout=480000 --suite-timeout=540000"; output /tmp/eng107-lane-check.log; receipt .lane/gate.json'
  - 'Isolated final mechanics evidence: /private/tmp/e107-harness-CCz9nQ/herdr-acceptance-6Xyf3T/evidence/summary.json, screen.txt, creations.jsonl, creation-intents.jsonl, cleanup-residue.json, focus-summary.json and numbered JSONL logs'
  - 'Isolated inventories: /private/tmp/e107-harness-CCz9nQ/before.json and after.json; both contain only w1'
  - 'Initial mechanics diagnostic: /private/tmp/e107-harness-E7Xb5y/herdr-acceptance-q1sltq/evidence/cleanup-residue.json'
  - 'Operator read-only inventories: /tmp/eng107-workspaces-before.json and /tmp/eng107-workspaces-after.json'
decisions:
  - text: Use refusal and fixture fake executables with an absent scratch socket for ordinary offline tests.
    category: tooling
    why: Prevent installation and lane tests from inheriting the operator server or live pane identities, including direct test-file execution.
  - text: Grant implicit creation ownership only to new native IDs at exact confined checkout paths absent from the pre-creation inventory.
    category: security
    why: Herdr may implicitly open the main checkout; this proof covers that side effect without granting closure authority over existing or unrelated workspaces.
  - text: Persist and replay creation receipts independently of optional topology probes and audit every remaining owned workspace by ID and label.
    category: design
    why: Failure, interruption, a stale ownership lock or a failed get must not hide successful creation or suppress cleanup of other workspaces.
  - text: Stop additional harness runs after the operator update and use offline validation for the remaining lane work.
    category: tooling
    why: The updated operator instruction supersedes the original brief's request for extra harness verification.
questions: []
challenges:
  - 'Two --skip-live isolated mechanics passes ran before the operator update arrived. The first exposed the implicit-parent leak; the second verified its fix. No further harness runs followed the update.'
  - 'The shared operator inventory changed from 175 to 185 during concurrent work (+11/-1). It includes a separate eng105-gate-final harness path, monitor-plugin-test fixtures and removal of lane-settle-rebase. This is not a clean global equivalence proof; the private-server inventory comparison is exact.'
  - 'Plain npm test attempts encountered bounded child/suite timeouts under concurrent load. The two discovery failures passed on their guarded standalone retry; the final gate uses the runner existing 480000/540000 ms bounds without changing shared configuration.'
---

The brief counted 245 historical leaks: 212 from plugin-install tests and 33 from
acceptance runs. The changes cover both sources and would prevent that documented
245-workspace class: tests cannot contact the operator server, and acceptance
retains explicit, linked and implicit-parent creation ownership through cleanup.
This is a prevention estimate against the brief, not a fresh historical census.
No existing leaked operator workspace was closed by this run.

The offline controls exercise pass/failure cleanup, SIGINT and SIGTERM, direct and
nested linked-worktree replies, topology-read failure, unfurled ownership receipts,
lost replies with an implicit main workspace, malformed journal entries, failed
listing/closure and named residue. An existing same-cwd ID never gains ownership;
unreceipted scratch residue is named without automatic closure authority. The lane
cwd mismatch control now uses its fake rather than the installed native CLI.

Native mechanics used a new named Herdr server with scratch HOME/config and its
own pinned socket. All creation calls used --no-focus; only that created server
was stopped. The final full case ordering with --skip-live took 124 seconds:
19 PASS, 0 FAIL, 8 PENDING. Cleanup and focus passed; the seed workspace w1 remained
alone before and after. The first diagnostic pass retained an unowned implicit
main workspace in its audit, then stopped its private server; the subsequent fix
records and closes it. Evidence stays in scratch, not in release artifacts.

No live/model release acceptance gate ran. The eight pending cases concern omitted
native discovery, bch-cloak compatibility/cutover and the offline console dependency
cache. They are release-supervisor work, excluded here by the operator update.
No bch-cloak, shared lane settings, release installation, operator bin, unrelated
pane or project-wide housekeeping loop was changed. SIGKILL and an unavailable
Herdr server cannot guarantee cleanup; failures remain named in the audit.

The initial sandbox baseline could not run ps ownership checks. Subsequent offline
suites used approved process-inspection access and a refusal CLI/absent socket.
An intermediate test-isolation control was corrected and passed; the final core
attempt timed out on two discovery children and its six-minute suite bound.
Those two tests passed separately (45 seconds total). Automatic approval initially
rejected that retry because it attributed the shared inventory changes to this
lane; source inspection established the scripted-only transport and the retry was
approved with an additional shell-level refusal CLI and absent socket.

The report is checked with record check and committed before the final lane check.
The exact committed-head gate result is recorded in .lane/gate.json and its log,
which remain outside the committed report so validation can run last.

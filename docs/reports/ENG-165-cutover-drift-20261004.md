---
run: R-223
outcome: done
summary: |
  Fixed the two requested cutover failures against a read-only snapshot of bch-cloak's current checkout. Both host temp spellings relocate into scratch, including dispatch locks and transitive callers; the independent sandbox remains unchanged. Retired only the legacy notify section of the mixed se-test, updated the event-service inline reference, and preserved strict zero-callers auditing and exact rollback. Offline acceptance tests passed 186/186; final cutover regressions passed 15/15. The complete source comparison also found that the restored legacy watcher now requires an outbox consumer; that remaining release-gate drift is proposed below, not claimed fixed.
headline: Scratch cutover locks and notify retirement are fixed, with rollback delivery drift identified
blockers: []
proposals:
  - role: engineer
    title: Update the cutover rollback canary for bch-cloak's queued notification transport
    why: |
      Current notify-watch.sh queues reports in .lane/supervisor/outbox instead of prompting the supervisor directly. acceptance/run.mjs legacyCanary still waits for a supervisor PTY receipt without starting a copied supervisor-events consumer. The new offline regression proves a successful legacy report produces one outbox message and no agent prompt. Keep the strict end-to-end delivery requirement and add a scratch-owned, scoped consumer with private instance-port and lifecycle receipts before the next release candidate gate; otherwise case 19 can time out after its lock failure is fixed and case 20 stays prerequisite-blocked.
learnings:
  - bch-cloak's se-test is mixed; its supervisor-events and kernel-lock checks remain useful, while its NW tests assert the retired outbox/verdict/grace interface and cannot simply point at arm-watch.
  - An inline comment after executable code is counted by the strict retirement audit; supervisor-events.mjs line 137 was an additional notify retirement hit in the retained RC-6 evidence.
  - WORK-PATTERN's existing 20261004 fixture is byte-identical to the current live document and needed no refresh.
  - The offline acceptance suite requires test/helpers/run.mjs to supply HERDR_TEST_SUITE_PID and manage fixture process ownership. macOS sandbox tests must run outside the inherited sandbox so their own policies can apply.
artifacts:
  - "Code commit: 91719ca (lane/cutover-drift)"
  - acceptance/cutover.mjs
  - acceptance/security.mjs
  - acceptance/test/fixtures/bch-cloak-20261004/manifest.json
  - docs/reports/evidence/ENG-165/R-223-acceptance.tap
  - docs/reports/evidence/ENG-165/R-223-cutover.tap
  - "node test/helpers/run.mjs acceptance/test/*.test.mjs: 186 passed, zero failed"
  - "node test/helpers/run.mjs acceptance/test/cutover.test.mjs: final 15 passed, zero failed"
decisions:
  - text: Retire the legacy notify portion of se-test and its NW default, preserving the supervisor-events tests and both kernel-lock tests.
    category: tooling
    why: The test file is mixed; redirecting its old outbox, verdict, and grace assertions to the standalone watcher would test the wrong contract. Capture and restore cover the whole file, including original bytes and mode.
  - text: Relocate both fixed host temp spellings in every copied file and refuse residual host temp paths before execution.
    category: tooling
    why: Dispatch is only one of several reachable fixed locks, queues, logs and sweep paths. Relocation occurs before inserting scratch paths to avoid remapping scratch roots under /private/tmp. The existing kernel refusal remains intact.
questions: []
challenges:
  - "The retained case 19 evidence names supervisor-events.mjs:137 as another audit hit beyond se-test/run.sh:6. Its stale inline comment is explicitly rewritten; the caller scanner has no new exemptions."
  - "The complete comparison found queued legacy delivery drift in addition to the requested lock and caller failures. No live or skip-live pass ran, so repaired release cases 19 and 20 are not claimed green."
---

Implemented the requested scratch-only changes in commit `91719ca`. The real
bch-cloak checkout was read only, and no real lock, pane, record, service or
release was mutated.

The switch list now has thirteen entries: the original eleven plus the mixed
se-test and supervisor-events comment correction. The dispatch lock still uses
`zsystem flock`, exits 3 while held, and releases with the shell. The switched
session-cap scan now counts `watch/watch.mjs` runs for its scratch supervisor
name, including the intervening `--org` and `--cwd` arguments. Foreign targets
are excluded. Missing targets and held/capped dispatches make no record call.

The se-test's NW default, NW helpers and notify assertions are retired together.
Its event-service tests and both lock checks remain, with the dispatch negative
control expecting the switched supervisor name. The obsolete inline reference
in `supervisor-events.mjs` is corrected explicitly. The zero-callers scanner is
unchanged: unknown callers, nested sources, executable scripts, referenced
backups and inline mentions still prevent retirement. Rollback restores all
thirteen complete files with their exact relocated bytes and original modes.

Every switch was compared against the current checkout and the older
`kit/bch-cloak-20261001` inventory:

| Switch file | Comparison and handling |
| --- | --- |
| scripts/lane/launch-supervisor.mjs | Changed: installed current/contrib entry instead of development checkout; existing strict relocation and split-entry switch handle it. |
| .lane/supervisor/continue.sh | Unchanged; existing retry guidance applies. |
| .lane/supervisor/arm-watch.sh | Unchanged; replaced with standalone delivery wrapper. |
| .lane/supervisor/dispatch.sh | Changed: kernel lock, session cap, explicit prepare failure. Relocate lock, preserve refusal and prepare guard, count switched watchers. |
| .lane/supervisor/tidy-tabs.sh | Unchanged; existing bounded log recovery and safe cleanup switch apply. |
| .lane/supervisor/close-finished-agents.sh | Changed to org on PATH; existing premise accepts it and installs recorded-outcome cleanup. |
| .lane/supervisor/session-start.sh | Changed: janitor start removed, no daemons start. Stable-name switch preserves this. |
| .lane/supervisor/SETTLE.md | Unchanged; split-launch and retry protocol added. |
| .lane/supervisor/WORK-PATTERN.md | Changed from the old kit; unchanged from the dated 20261004 fixture. Existing strict notice replacements apply to the full current document. |
| scripts/lane/routing.test.mjs | Unchanged; split-entry assertions remain. |
| .lane/supervisor/notify-watch.sh | Changed: outbox delivery, waiter suppression, event wait grace, report recheck, failed-queue protection. Retired in switched tree; restored queued delivery creates the follow-on above. |
| .lane/supervisor/se-test/run.sh | Absent from the old kit; new mixed event/notify/lock tests. Notify section retired; remaining coverage retained. |
| .lane/supervisor/supervisor-events.mjs | Absent from the old kit; event-driven outbox consumer with fixed queues, slot path and port. Paths relocated; inline notify reference corrected. Consumer launch remains outside this patch. |

The dated snapshot contains all 30 active callers, both switch documents, the
copied lane skill and routing configuration. Its manifest retains SHA-256,
original modes, comparisons and fixed-path lines; 34 unreferenced historical
script backups are listed separately. A final read-only comparison confirmed all
34 source files still matched and found no new active caller. Fixtures execute
only after copying and relocation; tests need no live checkout.

The fixed-path audit covered the entire copied source set, including transitive
callers and documents:

- `/private/tmp/bch-cloak-dispatch.flock` and `bch-cloak-promote.flock`;
- `/private/tmp/bch-cloak-waiters`, `bch-cloak-gate-requests` and `bch-cloak-test-slot.lock`;
- `/private/tmp/se-test-XXXX`, `se-test-fake-promote`, `$T` promotion-log roots and direct-review scratch guidance;
- `/private/tmp` as lane-close's scratch sweep root;
- `/private/tmp/apply-settle-cmds.$$`, `/tmp/orgctx-*`, `/tmp/prep-*`, and routing-test `/tmp` literals;
- absolute project/record/archive paths, worktree roots, installed-release paths, home/toolchain/persona/plugin paths and HOME/homedir/tilde references, handled by existing relocation.

Both temp spellings now map to the acceptance scratch root. `$T/tmp/slot.lock`
remains relative to the se-test's own relocated temp directory. The new audit
rejects residual fixed host temp paths; the independent OS policy still refuses
external writes and code reads. The retained kernel test passed. The event
service's fixed default port 47391 is additional non-filesystem drift: any future
scratch consumer must select a private port rather than contend with it.

Validation is offline only. The first direct `node --test` attempt hit the
inherited macOS sandbox's nested-sandbox refusal. Outside it, the focused
cutover/security/deadline files passed 28/28. A direct whole-suite invocation
then exposed missing runner ownership metadata and a composer fixture timing
failure; the repository runner passed all 186 acceptance tests. After the final
source expansion and queued-transport regression, the cutover file passed its
final 15/15 checks. Raw successful logs are committed. Syntax checks and diff
whitespace checks passed. Neither the live harness nor a skip-live pass ran.

This report is checked before its own commit. Per the brief, the final operation
after that commit is `node lanes/lane.mjs check` using the configured fast tier;
its result is returned in the session output, since updating this report after
that check would violate the requested ordering.

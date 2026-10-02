---
run: R-129
outcome: done
summary: |
  Implemented a dependency-free release module that batches promoted commits into
  a tagged candidate, builds its snapshot, runs the declared gate once, records
  evidence and requests an operator-only shipping decision. Added supervisor,
  discovery and console integration plus this repository's tracked declaration.
  Scratch projects exercise real promotions through gate and operator decision.
  The repository preview built and invoked acceptance once with --skip-live;
  its pending cases correctly prevented shipping approval. Final lane validation
  runs the complete offline npm test file list in three bounded phases on the
  committed implementation and report, isolating the copied-entry probes.
headline: Release candidates now batch promotions and wait for the operator to ship
blockers: []
proposals: []
learnings:
  - "Tracked .release.json uses argv arrays; default base is main, default gate is npm test, and default load threshold is one per available CPU."
  - "Installed entry and copied-product manifests must include release alongside the other cycle modules."
  - "Acceptance --skip-live deliberately cannot produce release-ready evidence; pending cases return a nonzero gate result."
  - "The complete acceptance record fixture needs its imported cycle modules and a bounded archive buffer above one MiB."
artifacts:
  - "Commit: Batch promotions into gated release candidates with operator shipping decisions"
  - "Commit: Keep acceptance record fixtures complete with bundled cycle modules"
  - "Commit: Verify signaled gates and moved candidate tags without replay"
  - "Commit: Keep release reminders after unresolved supervisor work"
  - "release/release.mjs, release/config.mjs, release/README.md, release/test/release.test.mjs"
  - ".release.json; lib/release-record.mjs; supervisor/PROTOCOL.md; console/modern/frame.mjs"
  - "docs/reports/ENG-109-release-preview-20261002.json; docs/reports/ENG-109-validation-20261002.mjs"
  - "Offline release tests: /tmp/eng-109-focused-final.log (12 passed)"
  - "Offline acceptance tests: /tmp/eng-109-acceptance-offline-complete.log (81 passed)"
  - "Focused regression tests: /tmp/eng-109-regressions.log (44 passed)"
  - "Final validation: node lanes/lane.mjs check --cmd 'node docs/reports/ENG-109-validation-20261002.mjs'; receipt .lane/gate.json; output /tmp/eng-109-lane-check-phases.log"
decisions:
  - text: "Use a finite foreground supervisor operation with the shared Git lock and an archived snapshot for each candidate."
    category: design
    why: "Exclude concurrent promotion and preserve an exact commit while its declared gate executes."
  - text: "Claim each gate durably before external execution; reuse completed evidence and hand interrupted claims to inspection."
    category: design
    why: "A crash or duplicate request must never silently repeat the same gate or create another question."
questions: []
challenges:
  - "The preview is isolated wiring evidence, not a production-ready candidate: 8 PASS, 0 FAIL, 19 PENDING; gate exit 1 and no shipping question."
  - "High host load required a scratch-only preview threshold of three per CPU; production retains one per CPU. Dependency installation was skipped in the preview."
  - "Initial npm runs exceeded the six-minute aggregate bound; the last monolithic run also exceeded nine minutes and timed out the two copied-entry probes at their existing 15-second command limit. Final validation runs every npm test file in three bounded phases without relaxing fixture limits. Two cold-start ordering regressions were corrected; a rebase-time module-load failure passed on the stable tree."
---

Promotions continue to use their fast lane validation. The new cycle is
`supervisor release --role supervisor`, or `release/release.mjs --once --role
supervisor`, from the canonical checkout. It requires a clean declared base,
low configured load, a drained promotion queue and the shared promotion lock.
Candidate tags, commit batches, gate starts, results and decision links are
durable record facts; `record releases` and status expose their derived state.
Older folds ignore the new events.

A passing result atomically creates one publish question reserved for the
operator even when publish is configured as auto. Agents cannot answer,
overrule, forge decision fields, close or reopen that question. Approval executes
nothing: the declared ship argv is displayed for the operator, who also owns
activation. The modern console's Control → Releases view (`L`) shows candidates,
gate results, evidence and links to the pending questions. Cold start preserves
unresolved report and missing-checkout actions before release reminders.

The offline scratch proof performs two real lane promotions, archives their
shared main tip, runs one trivial declared gate and creates one question. A
scripted operator answer is recorded without executing the declared ship command.
Coverage also includes default discovery/record initialization, red preparation
and gate results, a signaled gate, pending/interrupted recovery, duplicate and
conflicting receipts, moved tags, load/STOP/dirty/role checks, promotion contention,
auto-category resistance, old-fold compatibility and supervisor/console entry.

The single repository preview used:

```sh
ORG_ACTOR=R-129 node release/release.mjs --dry-run --skip-live --max-load-per-cpu 3
```

It cloned the implementation commit into an owned scratch project, committed the
preview override there, cut a candidate tag, archived its exact commit, ran the
declared build-only preparation and invoked acceptance against the built snapshot.
The compact JSON evidence retains the source, candidate, commands, three record
events, raw evidence paths and every case disposition. Missing live prerequisites,
the omitted dependency cache and explicitly skipped discovery remained pending.
No canonical candidate, installed release, activation, bch-cloak data, shared
configuration or existing pane was changed.

The lane was rebased onto the main update titled “Amend ENG-103/ENG-105 briefs:
release gate per release, not per lane.” The final lane check runs the complete
offline npm test file list with the existing bounded timeout options and records this report's
commit as its validated head. The phased runner derives every file from
package.json's npm test command, checks complete coverage, and retains the runner's
existing file, command and suite bounds. The copied-entry probes run alone; the
other core/module files and settle/supervisor/release files occupy separate phases.
No live acceptance run, model call, push or publish was performed.

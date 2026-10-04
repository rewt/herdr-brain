---
run: R-227
outcome: done
summary: |
  Implemented release snapshot retention at the end of canonical release cycles, under the shared promotion lock, with a separate read-only retention report. Active, awaiting-operator, pending, interrupted, and latest-passed candidates remain available; removable snapshots require matching ownership markers and surviving tags. New or changed evidence is preserved before deletion, with synced intent and removal receipts. The supervisor brief now shows four bounded, advisory storage measurements. Focused offline checks passed; the final lane check follows the report commit.
headline: Release snapshots now shrink after recorded results and the supervisor shows project storage use.
blockers: []
proposals: []
learnings:
  - "Build evidence lives inside candidate snapshots as .release-build.json and must be preserved outside them before pruning."
  - "The standard active release is identified by HERDR_MONITOR_HOME/current/.release-commit; other activation schemes can supply RELEASE_ACTIVE_TAG or --active-tag to the retention command."
  - "Most historical evidence in a snapshot is already byte-identical to its tagged Git blobs; checking those hashes avoids copying committed history into local evidence again."
artifacts:
  - "Implementation commit 3db4a87 on lane/lean-storage"
  - "release/retention.mjs and release/test/retention.test.mjs"
  - "release/release.mjs and release/test/release.test.mjs"
  - "supervisor/footprint.mjs, supervisor/context.mjs, and supervisor/test/footprint.test.mjs"
  - "release/README.md and supervisor/README.md"
  - "Final focused test output: /private/tmp/ENG-169-final-focused.tap"
  - "Final gate command: node lanes/lane.mjs check; receipt .lane/gate.json"
decisions: []
questions: []
challenges: []
---

Implemented both requested storage changes without touching lib/, bin/org.mjs,
dispatch/, discovery/, committed historical evidence, or the archive/scratch sweep.

Retention reads fresh candidate facts through the record CLI. It runs after a
recorded result and when a cycle returns existing evidence or an inspection
handoff. The same lock covers release execution and pruning. It keeps unfinished
claims and recorded signal interruptions, so inspection and actual-result
recovery remain possible without replaying preparation or a gate.

`node release/release.mjs --prune --dry-run` reports the current project's plan
without cutting a candidate, running a gate, or writing state. Applying retention
requires the canonical supervisor, honors STOP, and acquires the shared lock.
A removable directory must be exactly release/candidates/TAG, with a matching
regular ownership marker and an unchanged surviving tag. Foreign paths,
symlink roots/ancestors, source/evidence symlinks, special files, moved tags, and
conflicting evidence refuse deletion. Generated dependency/cache links are never
followed. Unknown directories and partial extractions remain untouched.

Logs, JSONL, receipts/evidence, build evidence and JSON outside generated
dependency/cache trees survive in release/evidence/TAG when new or changed.
Byte-identical tagged historical evidence remains in Git. Evidence files and
directories are synced before a synced removal intent is written; a synced
removal receipt follows deletion. Existing external logs, receipts and acceptance
evidence paths remain available. Tags remain usable to reconstruct snapshots.

The supervisor cold start reports record, release, lane validation and promote
batch storage in four advisory lines. JSON includes allocated and apparent bytes.
Measurements deduplicate hardlinks, exclude symlink targets, and stop at 100,000
entries or one second per area, labeling incomplete measurements as lower bounds.
No storage threshold changes work status or refuses work.

Validation:

- Initial focused release, candidate, retention and footprint checks: 48 passed,
  zero failures, through `node test/helpers/run.mjs release/test/retention.test.mjs
  supervisor/test/footprint.test.mjs release/test/release.test.mjs
  release/test/candidate.test.mjs`.
- After the final retention refinements, 17 selected checks passed, zero failures,
  including every retention case and the release failure, signaled gate and
  actual-result recovery paths. Command: `node test/helpers/run.mjs
  --test-name-pattern='^(retention|installed current|pruning retains|unrecorded
  directories|red gate|result recovery|preparation env)'
  release/test/retention.test.mjs release/test/release.test.mjs` (the pattern is
  one line). Recovery coverage also proves duplicate results still work after a
  snapshot disappears, a gate is never replayed, and STOP permits only inspection.
- Five existing supervisor cold-start/history/identity checks passed, zero
  failures, using the pattern `^(cold start|full JSON|ingested report decisions)`
  on supervisor/test/supervisor.test.mjs.
- `git diff --check` passed before the implementation commit.
- Read-only inspection of this project's current record identified RC-1 through
  RC-6 as removable and retained RC-7 as the most recent passed candidate, with
  no refusals. No live snapshots were removed in this lane.
- Read-only footprint measurement found record 27.9 MiB, release 477.6 MiB,
  lane validation 18.8 MiB, and promote batches 7.0 MiB allocated locally; release
  measurement excludes symlink targets. These are observational measurements,
  not limits or a claim that the live storage has already been reduced.

The report is checked with the record CLI and committed separately. The final
lane check runs after that commit. No promotion/full release suite or live
acceptance harness ran in this lane.

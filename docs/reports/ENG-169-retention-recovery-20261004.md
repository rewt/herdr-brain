---
run: R-230
outcome: done
summary: |
  Fixed the Major and Moderate retention review findings. Recorded gate logs inside snapshots are preserved regardless of filename. Synced removal intents now carry directory ownership and evidence hashes; retries validate those proofs before resuming partial deletion or appending a missing completion receipt. Focused offline validation passed with 37 checks and zero failures. The supervisor scoped the footprint Minor to follow-up work; it is proposed below. The report is checked and committed before the final lane check.
headline: Release retention now preserves recorded gate logs and safely recovers interrupted pruning.
blockers: []
proposals:
  - role: engineer
    title: Bound supervisor footprint enumeration within wide directories
    why: The supervisor explicitly deferred the footprint Minor from this run. Incrementally enumerate directory children and enforce remaining entry and time allowances while reading them, with a wide-directory regression using a small allowance. The current whole-directory read can exceed the advertised bounds and queue too many paths.
learnings:
  - "An actual-result recovery receipt can record a gate log inside its snapshot with an arbitrary filename, including gate-output.txt; filename filters alone do not preserve that evidence."
  - "Recursive snapshot removal can unlink .release-commit before failing. Recovery needs a synced intent with the original directory device/inode identity and verified retained evidence; an absent marker alone cannot establish ownership."
  - "Legacy incomplete removal intents lack directory identity and evidence hashes. Retention refuses those retries for inspection instead of inferring ownership or deleting uncertain data."
artifacts:
  - "Implementation commit 0c41043 on lane/lean-storage"
  - "release/retention.mjs, release/test/retention.test.mjs, release/test/release.test.mjs, and release/README.md"
  - "Focused offline test output: /private/tmp/ENG-169-R-230-focused.tap"
  - "Report: docs/reports/ENG-169-retention-recovery-20261004.md"
  - "Final lane check: node lanes/lane.mjs check; receipt .lane/gate.json"
decisions: []
questions: []
challenges: []
---

Addressed the independent review at docs/reviews/lean-storage/093902b-r1.md
within the supervisor's revised scope. The inherited validation log had 178
passing fast checks and no failing checks to fix. The footprint Minor remains
unchanged and is proposed as follow-up work. No previous report was modified.

The recorded gate log is explicitly selected and copied to release/evidence/TAG
when it lies inside the snapshot, regardless of suffix or location in a generated
dependency tree. Missing logs, directory paths and symlinks refuse pruning.
External gate logs keep their existing locations. The actual-result recovery
regression now records gate-output.txt inside the snapshot, recovers the failed
result without replaying the gate, checks its retained bytes after pruning, and
verifies duplicate completion remains valid after the snapshot disappears.

Each synced removal intent now records the original snapshot's device/inode
identity and a SHA-256 manifest for selected evidence, identifying which files
were retained separately and which remain in the surviving Git tag. The ownership
marker is always retained separately. Retention reads outstanding intents and
validates the candidate paths, commit, surviving tag, retained ownership marker,
and hashes. For a remaining snapshot, its original directory identity must match
and all surviving selected evidence must still match the manifest. Only then can
it finish partial deletion despite the missing original ownership marker. An
already absent snapshot receives the missing completion receipt after evidence
validation. Both cases sync the candidates directory before recording completion.
Subsequent retries produce no duplicate completion. Dry runs report each recovery
case without modifying the journal or snapshot.

Recovery refuses replaced directories, changed or missing retained evidence,
changed or newly added snapshot evidence, symlinks, moved tags, conflicting
candidate facts, malformed journals and legacy intents without the required
proofs. Existing active/pending/interrupted/awaiting/latest-passed protections
still take precedence over removal intents. Uncertain cases retain remaining
snapshot data and report the refusal.

Validation command (offline, scratch fixtures only):

```sh
node test/helpers/run.mjs --test-name-pattern='^(retention|installed current|pruning retains|unrecorded|interrupted retention|missing completion|a newly active|a recorded gate log|result recovery|red gate|preparation env)' release/test/retention.test.mjs release/test/release.test.mjs
```

Result: 37 passed, zero failed, 22 unrelated checks skipped. The fault injections
cover removal stopping after .release-commit and the gate log are unlinked, and
completion receipt writing failing after deletion has finished. Other checks
cover safe refusals, dry-run recovery, idempotence, a newly active candidate,
gate failure, signal interruption, and actual-result recovery with a text log.
`git diff --check` passed before the implementation commit.

No live snapshots were removed. No full promotion/release suite or live acceptance
harness ran. The record CLI checks this report; it is then committed separately.
The final lane check runs last on that committed tree and writes .lane/gate.json.

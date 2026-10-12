# Release

Promotions accumulate on the integration branch. At a quiet point the canonical
supervisor runs a finite foreground cycle:

```sh
node /path/to/herdr-monitor/release/release.mjs --once --role supervisor
# Or, through the supervisor protocol:
node /path/to/herdr-monitor/supervisor/supervisor.mjs release --role supervisor
record releases
```

No project configuration is required. Defaults are `main`, a one-minute load
average at most one per available CPU, an archive of the exact tagged commit,
`npm test` as the release gate, and an operator-selected ship/activation step.
A project without a working npm gate must declare its actual gate. No model,
background loop, live pane operation, push or automatic ship is involved.
Workers never invoke this cycle or its gate. Discovery names the gate at entry.

The command defers under load, [memory pressure](../docs/reference/memory-gate.md), STOP, a promotion lock, a pending/current promotion
queue, or an earlier undecided candidate. It requires a clean canonical checkout
on the declared base. It holds the **same** Git-common-directory lock as direct
and queued promotions and lane closure through snapshot, build and gate execution.
The tag pins the candidate even when later promotions change main. History must
descend from the previous candidate. The record lists commits since that candidate
and retains previous candidates, failures and decisions.

Tracked `.release.json` overrides are read from the exact commit, not an untracked
file. For example:

```json
{
  "base": "main",
  "max_load_per_cpu": 1,
  "gate": ["node", "scripts/release-gate.mjs", "--candidate", "{candidate}"],
  "preflight": ["node", "scripts/release-inputs.mjs", "--repo", "{repo}"],
  "prepare": ["node", "scripts/build.mjs"],
  "prepare_env": {},
  "ship": ["node", "scripts/ship.mjs", "{tag}"],
  "parent": null
}
```

Commands are argument arrays, never shell text. `{tag}`, `{candidate}`, `{commit}`
and `{repo}` substitute inside each argument. Optional `preflight` checks machine
inputs from the clean canonical checkout under the project lock, before recording
the candidate, cutting its tag, claiming the gate or creating its snapshot. It must
be read-only; `{candidate}` names the future snapshot, which does not yet exist.
A nonzero exit, launch error or signal returns `setup-required`, with the command,
setup message and retained `{tag}.setup.log`. No new candidate, tag, gate-start/result
or ship question is created. Correct setup and invoke the cycle again to cut and
gate the current release base. If promotions have advanced the base meanwhile,
that later commit is cut normally; setup failure leaves no candidate blocking it.
Interrupted preflight is likewise retryable.
Optional `prepare` runs in the owned candidate snapshot before the gate; its environment overrides are scoped to
that command. The gate also runs in that snapshot. Project commands are trusted
project code and must use their own scratch directories when they need mutable
fixtures. `parent` may name an existing record item for the operator question.
`--repo`, `--org` and `--tag` select the project, record and tag explicitly.

This repository declares `herdr/release-candidate.mjs` as its project wrapper.
Preparation runs `herdr/install.sh` in build-only mode (the product has no npm
dependencies, so nothing is installed), then `npm run test:release`
(the complete offline suite formerly in promotion) before writing build evidence.
A failing offline suite stops preparation before live acceptance. It never installs machine entry.
The retained `.release-build.json` names the candidate commit and build command
before acceptance starts.
The gate requires successful preparation evidence before starting acceptance.
Copied-product workflows and deliberate long-response regressions must pass
before live acceptance starts; a failure stops the gate.
The gate passes `--bch-cloak`, when configured, to `acceptance/run.mjs`. `herdr/release.sh build` remains the operator's ship step;
activation remains a separate operator action. The live harness belongs only
to the canonical supervisor's release cycle, never a lane's validation.

Set this optional machine input in the invoking supervisor environment:

```sh
# Optional existing-project compatibility checks:
export RELEASE_BCH_CLOAK=/absolute/path/to/existing/bch-cloak
```

`RELEASE_BCH_CLOAK` is optional. When unset or empty, the five existing-project
compatibility cases report SKIP with a visible reason and the remaining cases
decide the gate. When configured, the path must exist and all compatibility
requirements remain in force; the harness reads that project only to create
its scratch compatibility copies. `RELEASE_NPM_CACHE` is no longer read.
This project's declared preflight checks the configured compatibility path
without copying or building anything.
Missing inputs return setup instructions without cutting a candidate or consuming
a gate attempt.

The record stores candidate, gate-start and gate-result events through the record
CLI. On a passing result it atomically creates one `publish` question, reserved for
`ORG_ACTOR=human`, even if publish is configured as auto. Agents cannot answer,
overrule, forge decision fields, close or reopen that question. Operator replies,
including `--overrule`, must start with yes or no. Case and punctuation are
normalized, and any following explanation is retained as the note. Other replies
are rejected without writing events or closing the question. A yes records
approval; it executes nothing. The operator executes the displayed ship argv from
the project checkout and controls any activation separately. A no retains the
candidate and evidence. `record releases` shows candidates, gate results, logs
and links to those questions.

Repeated calls on an already gated commit return the existing result without
another gate or question. A red build/gate retains evidence and asks no shipping
question; a later promoted commit can form a new candidate. Gates have no invented
timeout. After preflight passes, the record claims the gate once before snapshot,
preparation or gate execution.
An interrupted claim without a result is an inspection handoff, never a replay.
Crash locks fail closed: inspect owner.json and surviving children before removing
only a stale lock. If a gate completed but recording was interrupted, recover its
actual result with `record release result RC-n --file RECEIPT.json`; never rerun it
to reconstruct evidence. A different recorded result is rejected. Candidate intent
recorded before an interrupted tag cut can resume only on the same exact commit.
Evidence is kept in `GIT_COMMON_DIR/release/`, including snapshots and gate logs;
work status is derived from events, not stored in a module status file.

For this repository's wiring proof, from a clean committed lane:

```sh
node release/release.mjs --dry-run --skip-live
```

This clones the selected checkout into an owned temporary Git project, commits
the preview declaration there, builds its tagged archive and runs the same gate
with `--skip-live`. Its record and tags stay in scratch;
preparation uses the same build step and retains `.release-build.json`.
It neither ships nor activates. The retained scratch path and
source commit are returned. Preview results are distinct from production release
evidence. The production CLI refuses `--skip-live` without `--dry-run`.
`--max-load-per-cpu N` may change the tracked threshold in the scratch preview;
the returned evidence names it. It never overrides the production declaration.

`npm run test:release` includes the complete bounded offline inventory with
explicit actors: record, lane promotion, settle/recovery, supervisor,
queue, discovery, native ownership and offline acceptance coverage. The tier
helper partitions files across core, cycle, lanes, acceptance and release-only
steps so each file runs once; copied-entry probes stay isolated. Fixture, file
and suite watchdogs remain unchanged; failures stop validation immediately.

The release cycle takes the [host test slot](../test-slot/README.md) before
cutting or claiming a candidate, and keeps it through preparation and the gate.
A busy or unknown holder defers release without consuming its once-only gate
claim. Its CLI emits the coded refusal and exits 75. Only a recognized gate
timeout under measured load retries once within the held slot; preparation,
candidate creation, claim and interrupted-release recovery never replay.

## Snapshot retention

At the end of a release cycle, under the promotion/release lock, retention drops
snapshots whose results are durable. It keeps the active release, candidates
awaiting an operator decision, pending or interrupted gates (including recorded
signal interruptions), and the most recent passed candidate. An already recorded
result can be returned after its snapshot has gone; no gate or preparation is
replayed. Recover a missing result through `record release result` first. Its
snapshot stays available until then.

Inspect the existing project's retention plan without running a gate or writing
anything, including from a lane:

```sh
node release/release.mjs --prune --dry-run --repo /project --org /record
# The canonical supervisor can apply the same policy without cutting a candidate:
node release/release.mjs --prune --role supervisor --repo /project --org /record
```

This is separate from the scratch release-cycle `--dry-run` above. The JSON
report lists kept, refused, removed and would-remove candidates, with reasons.
The standard `HERDR_MONITOR_HOME/current/.release-commit` identifies the active
installed release by commit. Projects with another activation scheme supply
`RELEASE_ACTIVE_TAG` to their supervisor environment or `--active-tag TAG` to
`--prune`; it must name a recorded candidate. An existing activation pointer with
an unreadable or malformed commit marker refuses retention.

Only a recorded candidate's exact `GIT_COMMON_DIR/release/candidates/TAG`
directory can be deleted. Its `.release-commit` must match both the record and the
surviving Git tag, so `git archive TAG` can reconstruct the source. Candidate-root
and ancestor symlinks, foreign paths, ownership mismatches, moved/missing tags,
conflicting retained evidence and special files are refused. Unrecorded paths and
partial extractions are left for inspection. Within generated dependency/cache
trees, links are unlinked with the disposable tree and never followed; other
snapshot symlinks are refused.

Every external gate/setup log and receipt stays in place. Before deletion,
retention copies the snapshot's `.release-build.json`, `.release-commit`, logs,
JSONL, receipt/evidence files and directories, and JSON outside generated
dependency/cache trees into `release/evidence/TAG/`, preserving relative paths and
bytes. A recorded gate log inside the snapshot is always copied regardless of
its filename, including a text-suffixed actual-result recovery log. Dependencies,
cache contents and source copies are disposable.
Byte-identical copies of committed historical evidence stay recoverable in the
tag; Git blob hashes are checked so they need no additional local copy. New or
changed evidence is always copied. The
append-only `release/retention.jsonl` records a synced removal intent after
preserving evidence, followed by a synced removal receipt. The intent records
the snapshot directory's device/inode identity and hashes of selected evidence.
A retry validates the recorded candidate, surviving tag and retained evidence,
then resumes deletion only from that same directory, even if its ownership marker
was already removed. If deletion finished before its completion receipt, the
retry validates retained evidence and appends the missing receipt. Dry runs show
both recovery cases without writing. Changed ownership or evidence, new snapshot
evidence, malformed journals, and legacy intents without ownership/evidence proof
refuse recovery and leave remaining data for inspection. Retention advisories do
not change a recorded gate result. Installed releases, Git tags, record history,
and committed reports are never pruned by this command.

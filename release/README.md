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

The command defers under load, STOP, a promotion lock, a pending/current promotion
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
  "prepare": ["node", "scripts/build.mjs"],
  "prepare_env": {},
  "ship": ["node", "scripts/ship.mjs", "{tag}"],
  "parent": null
}
```

Commands are argument arrays, never shell text. `{tag}`, `{candidate}`, `{commit}`
and `{repo}` substitute inside each argument. Optional `prepare` runs in the
owned candidate snapshot before the gate; its environment overrides are scoped to
that command. The gate also runs in that snapshot. Project commands are trusted
project code and must use their own scratch directories when they need mutable
fixtures. `parent` may name an existing record item for the operator question.
`--repo`, `--org` and `--tag` select the project, record and tag explicitly.

This repository declares acceptance/run.mjs against the built archive as its gate,
herdr/install.sh with build-only mode as preparation, and herdr/release.sh build
as the operator's ship step. Activation remains a separate operator action. The
live harness belongs only to the canonical supervisor's release cycle, never a
lane's validation.

The record stores candidate, gate-start and gate-result events through the record
CLI. On a passing result it atomically creates one `publish` question, reserved for
`ORG_ACTOR=human`, even if publish is configured as auto. Agents cannot answer,
overrule, forge decision fields, close or reopen that question. A yes records
approval; it executes nothing. The operator executes the displayed ship argv from
the project checkout and controls any activation separately. A no retains the
candidate and evidence. The console's **Control → Releases** (`L`) shows candidates,
gate results, logs and links to those questions.

Repeated calls on an already gated commit return the existing result without
another gate or question. A red build/gate retains evidence and asks no shipping
question; a later promoted commit can form a new candidate. Gates have no invented
timeout. Before executing anything external, the record claims the gate once.
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
with `--skip-live`. Its record and tags stay in scratch, dependency installation
is skipped, and it neither ships nor activates. The retained scratch path and
source commit are returned. Preview results are distinct from production release
evidence. The production CLI refuses `--skip-live` without `--dry-run`.
`--max-load-per-cpu N` may change the tracked threshold in the scratch preview;
the returned evidence names it. It never overrides the production declaration.

`npm test` includes bounded offline tests with explicit actors: real disposable
lane promotions into a batch, default and declared gates, once-only reuse, red
and interrupted results, load/STOP/dirty/lock/queue/role deferral, operator-only
decisions, record compatibility, discovery, supervisor and console integration.

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
Preparation copies npm cache indexes and just the console/MCP lockfile tarballs
into the candidate's private `.release-npm-cache`, then runs `herdr/install.sh`
with real `npm ci` in offline, build-only mode. It never installs machine entry.
The retained `.release-build.json` names the candidate commit, both lockfile
hashes, installed package counts and build command before acceptance starts.
The gate first runs the offline release tier against the prepared candidate.
Copied-product workflows and deliberate long-response regressions must pass
before live acceptance starts; a failure stops the gate.
The gate passes `--npm-cache` (that private copy) and, when configured, `--bch-cloak` to
`acceptance/run.mjs`. `herdr/release.sh build` remains the operator's ship step;
activation remains a separate operator action. The live harness belongs only
to the canonical supervisor's release cycle, never a lane's validation.

Set these machine inputs in the invoking supervisor environment:

```sh
export RELEASE_NPM_CACHE=/absolute/path/to/npm-cache
# Optional existing-project compatibility checks:
export RELEASE_BCH_CLOAK=/absolute/path/to/existing/bch-cloak
```

`RELEASE_BCH_CLOAK` is optional. When unset or empty, the five existing-project
compatibility cases report SKIP with a visible reason and the remaining cases
decide the gate. When configured, the path must exist and all compatibility
requirements remain in force; the harness reads that project only to create
its scratch compatibility copies. The cache defaults to `npm_config_cache`, then
`~/.npm`; the shared source is never written by preparation or acceptance.
Populate it with the pinned dependencies before the release cycle, for example
by running `npm --prefix console ci --cache "$RELEASE_NPM_CACHE"` and
`npm --prefix mcp ci --cache "$RELEASE_NPM_CACHE"` in a development checkout.
This project's declared preflight checks the cache index, readable pinned
tarballs and configured compatibility path without copying or building anything.
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
candidate and evidence. The console's **Control → Releases** (`L`) shows candidates,
gate results, logs and links to those questions.

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
with `--skip-live`. Its record, tags and installed dependencies stay in scratch;
preparation uses the same real offline build and retains `.release-build.json`.
It neither ships nor activates. The retained scratch path and
source commit are returned. Preview results are distinct from production release
evidence. The production CLI refuses `--skip-live` without `--dry-run`.
`--max-load-per-cpu N` may change the tracked threshold in the scratch preview;
the returned evidence names it. It never overrides the production declaration.

`npm test` includes bounded offline tests with explicit actors: real disposable
lane promotions into a batch, default and declared gates, once-only reuse, red
and interrupted results, load/STOP/dirty/lock/queue/role deferral, operator-only
decisions, record compatibility, discovery, supervisor and console integration.
Its complete file list runs in three bounded phases to keep the copied-entry
probes isolated and avoid one aggregate six-minute timeout. Fixture, file and
suite watchdogs remain unchanged; failures stop validation immediately.

The release cycle takes the [host test slot](../test-slot/README.md) before
cutting or claiming a candidate, and keeps it through preparation and the gate.
A busy or unknown holder defers release without consuming its once-only gate
claim. Its CLI emits the coded refusal and exits 75. Only a recognized gate
timeout under measured load retries once within the held slot; preparation,
candidate creation, claim and interrupted-release recovery never replay.

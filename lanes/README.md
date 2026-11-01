# Lane dispatch reference

`lane` opens isolated Git worktrees, dispatches visible Herdr sessions into them,
runs independent reviews, and validates and fast-forwards completed work into the
local integration branch. It is herdr-brain's dispatch layer and uses only Node.js
built-ins.

## Configuration

Each key is optional. The nearest parent `.lane.json` supplies shared settings and
the canonical checkout's `.lane.json` overrides them:

When `~/.herdr-monitor/fleet.json` exists, the project's fleet mapping supplies
its owned parent `.lane.json` layers, and its worktree directory unless those
layers or the checkout's `.lane.json` set `worktree_root`: a project moves new
lanes by committing `worktree_root`, and existing lanes keep their paths. Discovery never
borrows a neighbour's settings. Without a fleet file, legacy parent discovery
is unchanged. See [fleet mapping and adoption](../discovery/README.md#fleet).

```json
{
  "main": "main",
  "worktree_root": "../.worktrees",
  "archive": { "dirs": ["docs/reports", "../archive"] },
  "validate": "npm test",
  "registry": ".lane/sessions.json",
  "prepare": [{ "run": "pnpm install --prefer-offline --ignore-scripts --frozen-lockfile" }],
  "dispatch": { "kind": "codex", "model": "model-name" },
  "always_args": { "codex": ["-p", "shared-profile"] },
  "routes": {
    "engineer": { "kind": "codex", "model": "model-name" },
    "review": { "kind": "codex", "model": "model-name" }
  }
}
```

Run dependency installs unconditionally: an existing `node_modules` directory can
be stale after a rebase changes the lockfile or adds packages. `--prefer-offline`
uses cached packages while allowing missing ones to be fetched. Reserve the
optional `unless` guard for preparation whose output remains valid whenever its
path exists; see the [promotion preparation guidance](../promote/README.md#existing-project-gate-profile).

`LANE_CONFIG` selects one configuration file. `LANE_VALIDATE` overrides the
validation command, and `LANE_WORKTREE_ROOT` overrides the final per-repository
worktree directory. Relative configuration paths resolve from the file that defines
them; relative environment paths resolve from the invoking directory.

`archive.dirs` names the project's archive directories for durable results. The
repository layer replaces the parent declaration as a whole, and each directory
resolves relative to the layer file that declares it. Declared paths may be
created later. With no declaration, the default is `archive/` beside the canonical
checkout, only when that directory exists; otherwise no archive resolves.
An explicit empty list suppresses that default. `lane config` shows the resolved
`archive directories` and their source. Record briefs and project summaries name
the same locations; durable results go to the archive before the lane closes.
This declaration is separate from Git archive tags and `archival_retirement`;
it adds no sweep or delete behavior.

The configured registry and its `.d` sidecar must be repository-local, untracked,
gitignored, free of symlink escapes, and writable. It contains display metadata for
dispatched sessions and never authorizes lifecycle work.

Use `lane config` to print every resolved value and source, and `lane routes` to
inspect dispatch defaults. The same dependency-free resolver supplies
`record start <ID> --route <name>`, so the run and the launched session receive the
same harness, model, and effort without copied flags. Route selection policy is
project configuration; pool and task-class names are opaque to Herdr.

Declare validation tiers in tracked `.lane.validation.json` in the canonical
checkout (or `validation` in `.lane.json`):

```json
{
  "fast": "npm run test:fast",
  "promotion": "npm test",
  "release": "npm run release:gate",
  "environment": "toolchain-or-container-revision"
}
```

Every field is optional. Undeclared tiers use the legacy `validate` command,
otherwise `npm test` (`node --test` for a project with `test/` and no declared npm test script).
The tracked file overrides individual tiers from lane config. `LANE_VALIDATE`
overrides commands for CLI adapters; `check --cmd` wins for that invocation.
Workers capture their tests with `lane check` (fast), including projects with no
validation configuration. Use `lane check --cmd 'COMMAND'` for the declared
focused command. Run it on the committed clean candidate before reporting; it
executes that command and writes `.lane/gate.json` plus the log and receipt in
`GIT_COMMON_DIR/lane-validation/`. The receipt includes the actual command, exit
status, Node version and each top-level TAP summary (null when absent). Settle
inherits this evidence through the same path for configured and default projects.
In Brain's source repository, changes to `lib/state.mjs` or
`lib/obligations.mjs` relative to the lane's merge base with main also require
`test/release-record-compatibility.test.mjs`. Ordinary checks append the bounded
runner for that file, independent of selected name filters; exact gates include
it in their required test plan. A direct, unfiltered run of that file already
satisfies the ordinary check. Other repositories without Brain's admission reader
keep their selected command.
Settle performs code/report review with no
suite, and the promotion train runs the promotion tier on each integration batch.
Workers never run the release gate; `bash herdr/release.sh build TAG`
runs the declared release command and timeout inside the tagged snapshot.
`lane config`, `record desks` and supervisor
policy show all three tiers. Worker copies cannot weaken
the canonical declarations.

Route edits (a new named route for a model, the primary pool, task selections,
dispatch or always arguments) save through validating record commands:

```sh
record routes add --value '{"name":"specialist","route":{"kind":"opaque","model":"project-model"}}'
record routes policy --value '{"primary_implementation_pool":"project-pool","by_task_class":{"implementation":"specialist"}}'
record routes defaults --value '{"kind":"opaque","args":["--option","value with spaces"]}'
record routes arguments --value '{"opaque":["--option","value with spaces"]}'
```

Policy/defaults/arguments values replace their whole routing field; include the
other entries when editing one selection or harness. Every write keeps
lifecycle and desk settings and validates effective references. All project
config controls share an atomic writer and lock, with `--expect REV` for reviewed
edits. Names stay opaque; no model/provider catalog or machine settings are needed.

## Lifecycle

`lane promote TOPIC --expected-head-from-worktree` self-promotes the invoking
native worker's claimed lane. It resolves the topic's actual linked worktree,
checks the active worker/run and claim, and captures its full HEAD once under
the promotion lock before any preparation or Git effect. It refuses a moved
tip or required rebase, without recapture, automatic rebase or retry. Rebase a
behind-main lane explicitly before making a new request. Native identity,
claim generation, source ownership, STOP/HOLD, branch, clean lane/main and
fast-forward checks remain in force at integration. The normal landing receipt
includes the captured expected head and full landed base/head. Under the current
landing waiver, this remains land-first with no new test, review or report gate.

Canonical `.lane/supervisor/STOP` and `.lane/supervisor/HOLD` both refuse
promotion, including worker self-promotion under the landing waiver. The shared
guard checks them before preparation and again at the fast-forward boundary.
HOLD returns `PROMOTION_HELD: supervisor HOLD exists; nothing merged` and keeps
the lane branch and worktree. After the supervisor clears the marker, a fresh
request must pass the current native, claim, source and Git guards.

Project HOLD fences new line effects and landing. It does not cancel an already
running owned `lane check`: let that check and its evidence hooks finish, then
attempt landing through the usual fresh guard. A worker wrapper must not turn
HOLD observation into a signal to an in-flight check. Explicit cancellation and
the runner's owned-process safety controls keep their existing behavior.

Scratch recovery checkpoints every eligible owned tree beside its durable
journal before unlinking any tree. Content, modes and symlink targets are
verified before deletion; copy failures leave source untouched. An unlink
failure retains the whole verified copy and its `preservation.json` receipt,
even if the original recursive removal already deleted siblings. Unknown/live
owners and retained descendants still prevent deletion. Successful reclamation
removes its temporary checkpoint; failed preservation/removal evidence stays
with the attempt for its owner to reconcile, without changing permissions.

`lane promote TOPIC --expected-head FULL_COMMIT_HASH` checks an authorized head
under the promotion lock and refuses tip changes or a required rebase. Queue
callers use the same check. Add `--if-current-run R-n --org /record` to recheck
record readiness before integration; the record lock spans that final check and
fast-forward. The self-promotion flag cannot be combined with a literal head or
record-readiness options; external exact-tuple callers keep the literal form.
See [Promote](../promote/README.md) for the request and retry contract.

Start Herdr in the canonical checkout, then open and dispatch one worktree per task:

```sh
cd /path/to/repository
herdr

lane open api-change --git-only
lane dispatch api-change --route engineer @/absolute/path/to/brief.md
lane status
```

`open` creates `lane/<topic>` and a linked worktree beneath the configured root.
Canonical Git common-directory identity owns the lane; repository names, remotes,
workspace labels, and author settings do not. Unsafe destinations, foreign
repositories, symlink escapes, and mismatched registered worktrees are refused.
Use `--git-only` before dispatch to defer Herdr workspace creation until the agent
launch. The standard dispatch module uses this mode, including retries after
preparation or record-start failures. Plain `lane open` still opens a shell for
interactive work.

`dispatch` verifies the lane's Herdr workspace, starts the configured agent, checks
its reported cwd by real path, sends the brief, and only then records session
metadata. A persistence failure after delivery is reported as partial success and
never replays the prompt.

Before delivering a Codex brief, direct dispatch reads the visible pane and
blocks on a hook-review dialog, including the `Hooks` event table. It names the
worker, pane and launch profile and retains the agent with the brief unsent.
Open `/hooks` in that worker and review the hooks in that profile, then deliver
the brief to the retained worker with `herdr agent prompt`. Hook trust remains
the operator's decision. A failed screen read also leaves the brief unsent.

Dispatch opens from the canonical project's workspace when one exists, or from
its canonical checkout path when none is open. Both paths use `--no-focus` and
verify the resulting repository identity.

If `dispatch` opens the Herdr workspace itself, it uses that invocation's initial
tab and pane, sources the route environment from a private 0600
temporary file, verifies the exported values before starting, deletes the file,
and starts the agent through native `herdr agent start`. The workspace has one
tab showing its agent, and operator focus stays in place. The environment nonce
is the shell-readiness check and uses the agent-start allowance (or the remaining
dispatch deadline), so slow rc files are not subject to a separate five-second
cap. The initial tab is renamed only after dispatch succeeds; failures retain its
original shell label. Non-POSIX shells such as fish and nushell retain the initial
shell and dispatch through a separate agent tab with `--no-focus` and native env
arguments. A workspace opened earlier by `lane open`, a reused lane or a
fix round keeps the existing behavior: a new agent tab with `--no-focus`.
Selecting that new background tab remains the upstream TOOL-1 follow-up.

`lane dispatch --json` emits the verified agent, pane, tab, workspace, cwd and
available immutable occupant IDs as one JSON object. With no prompt operand it
starts the worker without sending work. `--route-config FILE` selects a routing
snapshot for this launch while retaining the lifecycle configuration's original
paths. The [dispatch module](../dispatch/README.md) uses these options to record
and watch the worker before prompting it in one command.

Dispatch and review validate arguments before waiting for
[host memory pressure](../docs/reference/memory-gate.md) to clear. Wait reasons
appear on stderr as they happen; work proceeds automatically when pressure clears.
Both check the canonical checkout's `.lane/supervisor/STOP` throughout the wait
and before launch. STOP prints a JSON `result: stopped` receipt without launching;
dispatch exits 0, while review exits 3 so STOP cannot be mistaken for PASS.
After STOP clears, retry the invocation. Coordinators use `--memory-checked` on
either command when they already own the memory wait; it skips that extra wait
but still checks STOP before launch.

Run an independent foreground review against a fixed clean commit:

```sh
lane review api-change --round 1 --brief /absolute/path/to/review-questions.md
```

The review command uses [the packaged protocol](docs/REVIEW_TEMPLATE.md), validates
the reviewer's private record delivered inside its lane worktree, verifies that the
lane did not move, archives the validated bytes under canonical `.lane/reviews/<topic>/`,
and publishes a sanitized review under `docs/reviews/<topic>/`. Native worker
permissions continue to protect canonical `.lane/`; the CLI owns archival. Partial
or late delivery evidence is retained and the occupied round cannot be dispatched
again. After publication succeeds it
prints `PASS` (exit 0), `NEEDS-WORK`, or `FAIL` (exit 1). A STOP before launch
prints the stopped JSON receipt (exit 3); other failures exit 2 without a verdict.
Malformed finding lines are preserved as sanitized literal prose marked
`[Unparsed finding]`, so workers can read the requested revisions. Private-only
sections are never projected; privacy and captured-target checks still apply.

Before handoff, validate the exact clean commit:

```sh
lane check
```

The command runs configured preparation and validation, then records
`.lane/gate.json` with the full commit, tree, tier, command, environment fingerprint,
exit status, log and timing. Re-run it
after the final commit so the printed `GATE <head> exit=0` names that commit.
Passing results live under `GIT_COMMON_DIR/lane-validation/`, keyed by the tree,
command and environment fingerprint. Repeated checks, settle, unchanged-tree
rebases and promotion reuse the original log. Identical tier commands share proof.
A review-record commit changes the tree and needs a new check. Failed checks,
malformed/old receipts and altered/missing logs are never reused. Overlapping
checks for one key refuse with a lock diagnostic; retry after the first completes.
Crash locks require inspection of their owner and surviving processes.

The fingerprint hashes Node/Git/OS identity, process environment and preparation
definitions without saving environment values. Coordination variables (`ORG_ACTOR`,
`ORG_DIR`, `LANE_CONFIG`, `LANE_VALIDATE`, `LANE_WORKTREE_ROOT`) and shell cwd
bookkeeping do not invalidate proof; checks must not use them as test inputs.
`HERDR_PANE_ID`, `HERDR_TAB_ID` and `HERDR_WORKSPACE_ID` are removed from both
preparation and validation environments, so separate worker, settle and queue
panes share evidence.
Keep validation inputs tracked and dependencies reproducible; update `environment`
when ignored dependencies, external tools or a container image changes. Preparation
still runs before lookup and must leave tracked and untracked files clean.

The [promotion queue](../promote/README.md) runs promotion, scoped finished-tab cleanup,
lane closure and supervisor notices in order. `lane promote` and `lane close` share
a Git lock, so closing cannot remove a worktree while a gate is running.
`lane close --git-only` preserves occupied tabs; the queue uses it after closing
only authorized finished tabs. Both modes close the empty lane workspace through
the shared guarded executor. Its `--expected-tip COMMIT` guard requires that exact
tip to remain on the lane and be contained in the base, checked under the lock
before removal. Without that guard, ordinary close retains unmerged archive-tag
recovery.

Promote and close from the clean canonical checkout:

```sh
lane promote api-change
lane close api-change
```

`promote` dry-runs and then performs a clean rebase onto current main, obtains
passing promotion evidence for the exact tree and environment, refuses if main
moved, and fast-forwards local main. It never pushes, merges, or treats saved
review or the worker's gate file as promotion authority. Run one promotion at a
time.

`close` removes the clean worktree and deletes a merged branch. An unmerged branch
is first preserved as `archive/lane/<topic>` and freshly resolved to the exact tip.
A different existing tag target refuses an unmerged close; a matching tag permits
retry. An integrated lane leaves any older archive tag untouched.
The automatic sweep releases clean integrated or exact-archive-tagged lanes
without waiting for their item or parent to close. Non-ancestor patch landings
qualify by default when every historical patch matches main and there are no
unique merge commits; canonical `retirement.archival_retirement: false` opts
out of patch scanning. These matches never set the ancestry field `integrated`.
They use the exact archive-tag and preservation path before removal. Untagged,
unlanded lanes retain the existing chain holds, and no label proves supersession.
Open local runs, unknown run bindings, occupants, references and all ordinary
lifecycle guards still keep a lane. See the [closeout contract](../docs/contracts/CLOSEOUT.md)
for the opt-in train queue and precise supersession evidence. Close-at-landing
for every project by default is deferred to the separate option B lock-scope work.
Before deleting anything, close probes writes, renames and removal in the affected
Git metadata directories and copies ignored/untracked evidence (including `.lane/`)
to `GIT_COMMON_DIR/lane-archive/<topic>/<unique timestamp>/`. Its `sha256.json`
manifest records file hashes and symlink targets. Tracked content remains preserved
by the verified integrated tip or exact archive tag, without a duplicate payload copy.
The copy and unchanged source
are verified against that manifest before removal; any failure keeps the lane.
Planner KEEP and process-cwd refusals run before tagging or copying. A size-only
inventory also runs first: the default evidence budget is 256 MiB of copied bytes. Optional
`LANE_EVIDENCE_MAX_BYTES` overrides it with a nonnegative integer byte count for
the attempt. Content over that budget keeps the lane, copies nothing, and reports
its size and the need for explicit disposition; it never permits an unverified sweep.
Only Git-ignored paths under directories named exactly `node_modules`, `.pnpm-store`,
`dist`, `build`, `.cache`, `coverage` or `target` may omit payloads. These disposable
paths are recorded individually in the `lane-evidence/v2` manifest by path, type and
`lstat` size, with `metadataOnly: true`; their bytes do not consume the copy budget.
Evidence and reference claims override omission. Ignored reports, diagnostics,
unknown content and `.lane/` evidence retain full verified copies. Outside confirmed
disposable trees, untracked `.local-live` and paths matching the canonical project's
`retirement.protected_paths` globs keep the lane before payload reads or archive
creation. Tracked names remain recoverable through Git. See the
[preservation boundary](docs/REFERENCE.md#lane-evidence-preservation) for glob
syntax and exact, lane-scoped claim rules. A missing claim record keeps the lane
when disposable output would otherwise be omitted.
Ordinary untracked changes still fail the clean Git requirement. Close refuses
`assume-unchanged` and `skip-worktree` index flags because they can hide unique
local bytes from Git status.

The guarded executor also inventories top-level scratch directories under the
native temporary directory and `/private/tmp` (`/tmp` on other systems). Before
lane removal it writes `lane-scratch-sweep/v1` into the first eligible declared
archive's `lane-sweeps/` directory. The archive directory and resolved destination
must be outside the canonical checkout and every registered Git worktree, or
ignored by Git in each containing worktree. An archive inside the closing lane
is still refused. Archive resolution uses the shared `lib/archive.mjs`
helper: layer-relative `.lane.json` `archive.dirs`, otherwise an existing sibling
`archive/`; an explicit empty list opts out. Without an eligible archive, the
manifest sits beside the lane's preservation bundle under
`GIT_COMMON_DIR/lane-archive/<topic>/`. An unavailable declared destination also
falls back there and keeps scratch.
The manifest retains full entries for removals, pending removal intents,
uncertain observations and ownership failures. Ordinary kept entries are
summarized in `kept_summary`: exact counts by reason (sibling topics share one
reason), with at most 16 sample paths using at most 4,096 serialized path bytes.
`counts` includes every observed entry, both detailed and summarized. Routine
keeps therefore do not grow the manifest with the number of scratch directories;
required removal and failure details remain uncapped. Older v1 manifests have
the complete inventory in `entries` and omit the additive summaries. Retirement,
recovery and the closeout queue retain the manifest path and recovery links;
they do not consume the entry inventory.
Refused or deferred closes finalize their manifests as `not-executed`, with the
refusal reason, before discarding duplicate preservation evidence. Once that
duplicate is discarded, its fallback manifest is removed too; a declared archive
retains one `<topic>-<project-identity-hash>-not-executed.json`, overwritten by
later refusals of that project's topic. Partial
Git removals retain their evidence and attempt manifest for recovery. Recovery
writes a new manifest linking the recorded proof, completes lane removal and
executes the same final scratch checks before closing workspaces. A manifest
update failure warns on stderr and in the lifecycle log; it retains remaining
scratch and allows workspace closure after Git removal. The last durable
manifest may then show an unfinished intent; the log records any removed paths.

Scratch creators can write `.herdr-scratch.json` containing
`{"schema":"herdr-scratch/v1","common":"/absolute/git/common","run":"R-123"}`
(or `topic` instead of `run`). The marker must bind this canonical Git identity;
a run must belong to the closing lane and have reported or been abandoned.
Invalid, active or foreign markers keep scratch and prevent name fallback.
Unmarked scratch uses the longest complete lane topic at the start of its name,
including known branch, archive-tag and record topics. A matching run-id token
refines ownership only when it belongs to a run in the closing lane; an active
matching run keeps scratch. Other run-like tokens, including review-round
suffixes such as `topic-review-r2` and `eng1685-pair-review-r2493`, are ignored
for longest-topic fallback. An unmarked run id alone cannot prove project
ownership. For example, closing `topic` keeps `topic-ds3-review` when `topic-ds3`
is known, and never matches `topical-review`.

Unmarked topic matches are not project-bound. Projects sharing temporary roots
can reuse lane topics, so idle, unmarked scratch from another project with the
same topic may be swept. Every topic-name match records that residual risk in
its manifest reason. Creators sharing these roots should write the project-bound
marker; a foreign marker prevents fallback and keeps that project's scratch.

After successful lane removal the same executor sweeps only verified owned
scratch. Unmerged lanes keep it with their archive tag. HOLD, open process files
or working directories, changed ownership/content, protected live entries and
failed observations keep scratch with a reason in the manifest. Report artifacts
outside both the archive and lane produce warnings in the manifest and on stderr;
scratch containing cited evidence is retained without refusing lane close.

After Git succeeds, matching session
metadata is marked done, including when workspace cleanup remains pending. Close
then reports the pending workspace and exits nonzero; metadata errors never
rewrite the Git result.

Closure rechecks the shared retirement policy and requires zero occupants before
Git removes a worktree, including with `--git-only`. This includes shell panes,
processes with a cwd inside the worktree, open runs, pending references, promotion
and verify jobs, and test-slot holders/waiters. Recorded work must have a terminal
review/correction/integration chain and explicit disposition, including parked,
design or non-code work. Age never authorizes deletion. The canonical
`.lane/supervisor/HOLD-WORKER-TAB-CLOSE` stops every mode. A kept workspace and its
reason remain in the promotion cleanup receipt and notice; cleanup retries do not
repeat successful validation or integration. No housekeeping schedule is started.
If the Herdr executable is
absent, its inventory is empty and Git-only removal can proceed with the record
and job guards. An installed CLI whose server cannot be read refuses closure.

Lane creation records the initial shell's canonical worktree, workspace, tab,
pane, terminal and process birth in the Git common directory's
`retirement/initial-shells/`. This receipt supplies identity only. Dispatch marks
it claimed before reusing that pane; it never backfills receipts for existing
or concurrently opened workspaces. An unchanged, unclaimed initial shell may
retire only as its tab's sole pane, in a clean integrated lane, with complete
process inventory, no jobs, a terminal recorded chain (or a successful record
read establishing no chain), and no references, focus or HOLD.

Receipt-less shells use the same guards under Astra's 2026-10-18 legacy inert
shell rule. The executor requires stable observations at planning and the close
edge, and records `legacy inert-shell retirement` with both observed identities.
A changed identity, agent claim or incomplete observation keeps the tab. Closing
the last inert pane is allowed; empty-workspace removal remains a separate guard
that cannot close a surviving pane. These paths never force-kill a process.
Fresh lanes whose tip is still their recorded opening base, or whose branch
reflog establishes only creation, keep their initial shell unless a terminal
recorded chain names the lane. Unknown branch history also keeps without such a
chain, including for Git-only opens.

When dispatch creates a workspace, it holds the retirement tab lock through
the shell compatibility check and agent registration. Before reusing the initial
pane, it claims a recorded receipt, or reuses the pane without a claim when no
receipt was recorded. It uses a separate agent tab for an incompatible shell,
a concurrent opener, or a recorded receipt that is missing or invalid at claim
time; a separate-tab fallback leaves the initial receipt unclaimed.
Receipts publish atomically with mode 0600, survive claim updates with that mode,
and can be replaced by a new creation with a different terminal or shell birth.
Guarded cleanup prunes them only after fresh native absence checks; a malformed
receipt keeps its filename-bound tab instead of the project.

The closeout drain holds the project retirement owner lock only for admission
and fresh ownership/policy checks, with a bounded 1000 ms contention wait.
Legacy housekeeping and promotion retirement take the consumer claim before
the owner claim, so policy rollback cannot overlap an in-flight queue effect.
Stopped-allocation disposal holds request, consumer and branch allocation claims,
using owner.lock only for fresh ownership/policy guards.
History scans, native exit waits and Git
preservation/removal run under the consumer claim and a branch allocation lock
in `retirement/allocations/`. Dispatch takes that same allocation lock before
the project lock: a retiring branch refuses reuse with its exact lock path,
while unrelated lanes can open and launch. Live or unknown owners are retained;
dead-owner recovery still needs the existing process-birth proof. Releasing a
claim never resolves an uncertain native or Git effect.

For the consumer canary, retain a nonempty missing-binding backlog and delay a
drain's native observation until an unrelated dispatch has opened and bound its
worker. Record launch time and the drain's `owner_lock` hold timings, then rerun
the finite turn: already classified source identities must add zero binding
observations. Distinct old sources may each need their first observation; event
volume alone does not establish repeated facts. Also retain a same-branch
refusal, a live/unknown owner refusal and the proven-dead recovery control.
`test/closeout-launch-contention.test.mjs` is the offline source witness; actual
installed consumer/native acceptance remains with the canary/release owner.

## Commands

| Command | Purpose |
| --- | --- |
| `lane open <topic> [base-ref] [--git-only]` | Create a lane worktree and branch; optionally defer its Herdr workspace |
| `lane dispatch <topic> [--route <name>] [options] [@brief \| prompt]` | Start and prompt a visible Herdr agent |
| `lane review <topic> --round N [--brief <path>] [--route <name>] [--timeout <seconds>] [--run R-n]` | Run one foreground independent review; optionally bind its launch receipt to the run under review |
| `lane routes [--for <task-class> [--pool <pool>]]` | List routes or resolve selection policy |
| `lane config` | Print resolved configuration values and sources |
| `lane status` | Show lane state and overlapping files |
| `lane check [--cmd <validate command>] [--tier fast\|promotion]` | Validate or reuse evidence for the current clean tree |
| `lane check --gate [--required-tests JSON]` | With a committed canonical receipt declaration, run the train's planned promotion command with the queue request's bound test list and record exact-input evidence; requires current main as an ancestor ([contract](../docs/contracts/exact-validation.md)) |
| `lane prepare <topic>` | Run missing setup steps |
| `lane rebase-check <topic>` | Check whether promotion can rebase the lane onto main (conflicts, or a merge commit it will not flatten) |
| `lane promote <topic>` | Rebase, validate, and fast-forward local main |
| `lane promote <topic> --expected-head-from-worktree` | Capture the owning native worker's claimed worktree HEAD under lock and fast-forward without automatic rebase |
| `lane close <topic>` | Remove and delete or archive a lane |
| `lane seams [pattern]` | List unfinished work that can be resumed |

Requirements are Node.js 20+, Git 2.38+, and Herdr for dispatch and review. Git-only
operations work without Herdr. See [the technical reference](docs/REFERENCE.md) for
configuration precedence, safety checks, review record rules, recovery, and failure
messages. Use [the brief template](docs/BRIEF_TEMPLATE.md) when dispatching work.

Internal response waits adapt to measured machine load; see the
[deadline inventory](../docs/reference/load-deadlines.md) for allowances and preserved safety checks.

Promotion validation uses the [host runner](../test-slot/README.md). Under ARCH-34,
Brain gates start immediately with shared occupancy. Only a project-declared
exclusive proving profile takes the host slot. Set paths and any proving wait
budget at the workspace boundary. CLI exit 75 is a pre-execution slot refusal and supplies no GATE line
or failed validation receipt; retry or queue when the holder finishes. A command
that starts and exits 75 is a validation failure: check and promote exit 1,
while the GATE line (for check) and failed receipt retain the command's exit 75.
The promotion adapter never retries the full command chain. Retry-enabled leaf
steps may retry their own timeout under measured load once inside the held slot;
a leaf that declines its retry leaves the chain failed without replay.
Slot tokens, paths and wait budgets are coordination fields excluded from the
evidence fingerprint. Tests must not treat those values as validation inputs.

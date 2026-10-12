# Lane dispatch reference

`lane` opens isolated Git worktrees, dispatches visible Herdr sessions into them,
runs independent reviews, and validates and fast-forwards completed work into the
local integration branch. It is herdr-brain's dispatch layer and uses only Node.js
built-ins.

## Configuration

Each key is optional. The nearest parent `.lane.json` supplies shared settings and
the canonical checkout's `.lane.json` overrides them:

When `~/.herdr-monitor/fleet.json` exists, the project's fleet mapping supplies
its worktree directory and owned parent `.lane.json` layers. Discovery never
borrows a neighbour's settings. Without a fleet file, legacy parent discovery
is unchanged. See [fleet mapping and adoption](../discovery/README.md#fleet).

```json
{
  "main": "main",
  "worktree_root": "../.worktrees",
  "validate": "npm test",
  "registry": ".lane/sessions.json",
  "prepare": [{ "unless": "node_modules", "run": "npm ci" }],
  "dispatch": { "kind": "codex", "model": "model-name" },
  "always_args": { "codex": ["-p", "shared-profile"] },
  "routes": {
    "engineer": { "kind": "codex", "model": "model-name" },
    "review": { "kind": "codex", "model": "model-name" }
  }
}
```

`LANE_CONFIG` selects one configuration file. `LANE_VALIDATE` overrides the
validation command, and `LANE_WORKTREE_ROOT` overrides the final per-repository
worktree directory. Relative configuration paths resolve from the file that defines
them; relative environment paths resolve from the invoking directory.

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
Workers may run `lane check` (fast); settle performs code/report review with no
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

`lane promote TOPIC --expected-head FULL_COMMIT_HASH` checks an authorized head
under the promotion lock and refuses tip changes or a required rebase. Queue
callers use the same check. Add `--if-current-run R-n --org /record` to recheck
record readiness before integration; the record lock spans that final check and
fast-forward. See [Promote](../promote/README.md) for the request and retry contract.

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
`lane close --git-only` preserves Herdr workspaces; the queue uses it after closing
only authorized finished tabs. Its `--expected-tip COMMIT` guard requires that exact
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
is first preserved as `archive/lane/<topic>`. After Git succeeds, matching session
metadata is marked done; metadata errors never rewrite the Git result.

## Commands

| Command | Purpose |
| --- | --- |
| `lane open <topic> [base-ref] [--git-only]` | Create a lane worktree and branch; optionally defer its Herdr workspace |
| `lane dispatch <topic> [--route <name>] [options] [@brief \| prompt]` | Start and prompt a visible Herdr agent |
| `lane review <topic> --round N [--brief <path>] [--route <name>] [--timeout <seconds>]` | Run one foreground independent review |
| `lane routes [--for <task-class> [--pool <pool>]]` | List routes or resolve selection policy |
| `lane config` | Print resolved configuration values and sources |
| `lane status` | Show lane state and overlapping files |
| `lane check [--cmd <validate command>] [--tier fast\|promotion]` | Validate or reuse evidence for the current clean tree |
| `lane prepare <topic>` | Run missing setup steps |
| `lane rebase-check <topic>` | Check whether promotion can rebase the lane onto main (conflicts, or a merge commit it will not flatten) |
| `lane promote <topic>` | Rebase, validate, and fast-forward local main |
| `lane close <topic>` | Remove and delete or archive a lane |
| `lane seams [pattern]` | List unfinished work that can be resumed |

Requirements are Node.js 20+, Git 2.38+, and Herdr for dispatch and review. Git-only
operations work without Herdr. See [the technical reference](docs/REFERENCE.md) for
configuration precedence, safety checks, review record rules, recovery, and failure
messages. Use [the brief template](docs/BRIEF_TEMPLATE.md) when dispatching work.

Internal response waits adapt to measured machine load; see the
[deadline inventory](../docs/reference/load-deadlines.md) for allowances and preserved safety checks.

Promotion validation takes the [host test slot](../test-slot/README.md), shared
with other projects and bch-cloak. Set its paths and wait budget at the workspace
boundary. CLI exit 75 is a pre-execution slot refusal and supplies no GATE line
or failed validation receipt; retry or queue when the holder finishes. A command
that starts and exits 75 is a validation failure: check and promote exit 1,
while the GATE line (for check) and failed receipt retain the command's exit 75.
The promotion adapter never retries the full command chain. Retry-enabled leaf
steps may retry their own timeout under measured load once inside the held slot;
a leaf that declines its retry leaves the chain failed without replay.
Slot tokens, paths and wait budgets are coordination fields excluded from the
evidence fingerprint. Tests must not treat those values as validation inputs.

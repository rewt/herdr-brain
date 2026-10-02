# Lane dispatch reference

`lane` opens isolated Git worktrees, dispatches visible Herdr sessions into them,
runs independent reviews, and validates and fast-forwards completed work into the
local integration branch. It is herdr-brain's dispatch layer and uses only Node.js
built-ins.

## Configuration

Each key is optional. The nearest parent `.lane.json` supplies shared settings and
the canonical checkout's `.lane.json` overrides them:

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

## Lifecycle

Start Herdr in the canonical checkout, then open and dispatch one worktree per task:

```sh
cd /path/to/repository
herdr

lane open api-change
lane dispatch api-change --route engineer @/absolute/path/to/brief.md
lane status
```

`open` creates `lane/<topic>` and a linked worktree beneath the configured root.
Canonical Git common-directory identity owns the lane; repository names, remotes,
workspace labels, and author settings do not. Unsafe destinations, foreign
repositories, symlink escapes, and mismatched registered worktrees are refused.

`dispatch` verifies the lane's Herdr workspace, starts the configured agent, checks
its reported cwd by real path, sends the brief, and only then records session
metadata. A persistence failure after delivery is reported as partial success and
never replays the prompt.

`lane dispatch --json` emits the verified agent, pane, tab, workspace, cwd and
available immutable occupant IDs as one JSON object. With no prompt operand it
starts the worker without sending work. `--route-config FILE` selects a routing
snapshot for this launch while retaining the lifecycle configuration's original
paths. The [dispatch module](../dispatch/README.md) uses these options to record
and watch the worker before prompting it in one command.

Run an independent foreground review against a fixed clean commit:

```sh
lane review api-change --round 1 --brief /absolute/path/to/review-questions.md
```

The review command uses [the packaged protocol](docs/REVIEW_TEMPLATE.md), validates
the reviewer's private record, verifies that the lane did not move, and publishes a
sanitized review under `docs/reviews/<topic>/`. It prints only `PASS`,
`NEEDS-WORK`, or `FAIL` after publication succeeds.
Malformed finding lines are preserved as sanitized literal prose marked
`[Unparsed finding]`, so workers can read the requested revisions. Private-only
sections are never projected; privacy and captured-target checks still apply.

Before handoff, validate the exact clean commit:

```sh
lane check
```

The command runs configured preparation and validation, then records
`.lane/gate.json` with the full commit, command, exit status, and timing. Re-run it
after the final commit so the printed `GATE <head> exit=0` names that commit.

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

`promote` dry-runs and then performs a clean rebase onto current main, runs fresh
validation, refuses if main moved, and fast-forwards local main. It never pushes,
merges, or treats saved review or gate data as authority. Run one promotion at a
time.

`close` removes the clean worktree and deletes a merged branch. An unmerged branch
is first preserved as `archive/lane/<topic>`. After Git succeeds, matching session
metadata is marked done; metadata errors never rewrite the Git result.

## Commands

| Command | Purpose |
| --- | --- |
| `lane open <topic> [base-ref]` | Create a lane worktree and branch |
| `lane dispatch <topic> [--route <name>] [options] [@brief \| prompt]` | Start and prompt a visible Herdr agent |
| `lane review <topic> --round N [--brief <path>] [--route <name>] [--timeout <seconds>]` | Run one foreground independent review |
| `lane routes [--for <task-class> [--pool <pool>]]` | List routes or resolve selection policy |
| `lane config` | Print resolved configuration values and sources |
| `lane status` | Show lane state and overlapping files |
| `lane check [--cmd <validate command>]` | Validate and record the current clean commit |
| `lane prepare <topic>` | Run missing setup steps |
| `lane rebase-check <topic>` | Check whether promotion can rebase the lane onto main (conflicts, or a merge commit it will not flatten) |
| `lane promote <topic>` | Rebase, validate, and fast-forward local main |
| `lane close <topic>` | Remove and delete or archive a lane |
| `lane seams [pattern]` | List unfinished work that can be resumed |

Requirements are Node.js 20+, Git 2.38+, and Herdr for dispatch and review. Git-only
operations work without Herdr. See [the technical reference](docs/REFERENCE.md) for
configuration precedence, safety checks, review record rules, recovery, and failure
messages. Use [the brief template](docs/BRIEF_TEMPLATE.md) when dispatching work.

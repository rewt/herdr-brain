# herdr-lanes

Open one isolated git worktree per task, run an agent in each Herdr workspace, and
promote completed lanes into local main.

## Quick start

Install `lane` once:

```sh
git clone https://github.com/rewt/herdr-lanes.git
mkdir -p ~/.local/bin
ln -s "$PWD/herdr-lanes/lane.mjs" ~/.local/bin/lane
```

In the repository you want agents to work on:

```sh
cp /path/to/herdr-lanes/.lane.json.example .lane.json
```

Edit `.lane.json` so `worktree_root`, `validate`, `prepare`, `dispatch.kind`, and the
named `routes` match the project. Put the project's instructions in `AGENTS.md` before
opening lanes. A relative `worktree_root` is resolved from the file that defines it.
Ensure Git ignores `.lane/` through the target repository's `.gitignore` or the
operator's global excludes file; `lane check` and `lane board` write runtime state
there, and that state must not make a worktree dirty.

Start Herdr in that repository:

```sh
cd /path/to/your-repository
herdr
```

From an operator terminal or Herdr pane, open and dispatch one lane per task:

```sh
lane open api-change
lane dispatch api-change --route engineer @/absolute/path/to/api-change-brief.md

lane open docs-change
lane dispatch docs-change --route engineer @/absolute/path/to/docs-change-brief.md

lane routes
lane config
lane status
```

Before built-in routes ship, configure a named `review` route in `.lane.json`. Then
run one independent review of a fixed lane commit with the packaged
[review template](docs/REVIEW_TEMPLATE.md):

```sh
lane review api-change --round 1 --change api-change
lane review docs-change --round 1 --brief /absolute/path/to/review-questions.md
```

The command validates the reviewer's gitignored private record, verifies a sanitized
public projection, and leaves that public record untracked for operator inspection.
It prints only PASS, NEEDS-WORK, or FAIL after the publication boundary succeeds.

The agents now run concurrently in separate branches, worktrees, and Herdr
workspaces. Each agent should test and commit only in its own lane.

When a lane is ready, promote and close it from the clean main checkout (the original,
non-lane checkout):

```sh
lane promote api-change
lane close api-change
```

Promote lanes one at a time. `promote` rebases the lane onto current main, runs the
configured validation in the lane worktree, and fast-forwards local main. It stops on
dirty files, conflicts, failed validation, or a concurrent change to main. It never
pushes.

## How lanes work

`lane open <topic>` creates:

```text
lane/<topic> branch
<worktree_root>/<repo>/lane-<topic>
<root-label>/<repo>:lane-<topic> Herdr workspace for that worktree
```

Git's canonical common-directory path—not the repository basename, remote, or
author—owns each lane. Before creating or using a worktree, `lane` verifies that
identity and its real path. New destinations inside a checkout or escaping the
selected worktree base are refused; already-registered legacy locations remain
usable. `lane` never changes git author configuration.

`lane dispatch <topic> --route <name> @brief.md` starts the route's configured agent
in that workspace, verifies its repository identity and cwd, then sends the brief.
New workspace labels include root, repository, and topic identity and are bounded to
64 Unicode code points; agent names include a repository-identity and random suffix.
After successful delivery it writes one gitignored display record under
`<registry>.d/`. File briefs use their first heading outside fenced code as the board
goal; inline prompts use their first nonempty content line outside fenced code and
strip ATX syntax when that line is a heading. A post-delivery metadata failure is
reported as partial success and never causes the brief to be replayed.

`lane status` shows each lane's commits ahead/behind main, dirty state, rebase state,
and files changed by more than one lane. Keep concurrent lanes in separate files when
possible. If `shared files` appears, coordinate or serialize those lanes.

For a conversational daily facilitator with engineer reports instead of polling,
use the [supervisor session protocol](config/supervisor/2026.09.13.1/README.md).
Once delegated, the supervisor verifies the required review and validation,
preserves evidence, promotes, and closes each accepted lane and its Herdr sessions.

After one lane is promoted, the others are behind the new main. Their next promotion
rebases automatically when clean and refuses with a file list when conflicts exist.

## Commands

| Command | Purpose |
| --- | --- |
| `lane open <topic> [base-ref]` | Create a lane |
| `lane dispatch <topic> [--route <name>] [options] [@brief \| prompt]` | Start and prompt its agent |
| `lane review <topic> --round N [--change <name>] [--brief <path>] [--route <name>] [--timeout <seconds>]` | Run one foreground independent review and create sanitized public evidence |
| `lane routes` | List resolved named dispatch routes |
| `lane config` | Print resolved configuration values and sources |
| `lane status` | Show lane state and overlap |
| `lane check [--cmd <validate command>]` | Record validation against this worktree's HEAD |
| `lane promote <topic>` | Rebase, validate, and fast-forward local main |
| `lane close <topic>` | Remove and delete or archive a lane |
| `lane board [--once \| --json \| --watch --json \| focus <row-id> \| done <row-id>] [--repo <path>] [--all]` | Open the UI, inventory local sessions, focus one, or mark one done |
| `lane seams [pattern]` | List work that can be resumed |
| `lane prepare <topic>` | Run missing setup steps |
| `lane rebase-check <topic>` | Check whether promotion will conflict |

Requirements: Node.js 20+, git 2.38+, and [Herdr](https://herdr.dev) 0.8+ for
dispatch. Herdr is optional for git-only lane operations.

Configuration may be shared in the nearest parent `.lane.json` and overridden by the
canonical repository's `.lane.json`. `LANE_CONFIG` selects one file instead;
`LANE_VALIDATE` overrides validation, and `LANE_WORKTREE_ROOT` preserves its legacy
meaning as the final per-repository directory. Relative environment paths resolve
from the invoking shell's directory. See the reference for the exact boundaries and
merge rules.

## Lane board

The interactive board is optional. Install its isolated dependencies once:

```sh
npm --prefix /path/to/herdr-lanes/board ci
```

Add `"registry": ".lane/sessions.json"` to `.lane.json`. If a different registry
path is configured, it must also be gitignored.

```sh
lane board
lane board --once
lane board --json
lane board --json --all
lane board --watch --json --repo /path/to/your-repository
lane board focus <row-id> --repo /path/to/your-repository
lane board done <row-id> --repo /path/to/your-repository
```

Run the interactive view in a Herdr pane; use `--once` for a plain snapshot,
`--json` for one schema-v1 document, or `--watch --json` for foreground
newline-delimited snapshots. Read modes inventory accessible local Herdr servers by
default, including unregistered, unnamed, facilitator, and non-Git agents. `--repo`
filters by canonical repository identity and works from outside Git; `--all` also
includes metadata-completed history. Coverage and discovery errors say which local
endpoints were actually observed. The interactive entrypoint remains repository-
anchored until its separate frame update consumes the machine document. Plain and
JSON reads use only Node.js built-ins and do not require the optional board package
installation. Live registry joins require recorded agent-session identity and the
verified lane branch; older records remain offline history while current occupants
stay visible separately. A terminal-title goal never becomes a brief excerpt.
When Herdr can read a registered Codex or Claude pane, every
mode uses the same conservative visible-text adapter to show the last confidently
bounded assistant response. Recognized terminal footer and tool chrome are excluded;
unsupported or incomplete output is labeled unavailable. JSON keeps any bounded raw
excerpt separately labeled as pane output. The board
reads legacy JSON-array entries plus immutable per-session files in
`<registry>.d/`. Board completion and successful `lane close` write independent
atomic done markers; this metadata is display-only and never controls validation,
promotion, scheduling, retries, or deletion. A report is incomplete without the
`GATE` line printed by `lane check`.
The interactive table consumes one foreground `lane board --watch --json` process;
Enter or `a` runs the verified focus action, `d` runs the verified done action, and
`r` restarts only the observation process. Focus refreshes the recorded session on
its stored Herdr server before targeting its current agent or pane. Done accepts only
canonical registered rows and changes only their completion marker. Neither action
is retried or replayed during observation reconnection.
Run `lane check` again after the last commit; before handoff, the board's `GATE`
column must read `exit=0 @<head7>` against the lane's current HEAD.

See [the technical reference](docs/REFERENCE.md) for configuration, dispatch options,
board fields, status fields, recovery, archived lanes, and unattended promotion. Use the
[brief template](docs/BRIEF_TEMPLATE.md) when dispatching work.

Run this repository's offline tests with `npm test`. The suite isolates its home,
global Git configuration, and system Git configuration, so operator settings do not
affect fixture behavior. License: MIT.

The [specification workflow](openspec/README.md) describes planned changes and how
to take an independently promotable engineering brief.

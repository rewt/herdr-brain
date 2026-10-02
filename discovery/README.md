# Project entry

The installed machine adapter supplies the workflow on session entry, even in a
Git project with no `AGENTS.md`, `CLAUDE.md`, record or route configuration. It
creates a separate worker checkout by default before the harness starts. Project files do
not need a setup edit. Core record/Git identity code remains dependency-free and
has no harness branches; Codex and Claude prompt transport lives in `adapters/`.

Install once from an immutable product installation, into a dedicated machine
bin directory. The supervisor/operator owns this step; lane development must
only install into scratch destinations:

```sh
node /path/to/installed-monitor/discovery/install.mjs \
  --bin /path/to/machine-entry/bin --codex /absolute/path/to/native/codex \
  --claude /absolute/path/to/native/claude
```

`--claude` is optional. Put that directory ahead of the native CLI directories on
the machine's Herdr shell PATH. Fresh interactive `codex` and `claude` launches
then enter through Monitor. Model, effort, account and native
permission settings pass through. Help, authentication, debugging, sandbox and
other non-session commands pass directly to the native executable. The installer
refuses unmanaged files, retains native executable receipts, supports upgrades,
and removes only its unchanged managed files with `--bin ... --remove`.

Batch/print, resume, utility and noninteractive invocations pass directly through.
Every session inside an existing linked worktree also passes through. Lane
dispatch, supervisor/open-session and contrib/settle-watch set
`MONITOR_ENTRY_BYPASS=1` in the tab and launch environment, preserving their
assigned checkout, role, report path and run. A raw `herdr agent start` is detected
from the pane's live managed-start receipt before command injection; failure to
read that receipt conservatively bypasses entry. An ordinary Herdr shell with
no managed start can still enter interactively. These receipts only suppress
automatic interception; they grant no worker or supervisor capability.
Non-Git folders, empty repositories and a checkout on the wrong configured
integration branch warn and continue with the native executable.

Tools intentionally opting into entry use `monitor-codex -- exec ...` or
`monitor-claude -- --print ...`. These explicit entry commands are also the
transport used by the independent batch discovery probe.

This checkout does **not** install or activate adapters on the operator's
machine. The current Herdr plugin manifest declares build, panes and actions;
installing that manifest alone does not cause arbitrary native harness sessions
to read a new policy. A machine launch adapter is the installation boundary, and
must be carried in the eventual release installation. A native binary launched
by absolute path bypasses a PATH adapter. Desktop/remote harness entry needs its
own transport adapter; there is no claim of universal hook coverage.

Worker entry is the default. A supervisor chooses its role explicitly:

```sh
monitor-codex --role supervisor -- [native codex options]
monitor-claude --role supervisor -- [native claude options]
```

A supervisor must enter from the canonical checkout. Its policy teaches the
record, dispatch, watch, lane promotion and default housekeeping. Only that
supervisor starts the project housekeeping schedule. A worker's policy never
starts a loop, dispatches another agent, pushes, deletes a lane or acts on a live
Herdr pane. Entry itself makes no Herdr calls.

## Project settings

Projects can commit entry preferences in their canonical checkout's `.lane.json`,
alongside existing routes and validation. No configuration is required to use the
default worker-lane workflow:

```json
{
  "main": "trunk",
  "entry": {
    "enabled": true,
    "mode": "worker",
    "policy": "Use the project review desk before integration."
  }
}
```

`entry.enabled` defaults to `true`. Set it to `false` to decline entry entirely.
Both automatic `codex`/`claude` wrappers and explicit `monitor-*` entry then pass
native arguments, working directory and environment straight through. Entry does
not initialize or alter a record, exclusions, lane, runtime queue or existing
entry receipts. Opt-out is checked before unused routing, branch or mode settings.

`entry.mode` is `worker` (the default, isolated worker lane) or `main` (work in
the canonical integration checkout). Main mode keeps the worker role: it cannot
start housekeeping or acquire supervisor capabilities. Its bounded commands
record the task, commit, check and finish in that checkout; there is no lane to
rebase or promote. A done report requires a clean committed checkout and a green
sandboxed check before ingestion. Main-mode sessions share that checkout, so a
project choosing this mode also chooses to coordinate concurrent edits there.
Both Codex and Claude main-mode workers run inside an additional native filesystem
guard that keeps the selected record, its resolved files, and entry coordination
state read-only. The guard leaves harness runtime/account writes and the harness's
own tool sandbox, network and approval settings in place. Only this session's
request queue is writable under protected state; bounded parent commands perform
record and Git mutations. Opt-out and explicit supervisor sessions retain their
existing launch behavior.
An explicit `--role supervisor` always uses the canonical checkout and its existing
supervisor workflow, unless the project opts out.

The existing top-level `main` field declares the integration branch for both
modes. If omitted, entry uses the canonical checkout's current branch. Entry
requires that checkout to be on the selected branch; automatic entry warns and
passes through if it is on a different branch, while explicit entry fails before
creating project runtime state. It never switches the integration checkout.

`entry.policy` is additional text, defaulting to empty. Both transports receive
it with its config source, plus the root `AGENTS.md` and `CLAUDE.md` contents when
present. The generic workflow explicitly yields to the project's own instructions
where they conflict, and tells agents to read applicable directory instructions.
Project text does not change the adapter's fixed capabilities or lifecycle checks.

Entry preferences come only from the canonical project's `.lane.json`, using
Git common-directory identity. Parent configuration, `LANE_CONFIG`, and a linked
worktree's edited config cannot opt a project out or change its mode. Existing
parent route/lifecycle configuration still applies to its own fields; a project's
top-level `main` overrides an inherited branch. Entry-only settings do not declare
model preferences: the portable routing suggestion still waits for the operator.
Invalid enabled entry settings fail clearly; automatic wrappers warn and preserve
the native session without creating entry state. Help, resume, batch and managed
session bypass rules continue to apply.

The canonical Git common-directory identity owns the record and lanes. Lookup
first walks from the original working directory to its checkout root, respecting
nested subproject records; it then considers the canonical shared record and
ancestors above it. An inherited `ORG_DIR` cannot silently redirect a
new adapter session to another record. New projects get `.org/`. Initialization
uses exclusive creation and the record lock, so concurrent first entries never
truncate events or create divergent records. Runtime directories are ignored
through local Git `info/exclude`; no tracked instruction or ignore file is
required. Worktree roots use a digest of the full common-directory identity,
not a basename, remote or workspace label. A project needs an initial Git commit
and a known integration branch; an anonymous non-Git folder has no lane identity.

Routes resolve from the portable `lanes/preset.mjs` when no project/parent config
exists. They are **suggestions**, not operator preferences. A single durable
`other` question recommends engineering on Codex `gpt-6.1-sol` high and review on
Claude `opus` high, with the other current routes and a task selection policy.
`record ask --wait` keeps it pending even under an auto-answer category override.
A worker applies an actual operator answer with `monitor apply-routes`: yes
copies the exact proposed preset into its lane's tracked `.lane.json`; no leaves
it unapplied; a text answer must be valid route JSON. Successful promotion closes
the routing setup item. No paths, memory profiles or account data ship in routes.

Workers record their actual task with `monitor start 'task summary'`, or
`monitor resume ITEM` for a fresh run on existing work. Both return the record
brief, exact report path and run ID. They commit, check, promote and finish through
`discovery/client.mjs`. Reports are checked before promotion, then ingested by
the record CLI. A done report cannot be ingested before its commit is integrated;
a second different report for a run is refused by the record. Blocked work can
be reported without promotion. Worktrees/commits with work survive an interrupted
adapter; the existing lane CLI close/archive protections still apply. Closing a
session that never started a run removes its entry worktree and branch only when
the assigned Git identity and branch still match, the worktree has no modified,
untracked **or ignored** files, and the branch has no commits beyond its creation
base. An ignored `.env`, local settings or `.lane` notes therefore keep the lane.
Cleanup runs under the coordination and record locks and never forces Git
removal. Retained lanes print their path and reason. Setup failure after creating
an untouched lane uses the same cleanup.

Both adapters forward `SIGHUP`, `SIGINT` and `SIGTERM` to the native child and
close entry resources after the child exits. Each next entry sweeps stale entry
creation receipts under the coordination lock. It removes a candidate only after
checking that neither parent nor registered native child is alive, the actual
Git common-directory identity and assigned branch match, the complete record
contains no run for that checkout, and the same base/cleanliness checks pass.
Recorded, dirty, ignored or committed lanes survive. Unknown or unreceipted
worktrees are preserved. This is foreground recovery; display-only lane session
metadata never participates in removal.

Native launch waits until the parent has recorded its PID, then execs in that
same PID. A parent crash before this handoff cannot start an unregistered agent.
Queue and Git metadata paths are recorded before creation for setup recovery.

The default root resolves the operator's home directory, and an explicit
`MONITOR_WORKTREE_ROOT` resolves its existing prefix before creating missing
directories. Operator-selected links therefore work; no-follow checks remain
below that boundary for privileged writes into agent-writable locations.

The session parent exposes fixed operations only for its own worktree creation
receipt, branch and verified Git identity. Requests cannot select a repository,
cwd, shell command, validation command or arbitrary Git argv. There is no socket
or persistent service. The request queue ends with the native session. Git hooks,
fsmonitor and signing are disabled on broker Git calls. Author and committer
identity resolve through the operator's normal Git configuration before execution
configuration is bounded. External clean/smudge/merge/diff drivers referenced by
project attributes require a project-specific bounded adapter; unused global
git-lfs registration does not prevent entry. Rebase conflicts remain in
the lane; `monitor continue` stages the resolved files and continues only the
rebase receipt for that assigned branch, and `monitor abort` restores it.

Promotion calls the existing lane CLI with its clean/rebase/green/fast-forward
checks intact. Preparation and validation execute in a native Codex permission
profile: read access for runtime dependencies, write access only in the assigned
checkout, protected `.git`, and no network. The session parent also supplies
read-only exclusions for the selected record (including resolved symlink targets)
and the canonical `.lane` state, so preparation or validation cannot overwrite
ignored shared state from the main checkout. Its dedicated validation temporary
directory remains writable. The default check is the project's
`npm test`, or `node --test` for a Node test directory. Unknown validation asks for
the real project command in `.lane.json`; it never substitutes a trivial check.
The native Codex executable is currently the validation sandbox provider for
both transports. Existing restrictive managed requirements remain authoritative.
Canonical `validate` and `prepare` fields are authoritative independently; lane
values are used only when the corresponding canonical field is absent. Both
check and promote print the effective command and its configuration source.

Privileged writes into agent-writable locations use random temporary files opened
with `O_NOFOLLOW` and `O_EXCL`. Directory components are opened without following symlinks and checked
against the entered inode. Synchronous writes stay relative to that kernel-pinned
directory, so an agent replacing an ancestor cannot redirect the write. This
boundary is local to entry capabilities; ordinary record, report and operator
configuration IO retains normal symlink semantics, including `ORG_DIR`, `--org`,
`LANE_CONFIG`, route-config and a linked `.lane.json`. Entry resolves selected
record paths once before launching the child and verifies those receipts later.
Regression tests plant the old predictable symlink,
replace a directory during a write, and exercise every existing launcher.

Offline scratch directories use the system temporary directory's real path.
All PTY tests share a transport that selects BSD script arguments on Darwin and
util-linux script arguments on Linux; unavailable transports skip explicitly.

Offline checks are part of `npm test`. A native sandbox check, still with no
model call, can be run explicitly outside a nested sandbox:

```sh
MONITOR_TEST_SANDBOX=/absolute/path/to/codex node --test discovery/test/sandbox.test.mjs discovery/test/confinement.test.mjs
```

The independent real discovery probe is outside `npm test`:

```sh
node discovery/acceptance.mjs --binary /absolute/path/to/codex --keep
```

It installs product files and creates unrelated projects under **separate**
scratch roots. No source repository or instruction file sits beside a project.
Real sessions get tasks and safety boundaries, while the installed adapter
provides workflow policy. They use `gpt-5.6-luna` low by default; measured tokens,
transcripts and summaries include failures. Temporary authentication copies are
mode 0600 and deleted. Native sessions keep `workspace-write`, exclude broad tmp
write grants, and receive only their checkout and request queue as writable roots.
This probe complements the ENG-74 release gate; it does not replace it.

# Project entry

The installed machine adapter supplies the workflow on session entry, even in a
Git project with no `AGENTS.md`, `CLAUDE.md`, record or route configuration. It
creates a separate worker checkout by default before the harness starts. Project files do
not need a setup edit. Core record/Git identity code remains dependency-free and
has no harness branches; Codex and Claude prompt transport lives in `adapters/`.

Release activation and the Herdr plugin's build install entry automatically,
including removable shell PATH snippets; see [machine installation](../herdr/README.md).
The supervisor/operator owns that step. Lane development installs only into
scratch homes. Fresh zsh/Bash shells need no user PATH edit or project setup.

The lower-level installer remains available for an explicitly managed transport
that already owns its shell PATH:

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
assigned checkout, role, report path and run. A fresh native `herdr agent start`
receives worker entry just like a fresh interactive shell launch. A display-only
managed-start receipt neither bypasses entry nor selects a supervisor role.
Assigned Monitor launches retain their explicit bypass; receipts grant no worker
or supervisor capability.
Non-Git folders, empty repositories and a checkout on the wrong configured
integration branch warn and continue with the native executable.

Tools intentionally opting into entry use `monitor-codex -- exec ...` or
`monitor-claude -- --print ...`. These explicit entry commands are also the
transport used by the independent batch discovery probe.

Development in this checkout does **not** install or activate adapters on the
operator's machine. The release and manifest build carry the machine launch
adapter; merely linking a manifest skips its build. A native binary launched
by absolute path bypasses PATH. It needs a harness SessionStart/policy hook or
an explicit launch adapter. Desktop sessions need their app's supported
instruction/entry transport; remote sessions need the adapters installed on the
remote host (or its own harness entry hook). Custom shells need their own PATH
startup transport. Those entry paths are not covered by this release canary.

Worker entry is the default. A supervisor chooses its role explicitly:

```sh
monitor-codex --role supervisor -- [native codex options]
monitor-claude --role supervisor -- [native claude options]
```

A supervisor must enter from the canonical checkout. Its policy includes the
generic [supervisor protocol](../supervisor/PROTOCOL.md) and a fresh compact cold
start generated from the record without a model. It teaches record, dispatch,
watch notices, settle, the promotion queue and default housekeeping. Entry itself
only reads supervisor context; the supervisor explicitly checkpoints decisions
after reading them. The plugin's explicit supervisor pane selects this same role.
Only that canonical supervisor starts the project housekeeping schedule. A worker's policy never
starts a loop, dispatches another agent, pushes, deletes a lane or acts on a live
Herdr pane. Entry itself makes no Herdr calls.

## Fleet

The fleet is the machine's joined project list; a workspace remains Herdr's tab
group. First entry creates `~/.herdr-monitor/fleet.json` and joins only the entered
Git project. `HERDR_MONITOR_FLEET` selects a different fleet **home directory**
for tests. Reads never create or join anything. Agents that bypass entry run:

```sh
monitor fleet join
monitor fleet show
monitor fleet join --session-limit 8
```

Join is idempotent, including from linked worktrees. The session limit defaults
to 6 and is advisory; entry, the console and `show` surface it without refusing
sessions. Entry/join alone writes the file. Supervisors remain per project.

Each entry stores the canonical Git common directory (`identity`), canonical
`checkout`, `record`, `worktrees`, `temp` and explicitly owned settings `layers`.
Existing checkout records and matching legacy console mappings are adopted in
place. The mapping must name this canonical checkout; a neighbouring ancestor
record is never adopted just because it exists. A new project keeps the native
`<checkout>/.org` record, excluded from Git, and gets worktree and temp locations
under the fleet home keyed by its Git identity. Existing mapped parent settings
preserve their worktree location. No paths are moved.

For adoption without a console mapping, the project's supervisor can name its
existing paths explicitly (repeat `--layer` for each owned settings file):

```sh
monitor fleet join --record /project-record \
  --worktrees /project-worktrees --temp /project-temp --layer /owned/.lane.json
```

With a fleet present, automatic record and parent-settings discovery stops at
the project edge and reads only that project's mapping and checkout. An unjoined
project can bootstrap its own record through `record`, but only entry/join adds
it to the fleet. `ORG_DIR` and `LANE_CONFIG` remain explicit selections. Without
a fleet file, legacy discovery and console configuration work as before.
The console reads joined projects from the fleet and keeps presentation and
transcript preferences from its existing configuration. A moved or replaced
checkout is shown stale, with no guessed replacement or usable record binding.
Malformed fleet JSON or schema fails before entry/join or record commands write
records; automatic entry also refuses rather than launching an unbound session.

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
configuration is bounded. External merge/diff drivers referenced by
project attributes require a project-specific bounded adapter; clean/smudge/process
filters run through the bounded adapter described below; unused global
git-lfs registration does not prevent entry. Rebase conflicts remain in
the lane; `monitor continue` stages the resolved files and continues only the
rebase receipt for that assigned branch, and `monitor abort` restores it.

Promotion calls the existing lane CLI with its clean/rebase/green/fast-forward
checks intact. Preparation and validation execute in a native filesystem sandbox: read access for runtime dependencies, write access only in the assigned
checkout, protected `.git`, and no network. The session parent also supplies
read-only exclusions for the selected record (including resolved symlink targets)
and the canonical `.lane` state, so preparation or validation cannot overwrite
ignored shared state from the main checkout. Its dedicated validation temporary
directory remains writable. The default check is the project's
`npm test`, or `node --test` for a Node test directory. Projects can declare fast,
promotion and release commands in tracked canonical `.lane.validation.json` (or
`validation` in `.lane.json`). Entry tells workers the effective tiers; check uses
fast, promote uses promotion, and workers never run release. Passing exact trees
reuse their command/environment evidence, with original logs retained. Configure
the real project command when these defaults do not apply.
Installs containing Codex retain its validation provider and restrictive managed
requirements; Claude-only installs select a host provider as described below.
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

Offline probe regressions also use the probe's copied product and installed
Codex/Claude adapters for scripted worker checks, guarded promotion and approved
route integration. Project tests actually run; dirty trees, red gates, changed
expected heads and supervisor STOP refuse promotion before the fast-forward.
These cases use no authentication or model calls.

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

## Validation without Codex and bounded Git filters

A Claude-only machine can install just `--claude /absolute/native/claude`.
There is no Codex launcher or dependency in that install. Its validator defaults
to `auto`: macOS selects `/usr/bin/sandbox-exec`. On Linux, `auto` refuses clearly;
it never discovers bubblewrap from PATH. An install with Codex retains the native
Codex provider by default on either platform. Select `--validator /absolute/native/codex`
to use that existing provider explicitly. `--validator auto` or
`--validator /absolute/provider` on the installer or either entry adapter selects
the supported provider; ordinary bubblewrap paths are refused.
An unavailable provider or failed kernel setup fails the check; execution never
falls back to an ordinary shell. The Codex provider still includes managed
configuration. Host alternatives enforce their own fixed filesystem and network
boundary independently of any harness configuration.

The Linux bubblewrap adapter is **experimental and disabled by default** until
ENG-92 proves it on a Linux host. Its reviewed writable-mount path race and
nonempty file-copy failures remain unresolved on that item. macOS and native
Codex validation retain their existing providers. To opt in explicitly for
experimental Linux testing, supply an absolute executable in the validator value:

```sh
node discovery/install.mjs --bin /scratch/machine-bin --claude /absolute/native/claude \
  --validator experimental-bubblewrap:/absolute/path/to/bwrap
# The same --validator value is accepted by monitor-claude and monitor-codex.
```

This selector is preserved in installed launchers and bounded Git filter commands.
Passing a bare bwrap executable, including a renamed symlink to it, does not opt
in. There is no environment toggle and no automatic bubblewrap selection, even
after opting in elsewhere. The opt-in selects the unfinished adapter; it does
not establish a safe Linux boundary or resolve its known findings. The internal
`bubblewrap.mjs` launcher also requires an explicit `--experimental-bubblewrap`
argument before it launches anything. Keep experimental runs in scratch projects.

The supported validation providers allow runtime reads, deny network, permit writes only
to the assigned checkout and its validation temporary directory, and protect
Git metadata, the selected record's aliases and resolved targets, and canonical
coordination state. Main-mode guards retain native account/runtime writes and
network settings while excluding shared state. The experimental bubblewrap design uses read-only mounts
and separate PID/network namespaces for validation. Its x64/arm64 seccomp filter
allows only the synchronous file/process/runtime syscalls in `syscalls.mjs` and
denies everything else, including sockets, all three io_uring entry points, BPF
and ptrace. Network namespaces alone do not hide host filesystem Unix sockets;
asynchronous socket operations must be denied too. Other ABIs fail closed. It refuses protected
symlinks inside a writable tree (including a linked record in main mode): mounts
cannot protect the symlink inode itself from unlink. Use Codex or the macOS
provider for that layout. Missing protected mount paths also fail closed.

External Git `filter.*.clean`, `.smudge` and `.process` commands now run through
that same validation boundary during entry, commits, rebase and promotion.
Their stdin/stdout protocol and `%f` filename substitution are retained; command
text is encoded separately from Git's filename argument. Broker Git retains
normal author identity, disables hooks, signing and fsmonitor, and carries the
bounded overrides into the lane subprocess. Filter failures are required failures,
so Git cannot silently store unfiltered content. Drivers must have the same
execution configuration in the canonical checkout and assigned lane.
External merge/diff drivers still require a dedicated adapter and are refused.
Filters that need network or writes outside the checkout, such as a Git LFS
fetch/cache under `.git/lfs`, fail within this boundary; there is no permissive
Git LFS exception.

Preparation, fast validation and each filter process have a 120-second deadline.
Promotion validation has a bounded 30-minute deadline, including for a project's
declared promotion command. The trusted parent selects the tier; worker requests
cannot supply commands or deadlines. Each validation wrapper reserves another
25 seconds for compilation and confirmed descendant cleanup. The entry command
also reserves preparation time and 35 seconds for Git preflight/integration,
with a one-hour overall cap. Each native step also respects the remaining entry
time, reserving its wrapper's cleanup grace before that cap can expire.
The request client waits up to that cap plus five
seconds for check, promote and finish replies; other operations keep their
three-minute deadline. The filesystem/network boundary, lifetime markers and
descendant cleanup are the same for both tiers.
A foreground native owner stops and kills every owned descendant before returning,
including detached children and double forks. On Linux it adopts orphans as a
subreaper. On macOS two private read probes identify the inherited kernel policy;
cleanup uses stable process identities and generation-checked audit-token signals.
Processes without that policy identity are never cleanup targets. A trusted
bootstrap confirms the policy before project execution. The macOS policy also
denies signalling owners outside the sandbox. Missing ownership or unconfirmed
cleanup fails the check rather than retrying without containment.

The owner ships prebuilt for macOS and Linux on arm64/x64; validation needs no C
compiler on those targets. Its binary and source SHA-256 checksums and native
architecture are verified before copying the bytes into a private,
no-follow-checked system scratch directory. Linux binaries statically link musl.
No dependency or runtime download is added. See the [native helper guide](native/README.md)
for the manifest, license notices and offline maintainer rebuild commands.

A missing, redirected, damaged or stale bundle explains its rejection and tries
the existing `/usr/bin/cc` source build in private scratch. Compiler environment
overrides remain ignored. If that build also fails, execution is refused before
project code runs. Compilation retains its 15-second bound and cleanup its
three-second bound. Broker calls retain their 180-second deadline. These execution
safety bounds are independent of org budgets; kernel identity and cleanup are
unchanged from the source-built owner.

Offline adapter/profile/cleanup regressions run in `npm test`. Exercise the
actual host boundary explicitly outside a nested sandbox:

```sh
ORG_ACTOR=alternative-test MONITOR_TEST_ALTERNATIVE=/usr/bin/sandbox-exec \
  node --test discovery/test/alternatives.test.mjs discovery/test/review-r3.test.mjs
# Experimental Linux only: use
# MONITOR_TEST_ALTERNATIVE=experimental-bubblewrap:/absolute/path/to/bwrap
```

Round-four host applicability checks exercise nonempty Node file copies and
replacement of a validated temporary directory with an external symlink after
profile construction. Run them with the real macOS and/or Codex provider:

```sh
ORG_ACTOR=validation-host-test MONITOR_TEST_ALTERNATIVE=/usr/bin/sandbox-exec \
  MONITOR_TEST_SANDBOX=/absolute/native/codex \
  node --test discovery/test/review-r4.test.mjs
```

The Linux regression makes an asynchronous AF_UNIX connection to a host socket
as its positive control, then attaches the actual seccomp program and checks that
socket creation, io_uring setup/enter/register and an unknown syscall are refused.
It skips explicitly on non-Linux hosts or when the host disables io_uring; those
skips do not constitute Linux kernel proof.

The real discovery probe now accepts either transport:

```sh
ORG_ACTOR=claude-discovery node discovery/acceptance.mjs \
  --harness claude --binary /absolute/native/claude \
  --claude-auth /operator-authorized/credentials.json --keep
```

Claude defaults to `haiku` low; Codex retains `gpt-5.6-luna` low. Both run the same
record bootstrap, route suggestion, installed policy, concurrent integration and
operator-answer cases. Claude live probing currently requires macOS and applies
an independent scratch-only filesystem guard while preserving network for
inference. The guard adds no workflow instructions. Only an explicitly supplied
Claude credential file is copied; hooks, settings, plugins and MCP configuration
are excluded. Per-session credential copies are mode 0600 and removed on exit or
handled interruption. Sessions have a four-minute process-group deadline.
Claude result usage includes uncached input, cache creation/read, output, model
usage and CLI-reported cost; failed/no-auth sessions cannot pass. `--skip-live`
leaves the live cases pending and exits nonzero.

Writable exceptions undergo the same check for every provider: inspect each
component with lstat and realpath, reject symlinks or changed inodes, and open the
component with O_NOFOLLOW before granting access. Fixed root-owned system aliases
such as macOS /tmp are normalized first; paths below them remain checked.
Validation exceptions must remain inside the assigned checkout. Shared-record
or Git targets cannot be granted directly or through a parent directory. A
legitimate validation-temp or native request-queue exception preserves all other
shared-state exclusions, including protected descendants. The live-probe guard's
separate runtime paths are checked too and are unavailable to offline validation.
Filters inspect optional temporary directories even when a dangling link makes
existsSync return false; missing plain directories receive no extra grant.

Empty classic filter settings retain identity conversion. When a driver has a
configured command in one classic direction, its missing/empty opposite uses a
trusted byte-copy transport rather than an empty shell. Only configured external
commands are sandboxed, and their failures remain required failures. An
explicitly empty process setting disables the driver, including its classic
commands, as Git's process precedence requires; it never starts an empty protocol
subprocess. These rules preserve binary bytes, including NUL and non-UTF8 data.

Without an explicitly authorized --claude-auth file, the Claude probe does not
launch native sessions or read authentication. Both live cases are PENDING;
ENG-81's proof awaits the operator's answer to HUM-19. Pending cases keep the
acceptance exit nonzero, without classifying their absence as a code failure.
Pending-only and `--skip-live` probes work on Linux too: the macOS guard is checked
only when live Claude execution is required. All setup is covered by cleanup;
setup failure removes the installed snapshot and copied project roots, preserving
only an available evidence summary.

# ARCH-18: a per-project OS sandbox for every agent session

Research and a recommendation, 2026-10-03 (run R-152). No product code changed. Operator decisions are
marked **Q1..Q7** and collected at the end.

The ask (operator, 2026-10-03, G-3): every agent session is confined by the OS to its own project. It
writes only its worktree, its project's record and its own temp; it reads its own project plus
toolchains; it cannot reach another project's source, record, temp or scratch, or private data
(Documents, Desktop, Downloads, Mail, most of ~/Library, ~/.ssh, Keychain, system folders) without an
explicit, recorded, revocable operator grant. Temp stays inside the boundary with socket-safe paths.
Workers cannot reach the shared Herdr socket to drive other projects' panes.

## Answer in one paragraph

macOS can enforce all of this today with seatbelt (`sandbox-exec`), which both harnesses already use
underneath; I proved every rule in scratch. The hard constraint is that **seatbelt does not nest**: once a
process has any non-trivial profile, a child cannot apply another one. So on macOS there is exactly one
confining layer per process tree, and the design is a choice of *where* that layer sits, not a stack of
layers. Recommended order: (0) a short per-run temp scheme and a fix for the setuid `ps` dependency,
because every option below needs them; (1) generate each harness's native sandbox from the workspace
file, which confines tool commands (Codex: nearly everything an agent does; Claude: Bash only, with the
file tools held by in-process deny rules); (2) a Monitor-owned seatbelt/bubblewrap wrapper around the whole
harness process, used *instead of* the harness sandbox, which also covers Claude's file tools, hooks and
MCP servers but exposes the harness's own login state to its tools; (3) a separate macOS user stays the
operator's decision and does not by itself isolate projects from each other. The Herdr socket needs a
pane-scoped broker, not a plain deny, because Herdr's own agent-state hook uses it from inside the session.

## Status quo, measured

This worker session (a lane worker started by dispatch) is not confined at all. From inside a scratch
workspace with two projects (A, B), a fake home and a stand-in Herdr socket, an unconfined process
running as project A could read and write project B's source, record and temp, read the fake Documents,
.ssh and Mail, write /tmp and the system per-user temp, and connect to the control socket. The real
environment also hands every worker `HERDR_SOCKET_PATH=~/.config/herdr/herdr.sock` (mode 0600, same uid,
so reachable) and the operator's home and `~/development` are mode 0755.

Today's confinement in this repo is narrower than ARCH-18: `discovery/confinement.mjs` generates
**write-only** guards (`(allow default)` reads, writes limited to the checkout, protected `.git`, record
and `.lane`) for validation and main-mode workers, via Codex permission profiles, `sandbox-exec`, or
experimental bubblewrap (ENG-92, unproven on Linux). Reads, other projects and sockets are open.

## Experiments (all in scratch, macOS 26.6.2 arm64, Codex CLI 0.160.0, Claude Code 2.1.284)

Probe matrix (17 checks) run unconfined, under a generated seatbelt profile, and under a Codex
permission profile. Results:

| check (as project A) | unconfined | seatbelt profile | Codex profile, network off | Codex profile, network on |
|---|---|---|---|---|
| read/write own source and temp | allowed | allowed | allowed | allowed |
| read, list or write project B source/record/temp | allowed | **denied** | **denied** | **denied** |
| read Documents, .ssh, Mail (fake home) | allowed | **denied** | **denied** | **denied** |
| write /tmp or system `$TMPDIR` | allowed | **denied** | **denied** | **denied** |
| connect to control socket | allowed | **denied** (see rule notes) | **denied** (all network off) | allowed |
| git, node | allowed | allowed | allowed | allowed |

A second, realistic profile closed the operator's whole real home except toolchains (`~/.nvm`,
`~/.local/bin`, `~/.cargo`, `~/.bun`, git config) and herdr-brain's own areas (canonical checkout,
`.worktrees/herdr-brain`, record `rewt/.org`), with writes to this lane, the canonical `.git` and the
record. Under it: other rewt projects, bch-cloak, `~/.claude-personal` and real Documents were denied
(exit codes only; nothing private was printed); git status, git object writes, the record CLI, node and
`herdr --help` worked. The profile was generated from a small JSON description by a 20-line scratch script
(`gen-sb.mjs`), which is the shape of step 2.

Findings that change the design:

1. **Seatbelt does not nest.** With an outer `(allow default)` profile a nested `sandbox-exec` works; add
   any single deny rule (one file-read, one file-write, or one socket rule) and the inner
   `sandbox_apply` fails with `Operation not permitted` (exit 71). `codex sandbox` inside the project
   profile fails the same way. `(allow process-exec* (with no-sandbox))` makes nesting "work" only because
   children then run unconfined: a child could read the denied Documents. That is an escape, not a fix.
2. **Setuid binaries cannot run in any seatbelt sandbox**, ours or Codex's (`execvp() of 'ps' failed`,
   exit 71). `/bin/ps` is setuid root. This repo's test runner (`test/helpers/processes.mjs`, since
   2026-10-02) refuses to start without `ps`, so `npm test` cannot run inside *any* OS sandbox today,
   including Codex's validation provider. `pgrep` (not setuid) and `sysctl` work.
   `supervisor/open-session.mjs` and `contrib/settle-watch.mjs` also call `ps` but run outside workers.
3. **Socket rules are subtle.** A `(deny network-outbound (remote unix-socket (path-literal P)))` rule
   needs the real path (`/private/tmp/...`, not `/tmp/...`); several `path-literal`s inside one
   `(remote unix-socket ...)` filter silently match only the first; and denying file read/write on the
   socket node does not stop `connect()`. One filter per resolved path works.
4. **Unix socket paths are limited to 104 bytes** (103 characters plus NUL). Python refuses a longer path
   (`AF_UNIX path too long`); Node **silently truncates** it to 103 characters, so two long names collide
   (`EADDRINUSE`) or a client connects to the wrong socket. This session's scratch directory alone is
   136 characters.
5. **Toolchains honour `TMPDIR` but need it set.** `cc` compiled with `TMPDIR` inside the project and
   failed without it (`unable to make temporary file`). The shared npm cache (`~/.npm`) is outside the
   boundary: `npm ci` failed writing `~/.npm/_logs`.
6. **User config has includes.** `git status` failed until `~/.gitconfig-rewt` (an `[include]` of
   `~/.gitconfig`) was readable. A generator must resolve includes, not just list `~/.gitconfig`.
7. **Herdr's own Claude integration hook uses the socket from inside the session.**
   `~/.claude-personal/hooks/herdr-agent-state.sh` (installed by Herdr) connects to `HERDR_SOCKET_PATH`
   to report the pane's agent state. A blanket socket deny on the whole session breaks Herdr's agent
   status display, which watch and the console rely on.

Claude Code facts come from its documentation (code.claude.com/docs/en/sandboxing, settings-reference),
not from experiment: running a real Claude session in a scratch home would need copied credentials.

## Mechanisms

### Codex sandbox and permission profiles

- **Blocks:** every shell command Codex runs: reads (`"none"` per path), writes (`:workspace_roots`,
  named paths), network, and with network off all Unix sockets. Codex does most reading through shell
  commands, so this covers most agent file access. Generated per launch with
  `-c permissions.<profile>.filesystem={...}`, exactly as `discovery/confinement.mjs` already does.
- **Cannot block:** the Codex process itself (it reads `~/.codex`, writes sessions, calls the model), and
  with network on it allows every Unix socket (it has `network.allow_unix_sockets`-style options for its
  proxied mode; not verified here). A per-path socket allowlist with network on is unproven.
- **Breaks:** setuid tools (ps); anything writing outside the grant (shared npm cache, system temp).
- **Cost:** low. The generator exists; extend it from write-only to read-closed.

### Claude Code sandbox and permission settings

- **Blocks:** Bash (and Monitor) commands and their children, via seatbelt on macOS and bubblewrap on
  Linux: `sandbox.filesystem.denyRead/allowRead/allowWrite/denyWrite`, network domains, and Unix sockets
  (blocked by default on macOS; `network.allowUnixSockets` takes a path list). `failIfUnavailable` and
  `allowUnsandboxedCommands: false` close the "retry unsandboxed" escape. A launcher can impose it with
  `--settings FILE` (above user and project settings, below managed settings).
- **Cannot block (by OS):** the Read, Edit, Write and Grep tools, hooks, MCP servers and the Claude
  process. Read/Edit deny rules (`Read(~/.ssh/**)`) are enforced in-process: policy, not OS. Default
  sandbox writes include the per-user system temp. Project hook settings inside the worktree are
  agent-writable, and hooks run unsandboxed, so an agent that edits them gets unconfined code on the next
  session start; the generator must deny writes to the worktree's `.claude/` and `.codex/` config.
- **Breaks:** same as Codex (ps, caches, system temp). On Linux, Unix sockets are all-or-nothing
  (seccomp), so a single Herdr socket cannot be allowed by path there.
- **Cost:** low. Generate one settings file per session from the workspace file.

### Monitor-owned seatbelt wrapper (macOS)

- **Blocks:** everything the harness process tree does: Claude's in-process file tools, hooks, MCP
  servers, Codex's own process. Reads, writes and named sockets, as in the matrix above.
- **Cannot block:** anything distinguishing the harness from its tools. The harness must read and write
  its own state (`~/.claude-personal`, `~/.codex`, Keychain for Claude's login), so its tool commands can
  too. Those state directories also hold **other projects'** transcripts and memory (for example
  `~/.claude-personal/projects/*`), so a per-project state directory is needed to keep projects apart,
  which costs a login per project (Q4).
- **Breaks:** the harness's own sandbox (finding 1): Codex must run with its sandbox off inside the
  wrapper, Claude with `sandbox.enabled: false`. Also ps, caches, system temp, and any profile mistake
  stops the harness itself, not one command. A profile is fixed for the life of the process, so a revoked
  grant takes effect at the next session start.
- **Cost:** medium. The generator and launcher integration exist in pieces (`confinement.mjs`,
  dispatch, entry adapters). Must be proven on both harnesses and under Herdr.

### bubblewrap on Linux

- **Blocks:** more than seatbelt: mount namespaces *hide* paths (tmpfs over other projects, private
  folders and `~/.config/herdr`), so a socket you cannot see you cannot connect to; PID and network
  namespaces; seccomp for socket families (discovery's `socketFilter()`).
- **Cannot block (unproven here):** this Mac cannot run it, and Docker was not running; ENG-92 ("prove
  the bubblewrap boundary on a Linux host") is still open, with known writable-mount race findings.
  Nesting bubblewrap inside bubblewrap generally works with user namespaces, unlike seatbelt, but Claude
  documents `enableWeakerNestedSandbox` for unprivileged containers. Not tested.
- **Breaks:** distributions that restrict unprivileged user namespaces (Ubuntu 24.04 AppArmor).
- **Cost:** medium, gated on ENG-92.

### A separate macOS user

- **Blocks:** everything the operator's file modes deny: `~/.ssh`, `~/Documents` and `~/Library` are
  0700 already; the Herdr socket is 0600, so another user cannot drive panes at all; the operator's
  Keychain and TCC grants do not carry over.
- **Cannot block:** other projects. The operator's home and `~/development` are 0755 today, so the agent
  user could read all source and records unless the operator tightens them (that changes the operator's
  setup). One agent user separates agents from the operator, not project from project; per-project
  isolation still needs step 1 or 2, or one user per project.
- **Breaks:** toolchains under the operator's home (`~/.nvm`, `~/.cargo`), harness login (a second
  account login per user), Herdr panes (launch through `sudo`/launchd per pane), git ownership checks
  (`safe.directory`) on shared checkouts, file ownership of shared records.
- **Cost:** high. It is also ARCH-19's rehearsal target (a fresh macOS account), so it is worth knowing
  the install works there even if agents never run as a separate user.

## Recommended order

0. **Prerequisites (now, small):**
   - A per-run temp under the workspace with a short root, for example
     `<workspace>/.t/<project-tag>-<run>/` (about 30 characters on this machine), exported as `TMPDIR`,
     `TMP` and `TEMP`, with a socket budget: the launcher refuses a temp path longer than 60 characters
     so 40+ remain for socket names. Housekeeping removes it with the lane and reports leftovers.
     Named system-temp exceptions, kept as a short list: Claude's messaging socket (`/tmp/cc-socks/<pid>`),
     Claude's sandbox default per-user temp, and `DARWIN_USER_TEMP_DIR` consumers that ignore `TMPDIR`.
     ENG-118's machine-wide test slot lock moves under the workspace.
   - Replace `ps` in `test/helpers/processes.mjs` with a non-setuid source (`pgrep` plus `sysctl`, or the
     native owner from ENG-105) so the suite can run inside any OS sandbox.
1. **Native harness sandboxes, generated from the workspace file** (ARCH-17 owns the file). Codex:
   read-closed permission profile per session. Claude: a per-session `--settings` file with
   `sandbox.enabled`, `failIfUnavailable`, `allowUnsandboxedCommands: false`, the same read/write lists
   and matching `Read`/`Edit` deny rules, and writes denied to the worktree's harness config. Strong for
   Codex; for Claude it confines commands and holds file tools by policy.
2. **Monitor-owned wrapper**, per session, as the alternative layer: seatbelt on macOS, bubblewrap on
   Linux after ENG-92. It closes Claude's file tools, hooks and MCP at the OS level, at the price of
   turning the harness's own sandbox off and giving tools the harness's login state. Prove it on one
   project before making it the default (Q3).
3. **Separate macOS user**: the operator's decision (Q5). Useful as a second wall around the operator's
   private data; it does not replace 1 or 2.

### The Herdr socket

A plain deny is easy (one seatbelt rule per resolved socket path, or a hidden directory under
bubblewrap) but breaks Herdr's agent-state hook. Recommended: Monitor gives each session a **pane-scoped
broker socket** in that session's temp and points `HERDR_SOCKET_PATH` at it. The broker forwards only
agent-state reports for its own pane (and anything else a worker provably needs: today nothing else; the
dispatch watcher, supervisor and console run outside worker sessions) and refuses pane control. The real
socket is denied. A longer-term alternative is a Herdr upstream feature: per-pane capability tokens (Q6).

### Grants

A grant (for example "project X may read ~/Documents/specs") lives in the workspace file, is recorded as a
security-category decision, and is revoked by removing it. Because a profile cannot change after it is
applied, revocation takes effect when the session restarts; the console should show which live sessions
still hold a revoked grant. Grants are additive to one project's profile and never widen another's.

## Seams with ARCH-17 (workspace)

- The workspace file is the generator's input: project roots, each project's record, worktree root and
  temp root, toolchain read paths, named temp exceptions, grants, and the Herdr broker setting.
- **herdr-brain's record sits at the shared ancestor `rewt/.org`** and its lanes in `rewt/.worktrees`
  beside other rewt projects' lanes. Per-project write isolation needs a per-project record path (or a
  record that only this project uses there) and per-project worktree roots.
- Lane workers commit through the canonical checkout's `.git` (worktree common dir), so a worker profile
  must grant writes to the canonical `.git`; discovery's bounded Git adapter is the stricter alternative.
- Shared caches (npm, cargo, Homebrew) are workspace state: either a per-project cache (more downloads)
  or one workspace cache writable by all projects, which is a cross-project channel (Q2).
- Workspace-level sessions (supervisor, console, release) need cross-project read and the real Herdr
  socket; they are a different profile, not "no profile".

## Operator questions

- **Q1 (security):** Approve the order above (temp scheme and `ps` fix first, then generated native
  harness sandboxes, then a wrapper proven on one project)? Recommend yes.
- **Q2 (security):** Package caches: per-project (isolated, slower first install) or one shared
  workspace cache (fast, a cross-project write channel)? Recommend per-project for writes with the shared
  cache read-only where the tool allows it, falling back to per-project.
- **Q3 (security):** On macOS, for Claude sessions, prefer the outer wrapper (OS-level file tools, no
  harness sandbox) over Claude's own sandbox plus in-process deny rules? Recommend: native first, wrapper
  as the target once proven, because the in-process file tools are the larger gap.
- **Q4 (security):** Per-project harness state directories (a login per project) so projects cannot read
  each other's transcripts and memory through harness state? Recommend yes when the wrapper lands.
- **Q5 (security):** Run agents as a separate macOS user? Recommend not now; rehearse ARCH-19's install
  on one, and revisit after step 2.
- **Q6 (security):** Herdr control: a Monitor pane-scoped broker now, and ask Herdr upstream for per-pane
  tokens? Recommend yes to both.
- **Q7 (security):** Grants as workspace-file entries recorded as security decisions, effective at the
  next session start? Recommend yes.

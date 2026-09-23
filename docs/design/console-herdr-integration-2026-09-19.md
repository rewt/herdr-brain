# Native spaces, Herdr ownership and the integration boundary

The operator selected layout A. Keep native spaces and agents as the primary
navigation; put goals and tasks in the central workspace. This note answers how
that can remain sustainable as Herdr changes, and records the next preview pass.

## What exists today

The production console is an independent Node/Ink application launched by
`org console`. It runs in a Herdr terminal; it is not compiled into Herdr and does
not import Herdr's UI code. `console/package.json` declares Ink and React. The
Herdr dependency is a running service and CLI, not an npm library.

`console/lib/cli.mjs` invokes `herdr` with child-process argument arrays for agent
and tab lists, focus, output reads, prompting, and right-click routing for the
console's own pane. The adapter in this worktree matches the canonical checkout.
`console/lib/session.mjs` refreshes these sources alongside org and Brain data.
The console reads durable work through org and writes only through its CLI.

Other parts of Brain already have different integration paths:

- `brain/lib/herdr.mjs` wraps the Herdr CLI for watching and reading agents.
- `brain/lib/start.mjs` creates a tab and starts a configured Claude session.
  It currently requires a prompt; a blank multi-agent chat is additional work.
- `lanes/lane.mjs` uses CLI helpers for worktrees, tabs and dispatch.
- `lanes/board/herdr-client.mjs` is a direct socket client with request timeouts,
  session snapshots, pane reads, subscriptions and reconnect behavior.

Consequently, saying “we only depend on a socket” would be incomplete. Transport
is one dependency; commands/methods, JSON shapes, identifiers, event semantics,
output behavior and launch context are the actual integration contract.

Read-only inspection on September 19 found both CLI and running server at
Herdr **0.8.2**, server protocol **20**, compatible. `herdr api schema --json`
reports schema version 1 and includes plugin, snapshot, worktree and event APIs.
`herdr plugin --help` confirms plugin commands even though the top-level help
summary omits them. These are observed versions, not a promise that every
version carrying the same number will satisfy our adapter's needs.

## Recommended ownership

| Owner | Responsibilities |
| --- | --- |
| Herdr | Processes, PTYs, rendering terminals, spaces/tabs/panes, agent detection, native focus and restore |
| Git | Repository identity, primary/linked checkouts, branch, diff and divergence |
| Org / Brain | Goals, priorities, tasks, questions, runs, authority and controlled lane lifecycle |
| Console | Presentation, scope, navigation history and explicit operator commands through those owners |

Package the console as an **optional Herdr plugin entrypoint** while retaining
`org console`. Herdr's published plugin model launches manifest-declared,
out-of-process terminal UIs. It supplies launch context and supports actions and
event hooks. This fits an Ink process; it does not require a Herdr fork. Plugin
v1 does not offer arbitrary native non-terminal UI components, and plugin
packaging does not make an API dependency disappear.

Sources: [Herdr CLI plugin reference](https://herdr.dev/docs/cli-reference/),
[Herdr socket and plugin APIs](https://herdr.dev/docs/socket-api/).

Prefer a managed tab/overlay that supplies the required pane context. Do not
assume a popup has a normal pane ID. Add a manifest only after validating the
entrypoint and supported versions; this design pass installs no plugin.

Consolidate our existing wrappers behind one Herdr adapter. The adapter should
select the supplied binary/socket context, discover capabilities and validate
responses. CLI calls remain suitable for discrete actions; direct subscriptions
are useful for responsive activity views. Reconnect must obtain a fresh snapshot
because events during disconnection are not evidence we have seen every change.
Use bounded refresh of selected output; listing every pane must not require
re-reading every terminal on every render.

An upgrade that retains the used contract should require no console change.
Missing or changed capabilities should affect the relevant feature, with a
clear unavailable state; org goals and questions remain usable. Unknown optional
JSON fields should be ignored. A changed method, required field or identifier
contract requires an adapter update and compatibility test. Pin a tested range,
check the running server as well as the installed CLI, and test against the
versions we claim to support. Do not promise automatic compatibility merely
because the Unix socket accepts connections.

## Terminal output is the important boundary

`pane.read` gives a screen/output snapshot; it is not an embedded PTY renderer or
full terminal attachment. The current discussion preview contains captured text.
A plugin manifest also does not let an Ink process contain arbitrary existing
Herdr panes as children of its React tree.

For the native feel, keep Herdr responsible for interactive terminal output and
input. Brain can show a responsive read-only preview, then focus the existing
native pane for full interaction and restore the console on return. A fully
embedded native terminal in the proposed center panel requires a verified Herdr
host capability or an upstream extension; it must not quietly become a second
terminal emulator in Brain. Validate that transition before committing to the
pixel-level promise in the mockup. Never start another agent to imitate an
existing session. A plugin action can be the return path to the existing console.

## Project and checkout hierarchy

Project scope chooses an org and its configured repository association. A Herdr
space is a terminal workspace associated with one checkout. They are different
levels even when they previously shared the label `bch-cloak`.

The revised sidebar uses this structure:

```text
Project: bch-cloak

Project overview

Main checkout                 main · conversation
  source-anchor-authentication
  freeze-policy-codec
  pstore-v031-implementation
  created-side-seed-profile-binding
```

Worktrees appear directly under Main checkout; tabs appear horizontally in the
selected checkout's main panel, never beneath it in the sidebar. Selecting a
project scope opens a compact overview of sessions, goals, tasks and Needs you.
Selecting a checkout or session drills into output. This newer landing behavior
supersedes the earlier output-first comparison and Needs-you-first cold start.

Worktrees are visibly nested beneath the primary checkout. Group with Herdr's
`worktree.repo_key` / Git common-directory identity and use `is_linked_worktree`,
not branch names or workspace labels. A linked checkout can use a branch whose
name resembles the main branch; that must not turn it into the primary checkout.
If the primary space is closed, retain the group with “Main checkout not open.”
Actual metadata and provenance determine linkage, not the UI indentation.

The refreshed preview joins these fields from the captured native workspace
records. Project scope, native tab IDs and exact pane selection are retained.
All-project mode labels each repository group and keeps goal ranks project-local.
The Git/worktree summary remains a central view. Main is the conversation and
coordination location by workflow convention, not a claim that its filesystem
has been made read-only. A lane is a managed worktree lifecycle; an arbitrary
worktree must not be treated as a lane solely because its branch starts `lane/`.

## Goals, chats and Back

**Goals.** The central Goals view now has New goal: title, success criterion,
optional parent and relative priority. The reader has Earlier/Later controls and
`[` / `]` shortcuts. The preview applies changes only in memory. Production can
use existing `org add --goal --parent --accept --priority` and `org set …
priority=…`; higher numeric priority sorts first, while the UI shows ordinal
position. Preserve the existing goal-first pickup proposal: reordering affects
future feasible picks, does not preempt agents, bypass dependencies/stage gates,
or grant authority. Handle concurrent reorder consistently through org; do not
implement a partial multi-item renumber by direct log writes.

**Chats.** `+ Chat` or `n` opens the composer. From main, Conversation defaults to
a new tab in that checkout; from a worktree, Development defaults to that
worktree. The operator can choose an existing worktree or New worktree, choose
an agent, name the conversation and optionally provide goal context. Development
locations exclude the primary checkout. Review shows the target before launch.
A conversation does not require inventing a task/run. A goal association is
context, not an active work record or authorization. Converting discussion into
tracked work should create a real task and use the existing dispatch flow.

Production launch must preserve project account/model/route settings, memory,
`ORG_ACTOR`, canonical checkout ownership, and lifecycle gates. Discover supported
agent kinds; the mockup's Codex/Claude choices are not a universal launch policy.
A new development worktree must go through Brain's configured lane layer, with
collision/ownership checks. Creation responses supply IDs; do not predict them.
A failed agent start should expose the created tab for recovery instead of
blindly creating another on retry. No real chat or worktree was created here.

**Back.** Navigation history now records scope, central view, reader, space and
tab. The visible Back control, Alt+Left and mouse button 3 go to the same previous
view; Forward is paired. Dialog Back dismisses the dialog. The browser history
API is used where permitted; the sandboxed export can fall back to local history.
A host/browser can reserve side buttons, so hardware delivery remains unverified.

The production Ink mouse parser currently recognizes left/middle/right, motion
and wheel; it does not implement distinct extended Back/Forward buttons. Wire
extended terminal reports to the same history only after checking what Herdr and
the outer terminal forward. Preserve Esc/Alt+Left/visible Back as accessible
alternatives. The browser mockup is not proof of terminal side-button support.

## Delivery and engineering follow-through

Current preview source: `.lane/design-preview/modern-console-overview.html`.
The existing running preview URL is regenerated from it. Earlier A/B sources
remain available for reference. Production console files and the ingested R-25
report are unchanged by this pass.

Before product integration, the bounded follow-through is:

1. Consolidate and contract-test the Herdr adapter; validate plugin launch and
   native terminal focus/return against the installed server.
2. Build the accepted layout and Git-identity hierarchy on the existing console
   effects, preserving scope, session workflows and keyboard/mouse interaction.
3. Connect goal creation/order and chat creation to the authorized org/Brain
   commands, with the launch-context and recovery behavior described above.

Validation: all 185 root tests passed before and after this pass. Script/interaction checks
cover hierarchy, direct output, browser/side-button navigation, goal creation,
priority isolation, conversation/development launch previews, main-checkout
exclusion for development, cancellation, shell tabs and the six-column session
table. No browser was connected for rendered geometry or hardware mouse checks.

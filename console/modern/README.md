# Live Projects trial

This is the native-spaces design connected to live org and Herdr data, with
the September 20 operator-study repairs. It is a live trial whose only writes
are the project screen's prompt (a new chat, or a task under the work block),
what the operator types into a session, session names, and Needs you answers.
It runs in Ink through `console/app.mjs`; it is not the browser design preview or
`console/proto` fixture application. Opt in per launch; the existing console
remains the default and retains all of its operational actions.

The visual reference is the accepted `modern-console-preview.html` browser
preview, sourced from `.lane/design-preview/modern-console-overview.html`.
The first live renderer diverged from that reference; the September 20 fidelity
correction restores its color tokens, section surfaces, task grouping, central
navigation and overview composition. It starts dark; press `D` for the light
palette that matches the light browser preview, or launch with
`HERDR_CONSOLE_THEME=light`. The terminal controls font and cell dimensions.

From this worktree:

```sh
node bin/org.mjs console --modern --project bch-cloak
node bin/org.mjs console --modern --project herdr-brain

# Follow the calling Herdr workspace, or discover available projects.
node bin/org.mjs console --modern

# Inspect an existing repository or an ordinary folder, without setting it up.
node bin/org.mjs console --modern --folder /absolute/path/to/folder
```

To keep it open while the code changes, run the development loop in its own
Herdr tab. Saving any `.mjs` under `console/`, `lib/` or `bin/` restarts it in
place; after `q`, Enter reopens it and Ctrl-C ends the loop:

```sh
node console/dev.mjs --project bch-cloak
```

A direct launch supports an explicit config and one-frame output:

```sh
node console/app.mjs --modern --config /path/to/console.json --print 100x34
node console/app.mjs --modern --project herdr-brain --print 100x34 --keys 'g\n'
```

The keys in `--keys` are sent one character at a time; `\n` means Enter and `\e`
means Escape. This is a read-only rendering/testing interface in modern mode.

## What works

- The project screen (`h`) opens with counts (sessions, working, blocked,
  idle, done), then the work block: an open goal marked `meta.block`
  (morning, afternoon, overnight), else the goal most current sessions are
  linked to. Its open tasks follow, the ones with a session first, with that
  session's number. Needs you shows each item with its recommended answer.
  Every session is then numbered, one row each, under a `checkout · count`
  heading: state, name, time in its current state (as this console saw it
  change), uptime, harness, and its task or what it is doing.
- A session's number opens it (two digits when there are ten or more).
  Clicking its name renames it: a display-only Herdr pane label (`herdr pane
  rename`); the agent name that org runs link to is never changed. `e`
  renames the focused session; an empty name clears the label.
- The prompt at the bottom (`n`, or click it) adds a task under the block
  through `org add`, or starts a chat with a configured agent kind
  (`chat_kinds`, default claude and codex) in a chosen checkout. The bar
  always shows which and where (`task → G-15`, `claude → main`); Tab and
  Up/Down change them, and one Enter starts it. `--print` never writes.
- A Needs you item's page lists its choices with what each causes, the
  recommended one starred, then Reply, Open the session, Save for later and
  Drop. A number (or `y` for the recommended choice) arms the answer line,
  which says exactly what will happen; Enter does it. A reply or an org
  decline asks for its words first. Session results go through the Brain CLI
  (the same verbs as the classic console); org questions through `org answer`.
- Current project sessions lead the overview. Goals/tasks come from `org status
  --json`; decisions and stopped-session results reuse the existing org/Brain
  read projections. Finished tasks are excluded from the active list.
- Main checkout and worktrees use canonical Git common-directory identity. No
  basename, workspace label or branch prefix is used to establish ownership.
- The scope dropdown overlays the current view, supports filtering, and cancels
  without losing context. It includes configured projects and repositories open
  in Herdr. Opening a known worktree/folder reuses a matching association.
- Under `HERDR_ENV=1`, native Herdr owns the persistent sidebar. The companion
  hides its duplicate rail; `w` reveals checkouts on demand. Standalone mode
  starts with the rail. `HERDR_CONSOLE_SIDEBAR=0|1` overrides that local default.
- Projects and ordinary directories without an organization are inspectable.
  Missing config does not write an example file or prevent discovery.
- Checkout tabs are horizontal. A split tab with several agents requires an
  explicit session choice. Shell tabs offer native terminal access.
- Opening a session lets you type into it here. The console takes Herdr's
  control stream for that pane (`herdr terminal session control`). While it
  holds the stream, Herdr sizes the pane's terminal to the console's area, so
  the agent redraws to fit, with its cursor. Every key goes to the session,
  including Esc, Ctrl-C and `q`. Ctrl+] or clicking ‹ Back releases the pane,
  which returns to its native size, and goes back to where you were. A crash or
  kill releases it too. The wheel scrolls the session. If Herdr hands the
  terminal elsewhere, the view drops back to watching; `i` types into it again.
- The watching view separates goal/task/summary from a live, read-only harness
  screen. An exact-pane observer preserves supported ANSI styles and cell layout.
  It reads the native dimensions and shows the bottom rows first, with explicit
  visible row/column ranges. Console resize and local panning never resize or
  scroll the actual harness. `l` switches to a plain transcript polled every
  1.5 seconds; `v` returns to the live screen. Unsupported hosts show an error
  and the native-open path, rather than an unlabelled transcript fallback.
- Goal/task readers put current linked sessions before criteria and notes. They
  include descendant active tasks, distinguish historical links, and explicitly
  name missing criteria. Compact overviews retain all four work categories.
- Open native terminal transfers focus to that exact session after checking
  current topology. The console continues in its own tab for the return trip.
- Back restores project, view, focus and scroll. Closed/missing sources and
  reconnect errors retain distinguishable last-good data instead of pretending
  the project is empty.
- Current, deferred and future-stage decisions remain separately reachable.
- Needs you holds only what still asks something open. A session result folds
  out, still readable, when its org item has closed or a newer result about the
  same item replaced it (Resolved), when it reported without asking (Reports),
  or when its session ended over a day ago and no org item records it (Ended
  sessions). A stranded reply never folds. Org questions are never folded here.

## Keys

| Key | Action |
| --- | --- |
| `p` | Scope dropdown; type to filter, Up/Down choose, Enter selects, Esc dismisses |
| `h` | Project overview |
| `g` / `t` / `s` / `!` | Goals / Tasks / Sessions / Needs you |
| `Tab` / `Shift+Tab` | Change section, remembering selection within it |
| `j` / `k`, Up / Down | Select within the current section |
| Left / Right | Change central view, or the selected checkout's horizontal tab |
| `w` | Show/hide local checkouts |
| `Enter` | Open the focused row/control |
| `Esc`, `b`, `Alt+Left` | Back |
| `Alt+Right` | Forward |
| `PageUp` / `PageDown`, wheel | Scroll; live output switches to the older/latest transcript |
| `l` / `v` | Plain transcript / live native screen |
| Shift + arrows | Pan the live screen locally; vertical steps are 3 rows, horizontal 12 columns |
| `r` | Refresh sources |
| `D` | Switch between the reference's light and dark appearance |
| `o` | Open selected native terminal in Herdr |
| `i` | Type into the watched session here |
| `Ctrl+]` | While typing into a session: release it and go back |
| `n` | Prompt: type, Tab task/chat kind, Up/Down checkout, Enter starts, Esc |
| `1`–`9` | Open that numbered session (project screen) |
| `e` | Rename the focused session (project screen) |
| `?` | Help |
| `q` | Quit, restoring terminal modes |

Mouse clicks share these actions. Extended SGR mouse Back/Forward codes are
parsed and tested; physical side-button forwarding depends on Herdr and the
outer terminal and has not been validated. The readable layout minimum is
80 × 20; 80/100/140-column views have been exercised. Wider session views show
Session, Who, Where, Up, State, Doing. Narrow views preserve identity/state and
show the remaining facts in session detail.

## Boundaries

Typing into a session writes only to that session's terminal, and only while
the operator is in it. The prompt bar writes `org add` through the CLI for a
task, and `herdr tab create` / `agent start` / `agent prompt` for a chat, on the
operator's typed text and Enter. Renaming sets only a pane label. A Needs you
answer goes through the Brain CLI or `org answer` after the answer line says
what it will do. There is no dispatch or model-call path; use
`node bin/org.mjs console --project NAME` for dispatch. Nothing writes as a side effect of opening or navigating the trial.

Goal/session associations use recorded run data. A title resemblance does not
establish a link; unmatched sessions say Unlinked and older recorded associations
say last. An agent marked working does not prove progress on a task.

Folder opening is temporary observation. It does not initialize Git, register a
project, create an organization or persist a new catalog entry. Startup/config
files and project files remain unchanged. Idea capture, new folders, project
registration, chat creation, and new-shell write workflows are follow-on work in
the [onboarding design](../../docs/design/console-projects-onboarding-2026-09-20.md).
The browser URL on port 8765 remains a captured-data design preview.
Goal creation is not connected; the header offers `n Start` on the project
screen and states Read only elsewhere. The existing `herdr brain` brand is retained
while Projects remains a naming recommendation. Daily/weekly planning is
specified in the [backlog review design](../../docs/design/console-backlog-review-2026-09-20.md);
no scheduler or autonomous backlog mutation is enabled by this trial.

The watching viewer is a decoded terminal screen; typing uses Herdr's control
stream, not a local PTY. It supports
the observed Herdr renderer's bounded ANSI controls, not arbitrary terminal
images or every host palette customization. See the [terminal contract](../../docs/design/console-native-terminal-contract-2026-09-20.md).
Mouse clicks inside the session are not forwarded; use `o` for those.

## Herdr plugin package

The root `herdr-plugin.toml` declares a tab entrypoint and no automatic hooks.
`console/plugin.mjs` opens the same live reader. It honors `HERDR_BIN_PATH` and
the inherited socket context, and selects the calling workspace's project when
no project/folder is specified. The tested CLI/server is Herdr 0.8.2; the manifest
requires that version. Node 20+ and the console's installed dependencies are
required. Local linking does not install dependencies.

To register and open the local package, when desired:

```sh
npm --prefix console ci
herdr plugin link /absolute/path/to/this/worktree
herdr plugin pane open --plugin rewt.brain-console-trial --entrypoint projects
```

Linking registers the plugin in Herdr's user configuration. This development pass
has not linked it globally or exercised the host-owned plugin tab lifecycle; the
standalone Ink entrypoint and live sources were verified. The trial package ID
avoids committing to a permanent brand or replacing another plugin.

## Validation

`npm test` includes the offline modern-session tests: canonical repository
identity, project isolation, absent config, non-Git folders, exact-pane reads,
split-tab choice, disappearance, stale responses, refresh races, source recovery,
Back/Forward, mouse hit targets, section navigation, dropdown cancellation,
compact work summaries and native-screen cropping. Observer tests cover full
and differential frames, Unicode cells, source geometry, cancellation, stale
callbacks and failure handling. These tests do not call a model or a real Herdr server.
The repository/console suites also cover the existing interface.

Current evidence and limits are in the
[independent operator UX study](../../docs/reviews/console-full-ux-study-2026-09-20.md)
and [usability delivery report](../../docs/reports/console-usability-study-2026-09-20.md).
Earlier live-trial and visual-fidelity reports remain historical records.

# Projects: live trial, naming, and starting from an idea

The product should let someone see what is happening in a project and take its
next useful step, whether they have a working codebase or only a rough idea.
Goals are helpful structure, not an admission requirement.

## Name recommendation

Use **Herdr Projects** as the product name and **Projects** inside Herdr. In a
marketplace description, “Projects for Herdr” makes the relationship clear.
The description can be: “Ideas, goals and agent work in one place.”

The name identifies what the operator manages. It fits an exploratory personal
project, a repository with existing agents, and a project with ranked goals and
delegated execution. Brain describes a reasoning component and implies that
autonomy is required; org describes the record-keeping implementation and makes
a fresh project sound administrative. Keep those names for the existing tools
and internal components. A branding decision need not rename commands, move
checkouts, change config locations, or break launch scripts.

Alternatives considered:

| Name | Assessment |
| --- | --- |
| Projects | Recommended: the clearest shared noun for discovery, ideas and ongoing work. |
| Studio | Inviting for exploration, but less specific about observing multiple projects. |
| Workbench | Suggests one working context rather than a portfolio and its agents. |
| Brain | Useful internal name for coordination; too narrow and anthropomorphic as the whole product. |
| Org | Appropriate CLI shorthand; exposes implementation instead of a person's work. |

The initial live trial used the generic heading Projects; the fidelity correction
restores the preview's existing `herdr brain` brand pending a naming decision.
Its draft plugin ID remains
`rewt.brain-console-trial`; adopting a permanent package ID and brand is a later
packaging decision. The existing repository, org IDs and commands are intact.

## Herdr remains the terminal host

The integration is an independent Ink application in a Herdr plugin terminal
pane. Herdr owns spaces, tabs, panes, agent recognition and terminal interaction;
Projects owns project context, durable work views and the connection between
goals and sessions. Plugin v1 declares terminal entrypoints in a manifest;
it does not embed a foreign React UI into Herdr's native layout. Runtime commands
receive Herdr's binary, socket and invocation context. The adapter uses
`HERDR_BIN_PATH` and argument arrays. See [Herdr's plugin contract](https://herdr.dev/docs/plugins/).

The installed CLI and running server were both 0.8.2, protocol 20. The trial
manifest requires 0.8.2 and uses a tab entrypoint. This gives the console a stable
place to return to after opening an existing native agent terminal. No startup
hook, watcher service or automatic dispatch is installed by this manifest.
A manifest is packaged in this worktree; host registration and plugin-owned-tab
launch still need validation. Running the same entrypoint directly has been
checked against live sources.

## Starting point: three equally valid entrances

```text
Projects

Continue
  bch-cloak        1 working · decisions waiting
  herdr-brain      1 working

Start something
  Bring an idea    Capture thoughts; no folder or goal required
  Open a folder    Use a repository or an ordinary directory
  Use an open space
                   Choose work already visible in Herdr
```

This is the empty-installation and project-picker experience, not a mandatory
wizard shown on every launch. With an invocation context, open the project
belonging to the selected Herdr workspace. With an explicit project argument,
use that project. Otherwise use the last chosen project once the catalog is
durable, then the project picker. Never infer a project from a matching basename.

### Bring an idea

Ask for a working title and a freeform note: “What are you thinking about?”
Accept pasted collections of ideas and links. Save the original wording first.
Do not turn each bullet into a task or manufacture goals as a side effect.
No model call is needed to save or view these notes.

A draft project has its own stable identity and a durable idea document in the
plugin's user-state directory. It does not need a Git repository, an org, an
agent, a budget, a deadline or a ranked backlog. Reopening it shows the notes
and any exploratory conversations. It is a project in the catalog from day one.
These are proposed data semantics, not an implemented org item kind.

Its contextual next actions are **Add ideas**, **Explore with an agent**, and
**Choose a folder**. Starting an exploratory conversation requires choosing an
available agent/account and showing its working directory. If no folder exists,
use a plugin-owned project workspace with no Git checkout, clearly shown before
launch. Keep the conversation distinct from development and task dispatch.

When an outcome becomes clear, offer **Shape a goal**. An agent may propose a
small set of outcomes and a first experiment, explaining how each relates to the
notes. The operator can edit and keep only the useful parts. Preserve source
notes and provenance; rejected suggestions should not become open work.
The draft should remain useful even if the operator never formalizes a goal.

### Open a folder

Allow direct path entry and a local directory picker. Existing Git repositories,
linked worktrees, and non-Git folders are all valid. Inspect only what was chosen;
do not run repository scripts, scan the home directory, or index unrelated text.

Show a small review of the discovered facts: folder, repository identity if any,
current checkout, existing Herdr spaces/sessions, and an already registered org
association. If a linked worktree was selected, open the parent project and keep
that checkout selected. Match a repository using its canonical Git common
directory, following symlinks; names, remotes and `lane/` prefixes are labels.

**Open** observes immediately. **Add to my projects** persists the catalog entry.
These have different outcomes and should be named accordingly. Configured
associations win; if a repo has more than one explicit organization association,
ask the operator which context to use. Never silently attach a neighboring `.org`
directory or merge two same-named repositories.

Existing goals are imported through their current org read contract. If no org
exists, show the real sessions and files with “No goals yet”; don't fill the page
with sample metrics or require setup before inspection. **Connect an organization**
is an optional advanced action. The common path is simply exploring the project.

### Use an open Herdr space / discover projects

Use Herdr's workspace inventory first. Group worktrees under the repository they
actually share, and show the root path to distinguish same-named projects.
Discovery is read-only and is not registration. Reopening an existing project
must reuse its catalog entry and its existing spaces, not create duplicates.

A later **Find projects in…** action can inspect immediate children of a folder
the operator chooses. Show candidates before adding anything. Recursive scanning
should be explicit and bounded, skip dependency/build directories, and remain
cancelable. Existing worktrees must not become separate projects. A folder with
several unrelated repositories requires a choice; do not auto-merge them.
Remote discovery requires an explicit machine identity and server-local paths;
the current live trial covers the connected local Herdr server only.

## Bootstrap without a blank-dashboard dead end

```text
Project: Pocket garden

Ideas                         Conversations
  Track what's growing         Explore the first version
  Remind me when to water
  Maybe share photos

No goals yet. What would make a useful first version?
  Shape a goal     Choose a folder
```

The overview adapts to evidence. With ideas and conversations but no goals,
show those useful objects. With running agents, sessions lead. With a first goal,
introduce Goals and its related work. Keep these transitions local to the project;
don't add setup progress percentages or stored lifecycle phases.

Creating a brand-new folder is a separate action from opening one. Before writing,
show the exact destination, whether Git will be initialized, which notes will be
copied, and which project/organization records will be created. Check collisions
and writable parents. Keep partial results findable; retry resumes the same
operation, and never overwrites an unrelated existing directory.

For a code project, a first development task creates its worktree through the
existing Brain dispatch layer. Main remains the conversation/coordination
checkout. A goal or project registration is not a grant to dispatch, promote,
push, or delete. Authority remains separately recorded and scoped. Bootstrap
should end with a useful conversation or an explicit first task, not with a
resident supervisor process.

## Durable ownership and implementation order

Use one catalog shared by the plugin console and Brain, with stable project IDs,
display names, optional canonical repo/folder identity, optional org association,
and draft-note location. Existing console and Brain project configuration need
an explicit compatibility/migration layer; adding a second independent writable
registry would recreate project discovery inconsistencies.

Do not extend org with stored project status. Org remains the authoritative event
record for goals, tasks, decisions and runs. Ideas can remain a plain document
until the operator promotes an outcome into work. Console mutations continue
through the owning CLI, with argument arrays; never append events directly.

Delivery order:

1. **Live inspection**: project/checkout/session navigation, exact output, goals,
   tasks, decisions, source health, and empty-folder discovery. Implemented as
   the opt-in `--modern` trial described below.
2. **Catalog and idea capture**: durable draft projects and notes, register/open
   distinction, explicit org connections, folder creation review and recovery.
3. **Conversation and work creation**: discover agent kinds/accounts; start a
   conversation without inventing a task; review a proposed goal/first task;
   use existing dispatch for development and preserve its lifecycle checks.
4. **Write workflows in the new shell**: bring over existing decision, reply,
   instruction and dispatch workflows, then goal ordering/authority as their
   backend contracts are implemented. Validate terminal mouse/focus round trips
   and the actual plugin-owned tab before changing the default console.

## Live trial design and scope

The accepted native-spaces composition is retained: project scope and checkouts
in the left rail, sessions first in the overview, goals and tasks side by side,
Needs you below, and tabs across the selected checkout. Worktrees appear directly
under Main checkout. Selected output is read by exact pane ID, with full native
interaction available by opening that terminal in Herdr.

The visual plan uses terminal typography: bold for identity/section headings,
normal mono for data, muted mono for context. The user's terminal controls the
font. The corrected implementation takes its actual colors from the approved
HTML: light Canvas `#fafcfe`, Rail `#e6edf7`, Ink `#22354c`, Navigation `#245d9b`,
Goals surface `#f0f3fb`, and Attention surface `#fff1d8`, with the same reference's
dark variant available. The indigo goal accent stays distinct from activity. The identifying
composition is the checkout tree beside live sessions and their goal/task link.
No extra dashboard cards or decorative metrics are introduced.

Before implementation, the design was checked against the accepted preview:
retain native spaces, avoid a competing tab tree, reserve color for resource and
state distinctions, and use only enough blank space to separate work groups.
Live testing then required compact session columns at narrow widths, a reserved
task-state column, direct list focus after keyboard navigation, and honest empty
states. The six-column session table is available at wider sizes; narrow views
preserve identity and state, with all details in the selected session.

The trial supports `org console --modern`, an explicit configured project, or
`--modern --folder PATH`. A missing console config opens discovery without writing
an example config. Opened folders are temporary in this trial and do not register
a project. Idea capture, new folders, chat/goal creation and organizational writes
are not implemented here; their entry screen states that limitation. The current
console remains available for existing operational actions.

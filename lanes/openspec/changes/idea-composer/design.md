# Design: Compose and dispatch an idea from the board

## Interaction

Keep a pinned task strip below the board; n from navigation focuses and expands
it. Draft task, editable topic, repository and route live only in UI memory and
survive selection, filtering and Escape. Task Enter inserts a newline. Suggest
a valid topic until the operator edits it; require a visible nonempty valid topic
before review. Tab/Shift-Tab traverse task, topic, Where, Who and Review launch;
Enter in topic advances to Where. Text controls own d/q/n and all other typing.
Escape closes the innermost popup or suspends composition without losing the draft.

Where uses the CLI's canonical repository inventory, with root/path or identity
suffixes to distinguish duplicate labels. An explicit path is validated through
lane routes --repo --json and does not create a persistent catalog. Board scope
changes never change the draft destination. Only a verified caller repository
may prefill Where; without that anchor leave it unselected, even if discovery has
results. Selecting a different repository clears Who, reloads its routes and
requires a fresh choice even for a same-named route. Show route name, resolved
kind/provider, model, effort and use note. Model and effort come from CLI
resolution and recognized arguments, never the route name; distinguish known agent
defaults from unknown values. Missing use is “no usage note.” Expose no environment
secret values. No repository or no routes disables review with guidance while
preserving the task. An identity root is not a repository and cannot dispatch;
offer an existing repository or explicit path. Do not create repositories, select
implicit scratch/default targets, or start a facilitator. Inaccessible Herdr
blocks dispatch without discarding the draft.

Review launch opens a focus-contained review showing the complete task, topic,
canonical repository/root, worktree destination and selected route/use with
resolved model/effort. Show unavailable destination data honestly and let the CLI
preflight be authoritative; do not compute a competing configuration/identity
resolver in the UI. Launch once and Edit then dispatch are explicit controls;
Enter from task input never launches. Submit one frozen argument-array request to
lane new, disabling repeated submit and target editing until that foreground
invocation returns. Do not persist or resume it as a job. Success refreshes and
selects the exact returned registered row without Herdr focus, revealing it if
necessary under an active filter. If it has not appeared, show “launched; waiting
for observation” using the returned identity rather than guessing by topic. A
subsequent Enter focuses it. Report refusal, retained draft, known unprompted
lane, ambiguous delivery and post-delivery registration failure distinctly, with
CLI-provided paths/identifiers and explicit inspection guidance. Never replay,
automatically retry, silently substitute a route, or delete retained work.

Edit then dispatch invokes lane new --edit with inherited terminal input.
Suspend/close the observation child, leave alternate screen and release raw mode
before handoff. Restore the board and refresh only after the command exits.
Editor cancellation preserves the CLI's draft and performs no dispatch. Present
duplicate-brief recovery without overwrite. The UI writes no brief, reads no
target files, runs no git command and opens no Herdr control connection directly.

Schema audit: the board schema supplies canonical repository path and resolved lane
destination base, but not a topic-specific destination preview; show that value as
unavailable unless a CLI result supplies it. **Needs field (idea-cli):** structured
lane-new success identity containing the canonical lane/worktree, agent/session or
registry row identity, and registration/delivery stage. **Needs field (idea-cli):**
route effort as a documented recognized-argument projection (or explicit resolved
field); model/effort must not be inferred from route names.

## Verification and risks

Use @inkjs/ui selection/text controls, keeping the application exclusively on CLI
interfaces. Draft form fields live only in UI memory; only the CLI writes the
ignored brief. Tests exercise a built-ins-only form/action model and fake CLI
responses without importing UI dependencies. A separate real-TTY smoke checks focus
ownership, editor handoff/return, long text, cancellation, and success selection.
Include one offline end-to-end new -> registered row -> focus -> close -> hidden row
scenario across two same-named repositories in different roots.

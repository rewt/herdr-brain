---
run: R-292
outcome: done
summary: |
  Fixed the folder path entry so capital C stays in the text instead of opening a project chat. Reopening now finishes a failed or delayed agent rename only when the unnamed occupant matches the recorded pane, workspace, harness and canonical checkout. New launches wait for a stable shell prompt, prove shell readiness and verify execution of the started command. The launcher adopts the existing named prototype in the chats workspace without restarting or changing its configuration, and opens other projects there. All 65 focused offline tests passed; implementation and this report are committed before the final lane check.
headline: Project chats now preserve typed paths, recover failed renames and reuse the existing conversation safely.
blockers: []
proposals: []
learnings: []
artifacts:
  - eeb5b8930cdc70b560e2af32b641c606e31b3f1f - implementation, documentation and offline regressions
  - lane/project-chats
  - console/modern/session.mjs
  - console/test/modern.test.mjs
  - supervisor/chats.mjs
  - supervisor/test/chats.test.mjs
  - discovery/README.md
  - supervisor/docs/R-292-report.md
  - node test/helpers/run.mjs supervisor/test/chats.test.mjs console/test/modern.test.mjs - 65 passed, 0 failed; supervisor chats 17, modern console 48
decisions:
  - text: Recover an unnamed chat by renaming the occupant only after validating the receipt's pane, workspace, harness and canonical checkout.
    category: tooling
    why: A failed rename or late detection can be repaired on reopen without launching a duplicate or adopting a foreign occupant.
  - text: Require a stable visible shell prompt and execution markers for readiness and the launch command.
    category: tooling
    why: A shell may own the foreground while an initialization builtin waits for input; process identity alone allowed an oh-my-zsh update question to swallow the command.
  - text: Use the chats control workspace and adopt its existing named project prototype by verified pane and checkout bindings.
    category: tooling
    why: The operator's ongoing conversation, personal Claude configuration and entry bypass must survive; other fleet projects belong in the same workspace.
questions: []
challenges: []
---

Read the correction ask, R-292 brief and R-285 review at canonical
.lane/reviews/project-chats/5055ef9-r1.md. Addressed both review findings and
the prototype's startup and adoption requirements.

The modern console's C shortcut now follows the folder text-entry branch.
The new regression types /projects/Code and checks that no chat call occurs.
Existing compose-entry coverage still passes.

The launcher retains the receipt before sending shell input, preserving its
one-tab/no-replay recovery policy. On reopen an unnamed occupant with the same
harness and checkout in the recorded pane is renamed. A named foreign occupant,
different harness or checkout, moved pane, or occupied chat name remains an error.
Offline tests cover failed rename and late detection after startup timeout.

New chats require two identical visible prompt samples while the shell owns the
foreground in the canonical checkout. A harmless split nonce must appear as an
exact output line, then the launch wrapper emits a separate execution nonce and
execs the adapter. Success requires both that nonce and detection of the expected
agent in the checkout. Tests distinguish executed output from command echo, wait
through an update question, send no input to a persistent oh-my-zsh update prompt,
and reject an agent detection without launch-command proof. Unknown prompt styles
time out with the tab retained for inspection; no prompt answers are automated.

The default workspace is now chats. Existing receipts keep their workspace ID.
With no receipt, a named chat-PROJECT prototype is adopted only after validating
its agent harness, canonical checkout and pane/tab/workspace topology. The
chat-herdr-brain conversation therefore keeps its original agent name and
environment, including personal CLAUDE_CONFIG_DIR and MONITOR_ENTRY_BYPASS=1.
New projects receive tabs named for the fleet project in that same workspace.
The adoption test models workspace w2XS, removes the default adapter to prove
adoption requires no relaunch, preserves its environment, renames the tab label,
reopens it and creates a second project's tab without stealing focus.

Validation: node test/helpers/run.mjs supervisor/test/chats.test.mjs
console/test/modern.test.mjs passed 65/65 (17 supervisor chats and 48 modern
console). git diff --check passed. Tests used only scratch fleet/project records
and fake Herdr; no model or live acceptance harness was called. The existing
live prototype was not mutated during development, so live adoption remains
unexercised by this run. No project housekeeping loop was started.

After writing the requested external report, record check and the report commit,
the final command is:

    node lanes/lane.mjs check

That command runs the canonical fast tier and records the final clean-commit
gate in .lane/gate.json. No report edit follows that final check.

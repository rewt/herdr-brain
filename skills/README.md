# Shared engineering procedures

One portable `SKILL.md` source serves Brain and BCH, on Codex and Claude. Load only
the procedure needed for the assigned work. Project AGENTS.md, the ask, record and
actual native authority still control effects. Hard checks stay in the current
tools; these files add no scheduler, state store, locking wrapper or approval gate.

| Procedure | Use it for | Source |
| --- | --- | --- |
| Preflight | Scope, split work and choose isolation | [project-preflight](project-preflight/SKILL.md) |
| Delivery | Owned landing, focused evidence, record and report | [project-deliver](project-deliver/SKILL.md) |
| Review | One immutable diff/evidence review | [project-review](project-review/SKILL.md) |
| Release | Final coverage and an authorized release handoff | [project-release](project-release/SKILL.md) |
| Troubleshooting | Diagnose a concrete failure and reframe stalled fixes | [project-troubleshoot](project-troubleshoot/SKILL.md) |

The nine research categories map to preflight (split/isolate), delivery
(land/report/record), review and release, plus the existing personal `herdr` skill.
The closeout procedure is held outside this landed package during the running
closeout proof. Existing lifecycle behavior and its owning service remain intact.

## Project bindings

Shared instructions carry procedure, never an ambient Brain default. Before a
command, resolve the project from the assignment and real Git common directory,
then use its record root, active claim, source/runtime and supported entry from
the run brief. Never infer mutation authority from a skill's installation path,
a folder name, a display label or harness session metadata.

Brain's sources remain `bin/org.mjs`, `lanes/lane.mjs`, `messages/README.md`,
`settle/README.md`, `supervisor/PROTOCOL.md` and the release references named in
the release skill. Consult them only for the operation at hand. BCH identities
resolve BCH's own instructions and entries. No BCH files, pins or saved jobs are
changed by installing these shared procedures. Both harnesses get identical core
instructions: no `context: fork`, tool allowlist, model selection or implicit
permission changes are embedded in the portable frontmatter.

## Discovery and distribution

The tracked `.agents/skills/` and `.claude/skills/` links expose these five folders
inside Brain without a second copy. A project session can also read the canonical
absolute skill path explicitly. The package is local source, not a published
marketplace or an immutable product release.
The source-only `.agents/` and `.claude/` harness trees are excluded from release
inventories and Git archives; the canonical `skills/` files remain in the archive.
Genuine build checkouts retain both harnesses' discovery links.

For cross-project discovery on this machine, put one link per skill under
`~/.agents/skills` for Codex and `$CLAUDE_CONFIG_DIR/skills` for Claude. The `ai`
wrapper selects Claude's config directory per persona; the personal persona used
by Brain and BCH reads `~/.claude-personal/skills`. Use the active persona's
directory rather than assuming `~/.claude/skills`. Point at the **canonical
landed** `herdr-brain/skills/NAME` directory, never at a disposable worktree or a
held/unlanded commit. Inspect all
destinations first: retain an identical link, create only absent paths, and stop
on any other file/directory/link rather than overwriting it. Native permission
refusals stop installation. Installation does not authorize editing BCH or change
its release pin; a BCH-identity session owns project-local integration.

Discovery metadata takes effect when a harness next loads skills. Creating links
does not prove a live invocation in either harness or project. Preserve current
sessions and watchers; do not restart them to refresh discovery. No plugin bundle,
machine hook or separate Codex-only copy is needed for this source package.

## Worktree decision and rollout

Allocate a source worktree only to each code writer working alongside another
writer. Research, planning, record-only work and fixed-diff review need no new
writable source checkout. A sole writer can reuse an exclusively owned checkout
where the project's existing guards support it. Generated test scratch is still
owned evidence/resources and does not become permission to share another writer's
index. A read-only owner becoming a source writer obtains a supported binding
before editing.

This is the engineering allocation decision, not a claim that current dispatch
already implements every case. Existing worker dispatch still allocates lanes.
Changing allocation requires preserving real claim/native source binding and the
pending-effect/recovery contracts; do not simply start a second writer in main.
Existing claimed runs remain in their assigned trees.

Land in steps:

1. Deliver these five procedures and discovery links. Leave runtime dispatch,
   retirement, cleanup, closeout and the running proof/measurement unchanged.
2. After the closeout-proof hold is released by its owner, resume the retained
   closeout skill source under the same project authority. Do not lift the hold
   from a skill or treat elapsed time as completion.
3. The allocation owner implements no-new-tree dispatch for read-only/record-only
   roles, then exclusive-writer reuse, under the existing claim/native guards.
   This step stays deferred where it touches lifecycle paths during the proof.
   BCH adoption and its own real tasks belong to BCH-identity sessions.

Judge later adoption on real assigned tasks, preserved review/correction ownership,
session-loss recovery, dirty/uncertain-work retention and guarded writer landing.
Fewer folders and installed links alone do not prove those outcomes. Keep the one
existing record queue-review and producer evidence; no pre-code or parallel review
stage is introduced by this rollout.

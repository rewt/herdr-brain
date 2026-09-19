# Daily supervisor protocol 2026.09.12.4

This supplements the pinned core/config release `config/2026.09.12.1`. That
release supplies a one-shot `monitor` route, but route `use` text is descriptive
and is not sent to agents or enforced by the CLI. This protocol supplies the
missing session boundary and startup instructions. It adds no watcher, daemon,
lease, or automatic action to herdr-lanes.

## Onboard each project once

The identity-level `.lane-supervisor/current/` pack is a versioned template,
not an automatically inherited agent instruction. Keep the project's rules in
its own `AGENTS.md` (and its existing agent-specific import, if any). Create a
private, ignored `.lane/supervisor/PROJECT.md` from `PROJECT_TEMPLATE.md` in
each canonical checkout. Fill in the exact sources for current goals and the
destinations for tracked plans, review records, external durable evidence,
runtime material, and disposable scratch. Check the project's instructions
first; do not guess one archive root for every repository under an identity.
Confirm `.lane/` is ignored with `git check-ignore` before writing there.

The project file is a locator, not a second copy of repository policy. Record
the default daily supervisor model separately from the active queue owner and
model. A launch-time model choice can override the default; changing the
default does not replace or retarget a running supervisor. A project without a
verified archive destination must not close a lane whose only evidence is in
scratch. Keep private material out of tracked documents,
report messages, and the supervisor prompt.

## Start one daily supervisor

1. Use the project's approved supervisor working directory in its Herdr
   workspace and resolve the canonical checkout and Git common directory.
   Some projects keep the canonical checkout read-only and require a
   coordination worktree for the supervisor. Choose the supervisor model and
   queue owner explicitly under that project's current policy. Resolve any
   conflicting model or owner instructions before starting a second queue
   owner. Do not reuse an engineering route simply because it is the default.
   A one-shot `monitor` route is not a
   substitute for a facilitator that must discuss plans and make decisions.
2. Create or refresh `.lane/supervisor/TODAY.md` from `TODAY_TEMPLATE.md`.
   Name at most three goals and point to the current authoritative plan and
   latest durable transition record. Treat yesterday's file as a handoff, not
   today's truth. Reconcile it with the operator's latest direction, current
   Git HEAD, lane status, exact gate/review records, and newer archive entries.
   Keep it roughly one page. Do not paste transcripts or secrets.
3. Start a fresh agent session from that approved working directory and give it
   `STARTER.md` plus the absolute paths to the project's `PROJECT.md` and
   `TODAY.md` in one prompt. For native Codex CLI access from iOS, follow
   `CODEX_REMOTE.md`: enable the shared host daemon once and pass both
   `--remote unix://` and `-C <approved-worktree>` after Herdr's `--` when
   starting each new Codex TUI. Verify its startup `directory:` before
   prompting. A Herdr pane cwd alone does not bind a remote Codex session.
   Select native arguments for the agent kind and the project's approved model.
   Run these commands only from an available shell pane inside Herdr. Use a new
   session name each day; don't restart a large old chat merely to monitor.
   Prompt the named session once with the three file paths, for example:

   ```sh
   supervisor_agent=daily_supervisor_0912
   identity_root=/path/to/identity
   repo_root=/path/to/canonical-checkout
   herdr agent prompt "$supervisor_agent" "Read $identity_root/.lane-supervisor/current/STARTER.md, $repo_root/.lane/supervisor/PROJECT.md, and $repo_root/.lane/supervisor/TODAY.md; follow the starter and report the verified goals and next evidence."
   ```
4. Add `ENGINEER_REPORT_APPENDIX.md` to each engineering brief with the exact
   supervisor agent name. The engineer preserves the evidence available at a
   material milestone, blockage, or completed gate, then sends one short
   `herdr agent prompt` to the supervisor. It does not wait for the supervisor's
   answer. A delivery failure leaves the durable evidence intact.
5. After dispatching, record the expected artifact, tell the operator, and end
   the supervisor turn. An incoming engineer report is the normal wake-up.
   Verify its branch, HEAD, gate, and report against Git and lane evidence
   before acting. The message is a claim, not authorization or a verdict.
   Independent reviewers follow the project's review-only protocol. When the
   project uses `lane review`, that command validates the saved record and
   returns its verdict; other projects must verify their own durable verdict.
6. If the operator asks for status before a report arrives, take one compact
   snapshot of exact named agents. Read bounded output only for changed state;
   use Git HEAD, lane status, gates, and review records for durable facts.
   Do not run a periodic supervisor polling loop.
7. At the end of the day or a major phase, update `TODAY.md` and the project's
   durable record at the declared destination, then start a fresh session next
   time. Use Codex `/compact` during a coherent long task if needed, but do not
   keep one chat for the whole project. Keep a soft ceiling
   near 20 model responses or 40,000 input tokens in one supervisor context;
   rotate earlier if a session starts with a larger required instruction set.

The project file, daily handoff, and incoming reports are continuity for
conversation, not authority for promotion, publication, financial actions, or
approval. Recheck those boundaries against their primary evidence on every
relevant action.

## Measure the result

Record per session: elapsed time, model response count, total input, cached
input, uncached input, and output tokens. Compare cost per completed milestone
and status transition with the prior supervisor. A high cache ratio is normal
for a reused prompt prefix; the aim is fewer unnecessary model calls and a
smaller context per call. Do not claim a percentage saving before measuring it.

OpenAI's Codex [best practices](https://learn.chatgpt.com/guides/best-practices)
recommend one chat per coherent unit of work and `/compact` for long chats.
